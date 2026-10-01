import type { ProofLearningBoundary, ProofLevel, ProvingRunResult, SourceIntake } from './types.js';
import { assertTreeUnchanged, canonicalTreeKey } from './treekey.js';
import { inspectSource, runLocal } from './local.js';
import { assertProvingDestination, parseRun, type ProvingClient } from './verdict.js';

export type SourceProofResult = ProvingRunResult | {
  schema: 'nexus.proof.v1'; run_key: string; level: ProofLevel; verdict: 'FAIL' | 'PARTIAL' | 'UNAVAILABLE';
  token: 'PROOF_REFUSED' | 'PROOF_UNPROVEN'; checks: Awaited<ReturnType<typeof runLocal>>['checks'];
  findings: Awaited<ReturnType<typeof runLocal>>['findings']; dependency_gaps: string[];
};

/** Source consent, level policy and upload come from 07. Missing 07/08 prevents all remote calls. */
export async function runSourceProof(client: ProvingClient | undefined,
  input: { path: string; level?: ProofLevel; requestedChecks?: string[]; sessionId?: string; trigger?: 'cli' | 'mcp' | 'verified_edit' },
  ports: { intake?: SourceIntake; learning?: ProofLearningBoundary } = {}): Promise<SourceProofResult> {
  const local = await runLocal(input.path, input.requestedChecks ?? ['scan', 'deps']);
  const requested = input.level ?? (client ? 'diff' : 'local');
  const gap = (reason: string): SourceProofResult => ({ schema: 'nexus.proof.v1', run_key: local.snapshot.run_key,
    level: requested, verdict: 'UNAVAILABLE', token: 'PROOF_UNPROVEN', checks: local.checks, findings: local.findings,
    dependency_gaps: [reason] });
  if (local.findings.some(finding => finding.severity === 'CRITICAL')) return { schema: 'nexus.proof.v1', run_key: local.snapshot.run_key,
    level: 'local', verdict: 'FAIL', token: 'PROOF_REFUSED', checks: local.checks, findings: local.findings, dependency_gaps: [] };
  if (local.findings.some(finding => finding.rule_id === 'license-refused')) return gap('SOURCE_LICENSE_REFUSED');
  if (requested === 'local') return { schema: 'nexus.proof.v1', run_key: local.snapshot.run_key, level: 'local',
    verdict: local.verdict, token: 'PROOF_UNPROVEN', checks: local.checks, findings: local.findings,
    dependency_gaps: ['Local measurements cannot satisfy a server evidence gate'] };
  if (!client) return gap('signed out');
  if (!ports.intake) return gap('07_SHARED_CONSENT_LEVELS_UPLOAD');
  if (!ports.learning?.proofOriginExcludedByDefault()) return gap('08_PROOF_LEARNING_EXCLUSION');
  assertProvingDestination(client.baseUrl);
  const level = await ports.intake.resolveLevel(local.snapshot.root, input.level);
  if (level === 'local') return { schema: 'nexus.proof.v1', run_key: local.snapshot.run_key, level, verdict: local.verdict,
    token: 'PROOF_UNPROVEN', checks: local.checks, findings: local.findings, dependency_gaps: ['Repository policy lowered proof to local'] };
  const consent = await ports.intake.authorizeSource({ path: local.snapshot.root, level, destination: client.baseUrl });
  await assertTreeUnchanged(local.snapshot);
  // A delayed consent prompt must not authorize bytes that changed while it was open.
  if ((await inspectSource(local.snapshot)).length) return gap('SOURCE_CHANGED_OR_SECRET_REFUSED');
  return ports.learning.withProofOrigin(async () => {
    const payload = await ports.intake!.prepareUpload({ path: local.snapshot.root, level, consent, snapshot: local.snapshot });
    if (payload.runKey !== local.snapshot.run_key || canonicalTreeKey(payload.manifest.files) !== local.snapshot.run_key) {
      throw new Error('STALE_CONTENT: upload is bound to another tree');
    }
    await assertTreeUnchanged(local.snapshot);
    const body = { schema: 'nexus.proof.v1', run_key: local.snapshot.run_key, level,
      repo_fingerprint: local.snapshot.repo_fingerprint, commit: local.snapshot.commit, dirty: local.snapshot.dirty,
      session_id: input.sessionId ?? null, baton_id: null, trigger: input.trigger ?? 'mcp', manifest: payload.manifest,
      payload_ref: level === 'manifest' ? null : payload.payloadRef, requested_checks: input.requestedChecks ?? ['scan', 'deps'] };
    return parseRun(await client.request({ method: 'POST', path: '/v2/proving/runs', body, retries: 0, timeoutMs: 10_000 }),
      local.snapshot.run_key, level);
  });
}
