import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({
  workspaceId: z.string().optional(),
});

export const chatFlowTools: ToolDefinition[] = [
  {
    name: 'swfte_chatflows_list',
    title: 'List chatflows',
    description: 'List chatflows in the workspace.',
    inputSchema: Workspace.extend({
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/chatflows',
        query: { page: input.page, size: input.size },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_get',
    title: 'Get chatflow',
    description: 'Fetch a chatflow definition by ID.',
    inputSchema: Workspace.extend({ chatFlowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/chatflows/${encodeURIComponent(input.chatFlowId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_create',
    title: 'Create chatflow',
    description: 'Create a new chatflow definition.',
    inputSchema: Workspace.extend({ chatFlow: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: '/v2/chatflows',
        body: input.chatFlow,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_validate',
    title: 'Validate chatflow definition',
    description: 'Validate a chatflow without persisting changes.',
    inputSchema: Workspace.extend({ chatFlowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/chatflows/${encodeURIComponent(input.chatFlowId)}/validate`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_deploy',
    title: 'Deploy chatflow',
    description: 'Deploy a chatflow so live sessions can use it.',
    inputSchema: Workspace.extend({ chatFlowId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/chatflows/${encodeURIComponent(input.chatFlowId)}/deploy`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_publish',
    title: 'Publish chatflow as widget',
    description: 'Publish a chatflow and produce a Swfte Widget configuration usable by the chat-flow widget SDK.',
    inputSchema: Workspace.extend({
      chatFlowId: z.string(),
      publishConfig: z.record(z.unknown()).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/chatflows/${encodeURIComponent(input.chatFlowId)}/publish`,
        body: input.publishConfig ?? {},
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_session_start',
    title: 'Start a chatflow session',
    description: 'Start a new conversational session for a deployed chatflow.',
    inputSchema: Workspace.extend({
      chatFlowId: z.string(),
      channel: z.enum(['WEB_CHAT', 'WHATSAPP', 'TELEGRAM', 'VOICE', 'WIDGET']).optional(),
      userId: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v2/chatflows/${encodeURIComponent(input.chatFlowId)}/sessions`,
        body: { channel: input.channel ?? 'WEB_CHAT', userId: input.userId, metadata: input.metadata },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_session_get',
    title: 'Get chatflow session',
    description: 'Fetch the state of a chatflow session.',
    inputSchema: Workspace.extend({ sessionId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/chatflows/sessions/${encodeURIComponent(input.sessionId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_chatflows_builder_templates',
    title: 'List chatflow builder templates',
    description: 'List the chatflow templates available in the builder.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/chatflows/builder/templates',
        workspaceId: input.workspaceId,
      }),
  },
];
