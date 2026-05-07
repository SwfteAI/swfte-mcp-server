import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const fileTools: ToolDefinition[] = [
  {
    name: 'swfte_files_list',
    title: 'List files',
    description: 'List files uploaded to the workspace.',
    inputSchema: Workspace.extend({
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/api/v2/files',
        query: { page: input.page, size: input.size },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_files_config',
    title: 'Get file upload config',
    description: 'Get the upload configuration (max sizes, allowed mime types, presign URL pattern).',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/api/v2/files/config',
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_files_get',
    title: 'Get file metadata',
    description: 'Fetch the metadata of a single file.',
    inputSchema: Workspace.extend({ fileId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/api/v2/files/${encodeURIComponent(input.fileId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_files_delete',
    title: 'Delete file',
    description: 'Delete a file from the workspace.',
    inputSchema: Workspace.extend({ fileId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'DELETE',
        path: `/api/v2/files/${encodeURIComponent(input.fileId)}`,
        workspaceId: input.workspaceId,
      }),
  },
];
