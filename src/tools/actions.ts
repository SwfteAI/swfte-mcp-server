import { z } from 'zod';
import { ACTION_CAPABILITIES, CatalogRefArg, ENVIRONMENTS } from '../catalog.js';
import { executeAction, getAction, presentAction, proposeAction, targetOf, type ActionRequest } from '../actions.js';
import type { ToolDefinition } from './_types.js';

const ACTION_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED', 'EXPIRED'] as const;

export const actionTools: ToolDefinition[] = [
  {
    name: 'swfte_request_approval',
    title: 'Propose an approval-gated action',
    description:
      `Propose a mutation for human approval (POST /v2/actions). Capabilities: ${ACTION_CAPABILITIES.join(', ')}. ` +
      'Nothing changes until a person approves it in Studio → Actions; then run it with ' +
      'swfte_execute_approved_action. There is intentionally no way to approve from here. Use this for every ' +
      'deploy/host/payments/connect/analytics change made on the user\'s behalf; production requests are the ' +
      'ones reviewers look at hardest, so say why in params where the capability allows it.',
    inputSchema: z.object({
      capability: z.enum(ACTION_CAPABILITIES),
      target: z
        .union([CatalogRefArg, z.object({ kind: z.string().min(1), id: z.string().min(1) })])
        .describe('What the action applies to: a catalogRef ("application:app_1") or {kind, id} (e.g. {kind:"provider", id:"stripe"}).'),
      params: z.record(z.unknown()).optional().describe('Capability parameters (allow-listed per capability by the server).'),
      environment: z.enum(ENVIRONMENTS).optional().describe('Default "development".'),
    }),
    execute: async (input, { client }) => {
      const action = await proposeAction(client, {
        capability: input.capability,
        target: targetOf(input.target),
        params: input.params,
        environment: input.environment ?? 'development',
      });
      return presentAction(action);
    },
  },
  {
    name: 'swfte_execute_approved_action',
    title: 'Execute an approved action',
    destructive: true,
    description:
      'Execute an action a human has approved (POST /v2/actions/{id}/execute). Refusals are explicit, not ' +
      'errors to retry: 409 → blocked NOT_APPROVED (still pending, rejected, or already executed — the current ' +
      'status is included), 410 → blocked EXPIRED (request a new approval). Returns the executed action with ' +
      'secret-looking result fields redacted.',
    inputSchema: z.object({ actionId: z.string().min(1) }),
    execute: async (input, { client }) => {
      const outcome = await executeAction(client, input.actionId);
      if (outcome.executed) return { executed: true, ...presentAction(outcome.action) };
      return { ...outcome, ...(outcome.action ? { action: presentAction(outcome.action) } : {}) };
    },
  },
  {
    name: 'swfte_get_action_status',
    title: 'Check an action request',
    readOnly: true,
    description:
      'Read one action request (GET /v2/actions/{id}) — status, who approved it, expiry, redacted result and the ' +
      'next instruction — or, without actionId, list this workspace\'s actions filtered by status (GET /v2/actions?status=).',
    inputSchema: z.object({
      actionId: z.string().optional(),
      status: z.enum(ACTION_STATUSES).optional().describe('List filter, when actionId is omitted.'),
    }),
    execute: async (input, { client }) => {
      if (input.actionId) return presentAction(await getAction(client, input.actionId));
      const res = await client.request<unknown>({ method: 'GET', path: '/v2/actions', query: { status: input.status } });
      const list: ActionRequest[] = Array.isArray(res)
        ? (res as ActionRequest[])
        : ((res as any)?.items ?? (res as any)?.content ?? (res as any)?.actions ?? []);
      return { count: list.length, actions: list.map(presentAction) };
    },
  },
];
