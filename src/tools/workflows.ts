import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const workflowTools: ToolDefinition[] = [
  {
    name: 'swfte_workflows_list',
    title: 'List workflows',
    description: 'List workflows in the workspace.',
    inputSchema: Workspace.extend({
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/workflows',
        query: { page: input.page, size: input.size },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_get',
    title: 'Get workflow',
    description: 'Fetch a workflow by ID.',
    inputSchema: Workspace.extend({ workflowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_create',
    title: 'Create workflow',
    description: 'Create a new workflow.',
    inputSchema: Workspace.extend({ workflow: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/workflows',
        body: input.workflow,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_validate',
    title: 'Validate workflow JSON',
    description: 'Validate a workflow definition without persisting it.',
    inputSchema: Workspace.extend({ workflow: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/workflows/validate',
        body: input.workflow,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_clone',
    title: 'Clone workflow',
    description: 'Clone an existing workflow into a new one.',
    inputSchema: Workspace.extend({ workflowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}/clone`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_workflows_export',
    title: 'Export workflow JSON',
    description: 'Export a workflow as a portable JSON document.',
    inputSchema: Workspace.extend({ workflowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/workflows/${encodeURIComponent(input.workflowId)}/export`,
        workspaceId: input.workspaceId,
      }),
  },
];
