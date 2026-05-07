import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const marketplaceTools: ToolDefinition[] = [
  {
    name: 'swfte_marketplace_browse',
    title: 'Browse marketplace',
    description:
      'Browse modules, agents and workflows published to the Swfte marketplace at https://www.swfte.com/marketplace.',
    inputSchema: Workspace.extend({
      query: z.string().optional(),
      category: z.string().optional(),
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/marketplace',
        query: { query: input.query, category: input.category, page: input.page, size: input.size },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_marketplace_get',
    title: 'Get marketplace publication',
    description: 'Fetch details of a single marketplace publication.',
    inputSchema: Workspace.extend({ publicationId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/marketplace/${encodeURIComponent(input.publicationId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_marketplace_install',
    title: 'Install marketplace item',
    description: 'Install a marketplace publication into the current workspace.',
    inputSchema: Workspace.extend({
      publicationId: z.string(),
      config: z.record(z.unknown()).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/marketplace/${encodeURIComponent(input.publicationId)}/install`,
        body: input.config ?? {},
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_marketplace_installations',
    title: 'List installations',
    description: 'List marketplace publications installed in the workspace.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/marketplace/installations',
        workspaceId: input.workspaceId,
      }),
  },
];
