import { z } from 'zod';
import type { RequestOptions } from '../client.js';
import type { ProofLevel, ProvingRunResult, VerdictResult } from './types.js';

export interface ProvingClient {
  readonly baseUrl: string;
  request<T = unknown>(options: RequestOptions): Promise<T>;
}
const Check = z.object({ name: z.string().min(1), ok: z.boolean().nullable(), detail: z.string(), evidence_ref: z.string().nullable().optional() });
const Result = z.object({
  schema: z.literal('nexus.proof.v1'), run_id: z.string().regex(/^pr_[a-f0-9]{64}$/u), run_key: z.string().regex(/^[a-f0-9]{64}$/u),
  level: z.enum(['local', 'manifest', 'diff', 'tree']), status: z.enum(['PENDING', 'COMPLETE']),
  verdict: z.enum(['PASS', 'FAIL', 'PARTIAL', 'UNAVAILABLE']), checks: z.array(Check),
  findings: z.array(z.object({ rule_id: z.string(), severity: z.string(), file: z.string(), line: z.number().int(),
    message: z.string(), remediation: z.string(), evidence_ref: z.string().nullable().optional() })),
  dependency_gaps: z.array(z.string()), behavior_trace: z.array(z.object({ category: z.string(), record_id: z.string(), content_hash: z.string().regex(/^[a-f0-9]{64}$/u) })),
  explained: z.array(z.string()), confidence: z.number().finite().optional(), report_url: z.string().optional(),
  evidence_record_id: z.string().optional(), review_packet_url: z.string().optional(),
});

export function assertProvingDestination(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid configured proving destination');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new Error('Proving requires HTTPS off-machine');
  }
}
export function parseRun(value: unknown, runKey: string, level: ProofLevel): ProvingRunResult {
  const result = Result.parse(value);
  if (result.run_key !== runKey || result.level !== level) throw new Error('STALE_CONTENT: result belongs to another tree');
  return result;
}

/** Always reads the server and, for PASS, the existing compliance verify route. No local result is read. */
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
      || run.checks.some(check => check.ok !== true || !check.evidence_ref) || !run.behavior_trace.length
      || run.findings.some(finding => ['CRITICAL', 'HIGH'].includes(finding.severity))) {
      return { token: 'PROOF_UNPROVEN', exitCode: 1, reason: run.dependency_gaps.join(', ') || 'checks or signed evidence incomplete', run };
    }
    if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(run.evidence_record_id)) throw new Error('Invalid evidence record reference');
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
