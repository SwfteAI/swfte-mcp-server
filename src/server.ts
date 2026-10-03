import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { SwfteApiError, SwfteClient } from './client.js';
import { loadConfig, type ServerConfig } from './config.js';
import { redactErrorValue, redactSecrets, withErrorSecrets } from './fsguard.js';
import { UnsupportedKindError, UnsupportedVerbError } from './kinds/index.js';
import { allTools } from './tools/index.js';
import type { ToolDefinition } from './tools/_types.js';
import { RESOURCE_TEMPLATES, STATIC_RESOURCES, ResourceNotFoundError, readResource } from './resources.js';
import { PROMPTS, getPrompt } from './prompts.js';

import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';

export interface BuildServerOptions {
  config?: ServerConfig;
  tools?: ToolDefinition[];
  /**
   * Resolve the client for a single call, from that call's auth.
   *
   * stdio has one credential for the life of the process, so it leaves this unset
   * and every call shares one client — unchanged from before. Hosted over HTTP the
   * credential arrives per request in the bearer token, and one process serves many
   * users, so capturing a client at construction would hand every caller whichever
   * identity happened to start the server. Resolving per call is what makes the same
   * build safe in both places.
   */
  resolveClient?: (authInfo?: AuthInfo) => SwfteClient | Promise<SwfteClient>;
  /**
   * False when the server is hosted (HTTP) rather than launched inside the
   * caller's project. Local-file tools then refuse and file-producing tools
   * return files inline instead of touching the server's own disk. Default
   * true (stdio).
   */
  localFilesystem?: boolean;
}

/** Apply the `SWFTE_TOOLS` group filter. An empty set means "advertise everything". */
export function selectTools(tools: ToolDefinition[], config: ServerConfig): ToolDefinition[] {
  const permitted = tools.filter((t) => !t.requiresFlag || config[t.requiresFlag]);
  if (config.enabledGroups.size === 0) return permitted;
  return permitted.filter((t) => !t.group || config.enabledGroups.has(t.group));
}

/** Scrub raw strings before JSON escaping, using only this request's identity. */
function redactProtocolMessage(
  message: string, config: ServerConfig, authInfo: AuthInfo | undefined, client: SwfteClient | undefined
): string {
  // Opaque OAuth tokens need not match a known secret shape or length. These
  // literals also cover failures before a resolver has returned a client. Use
  // one complete set: sequential markers could reintroduce an earlier literal.
  return client
    ? client.withErrorSecrets([config.credential, authInfo?.token], () => client.redactError(message))
    : redactSecrets(message, [config.credential, authInfo?.token]);
}

export function buildServer(opts: BuildServerOptions = {}): Server {
  const config = opts.config ?? loadConfig();
  // Built once and reused when no resolver is supplied, so the stdio path keeps
  // exactly the behaviour (and the connection reuse) it had before.
  const sharedClient = opts.resolveClient ? null : new SwfteClient(config);
  const resolveClient = opts.resolveClient ?? (() => sharedClient!);
  const tools = selectTools(opts.tools ?? allTools, config);

  const toolMap = new Map<string, ToolDefinition>();
  for (const t of tools) toolMap.set(t.name, t);

  const server = new Server(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodSchemaToJson(t.inputSchema),
      annotations: {
        ...(t.title ? { title: t.title } : {}),
        ...(t.readOnly ? { readOnlyHint: true } : {}),
        ...(t.destructive ? { destructiveHint: true } : {}),
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    let client: SwfteClient | undefined = sharedClient ?? undefined;
    const redact = (message: string) => redactProtocolMessage(message, config, extra?.authInfo, client);
    try {
      const tool = toolMap.get(req.params.name);
      if (!tool) {
        return {
          isError: true,
          content: [{ type: 'text', text: redact(`Unknown tool: ${req.params.name}`) }],
        };
      }

      const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: redact(`Invalid input for ${tool.name}: ${parsed.error.issues
                .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
                .join('; ')}`),
            },
          ],
        };
      }

      client = await resolveClient(extra?.authInfo);
      const result = await client.withErrorSecrets([config.credential, extra?.authInfo?.token], () =>
        tool.execute(parsed.data, { client: client!, config, localFilesystem: opts.localFilesystem ?? true }));
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      // Structured failures carry a code and a suggested action; hand those
      // through as JSON so the model can branch on them instead of parsing prose.
      if (err instanceof SwfteApiError) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(redactErrorValue(err.toJSON(), redact), null, 2) }],
        };
      }
      if (err instanceof UnsupportedKindError || err instanceof UnsupportedVerbError) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: true, code: 'UNSUPPORTED_CAPABILITY', message: redact(err.message), nextAction: 'Call swfte_capabilities to inspect implemented verbs and per-kind lifecycle paths. Artifact form, activation and infrastructure deployment are separate decisions.' }) }] };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: redact(message) }] };
    }
  });

  // Resources: local capabilities plus a per-artifact catalog context template.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: STATIC_RESOURCES }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
    let client: SwfteClient | undefined = sharedClient ?? undefined;
    let pendingClient: Promise<SwfteClient> | undefined;
    const redact = (message: string) => redactProtocolMessage(message, config, extra?.authInfo, client);
    const getClient = () => pendingClient ??= Promise.resolve().then(() => resolveClient(extra?.authInfo)).then((resolved) => {
      client = resolved;
      return resolved;
    });
    try {
      const content = await withErrorSecrets([config.credential, extra?.authInfo?.token], () => readResource(req.params.uri, {
        client: getClient,
        config,
        tools,
      }));
      return { contents: [content] };
    } catch (err) {
      if (err instanceof ResourceNotFoundError) throw new McpError(ErrorCode.InvalidParams, redact(err.message));
      if (err instanceof SwfteApiError) throw new McpError(ErrorCode.InternalError, redact(err.message), redactErrorValue(err.toJSON(), redact));
      // The SDK serializes generic error.message AND error.data. Preserve its
      // safe code and data while preventing that final serialization from
      // bypassing the same per-call redactor used for backend envelopes.
      const detail = err !== null && (typeof err === 'object' || typeof err === 'function')
        ? err as { code?: unknown; message?: unknown; data?: unknown } : undefined;
      const code = typeof detail?.code === 'number' && Number.isSafeInteger(detail.code) ? detail.code : ErrorCode.InternalError;
      const message = typeof detail?.message === 'string' ? detail.message : String(err);
      const safe = new McpError(code, redact(message), redactErrorValue(detail?.data, redact));
      // A previously wrapped MCP error already has its protocol prefix.
      safe.message = redact(message);
      throw safe;
    }
  });

  // Prompts: the reuse-first, ship and bake-in recipes.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req, extra) => {
    try {
      return getPrompt(req.params.name, (req.params.arguments ?? {}) as Record<string, string>);
    } catch (err) {
      // Unknown prompt or a missing required argument: the caller's request is at fault.
      const message = err instanceof Error ? err.message : String(err);
      throw new McpError(ErrorCode.InvalidParams, redactProtocolMessage(message, config, extra?.authInfo, sharedClient ?? undefined));
    }
  });

  return server;
}

function zodSchemaToJson(schema: ZodTypeAny): Record<string, unknown> {
  // The MCP SDK expects a JSON-Schema-like object on the wire. `zod-to-json-schema`
  // keeps each tool's input schema faithful and richly annotated for clients
  // (Claude Code/Desktop, Cursor, Cline, etc.).
  const json = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
