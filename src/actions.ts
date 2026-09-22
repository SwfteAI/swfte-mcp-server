/**
 * Approval-gated actions (`/v2/actions`).
 *
 * Every mutation the MCP proposes on a customer's behalf — deploy, host, enable
 * payments, start a connection, enable analytics — goes through an
 * ActionRequest: proposed here, approved by a human in Studio, executed only
 * once approved. The MCP deliberately exposes no approve call: an agent that
 * can approve its own proposal has no approval step at all.
 */
import { SwfteApiError, type SwfteClient } from './client.js';
import { parseCatalogRef, type ActionCapability } from './catalog.js';

export interface ActionRequest {
  id: string;
  capability: string;
  target: { kind: string; id: string };
  params: Record<string, unknown>;
  environment: string;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'FAILED' | 'EXPIRED';
  requiresApproval: boolean;
  requestedBy?: string;
  approvedBy?: string | null;
  expiresAt?: string;
  result?: Record<string, unknown> | null;
  createdAt?: string;
}

const SECRET_KEYS = /(secret|token|password|credential|private|apikey|api_key)/i;

/**
 * Strip secret-looking fields from an action result before it reaches the
 * model's context. Publishable values (app keys, URLs, ids) pass through.
 */
export function redactResult(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactResult(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(k) && typeof v === 'string' && !v.startsWith('swfte_pk_')) out[k] = '[redacted — retrieve it in Studio]';
    else out[k] = redactResult(v, depth + 1);
  }
  return out;
}

export function targetOf(target: string | { kind: string; id: string }): { kind: string; id: string } {
  if (typeof target !== 'string') return target;
  const r = parseCatalogRef(target);
  return { kind: r.kind, id: r.id };
}

export function proposeAction(
  client: SwfteClient,
  body: { capability: ActionCapability; target: { kind: string; id: string }; params?: Record<string, unknown>; environment: string }
): Promise<ActionRequest> {
  return client.request<ActionRequest>({
    method: 'POST',
    path: '/v2/actions',
    body: { capability: body.capability, target: body.target, params: body.params ?? {}, environment: body.environment },
    expectStatuses: [200, 201, 202],
    // A duplicate proposal is a second item in someone's approval queue.
    retries: 0,
  });
}

export function getAction(client: SwfteClient, id: string): Promise<ActionRequest> {
  return client.request<ActionRequest>({ method: 'GET', path: `/v2/actions/${encodeURIComponent(id)}` });
}

export type ExecuteOutcome =
  | { executed: true; action: ActionRequest }
  | { executed: false; blocked: 'NOT_APPROVED' | 'EXPIRED'; status: number; message: string; nextStep: string; action?: ActionRequest };

/** Execute an approved action; 409 and 410 come back as explicit outcomes, not generic errors. */
export async function executeAction(client: SwfteClient, id: string): Promise<ExecuteOutcome> {
  try {
    const action = await client.request<ActionRequest>({
      method: 'POST',
      path: `/v2/actions/${encodeURIComponent(id)}/execute`,
      expectStatuses: [200, 201, 202],
      retries: 0,
      timeoutMs: 180_000,
    });
    return { executed: true, action };
  } catch (err) {
    if (err instanceof SwfteApiError && err.status === 409) {
      const action = await getAction(client, id).catch(() => undefined);
      return {
        executed: false,
        blocked: 'NOT_APPROVED',
        status: 409,
        message: `Action ${id} is not approved${action ? ` (status ${action.status})` : ''}; the server refused to execute it.`,
        nextStep:
          action?.status === 'REJECTED'
            ? 'A reviewer rejected it. Do not re-propose the same change without addressing why.'
            : action?.status === 'EXECUTED'
              ? 'It has already been executed; read its result with swfte_get_action_status.'
              : 'Ask a human to approve it in Studio → Actions, then call swfte_execute_approved_action again. Do not try to approve it yourself.',
        ...(action ? { action } : {}),
      };
    }
    if (err instanceof SwfteApiError && err.status === 410) {
      return {
        executed: false,
        blocked: 'EXPIRED',
        status: 410,
        message: `Action ${id} expired before it was executed.`,
        nextStep: 'Request a fresh approval with swfte_request_approval; an expired approval cannot be revived.',
      };
    }
    throw err;
  }
}

export function approvalInstructions(action: ActionRequest): string {
  switch (action.status) {
    case 'PROPOSED':
      return action.requiresApproval
        ? `Pending human approval. Ask the user to approve action ${action.id} (${action.capability} on ${action.target.kind}:${action.target.id}, ${action.environment}) in Studio → Actions` +
            `${action.expiresAt ? ` before ${action.expiresAt}` : ''}, then call swfte_execute_approved_action {actionId:"${action.id}"}.`
        : `No approval required; call swfte_execute_approved_action {actionId:"${action.id}"} to run it.`;
    case 'APPROVED':
      return `Approved${action.approvedBy ? ` by ${action.approvedBy}` : ''}. Call swfte_execute_approved_action {actionId:"${action.id}"}.`;
    case 'EXECUTED':
      return 'Executed. The result is attached.';
    case 'REJECTED':
      return 'Rejected by a reviewer. Do not re-propose the same change without addressing the reason.';
    case 'EXPIRED':
      return 'Expired. Request a fresh approval.';
    case 'FAILED':
      return 'Execution failed; read result for the reason before retrying.';
    default:
      return `Status ${String(action.status)}.`;
  }
}

/** Shape an action for the model: redacted result plus the one instruction that matters next. */
export function presentAction(action: ActionRequest) {
  return {
    actionId: action.id,
    capability: action.capability,
    target: action.target,
    environment: action.environment,
    status: action.status,
    requiresApproval: action.requiresApproval,
    approvedBy: action.approvedBy ?? null,
    expiresAt: action.expiresAt ?? null,
    result: redactResult(action.result ?? null),
    instructions: approvalInstructions(action),
  };
}
