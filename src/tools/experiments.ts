import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const BASE = '/v2/chatflow-experiments';

/**
 * A/B experiments over chatflow versions. The lifecycle is
 * DRAFT → RUNNING → DECIDED → ARCHIVED and is enforced server-side: starting a
 * non-DRAFT experiment or deciding a non-RUNNING one returns 409 rather than
 * silently doing nothing.
 */
export const experimentTools: ToolDefinition[] = [
  {
    name: 'swfte_experiments_list',
    title: 'List A/B experiments',
    readOnly: true,
    description: 'List experiments, optionally filtered to one chatflow.',
    inputSchema: z.object({ chatflowId: z.string().optional() }),
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: BASE, query: { chatflowId: input.chatflowId }, retries: 1 }),
  },
  {
    name: 'swfte_experiments_get',
    title: 'Get an experiment',
    readOnly: true,
    description: 'Fetch one experiment, including its variants and assignment strategy.',
    inputSchema: z.object({ id: z.string() }),
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: `${BASE}/${encodeURIComponent(input.id)}`, retries: 1 }),
  },
  {
    name: 'swfte_experiments_create',
    title: 'Create an A/B experiment',
    description:
      'Create an experiment comparing two or more chatflow versions. It starts in DRAFT — call ' +
      'swfte_experiments_start to begin assigning traffic.',
    inputSchema: z.object({
      chatflowId: z.string(),
      name: z.string(),
      goalMetric: z.string().describe('What the experiment optimises, e.g. CSAT / COMPLETION_RATE / CONVERSION.'),
      variants: z
        .array(
          z.object({
            label: z.string().describe('Variant name, e.g. "control" / "b".'),
            chatflowVersion: z.union([z.string(), z.number()]),
            weight: z.number().optional().describe('Relative traffic share.'),
          })
        )
        .min(2),
      assignmentStrategy: z.string().optional().describe('e.g. STICKY_HASH, ROUND_ROBIN, INBOUND_RULE.'),
      inboundRules: z.array(z.record(z.unknown())).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({ method: 'POST', path: BASE, body: input, expectStatuses: [200, 201], retries: 0 }),
  },
  {
    name: 'swfte_experiments_update',
    title: 'Update an experiment',
    description: 'Update an experiment definition. Only meaningful while it is still in DRAFT.',
    inputSchema: z.object({ id: z.string(), patch: z.record(z.unknown()) }),
    execute: async (input, { client }) =>
      // Full-record PUT via read-merge-write; omitted fields are not preserved by the raw endpoint.
      client.mergePut(`${BASE}/${encodeURIComponent(input.id)}`, input.patch),
  },
  {
    name: 'swfte_experiments_start',
    title: 'Start an experiment',
    description: 'Move an experiment DRAFT → RUNNING so it begins assigning traffic. Returns 409 if it is not in DRAFT.',
    inputSchema: z.object({ id: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(input.id)}/start`,
        expectStatuses: [200, 409],
        retries: 0,
      }),
  },
  {
    name: 'swfte_experiments_assign',
    title: 'Assign a variant',
    description:
      'Ask which variant a given visitor should see. A 404 here means the experiment is not RUNNING; ' +
      'callers fall back to the chatflow’s current version, which is normal rather than an error.',
    inputSchema: z.object({
      id: z.string(),
      stickyKey: z.string().optional().describe('Stable per-visitor key so the same visitor keeps the same variant.'),
      matchAttributes: z.record(z.string()).optional().describe('Inbound attributes for rule-based assignment.'),
    }),
    execute: async (input, { client }) => {
      const res = await client.request<any>({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(input.id)}/assign`,
        body: { stickyKey: input.stickyKey, matchAttributes: input.matchAttributes },
        expectStatuses: [200, 404],
        retries: 1,
      });
      return (
        res ?? {
          assigned: false,
          reason: 'NOT_RUNNING',
          note: 'The experiment is not RUNNING — serve the chatflow’s current version.',
        }
      );
    },
  },
  {
    name: 'swfte_experiments_record_outcome',
    title: 'Record an outcome',
    description:
      'Push an outcome row for a session — the measurement the whole experiment rests on. Without ' +
      'outcomes the summary has nothing to compare.',
    inputSchema: z.object({
      id: z.string(),
      sessionId: z.string(),
      variantLabel: z.string().optional(),
      outcomeValue: z.number().optional().describe('The goal-metric value for this session.'),
      sideMetrics: z.record(z.number()).optional(),
    }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(input.id)}/outcomes`,
        body: {
          sessionId: input.sessionId,
          variantLabel: input.variantLabel,
          outcomeValue: input.outcomeValue,
          sideMetrics: input.sideMetrics,
        },
        expectStatuses: [200, 201],
        retries: 0,
      }),
  },
  {
    name: 'swfte_experiments_summary',
    title: 'Experiment results',
    readOnly: true,
    description: 'Per-variant aggregate of recorded outcomes — the numbers you decide on.',
    inputSchema: z.object({ id: z.string() }),
    execute: async (input, { client }) =>
      client.request({ method: 'GET', path: `${BASE}/${encodeURIComponent(input.id)}/summary`, retries: 1 }),
  },
  {
    name: 'swfte_experiments_decide',
    title: 'Decide a winner',
    description:
      'Mark a RUNNING experiment DECIDED with a winning variant. Returns 409 if it is not RUNNING. ' +
      'Read swfte_experiments_summary first — this call does not judge whether the result is significant.',
    inputSchema: z.object({ id: z.string(), winnerVariantLabel: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(input.id)}/decide`,
        body: { winnerVariantLabel: input.winnerVariantLabel },
        expectStatuses: [200, 409],
        retries: 0,
      }),
  },
  {
    name: 'swfte_experiments_delete',
    title: 'Delete an experiment',
    destructive: true,
    description: 'Delete an experiment and its recorded outcomes.',
    inputSchema: z.object({ id: z.string() }),
    execute: async (input, { client }) => {
      await client.request({
        method: 'DELETE',
        path: `${BASE}/${encodeURIComponent(input.id)}`,
        expectStatuses: [200, 202, 204],
        retries: 0,
      });
      return { deleted: true, id: input.id };
    },
  },
];
