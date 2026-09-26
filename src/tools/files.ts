import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { assertLocalFilesystem, assertSafeName, confineReadableFile } from '../fsguard.js';
import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const fileTools: ToolDefinition[] = [
  {
    name: 'swfte_files_upload',
    title: 'Upload a file',
    description:
      'Upload a local file to the workspace and return its file record. The `id` in that record is ' +
      'what swfte_datasets_documents_create takes as fileId — a dataset document is always backed by ' +
      'an uploaded file, so this is the first half of every "add knowledge" flow.',
    inputSchema: Workspace.extend({
      path: z.string().describe('Path to the local file to upload, inside the project directory the server runs in. Not available on a hosted server.'),
      name: z.string().optional().describe('Name to store it under. Defaults to the file basename.'),
      mimeType: z
        .string()
        .optional()
        .describe('Content type of the part. Defaults to application/octet-stream.'),
    }),
    execute: async (input, { client, localFilesystem }) => {
      assertLocalFilesystem(
        localFilesystem,
        'swfte_files_upload',
        'To add text to a dataset from a hosted server, pass it inline as documents[].text to swfte_knowledge_build.'
      );
      const file = confineReadableFile(input.path);
      if (input.name !== undefined) assertSafeName(input.name, 'File name');
      // Copy into a tight Uint8Array: readFileSync hands back a Buffer that may
      // sit in a larger pooled ArrayBuffer, and Blob would upload the slack.
      const bytes = new Uint8Array(readFileSync(file));

      const form = new FormData();
      form.append(
        'file',
        new Blob([bytes], { type: input.mimeType ?? 'application/octet-stream' }),
        input.name ?? basename(file)
      );

      return client.postMultipart('/api/v2/files/upload', form, {
        workspaceId: input.workspaceId,
      });
    },
  },
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
