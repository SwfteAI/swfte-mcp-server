/**
 * Learning-loop tools (brief 08).
 *
 * Section 1 (this package): the two review-queue tools, shaped after gpu-deploy-mcp's `submit_outcome` and
 * `propose_rule` — a body built field by field from typed inputs, one POST, the backend's answer returned
 * as-is. Each creates a review-queue entry and nothing else: a human reviews it, and it never changes an
 * evidence level or counts as evidence (only an Archivist replay in a fresh sandbox promotes anything).
 *
 * Recipe tools live in recipes.ts and are registered by tools/index.ts.
 */
import { z } from 'zod';

import { OUTCOMES_PATH, PROPOSALS_PATH, TRACE_ID_RE } from '../learning-contract.js';
import type { ToolDefinition } from './_types.js';
import { learningEnabled } from '../learning-capabilities.js';
import { SwfteApiError } from '../client.js';

const TraceId = z
  .string()
  .regex(TRACE_ID_RE, 'a trace id is 32 lowercase hex characters')
  .describe('The id from the `swfte-trace: <id>` line at the end of a Swfte tool result.');

/** Copy only the fields that are set, so the body carries exactly the typed inputs and nothing else. */
function compact(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

/* ── Section 1: review queue (outcomes and rule proposals) ────────────────── */

export const reviewQueueTools: ToolDefinition[] = [
  {
    name: 'swfte_report_outcome',
    title: 'Report how a traced call turned out',
    description:
      'Tell Swfte how the work behind one traced tool call actually ended: succeeded, failed or partial, ' +
      'with a short summary and any execution ids it produced. Pass the trace id from the ' +
      '`swfte-trace: <id>` line at the end of that call\'s result. This only adds an entry to a review ' +
      'queue that a human reviews; it never counts as evidence and never changes the evidence level of ' +
      'any recipe or record. Report what happened, not what was expected to happen. Summaries hold no ' +
      'secrets or customer data.',
    inputSchema: z.object({
      traceId: TraceId,
      outcome: z.enum(['succeeded', 'failed', 'partial']).describe('How the work ended.'),
      summary: z.string().max(1000).optional().describe('What happened, in at most 1000 characters.'),
      executionIds: z
        .array(z.string().min(1).max(128))
        .max(20)
        .optional()
        .describe('Up to 20 execution ids the work produced.'),
    }),
    execute: async (input, { client, config }) => {
      if (!await learningEnabled(client, config)) throw new SwfteApiError({ status: 404, code: 'NOT_FOUND',
        message: 'Not found', method: 'GET', path: '/v2/learning/capabilities' });
      return client.request({
        method: 'POST',
        path: OUTCOMES_PATH,
        body: compact({
          traceId: input.traceId,
          outcome: input.outcome,
          summary: input.summary,
          executionIds: input.executionIds,
        }),
        retries: 0,
      });
    },
  },
  {
    name: 'swfte_propose_rule',
    title: 'Propose a rule for the recipe book',
    description:
      'Propose one rule learned from experience (for example "set the Slack channel before the first ' +
      'run"), with the reasoning behind it and, optionally, the error signature it addresses and the trace ' +
      'ids of the calls that taught it. The proposal lands in a review queue as pending: a human reviews ' +
      'it and decides. It never counts as evidence and changes nothing on its own.',
    inputSchema: z.object({
      rule: z.string().min(1).max(500).describe('The rule, in at most 500 characters.'),
      rationale: z.string().min(1).max(2000).describe('Why the rule holds, in at most 2000 characters.'),
      errorSignature: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe('The error signature the rule addresses, e.g. http:404:NOT_FOUND.'),
      traceIds: z.array(TraceId).max(20).optional().describe('Up to 20 trace ids of the calls behind the rule.'),
    }),
    execute: async (input, { client, config }) => {
      if (!await learningEnabled(client, config)) throw new SwfteApiError({ status: 404, code: 'NOT_FOUND',
        message: 'Not found', method: 'GET', path: '/v2/learning/capabilities' });
      return client.request({
        method: 'POST',
        path: PROPOSALS_PATH,
        body: compact({
          rule: input.rule,
          rationale: input.rationale,
          errorSignature: input.errorSignature,
          traceIds: input.traceIds,
        }),
        retries: 0,
      });
    },
  },
];

/** Review tools only; recipeTools is registered separately in tools/index.ts. */
export const learningTools: ToolDefinition[] = [...reviewQueueTools];
