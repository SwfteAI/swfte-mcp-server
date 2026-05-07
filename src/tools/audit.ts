import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const auditTools: ToolDefinition[] = [
  {
    name: 'swfte_audit_events',
    title: 'List audit events',
    description: 'Query the workspace audit log.',
    inputSchema: Workspace.extend({
      resourceType: z.string().optional(),
      resourceId: z.string().optional(),
      action: z.string().optional(),
      from: z.string().optional().describe('ISO-8601 timestamp.'),
      to: z.string().optional().describe('ISO-8601 timestamp.'),
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/audit/events',
        query: {
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          action: input.action,
          from: input.from,
          to: input.to,
          page: input.page,
          size: input.size,
        },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_audit_resource_events',
    title: 'List events for a resource',
    description: 'List audit events scoped to a single resource.',
    inputSchema: Workspace.extend({
      resourceType: z.string(),
      resourceId: z.string(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/audit/events/${encodeURIComponent(input.resourceType)}/${encodeURIComponent(input.resourceId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_audit_my_events',
    title: 'My audit events',
    description: 'List audit events triggered by the calling principal.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/audit/events/me',
        workspaceId: input.workspaceId,
      }),
  },
];
