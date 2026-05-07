import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const datasetTools: ToolDefinition[] = [
  {
    name: 'swfte_datasets_list',
    title: 'List datasets',
    description: 'List RAG datasets in the workspace.',
    inputSchema: Workspace.extend({
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/api/v2/datasets',
        query: { page: input.page, size: input.size },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_datasets_get',
    title: 'Get dataset',
    description: 'Fetch a dataset and its configuration.',
    inputSchema: Workspace.extend({ datasetId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/api/v2/datasets/${encodeURIComponent(input.datasetId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_datasets_create',
    title: 'Create dataset',
    description: 'Create a new RAG dataset.',
    inputSchema: Workspace.extend({ dataset: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/api/v2/datasets',
        body: input.dataset,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_datasets_documents_list',
    title: 'List documents in a dataset',
    description: 'List documents that belong to a dataset.',
    inputSchema: Workspace.extend({
      datasetId: z.string(),
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/api/v2/datasets/${encodeURIComponent(input.datasetId)}/documents`,
        query: { page: input.page, size: input.size },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_datasets_documents_create',
    title: 'Add documents to dataset',
    description:
      'Create one or more documents inside a dataset. Documents can come from URLs, raw text, or file IDs uploaded via swfte_files_upload.',
    inputSchema: Workspace.extend({
      datasetId: z.string(),
      documents: z.array(z.record(z.unknown())),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/api/v2/datasets/${encodeURIComponent(input.datasetId)}/documents`,
        body: { documents: input.documents },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_datasets_documents_status',
    title: 'Document processing status',
    description: 'Check the processing/embedding status of documents in a dataset.',
    inputSchema: Workspace.extend({ datasetId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/api/v2/datasets/${encodeURIComponent(input.datasetId)}/documents/processing-status`,
        workspaceId: input.workspaceId,
      }),
  },
];
