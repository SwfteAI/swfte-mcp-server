import { z } from 'zod';
import { presentAction, type ActionRequest } from '../actions.js';
import { releaseStatus, releaseSummary, releaseTransition, releaseProposal, releaseProposalAuthority, text } from './review-release-contract.js';
import type { ToolDefinition } from './_types.js';

const hash = z.string().length(71).regex(/^sha256:[0-9a-f]{64}$/, 'An exact canonical content hash is required.');
const identity = { releaseId: z.string().max(512).refine(text, 'A bounded nonblank release identity without controls is required.') };
const bound = { ...identity, expectedContentHash: hash, expectedPlanHash: hash };
const releasePath = (id: string) => `/v2/releases/${encodeURIComponent(id)}`;

/** One server router owns every artifact kind and Studio audience release. MCP can only propose increases. */
export const releaseTools: ToolDefinition[] = [
  {
    name: 'swfte_release_status', title: 'Read a release', readOnly: true,
    description: 'Read the workspace release state and pinned baseline/candidate for a workflow, chatflow, agent, model, application, widget or Studio change.',
    inputSchema: z.object(identity).strict(),
    execute: async (input, { client, config }) => {
      const path = releasePath(input.releaseId);
      return releaseStatus(await client.request({ method: 'GET', path, headers: { 'Cache-Control': 'no-store' }, retries: 1 }), input.releaseId, config.workspaceId, path);
    },
  },
  {
    name: 'swfte_release_report', title: 'Read release results', readOnly: true,
    description: 'Read the server sample counts, registered requirement, sequential result and intervals, guardrails and cost. Allocation mismatch withholds the primary metric; an underpowered plan has no better outcome.',
    inputSchema: z.object(identity).strict(),
    execute: async (input, { client, config }) => {
      const path = `${releasePath(input.releaseId)}/summary`;
      return releaseSummary(await client.request({ method: 'GET', path, headers: { 'Cache-Control': 'no-store' }, retries: 1 }), input.releaseId, config.workspaceId, path);
    },
  },
  ...(['pause', 'rollback'] as const).map((control): ToolDefinition => ({
    name: `swfte_release_${control}`, title: control === 'pause' ? 'Pause a release' : 'Roll back a release',
    description: `Ask the existing release controls to ${control}, bound to the exact content and plan hashes. The server checks control authority; safe-direction controls require no new approval.`,
    inputSchema: z.object({ ...bound, trigger: z.string().min(1).max(200) }).strict(),
    execute: async (input, { client }) => {
      const path = `${releasePath(input.releaseId)}/${control}`;
      return releaseTransition(await client.request({
      method: 'POST', path,
      body: { expectedContentHash: input.expectedContentHash, expectedPlanHash: input.expectedPlanHash, trigger: input.trigger },
      retries: 0,
    }), input.releaseId, control, path);
    },
  })),
  {
    name: 'swfte_release_propose_ramp', title: 'Propose a release step',
    description: 'Create a release.ramp request, or release.complete for COMPLETE, in the inherited actions approval mechanism for the exact content and plan. This tool changes no traffic. A person reviews the request; execution remains in swfte_execute_approved_action.',
    inputSchema: z.object({ ...bound, desiredStage: z.enum(['SHADOW', 'CANARY', 'AB', 'RAMP', 'COMPLETE']), candidateWeight: z.number().int().min(0).max(10000) }).strict(),
    execute: async (input, { client, config }) => {
      const authorityPath = releasePath(input.releaseId);
      const authority = releaseProposalAuthority(await client.request({ method: 'GET', path: authorityPath,
        headers: { 'Cache-Control': 'no-store' }, retries: 0 }), input, config.workspaceId, authorityPath);
      const action = await client.request<ActionRequest>({ method: 'POST',
        path: `${releasePath(input.releaseId)}/propose-next-step`,
        body: { expectedContentHash: input.expectedContentHash, expectedPlanHash: input.expectedPlanHash,
          desiredStage: input.desiredStage, candidateWeight: input.candidateWeight },
        expectStatuses: [200, 201, 202], retries: 0 });
      releaseProposal(action, input, authority, `${releasePath(input.releaseId)}/propose-next-step`);
      return { changesTraffic: false, ...presentAction(action) };
    },
  },
];
