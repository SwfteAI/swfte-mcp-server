import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const conversationTools: ToolDefinition[] = [
  {
    name: 'swfte_conversations_initiate',
    title: 'Initiate a conversation',
    description: 'Initiate a (potentially multi-channel) conversation with an agent.',
    inputSchema: Workspace.extend({ initiate: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/conversations/initiate',
        body: input.initiate,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_conversations_list',
    title: 'List conversations',
    description: 'List conversations in the workspace, optionally filtered.',
    inputSchema: Workspace.extend({
      status: z.string().optional(),
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/conversations',
        query: { status: input.status, page: input.page, size: input.size },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_conversations_get',
    title: 'Get conversation',
    description: 'Get the status of a conversation.',
    inputSchema: Workspace.extend({ conversationId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/conversations/${encodeURIComponent(input.conversationId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_conversations_transcript',
    title: 'Get conversation transcript',
    description: 'Fetch the transcript of a conversation.',
    inputSchema: Workspace.extend({ conversationId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/conversations/${encodeURIComponent(input.conversationId)}/transcript`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_conversations_terminate',
    title: 'Terminate conversation',
    description: 'Terminate an active conversation early.',
    inputSchema: Workspace.extend({ conversationId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/conversations/${encodeURIComponent(input.conversationId)}/terminate`,
        workspaceId: input.workspaceId,
      }),
  },
];
