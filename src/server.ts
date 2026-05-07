import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

import { SwfteClient } from './client.js';
import { loadConfig, type ServerConfig } from './config.js';
import { allTools } from './tools/index.js';
import type { ToolDefinition } from './tools/_types.js';

const PACKAGE_NAME = '@swfte/mcp-server';
const PACKAGE_VERSION = '0.1.0';

export interface BuildServerOptions {
  config?: ServerConfig;
  tools?: ToolDefinition[];
}

export function buildServer(opts: BuildServerOptions = {}): Server {
  const config = opts.config ?? loadConfig();
  const client = new SwfteClient(config);
  const tools = opts.tools ?? allTools;

  const toolMap = new Map<string, ToolDefinition>();
  for (const t of tools) toolMap.set(t.name, t);

  const server = new Server(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description + (t.title ? '' : ''),
      inputSchema: zodSchemaToJson(t.inputSchema),
      annotations: t.title ? { title: t.title } : undefined,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
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
      const result = await tool.execute(parsed.data, { client });
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });

  return server;
}

function zodSchemaToJson(schema: ZodTypeAny): Record<string, unknown> {
  // The MCP SDK expects a JSON-Schema-like object on the wire. We use
  // `zod-to-json-schema` so each tool's input schema is faithful and richly
  // annotated for clients (Claude Desktop, Cursor, Cline, etc.).
  const json = zodToJsonSchema(schema, { target: 'jsonSchema7' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
