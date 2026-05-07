import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({
  workspaceId: z.string().optional().describe('Workspace ID. Falls back to SWFTE_WORKSPACE_ID env var.'),
});

export const agentTools: ToolDefinition[] = [
  {
    name: 'swfte_agents_list',
    title: 'List agents',
    description: 'List all agents in a Swfte workspace.',
    inputSchema: Workspace.extend({
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/agents',
        query: { page: input.page, size: input.size },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_agents_get',
    title: 'Get agent',
    description: 'Fetch a single agent by ID.',
    inputSchema: Workspace.extend({ agentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/agents/${encodeURIComponent(input.agentId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_agents_create',
    title: 'Create agent',
    description:
      'Create a new agent. The body is the full agent JSON — see https://www.swfte.com/developers for the schema.',
    inputSchema: Workspace.extend({ agent: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/agents',
        body: input.agent,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_agents_update',
    title: 'Update agent (partial)',
    description: 'Partially update an existing agent.',
    inputSchema: Workspace.extend({ agentId: z.string(), patch: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'PATCH',
        path: `/v2/agents/${encodeURIComponent(input.agentId)}`,
        body: input.patch,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_agents_delete',
    title: 'Delete agent',
    description: 'Delete an agent. Irreversible.',
    inputSchema: Workspace.extend({ agentId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'DELETE',
        path: `/v2/agents/${encodeURIComponent(input.agentId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_agents_wizard_generate',
    title: 'Generate agent from prompt (wizard)',
    description: 'Use the AI agent wizard to generate a draft agent from a natural-language prompt.',
    inputSchema: Workspace.extend({
      prompt: z.string().min(1).describe('What the agent should do, in plain English.'),
      template: z.string().optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/agents/wizard/generate',
        body: { prompt: input.prompt, template: input.template },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_agents_wizard_quick',
    title: 'Quick-create agent (wizard, no review)',
    description: 'Generate AND persist an agent from a prompt in a single call.',
    inputSchema: Workspace.extend({ prompt: z.string().min(1) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/agents/wizard/quick',
        body: { prompt: input.prompt },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_agents_wizard_templates',
    title: 'List agent wizard templates',
    description: 'List the available agent templates the wizard can use as a starting point.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/agents/wizard/templates',
        workspaceId: input.workspaceId,
      }),
  },
];
