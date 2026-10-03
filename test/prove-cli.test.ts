import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { handleProveCommand } from '../src/prove/cli.js';
import { NativeFilesystem } from '../src/native-filesystem.js';
import type { RequestOptions } from '../src/client.js';
const exec = promisify(execFile);
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prove-cli-'));
  await exec('git', ['init', '-q', root]);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'local-fixture', license: 'MIT' }));
  await writeFile(join(root, 'source.ts'), 'export const safe = 1;');
  return root;
}
test('actual local source measurements show PARTIAL counts and unknown deps without remote authority', async () => {
  const root = await fixture(); const lines: string[] = []; let requests = 0;
  try {
    const code = await handleProveCommand(['--level', 'local'], { cwd: root, output: line => lines.push(line),
      client: { baseUrl: 'https://api.example.invalid', request: async <T>() => { requests++; throw new Error('unexpected request'); } } });
    assert.equal(code, 1); assert.equal(requests, 0);
    assert.ok(lines.some(line => /^Local measurements: PARTIAL · checks passed=2 failed=0 unknown=1 · findings critical=0 high=0 medium=0 low=0 info=0 other=0$/.test(line)));
    assert.ok(lines.some(line => line.startsWith('PROOF_UNPROVEN')));
    assert.ok(!lines.some(line => line.includes('PROOF_PASS')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('clean forged local proof cannot grant PASS or override actual unknown measurements', async () => {
  const root = await fixture(); const lines: string[] = []; let requests = 0;
  try {
    await mkdir(join(root, '.nexus'));
    // No credential-shaped field: this control isolates self-reported authority from secret refusal.
    await writeFile(join(root, '.nexus', 'proof.json'), JSON.stringify({
      schema: 'nexus.proof.v1', verdict: 'PASS', output: 'PROOF_PASS',
    }));
    assert.equal(await handleProveCommand(['--level', 'local'], { cwd: root, output: line => lines.push(line),
      client: { baseUrl: 'https://api.example.invalid', request: async <T>() => { requests++; throw new Error('unexpected request'); } } }), 1);
    assert.equal(requests, 0);
    assert.ok(lines.some(line => /^Local measurements: PARTIAL · checks passed=2 failed=0 unknown=1 · findings critical=0 high=0 medium=0 low=0 info=0 other=0$/.test(line)));
    assert.ok(lines.some(line => line.startsWith('PROOF_UNPROVEN')));
    assert.ok(!lines.some(line => line.includes('PROOF_PASS') || line.includes('PROOF_REFUSED')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('actual secret refusal exposes counts without secret bytes', async () => {
  const root = await fixture(); const lines: string[] = [];
  const secret = 'sk_' + 'live_0123456789ABCDEFGHIJ';
  try {
    await writeFile(join(root, 'source.ts'), 'const credential = "' + secret + '";');
    assert.equal(await handleProveCommand(['--level', 'local'], { cwd: root, output: line => lines.push(line) }), 1);
    assert.ok(lines.some(line => line.startsWith('Local measurements: FAIL')));
    assert.ok(lines.some(line => /failed=[1-9]/.test(line) && /critical=[1-9]/.test(line)));
    assert.ok(lines.some(line => line.startsWith('PROOF_REFUSED')));
    assert.ok(!lines.join('\n').includes(secret)); assert.ok(!lines.join('\n').includes('source.ts'));
    assert.ok(!lines.join('\n').includes('PROOF_PASS'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('remote missing adapter preserves UNAVAILABLE as gap state and reports only source check counts', async () => {
  const root = await fixture(); const lines: string[] = [];
  try {
    assert.equal(await handleProveCommand([], { cwd: root, output: line => lines.push(line),
      client: { baseUrl: 'https://api.example.invalid', request: async <T>() => { throw new Error('unexpected request'); } } }), 1);
    assert.ok(lines.some(line => line.startsWith('Source checks: passed=2 failed=0 unknown=1')));
    assert.ok(!lines.some(line => line.startsWith('Local measurements: UNAVAILABLE')));
    assert.ok(lines.some(line => line.startsWith('PROOF_UNPROVEN')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('already aborted source and verdict errors produce no output', async () => {
  const controller = new AbortController(); controller.abort();
  for (const args of [[], ['verdict']]) {
    const lines: string[] = [];
    assert.equal(await handleProveCommand(args, { cwd: '/path-that-does-not-exist', signal: controller.signal, output: line => lines.push(line) }), 1);
    assert.deepEqual(lines, []);
  }
});
test('abort while authoritative verdict is delayed suppresses verified PASS output and success', async () => {
  const root = await fixture(); const controller = new AbortController(); const lines: string[] = []; let calls = 0; let key = "";
  try {
    const code = await handleProveCommand(['verdict'], { cwd: root, signal: controller.signal, output: line => lines.push(line),
      client: { baseUrl: 'https://api.example.invalid', request: async <T>(options: RequestOptions) => {
        calls++;
        if (options.path.endsWith('/verify')) return { recordId: 'cer_fixture', signatureValid: true, status: 'VALID', fresh: true, recordedContentHash: key, currentContentHash: key } as T;
        key = String(options.query?.run_key);
        controller.abort();
        return { schema: 'nexus.proof.v1', run_id: 'pr_' + 'a'.repeat(64), run_key: key, level: 'diff', status: 'COMPLETE',
          verdict: 'PASS', checks: [{ name: 'scan', ok: true, detail: 'fixture', evidence_ref: 'scan_fixture' }], findings: [], dependency_gaps: [],
          behavior_trace: [{ category: 'proof_admission', content_hash: key, record_id: null },
            { category: 'run_ledger', record_id: 'pr_' + 'a'.repeat(64) + '_a_' + 'b'.repeat(32) + ':0', content_hash: key }], explained: [],
          evidence_record_id: 'cer_fixture' } as T;
      } } });
    assert.equal(code, 1); assert.equal(calls, 2); assert.deepEqual(lines, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('abort at actual held-source read suppresses subsequent error output', async () => {
  const root = await fixture(); const controller = new AbortController(); const lines: string[] = [];
  const realRead = NativeFilesystem.prototype.read; let reached = false;
  const observe = mock.method(NativeFilesystem.prototype, 'read', function(this: NativeFilesystem, rel: string, cap?: number) {
    const result = realRead.call(this, rel, cap);
    if (rel === 'source.ts') { reached = true; controller.abort(); }
    return result;
  });
  try {
    assert.equal(await handleProveCommand(['--level', 'local'], { cwd: root, signal: controller.signal, output: line => lines.push(line) }), 1);
    assert.equal(reached, true); assert.deepEqual(lines, []);
  } finally { observe.mock.restore(); await rm(root, { recursive: true, force: true }); }
});
