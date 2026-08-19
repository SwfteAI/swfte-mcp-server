import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { SwfteApiError, SwfteClient } from './client.js';
import { loadConfig, type ServerConfig } from './config.js';
import { allTools } from './tools/index.js';
import type { ToolDefinition } from './tools/_types.js';

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
    { capabilities: { tools: {} } }
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
      const result = await tool.execute(parsed.data, { client, config });
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
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });

  return server;
}

function zodSchemaToJson(schema: ZodTypeAny): Record<string, unknown> {
  // The MCP SDK expects a JSON-Schema-like object on the wire. `zod-to-json-schema`
  // keeps each tool's input schema faithful and richly annotated for clients
  // (Claude Code/Desktop, Cursor, Cline, etc.).
  const json = zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
