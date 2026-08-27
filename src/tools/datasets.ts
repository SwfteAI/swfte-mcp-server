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
    description: 'Create a RAG dataset to hold documents for retrieval. Enum-valued fields must be UPPERCASE on the wire or the API rejects the body as malformed.',
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
    title: 'Add a document to a dataset',
    description:
      'Register ONE already-uploaded file as a document inside a dataset. Upload the file with ' +
      'swfte_files_upload first and pass the id it returns as fileId — the endpoint has no raw-text ' +
      'or URL path, fileId is required. Call once per document.',
    inputSchema: Workspace.extend({
      datasetId: z.string(),
      fileId: z.string().describe('The id returned by swfte_files_upload.'),
      name: z.string().describe('Display name for the document.'),
      dataSourceType: z.string().optional().describe("Defaults to 'upload_file'."),
      docType: z.string().optional(),
      docLanguage: z.string().optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/api/v2/datasets/${encodeURIComponent(input.datasetId)}/documents`,
        // datasetId is repeated in the body: the controller reads it from there,
        // not from the path, and rejects the call without it.
        body: {
          datasetId: input.datasetId,
          fileId: input.fileId,
          name: input.name,
          dataSourceType: input.dataSourceType ?? 'upload_file',
          docType: input.docType,
          docLanguage: input.docLanguage,
        },
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
