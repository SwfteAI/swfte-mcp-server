import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const Workspace = z.object({ workspaceId: z.string().optional() });

export const relayRunTools: ToolDefinition[] = [
  {
    name: 'swfte_relay_runs_list',
    title: 'List relay runs',
    description: 'List Relay runs (agent chats, journey workflow executions, and worker runs) in the workspace, newest first. Pass journeyTemplateId to scope to one journey\'s runs — this is the conversation-level data backing the Relay kanban board.',
    inputSchema: Workspace.extend({
      limit: z.number().int().min(1).max(500).optional(),
      journeyTemplateId: z.string().optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: '/v1/relay/runs',
        query: { limit: input.limit, journeyTemplateId: input.journeyTemplateId },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_relay_runs_get',
    title: 'Get relay run',
    description: 'Fetch a single Relay run\'s status, current step, pending gate (if paused for approval), and takeover state.',
    inputSchema: Workspace.extend({ runId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v1/relay/runs/${encodeURIComponent(input.runId)}`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_relay_runs_snapshot',
    title: 'Get relay run conversation snapshot',
    description: 'Fetch a run\'s conversation-centric snapshot: participant/agent identity, captured fields with confidence and validation state, completion/score, related documents, and the message transcript.',
    inputSchema: Workspace.extend({ runId: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `/v1/relay/runs/${encodeURIComponent(input.runId)}/snapshot`,
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_relay_runs_cancel',
    title: 'Cancel relay run',
    description: 'Cancel/kill a running Relay run. Routed by kind: WORKER runs are killed, WORKFLOW runs (journey executions) are cancelled. Requires the relay-operator role.',
    inputSchema: Workspace.extend({
      runId: z.string(),
      reason: z.string().optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v1/relay/runs/${encodeURIComponent(input.runId)}/cancel`,
        body: { reason: input.reason },
        workspaceId: input.workspaceId,
      }),
  },
  {
    name: 'swfte_relay_runs_gate_decide',
    title: 'Resolve a paused relay gate',
    description: 'Approve, deny, or edit-and-approve a pending human-in-the-loop gate that paused a run before a gated tool call. Requires the relay-operator role and per-run workspace scope. Idempotent — resolving an already-decided gate returns the prior decision.',
    inputSchema: Workspace.extend({
      runId: z.string(),
      gateRequestId: z.string(),
      decision: z.enum(['APPROVE', 'DENY', 'EDIT']),
      editedPayload: z.record(z.unknown()).optional().describe('Required when decision is EDIT — the replacement action payload.'),
      note: z.string().optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `/v1/relay/runs/${encodeURIComponent(input.runId)}/gate/${encodeURIComponent(input.gateRequestId)}`,
        body: { decision: input.decision, editedPayload: input.editedPayload, note: input.note },
        workspaceId: input.workspaceId,
      }),
  },
];
