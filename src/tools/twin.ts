import { z } from 'zod';
import { assertLocalFilesystem } from '../fsguard.js';
import { packTwinBundle, TwinIntakeRefusal } from '../twins/intake.js';
import { intakeDestination, TWIN_INTAKE_PATH, requireId, requireIntakeProposal, requireSameConsent, requireTreeReadiness, requireTwin } from '../twins/contracts.js';
import type { ToolContext, ToolDefinition } from './_types.js';

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const Workspace = z.object({ workspaceId: Id.optional() }).strict();
function workspace(input: { workspaceId?: string }, ctx: ToolContext): string | undefined {
  const configured = ctx.client.configuredWorkspaceId ?? ctx.config.workspaceId;
  if (configured !== undefined) requireId(configured);
  if (input.workspaceId !== undefined) requireId(input.workspaceId);
  if (configured && input.workspaceId && input.workspaceId !== configured) throw new TwinIntakeRefusal('WORKSPACE_MISMATCH');
  return configured ?? input.workspaceId;
}
export const twinTools: ToolDefinition[] = [
  {
    name: 'swfte_twin_push', title: 'Push a codebase twin snapshot',
    description: 'Push a committed synthetic reference repository after explicit tree consent. Refuses production credentials, unsafe source links, unsupported licenses and omitted local edits. Returns a hash-bound stack proposal to confirm before execution.',
    inputSchema: Workspace.extend({ repoPath: z.string().min(1), repoId: Id, consentRecordId: Id, baseRef: z.string().optional() }).strict(),
    execute: async (input, ctx) => {
      assertLocalFilesystem(ctx.localFilesystem, 'swfte_twin_push');
      const ws = workspace(input, ctx);
      const repoId = requireId(input.repoId), consentId = requireId(input.consentRecordId);
      const requestReadiness = () => ctx.client.request<unknown>({ method: 'GET', path: '/v2/twins/intake/readiness',
        query: { channel: 'mcp', repoId, consentId }, workspaceId: ws });
      const readiness = await requestReadiness();
      const destination = intakeDestination(ctx.client.baseUrl);
      const binding = requireTreeReadiness(readiness, ws, repoId, consentId, destination);
      const bundle = packTwinBundle(input.repoPath, input.baseRef);
      // Packaging can outlive/revoke a grant; inspect the actual current record again before any source POST.
      const currentReadiness = await requestReadiness();
      const currentDestination = intakeDestination(ctx.client.baseUrl);
      if (currentDestination !== destination) throw new TwinIntakeRefusal('TWIN_TREE_CONSENT_REQUIRED');
      requireSameConsent(binding, requireTreeReadiness(currentReadiness, binding.workspaceId, repoId, consentId, currentDestination));
      const form = new FormData();
      form.append('archive', new Blob([new Uint8Array(bundle.bytes)], { type: 'application/octet-stream' }), 'source.bundle');
      form.append('repoId', input.repoId); form.append('consentRecordId', input.consentRecordId);
      form.append('expectedHash', bundle.snapshotHash); form.append('format', 'GIT_BUNDLE');
      const result = requireIntakeProposal(await ctx.client.postMultipart<unknown>(
        TWIN_INTAKE_PATH, form, { workspaceId: binding.workspaceId }), binding, bundle.snapshotHash, bundle.commitShas);
      return { snapshotId: result.snapshot.snapshotId, snapshotHash: result.snapshot.snapshotHash, commitShas: result.snapshot.commitShas,
        proposalId: result.proposalId, proposalHash: result.proposalHash, requiredConfirmations: result.requiredConfirmations };
    },
  },
  {
    name: 'swfte_twin_status', title: 'Get twin status', readOnly: true,
    description: 'Read a private twin in the authenticated workspace. Unknown or missing evidence remains unknown.',
    inputSchema: Workspace.extend({ twinId: Id }).strict(),
    execute: async (input, ctx) => {
      const ws = workspace(input, ctx), twinId = requireId(input.twinId);
      return requireTwin(await ctx.client.request<unknown>({ method: 'GET', path: `/v2/twins/${encodeURIComponent(twinId)}`, workspaceId: ws }), ws, twinId);
    },
  },
];
