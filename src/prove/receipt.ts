import type { ProofLevel, ProvingRunResult as ProvingResult } from './types.js';
import { z } from 'zod';

const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Nonempty = z.string().min(1);
const Path = z.string().min(1).max(500).refine(path => !path.startsWith('/') && !/[\\:\x00-\x1f\x7f]/u.test(path)
  && path.normalize('NFC') === path && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const Check = z.object({ name: Nonempty, ok: z.boolean().nullable(), detail: z.string(), evidence_ref: Nonempty.nullable() }).strict();
const Finding = z.object({ rule_id: Nonempty, severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']), file: Path,
  line: z.number().int().min(1), message: z.string(), remediation: z.string(), evidence_ref: Nonempty.nullable() }).strict();
const Trace = z.union([
  // Actual nested Java Trace emits null; omitted is the explicit global NON_NULL compatibility case.
  z.object({ category: z.literal('proof_admission'), record_id: z.null().optional(), content_hash: Hash }).strict(),
  z.object({ category: Nonempty.refine(category => category !== 'proof_admission'), record_id: Nonempty, content_hash: Hash }).strict(),
]);
const Receipt = z.object({ schema: z.literal('nexus.proof.v1'), run_id: z.string().regex(/^pr_[a-f0-9]{64}$/u), run_key: Hash,
  level: z.enum(['local', 'manifest', 'diff', 'tree']), status: z.enum(['PENDING', 'COMPLETE']),
  verdict: z.enum(['PASS', 'FAIL', 'PARTIAL', 'UNAVAILABLE']), checks: z.array(Check), findings: z.array(Finding),
  dependency_gaps: z.array(Nonempty), behavior_trace: z.array(Trace), explained: z.array(z.string()),
  confidence: z.number().finite().min(0).max(1).optional(), report_url: z.string().optional(),
  evidence_record_id: Nonempty.optional(), review_packet_url: z.string().optional(),
}).strict();

export interface ProvingReceiptBinding { runKey?: string; level?: ProofLevel; runId?: string; admissionHash?: string }

/** Native15 wire decoding, never signature verification or native07 ConfidenceResult conversion. */
export function decodeProvingReceipt(value: unknown, binding: ProvingReceiptBinding = {}): ProvingResult {
  const result = Receipt.parse(value);
  if ((binding.runKey !== undefined && result.run_key !== binding.runKey)
    || (binding.level !== undefined && result.level !== binding.level)
    || (binding.runId !== undefined && result.run_id !== binding.runId)) throw new Error('STALE_CONTENT: result belongs to another proof identity');
  const admissions = result.behavior_trace.filter(trace => trace.category === 'proof_admission');
  const unmeasured = result.behavior_trace.length === 0 && result.verdict === 'UNAVAILABLE'
    && result.dependency_gaps.length > 0 && result.checks.every(check => check.ok === null && check.evidence_ref === null)
    && !result.evidence_record_id;
  if (admissions.length > 1 || (result.status === 'COMPLETE' && !unmeasured && admissions.length !== 1)
    || (binding.admissionHash !== undefined && (!/^[a-f0-9]{64}$/u.test(binding.admissionHash)
      || admissions.length !== 1 || admissions[0]!.content_hash !== binding.admissionHash))) throw new Error('Invalid sealed proof admission');
  return result;
}

/** Necessary shape only. The authenticated native15 GET re-verifies canonical bytes and issuer measuredHash.
 * A trace hash or the compliance tree-hash verify response cannot independently verify those measurements.
 */
export function hasProvingGateSeal(result: ProvingResult): boolean {
  const admission = result.behavior_trace.filter(trace => trace.category === 'proof_admission');
  const seals = result.behavior_trace.filter(trace => trace.category === 'run_ledger');
  if (admission.length !== 1 || seals.length !== 1 || !seals[0]!.record_id) return false;
  const suffix = seals[0]!.record_id.slice(result.run_id.length);
  return seals[0]!.record_id.startsWith(result.run_id) && /^_a_[a-f0-9]{32}:0$/u.test(suffix);
}
