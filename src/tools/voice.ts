import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const voiceTools: ToolDefinition[] = [
  {
    name: 'swfte_voice_calls_list',
    title: 'List voice calls',
    description: 'List voice calls in the workspace, optionally filtered by chatflow or agent.',
    inputSchema: Workspace.extend({
      chatFlowId: z.string().optional(),
      agentId: z.string().optional(),
      page: z.number().int().min(0).optional(),
      size: z.number().int().min(1).max(100).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/voice/calls',
        query: {
          chatFlowId: input.chatFlowId,
          agentId: input.agentId,
          page: input.page,
          size: input.size,
        },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_voice_calls_in_progress',
    title: 'List in-progress voice calls',
    description: 'List voice calls that are currently active.',
    inputSchema: Workspace,
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v2/voice/calls/in-progress',
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_voice_call_get',
    title: 'Get voice call',
    description: 'Fetch a voice call by Twilio SID.',
    inputSchema: Workspace.extend({ callSid: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/voice/calls/${encodeURIComponent(input.callSid)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_voice_call_transcript',
    title: 'Get voice call transcript',
    description: 'Fetch the transcript for a voice call.',
    inputSchema: Workspace.extend({ callSid: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/voice/calls/${encodeURIComponent(input.callSid)}/transcript`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_voice_call_recording',
    title: 'Get voice call recording',
    description: 'Fetch the recording metadata (and signed URL) for a voice call.',
    inputSchema: Workspace.extend({ callSid: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v2/voice/calls/${encodeURIComponent(input.callSid)}/recording`,
        workspaceId: input.workspaceId,
      }),
  },
];
