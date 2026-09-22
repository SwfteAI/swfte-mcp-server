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
import { UnsupportedKindError, UnsupportedVerbError } from './kinds/index.js';
import { allTools } from './tools/index.js';
import type { ToolDefinition } from './tools/_types.js';
import { RESOURCE_TEMPLATES, STATIC_RESOURCES, ResourceNotFoundError, readResource } from './resources.js';
import { PROMPTS, PromptNotFoundError, getPrompt } from './prompts.js';

const PACKAGE_NAME = '@swfte/mcp-server';
const PACKAGE_VERSION = '0.2.0';

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
   * caller's project. Local-file tools then refuse instead of touching the
   * server's own disk. Default true (stdio).
   */
  localFilesystem?: boolean;
}

/** Apply the `SWFTE_TOOLS` group filter. An empty set means "advertise everything". */
export function selectTools(tools: ToolDefinition[], config: ServerConfig): ToolDefinition[] {
  if (config.enabledGroups.size === 0) return tools;
  return tools.filter((t) => !t.group || config.enabledGroups.has(t.group));
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
    const tool = toolMap.get(req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
      };
    }

    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Invalid input for ${tool.name}: ${parsed.error.issues
              .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
              .join('; ')}`,
          },
        ],
      };
    }

    try {
      const client = await resolveClient(extra?.authInfo);
      const result = await tool.execute(parsed.data, { client, config, localFilesystem: opts.localFilesystem ?? true });
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
          content: [{ type: 'text', text: JSON.stringify(err.toJSON(), null, 2) }],
        };
      }
      if (err instanceof UnsupportedKindError || err instanceof UnsupportedVerbError) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: true, code: 'UNSUPPORTED_CAPABILITY', message: err.message, nextAction: 'Call swfte_capabilities to inspect implemented verbs and per-kind lifecycle paths. Artifact form, activation and infrastructure deployment are separate decisions.' }) }] };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });

  // Resources: local capabilities plus a per-artifact catalog context template.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: STATIC_RESOURCES }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
    try {
      const content = await readResource(req.params.uri, {
        client: async () => resolveClient(extra?.authInfo),
        config,
        tools,
      });
      return { contents: [content] };
    } catch (err) {
      if (err instanceof ResourceNotFoundError) throw new McpError(ErrorCode.InvalidParams, err.message);
      if (err instanceof SwfteApiError) throw new McpError(ErrorCode.InternalError, err.message, err.toJSON());
      throw err;
    }
  });

  // Prompts: the reuse-first, ship and bake-in recipes.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    try {
      return getPrompt(req.params.name, (req.params.arguments ?? {}) as Record<string, string>);
    } catch (err) {
      if (err instanceof PromptNotFoundError || err instanceof Error) throw new McpError(ErrorCode.InvalidParams, err.message);
      throw err;
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
