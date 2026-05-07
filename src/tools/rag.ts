import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const ragTools: ToolDefinition[] = [
  {
    name: 'swfte_rag_search',
    title: 'Hybrid RAG search',
    description:
      'Run a hybrid (semantic + BM25) retrieval search across one or more datasets and return scored chunks.',
    inputSchema: Workspace.extend({
      query: z.string().min(1),
      datasetIds: z.array(z.string()).min(1),
      topK: z.number().int().min(1).max(100).optional(),
      strategy: z.string().optional(),
      filters: z.record(z.unknown()).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/rag/search',
        body: {
          query: input.query,
          datasetIds: input.datasetIds,
          topK: input.topK ?? 8,
          strategy: input.strategy,
          filters: input.filters,
        },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_rag_rerank',
    title: 'Rerank documents',
    description: 'Rerank a set of candidate documents against a query using the configured reranker model.',
    inputSchema: Workspace.extend({
      query: z.string().min(1),
      documents: z.array(z.string()).min(1),
      topK: z.number().int().min(1).max(100).optional(),
      model: z.string().optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/rag/rerank',
        body: { query: input.query, documents: input.documents, topK: input.topK, model: input.model },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_rag_models_embeddings',
    title: 'List embedding models',
    description: 'List the embedding models available in this workspace.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/rag/models/embeddings',
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_rag_models_rerankers',
    title: 'List reranker models',
    description: 'List the reranker models available in this workspace.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/rag/models/rerankers',
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_rag_strategies',
    title: 'List retrieval strategies',
    description: 'List supported retrieval strategies (e.g. dense-only, hybrid, late-interaction).',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: '/v2/rag/strategies', workspaceId: input.workspaceId }),
  },
];
