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
  input: { path: string; level?: ProofLevel; requestedChecks?: string[]; sessionId?: string; trigger?: 'cli' | 'mcp' | 'verified_edit'; expectedRunKey?: string; signal?: AbortSignal },
  ports: { intake?: SourceIntake; learning?: ProofLearningBoundary } = {}): Promise<SourceProofResult> {
  // Freeze the actual configured target before any await; consent never follows a later target mutation.
  const destination = client?.baseUrl;
  const ensureAdmission = (): void => {
    if (input.signal?.aborted) throw new Error('PROVING_ABORTED: no next source effect authorized');
    if (client && client.baseUrl !== destination) throw new Error('PROVING_DESTINATION_CHANGED: new consent required');
  };
  ensureAdmission();
  const local = await runLocal(input.path, input.requestedChecks ?? ['scan', 'deps']);
  ensureAdmission();
  // Watch authorization belongs to the measured verified tree, not a newer tree found during this call.
  if (input.expectedRunKey !== undefined && (!/^[a-f0-9]{64}$/u.test(input.expectedRunKey)
    || input.expectedRunKey !== local.snapshot.run_key)) throw new Error('STALE_CONTENT: verified tree changed');
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
  assertProvingDestination(destination!);
  ensureAdmission();
  const level = await ports.intake.resolveLevel(local.snapshot.root, input.level);
  ensureAdmission();
  await assertTreeUnchanged(local.snapshot);
  ensureAdmission();
  if (level === 'local') return { schema: 'nexus.proof.v1', run_key: local.snapshot.run_key, level, verdict: local.verdict,
    token: 'PROOF_UNPROVEN', checks: local.checks, findings: local.findings, dependency_gaps: ['Repository policy lowered proof to local'] };
  ensureAdmission();
  const consent = await ports.intake.authorizeSource({ path: local.snapshot.root, level, destination: destination! });
  ensureAdmission();
  await assertTreeUnchanged(local.snapshot);
  ensureAdmission();
  // A delayed consent prompt must not authorize bytes that changed while it was open.
  const findings = await inspectSource(local.snapshot);
  ensureAdmission();
  if (findings.length) return gap('SOURCE_CHANGED_OR_SECRET_REFUSED');
  const result = await ports.learning.withProofOrigin(async () => {
    ensureAdmission();
    // Origin admission may await; recheck before the next effect, not only after an upload.
    await assertTreeUnchanged(local.snapshot);
    ensureAdmission();
    const payload = await ports.intake!.prepareUpload({ path: local.snapshot.root, level, consent, snapshot: local.snapshot });
    ensureAdmission();
    if (payload.runKey !== local.snapshot.run_key || canonicalTreeKey(payload.manifest.files) !== local.snapshot.run_key) {
      throw new Error('STALE_CONTENT: upload is bound to another tree');
    }
    await assertTreeUnchanged(local.snapshot);
    ensureAdmission();
    const body = { schema: 'nexus.proof.v1', run_key: local.snapshot.run_key, level,
      repo_fingerprint: local.snapshot.repo_fingerprint, commit: local.snapshot.commit, dirty: local.snapshot.dirty,
      session_id: input.sessionId ?? null, baton_id: null, trigger: input.trigger ?? 'mcp', manifest: payload.manifest,
      payload_ref: level === 'manifest' ? null : payload.payloadRef, requested_checks: input.requestedChecks ?? ['scan', 'deps'] };
    ensureAdmission();
    const response = await client.request({ method: 'POST', path: '/v2/proving/runs', body, retries: 0, timeoutMs: 10_000 });
    ensureAdmission();
    return parseRun(response, local.snapshot.run_key, level);
  });
  ensureAdmission();
  return result;
}
