import { z } from 'zod';
import type { ToolDefinition } from './_types.js';

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const REVIEW_KINDS = ['workflow', 'agent', 'chatflow', 'model', 'application', 'widget', 'studio-change'] as const;

/** Machine reads cannot manufacture a human room view or decide an action. */
export const reviewTools: ToolDefinition[] = [
  {
    name: 'swfte_review_room', title: 'Read a review room', readOnly: true,
    description: 'Read the archived review packet and reports for an action and exact content hash. Missing historical evidence stays absent. Opening through MCP creates no human room-view fact and grants no approval authority.',
    inputSchema: z.object({ actionId: z.string().min(1), contentHash: hash }).strict(),
    execute: async (input, { client }) => client.request({ method: 'GET',
      path: `/v2/review/${encodeURIComponent(input.actionId)}`, query: { hash: input.contentHash }, retries: 1 }),
  },
  {
    name: 'swfte_proof_bundle', title: 'Read signed proof bundle', readOnly: true,
    description: 'Read the signed proof bundle reference and verification material for one workspace artifact version. Facts join only this content hash; missing confidence is explicit. This evidence supports an audit and makes no certification claim.',
    inputSchema: z.object({ kind: z.enum(REVIEW_KINDS), artifactId: z.string().min(1), contentHash: hash }).strict(),
    execute: async (input, { client }) => client.request({ method: 'GET',
      path: `/v2/proof-bundles/${encodeURIComponent(input.kind)}/${encodeURIComponent(input.artifactId)}`,
      query: { hash: input.contentHash }, retries: 1 }),
  },
];
