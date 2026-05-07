import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const costControlTools: ToolDefinition[] = [
  {
    name: 'swfte_cost_routing_rules_list',
    title: 'List cost routing rules',
    description: 'List provider/model routing rules for the workspace.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/cost-control/routing-rules',
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_cost_routing_rule_create',
    title: 'Create cost routing rule',
    description: 'Create a new model-routing rule for cost / latency / fail-over policy.',
    inputSchema: Workspace.extend({ rule: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/cost-control/routing-rules',
        body: input.rule,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_cost_usage_caps_list',
    title: 'List usage caps',
    description: 'List configured spend caps for the workspace and per-model.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/cost-control/usage-caps',
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_cost_usage_cap_workspace_set',
    title: 'Set workspace usage cap',
    description: 'Set or update the workspace-wide spend cap.',
    inputSchema: Workspace.extend({ cap: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'PUT',
        path: '/v2/cost-control/usage-caps/workspace',
        body: input.cap,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_cost_usage_stats',
    title: 'Usage stats',
    description: 'Read aggregated usage statistics for the workspace.',
    inputSchema: Workspace.extend({
      from: z.string().optional(),
      to: z.string().optional(),
      groupBy: z.enum(['model', 'agent', 'workflow', 'day']).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/cost-control/usage-stats',
        query: { from: input.from, to: input.to, groupBy: input.groupBy },
        workspaceId: input.workspaceId,
      }),
  },
];
