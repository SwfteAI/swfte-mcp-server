import { z } from 'zod';
import type { RequestOptions } from '../client.js';
import type { ProofLevel, ProvingRunResult, VerdictResult } from './types.js';
import { decodeProvingReceipt, hasProvingGateSeal } from './receipt.js';

export interface ProvingClient {
  readonly baseUrl: string;
  request<T = unknown>(options: RequestOptions): Promise<T>;
}
export function assertProvingDestination(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid configured proving destination');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new Error('Proving requires HTTPS off-machine');
  }
}
export function parseRun(value: unknown, runKey: string, level: ProofLevel, expectedAdmissionHash?: string): ProvingRunResult {
  return decodeProvingReceipt(value, { runKey, level, admissionHash: expectedAdmissionHash });
}

/** Read only the accepted run identity; never starts/uploads another run when polling. */
export async function readPendingRun(client: ProvingClient, runId: string, runKey: string, level: ProofLevel): Promise<ProvingRunResult> {
  if (!/^pr_[a-f0-9]{64}$/u.test(runId)) throw new Error('Invalid pending run identity');
  assertProvingDestination(client.baseUrl);
  const result = parseRun(await client.request({ method: 'GET', path: `/v2/proving/runs/${runId}`,
    retries: 0, timeoutMs: 5_000 }), runKey, level);
  if (result.run_id !== runId) throw new Error('STALE_CONTENT: pending run identity changed');
  return result;
}

/** Always reads native15 authoritative GET, which re-verifies admission, canonical RUN_END and issuer
 * measuredHash. The additional compliance route checks tree identity/freshness, not measuredHash.
 * Decoding and trace syntax alone never certify a result. No local result is read.
 */
export async function readVerdict(client: ProvingClient | undefined, runKey: string, level: ProofLevel): Promise<VerdictResult> {
  if (!/^[a-f0-9]{64}$/u.test(runKey)) return { token: 'PROOF_UNPROVEN', exitCode: 1, reason: 'invalid tree key' };
  if (!client) return { token: 'PROOF_UNPROVEN', exitCode: 1, reason: 'signed out' };
  try {
    assertProvingDestination(client.baseUrl);
    const run = parseRun(await client.request({ method: 'GET', path: '/v2/proving/runs/verdict',
      query: { run_key: runKey, level }, retries: 0, timeoutMs: 5_000 }), runKey, level);
    if (run.status === 'PENDING') return { token: 'PROOF_PENDING', exitCode: 1, run };
    if (run.verdict === 'FAIL') return { token: 'PROOF_FAIL', exitCode: 1, run };
    if (run.verdict !== 'PASS' || run.dependency_gaps.length || !run.evidence_record_id || !run.checks.length
      || run.checks.some(check => check.ok !== true || !check.evidence_ref) || !hasProvingGateSeal(run)
      || run.findings.some(finding => ['CRITICAL', 'HIGH'].includes(finding.severity))) {
      return { token: 'PROOF_UNPROVEN', exitCode: 1, reason: run.dependency_gaps.join(', ') || 'checks or signed evidence incomplete', run };
    }
    if (['.', '..'].includes(run.evidence_record_id) || !/^[A-Za-z0-9._:-]{1,200}$/u.test(run.evidence_record_id)) throw new Error('Invalid evidence record reference');
    const verification = await client.request<unknown>({ method: 'GET',
      path: `/v2/compliance/evidence-records/${encodeURIComponent(run.evidence_record_id)}/verify`, retries: 0, timeoutMs: 5_000 });
    const record = z.object({ recordId: z.string(), signatureValid: z.literal(true), status: z.literal('VALID'),
      fresh: z.literal(true), recordedContentHash: z.string(), currentContentHash: z.string() }).parse(verification);
    if (record.recordId !== run.evidence_record_id || record.recordedContentHash !== runKey || record.currentContentHash !== runKey) {
      throw new Error('Evidence is stale or bound to another tree');
    }
    return { token: 'PROOF_PASS', exitCode: 0, run };
  } catch {
    return { token: 'PROOF_UNPROVEN', exitCode: 1, reason: 'server verdict or signed evidence unavailable' };
  }
}
export function verdictLine(result: VerdictResult): string {
  return result.token + (result.reason ? ` unproven: ${result.reason}` : '');
}
