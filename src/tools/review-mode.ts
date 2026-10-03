import { z } from 'zod';
import { SwfteApiError } from '../client.js';
import type { ToolDefinition } from './_types.js';

/**
 * Review mode from an MCP client (owner decision D-REVIEW-MODE).
 *
 * A stakeholder reviews a workflow without editing it. These six tools drive the same review session Studio shows. They
 * are read-only on the artifact: nothing here can reach an artifact write route. A token may start a review, run a
 * Copilot check in the Sandbox (the result is a suggestion until a person confirms it) and record a finding. It may not
 * confirm a check, request changes or accept a risk. Sign-off is the one decision a token may make, and only a token its
 * owner granted the `review:signoff` scope: without it the tool returns NEEDS_INTERACTIVE_SESSION and a Studio link.
 */

const hash = z.string().length(71).regex(/^sha256:[0-9a-f]{64}$/, 'An exact canonical content hash is required.');
const identity = z.string().min(1).max(512).refine(v => v.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(v), 'A bounded nonblank identity without controls is required.');
const reviewId = z.string().regex(/^rv_[0-9a-f]{12}$/, 'A review id looks like rv_ followed by twelve hex characters.');
const itemId = z.string().regex(/^item_[0-9]{1,3}$/, 'A check id looks like item_1.');
const KINDS = ['workflow', 'agent', 'chatflow', 'model', 'application', 'widget', 'studio-change'] as const;

const base = '/v2/review/sessions';
const sessionPath = (id: string) => `${base}/${encodeURIComponent(id)}`;

type Json = Record<string, any>;

/** Same exact-packet link pattern the review room already uses, with the review id added. */
export function reviewHref(kind: string, artifactId: string, contentHash: string, review: string, actionId?: string | null): string {
  const url = new URL(process.env.SWFTE_STUDIO_URL ?? 'https://studio.swfte.com');
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Invalid Studio URL');
  }
  url.pathname = `/v2/studio/review/${encodeURIComponent(kind)}/${encodeURIComponent(artifactId)}`;
  if (actionId) url.searchParams.set('action', actionId);
  url.searchParams.set('hash', contentHash);
  url.searchParams.set('review', review);
  return url.toString();
}

const counts = (s: Json) => s.counts ?? {};

export const reviewModeTools: ToolDefinition[] = [
  {
    name: 'swfte_review_start', title: 'Start a review',
    description: 'Start a review of one exact version of a workflow, agent, chatflow, model, application, widget or Studio change, as a stakeholder who is not designing it. '
      + 'The review is pinned to the content hash; while it is open the reviewer cannot edit the artifact (the server refuses edits), and it goes stale if anyone changes the artifact. '
      + 'role defaults to general; compliance, security, product-owner and finance are Enterprise. Read-only on the artifact.',
    group: 'review',
    inputSchema: z.object({ kind: z.enum(KINDS), artifactId: identity, contentHash: hash, role: z.enum(['general', 'compliance', 'security', 'product-owner', 'finance']).optional(), actionId: identity.optional() }).strict(),
    execute: async (input, { client }) => {
      const s = await client.request<Json>({ method: 'POST', path: base, body: input, expectStatuses: [200, 201], retries: 0 });
      return { reviewId: s.id, status: s.status, artifactReadOnly: s.artifactReadOnly === true, role: s.role, items: Array.isArray(s.items) ? s.items.length : 0, pinned: { version: s.version, contentHash: s.contentHash, ...(s.planHash ? { planHash: s.planHash } : {}) } };
    },
  },
  {
    name: 'swfte_review_items', title: 'List the checks of a review', readOnly: true, group: 'review',
    description: 'List the checks of a review with their confirmed status, any suggestion from the Copilot or a token, and the evidence each rests on.',
    inputSchema: z.object({ reviewId }).strict(),
    execute: async (input, { client }) => {
      const r = await client.request<Json>({ method: 'GET', path: `${sessionPath(input.reviewId)}/items`, headers: { 'Cache-Control': 'no-store' }, retries: 1 });
      return (r.items ?? []).map((i: Json) => ({ id: i.id, title: i.title, status: i.status, ...(i.suggestion ? { suggested: i.suggestion.result } : {}), evidence: i.evidence ?? [] }));
    },
  },
  {
    name: 'swfte_review_check', title: 'Run one check with evidence', group: 'review',
    description: 'Ask the review Copilot to check one item. It runs with read-only tools (inspect a step, list connections, run a check in the Sandbox, fetch evidence) and must cite evidence it read; '
      + 'an answer with no real evidence comes back as NEEDS_INFO. The result is recorded as a SUGGESTION: only a person confirms it in Studio. Reads the artifact, never changes it.',
    inputSchema: z.object({ reviewId, itemId, question: z.string().min(1).max(500).optional() }).strict(),
    execute: async (input, { client }) => {
      const s = await client.request<Json>({ method: 'POST', path: `${sessionPath(input.reviewId)}/items/${encodeURIComponent(input.itemId)}/check`, body: input.question ? { question: input.question } : {}, retries: 0 });
      const item = (s.items ?? []).find((i: Json) => i.id === input.itemId) ?? {};
      const sg = item.suggestion ?? {};
      return { itemId: input.itemId, suggested: sg.result ?? null, recorded: 'SUGGESTION_ONLY', reason: sg.reason ?? null, evidence: sg.evidence ?? [] };
    },
  },
  {
    name: 'swfte_review_finding', title: 'Record a finding', group: 'review',
    description: 'Record a finding against one check: what is wrong and how severe. A finding is a recorded fact that waits for a person, who decides to request changes or accept the risk in Studio. This tool decides nothing.',
    inputSchema: z.object({ reviewId, itemId, severity: z.enum(['LOW', 'MEDIUM', 'HIGH']), note: z.string().min(1).max(1000) }).strict(),
    execute: async (input, { client }) => {
      const s = await client.request<Json>({ method: 'POST', path: `${sessionPath(input.reviewId)}/findings`, body: { itemId: input.itemId, severity: input.severity, note: input.note }, expectStatuses: [200, 201], retries: 0 });
      const f = [...(s.findings ?? [])].reverse().find((x: Json) => x.itemId === input.itemId) ?? {};
      return { findingId: f.id, itemId: input.itemId, severity: f.severity ?? input.severity, status: f.status ?? 'WAITING_FOR_A_PERSON', needsHuman: ['request_changes', 'accept_risk'] };
    },
  },
  {
    name: 'swfte_review_signoff', title: 'Sign off a review', group: 'review',
    description: 'Sign off a review, bound to the exact content hash (and release plan hash) it is pinned to, through the approval system. A person can always sign off in Studio. '
      + 'A token can only when its owner explicitly granted it the review:signoff scope (off by default, audited); it then counts as that owner, once, in the quorum. '
      + 'Without the scope this returns status NEEDS_INTERACTIVE_SESSION and a Studio link, and signs nothing. All checks must be resolved first.',
    inputSchema: z.object({ reviewId, expectedContentHash: hash.optional(), expectedPlanHash: hash.optional(), note: z.string().max(1000).optional(), acknowledged: z.boolean().optional() }).strict(),
    execute: async (input, { client }) => {
      const session = await client.request<Json>({ method: 'GET', path: sessionPath(input.reviewId), headers: { 'Cache-Control': 'no-store' }, retries: 1 });
      if (input.expectedContentHash && input.expectedContentHash !== session.contentHash) {
        throw new SwfteApiError({ status: 409, code: 'STALE_CONTENT', message: 'The content hash you named is not the one this review is pinned to.', method: 'POST', path: `${sessionPath(input.reviewId)}/signoff` });
      }
      if (input.expectedPlanHash && input.expectedPlanHash !== session.planHash) {
        throw new SwfteApiError({ status: 409, code: 'STALE_PLAN', message: 'The plan hash you named is not the one this review is pinned to.', method: 'POST', path: `${sessionPath(input.reviewId)}/signoff` });
      }
      const body = { expectedContentHash: session.contentHash, ...(session.planHash ? { expectedPlanHash: session.planHash } : {}), ...(input.note ? { note: input.note } : {}), acknowledged: input.acknowledged === true };
      try {
        const r = await client.request<Json>({ method: 'POST', path: `${sessionPath(input.reviewId)}/signoff`, body, retries: 0 });
        return {
          status: r.status, reviewId: input.reviewId, signedBy: { user: r.signedBy?.user, via: r.signedBy?.via ?? 'token', scope: 'review:signoff' },
          actionId: r.actionId, contentHash: session.contentHash, ...(session.planHash ? { planHash: session.planHash } : {}),
          quorum: { required: r.quorum?.required, distinctPeople: r.quorum?.signed, countedAs: r.signedBy?.user, waitingFor: Math.max(0, (r.quorum?.required ?? 1) - (r.quorum?.signed ?? 0)) },
        };
      } catch (err) {
        if (err instanceof SwfteApiError && ['NEEDS_INTERACTIVE_SESSION', 'APPROVAL_REQUIRES_SESSION', 'INTERACTIVE_SESSION_REQUIRED'].includes(err.code)) {
          return {
            status: 'NEEDS_INTERACTIVE_SESSION', reason: 'This token was not granted review:signoff, so sign-off is a person signing in Studio.',
            openItems: (session.items ?? []).filter((i: Json) => !['PASSED', 'ACCEPTED_RISK'].includes(i.status)).length,
            ...(session.actionId ? { actionId: session.actionId } : {}), contentHash: session.contentHash,
            url: reviewHref(session.kind, session.artifactId, session.contentHash, input.reviewId, session.actionId),
          };
        }
        throw err;
      }
    },
  },
  {
    name: 'swfte_review_status', title: 'Read the status of a review', readOnly: true, group: 'review',
    description: 'Read where a review stands: open, stale, how many checks are passed, failed, need information or are not checked, what blocks sign-off, and the quorum.',
    inputSchema: z.object({ reviewId }).strict(),
    execute: async (input, { client }) => {
      const s = await client.request<Json>({ method: 'GET', path: `${sessionPath(input.reviewId)}/status`, headers: { 'Cache-Control': 'no-store' }, retries: 1 });
      return { reviewId: input.reviewId, status: s.status, stale: s.stale === true, items: counts({ counts: s.items }), signoff: s.signoff, quorum: s.quorum };
    },
  },
];
