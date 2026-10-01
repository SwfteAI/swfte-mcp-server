import { z } from 'zod';
import { presentAction, type ActionRequest } from '../actions.js';
import type { ToolDefinition } from './_types.js';

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'An exact canonical content hash is required.');
const identity = { releaseId: z.string().min(1) };
const bound = { ...identity, expectedContentHash: hash, expectedPlanHash: hash };
const releasePath = (id: string) => `/v2/releases/${encodeURIComponent(id)}`;

/** One server router owns every artifact kind and Studio audience release. MCP can only propose increases. */
export const releaseTools: ToolDefinition[] = [
  {
    name: 'swfte_release_status', title: 'Read a release', readOnly: true,
    description: 'Read the workspace release state and pinned baseline/candidate for a workflow, chatflow, agent, model, application, widget or Studio change.',
    inputSchema: z.object(identity).strict(),
    execute: async (input, { client }) => client.request({ method: 'GET', path: releasePath(input.releaseId), retries: 1 }),
  },
  {
    name: 'swfte_release_report', title: 'Read release results', readOnly: true,
    description: 'Read the server sample counts, registered requirement, sequential result and intervals, guardrails and cost. Allocation mismatch withholds the primary metric; an underpowered plan has no better outcome.',
    inputSchema: z.object(identity).strict(),
    execute: async (input, { client }) => client.request({ method: 'GET', path: `${releasePath(input.releaseId)}/summary`, retries: 1 }),
  },
  ...(['pause', 'rollback'] as const).map((control): ToolDefinition => ({
    name: `swfte_release_${control}`, title: control === 'pause' ? 'Pause a release' : 'Roll back a release',
    description: `Ask the existing release controls to ${control}, bound to the exact content and plan hashes. The server checks control authority; safe-direction controls require no new approval.`,
    inputSchema: z.object({ ...bound, trigger: z.string().min(1).max(200) }).strict(),
    execute: async (input, { client }) => client.request({
      method: 'POST', path: `${releasePath(input.releaseId)}/${control}`,
      body: { expectedContentHash: input.expectedContentHash, expectedPlanHash: input.expectedPlanHash, trigger: input.trigger },
      retries: 0,
    }),
  })),
  {
    name: 'swfte_release_propose_ramp', title: 'Propose a release step',
    description: 'Create a release.ramp request, or release.complete for COMPLETE, in the inherited actions approval mechanism for the exact content and plan. This tool changes no traffic. A person reviews the request; execution remains in swfte_execute_approved_action.',
    inputSchema: z.object({ ...bound, desiredStage: z.enum(['CANARY', 'AB', 'RAMP', 'COMPLETE']), candidateWeight: z.number().int().min(0).max(10000) }).strict(),
    execute: async (input, { client }) => {
      const action = await client.request<ActionRequest>({ method: 'POST',
        path: `${releasePath(input.releaseId)}/propose-next-step`,
        body: { expectedContentHash: input.expectedContentHash, expectedPlanHash: input.expectedPlanHash,
          desiredStage: input.desiredStage, candidateWeight: input.candidateWeight },
        expectStatuses: [200, 201, 202], retries: 0 });
      if (action.contentHash !== input.expectedContentHash || action.planHash !== input.expectedPlanHash)
        throw new Error('The proposal response does not match the requested content and plan hashes. Read the action in Studio before continuing.');
      const capability = input.desiredStage === 'COMPLETE' ? 'release.complete' : 'release.ramp';
      if (!action.id || action.capability !== capability || action.status !== 'PROPOSED' || action.requiresApproval !== true
          || action.params?.releaseId !== input.releaseId || action.params?.stage !== input.desiredStage
          || String(action.params?.candidateWeight) !== String(input.candidateWeight))
        throw new Error('The proposal response does not match the requested release step and human approval state. Read the action in Studio before continuing.');
      return { changesTraffic: false, ...presentAction(action) };
    },
  },
];
