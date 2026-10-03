import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeProvingReceipt, hasProvingGateSeal } from '../src/prove/receipt.js';
const hash = 'a'.repeat(64);
const receipt = () => ({ schema: 'nexus.proof.v1', run_id: `pr_${hash}`, run_key: hash, level: 'diff',
  status: 'COMPLETE', verdict: 'PASS', checks: [{ name: 'scan', ok: true, detail: 'measurement fixture', evidence_ref: 'scan_fixture' }],
  findings: [], dependency_gaps: [], behavior_trace: [
    { category: 'proof_admission', record_id: null, content_hash: hash },
    { category: 'run_ledger', record_id: `pr_${hash}_a_${'b'.repeat(32)}:0`, content_hash: hash },
  ], explained: [], evidence_record_id: 'cer_fixture' });
test('native null admission and absent optional Result scalars decode without becoming verified evidence', () => {
  const decoded = decodeProvingReceipt(receipt(), { runKey: hash, level: 'diff', runId: `pr_${hash}`, admissionHash: hash });
  assert.equal(decoded.behavior_trace[0]!.record_id, null);
  assert.equal(Object.hasOwn(decoded, 'confidence'), false);
  assert.equal(Object.hasOwn(decoded, 'signatureValid'), false);
  assert.equal(hasProvingGateSeal(decoded), true); // Shape only; this does not verify ledger bytes/signatures.
  const compatible = receipt(); delete (compatible.behavior_trace[0] as { record_id?: string | null }).record_id;
  assert.equal(Object.hasOwn(decodeProvingReceipt(compatible).behavior_trace[0]!, 'record_id'), false);
});
test('same-tree native identity and level bindings reject substitutions', () => {
  for (const binding of [{ runKey: 'b'.repeat(64) }, { runId: `pr_${'b'.repeat(64)}` }, { level: 'tree' as const }, { admissionHash: 'b'.repeat(64) }]) {
    assert.throws(() => decodeProvingReceipt(receipt(), binding));
  }
});
test('nested corruptions and nonfinite/out-of-range confidence cannot hide behind valid arrays', () => {
  const variants = [
    { ...receipt(), checks: [{ name: 'scan', ok: 'true', detail: 'bad', evidence_ref: null }] },
    { ...receipt(), findings: [{ rule_id: 'x', severity: 'HIGH', file: '../x', line: 1, message: '', remediation: '', evidence_ref: null }] },
    { ...receipt(), findings: [{ rule_id: 'x', severity: 'PASS', file: 'x.ts', line: 1, message: '', remediation: '', evidence_ref: null }] },
    { ...receipt(), dependency_gaps: [null] }, { ...receipt(), explained: [42] },
    { ...receipt(), behavior_trace: [{ category: 'scan', record_id: null, content_hash: hash }] },
    { ...receipt(), behavior_trace: [{ category: 'proof_admission', record_id: 'invented', content_hash: hash }] },
    ...[NaN, Infinity, -0.1, 1.1, null].map(confidence => ({ ...receipt(), confidence })),
  ];
  for (const value of variants) assert.throws(() => decodeProvingReceipt(value));
  for (const confidence of [0, 1]) assert.equal(decodeProvingReceipt({ ...receipt(), confidence }).confidence, confidence);
});
test('pending and genuinely unmeasured unavailable are readable; raw PASS and missing/duplicate seals never qualify', () => {
  const unmeasured = { ...receipt(), verdict: 'UNAVAILABLE', checks: [], dependency_gaps: ['CAPACITY'], behavior_trace: [], evidence_record_id: undefined };
  for (const status of ['PENDING', 'COMPLETE']) assert.equal(decodeProvingReceipt({ ...unmeasured, status }).verdict, 'UNAVAILABLE');
  assert.throws(() => decodeProvingReceipt({ verdict: 'PASS' }));
  assert.throws(() => decodeProvingReceipt({ ...unmeasured, verdict: 'PASS' }));
  for (const trace of [[], [receipt().behavior_trace[0]!], [...receipt().behavior_trace, receipt().behavior_trace[1]!],
    [receipt().behavior_trace[0]!, { ...receipt().behavior_trace[1]!, record_id: `pr_${hash}_a_${'b'.repeat(32)}:1` }]]) {
    const candidate = { ...receipt(), behavior_trace: trace };
    if (!trace.length) assert.throws(() => decodeProvingReceipt(candidate));
    else assert.equal(hasProvingGateSeal(decodeProvingReceipt(candidate)), false);
  }
});
