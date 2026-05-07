import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const mcpTools: ToolDefinition[] = [
  {
    name: 'swfte_mcp_servers_list',
    title: 'List connected MCP servers',
    description: 'List the third-party MCP servers connected to the workspace.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: '/api/v2/mcp/servers', workspaceId: input.workspaceId }),
  },
  {
    name: 'swfte_mcp_servers_connect',
    title: 'Connect an MCP server',
    description:
      'Connect a remote MCP server to the workspace. Body fields: providerId, transport, url, headers, etc.',
    inputSchema: Workspace.extend({ connection: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/api/v2/mcp/servers/connect',
        body: input.connection,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_mcp_tools_list',
    title: 'List MCP tools',
    description: 'List the tools discovered across all connected MCP servers.',
    inputSchema: Workspace.extend({
      providerId: z.string().optional(),
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/api/v2/mcp/tools',
        query: { providerId: input.providerId, page: input.page, size: input.size },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_mcp_tool_schema',
    title: 'Get MCP tool schema',
    description: 'Fetch the JSON schema of a single MCP tool.',
    inputSchema: Workspace.extend({ toolId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/api/v2/mcp/tools/${encodeURIComponent(input.toolId)}/schema`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_mcp_tool_execute',
    title: 'Execute MCP tool',
    description: 'Execute a single MCP tool managed by Swfte.',
    inputSchema: Workspace.extend({
      toolId: z.string(),
      args: z.record(z.unknown()).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/api/v2/mcp/tools/${encodeURIComponent(input.toolId)}/execute`,
        body: { args: input.args ?? {} },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_mcp_health_check',
    title: 'MCP health check',
    description: 'Run a health check across connected MCP servers.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/api/v2/mcp/health-check',
        workspaceId: input.workspaceId,
      }),
  },
];
