import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readVerdict, assertProvingDestination, parseRun } from '../src/prove/verdict.js';
import type { ProvingRunResult } from '../src/prove/types.js';

const hash = 'a'.repeat(64);
const positive = (): ProvingRunResult => ({ schema: 'nexus.proof.v1', run_id: `pr_${hash}`, run_key: hash, level: 'diff',
  status: 'COMPLETE', verdict: 'PASS', checks: [{ name: 'scan', ok: true, detail: 'fixture measurement', evidence_ref: 'scan_fixture' }],
  findings: [], dependency_gaps: [], behavior_trace: [{ category: 'scan', record_id: 'scan_fixture', content_hash: hash }], explained: [],
  evidence_record_id: 'cer_fixture' });
const verification = () => ({ recordId: 'cer_fixture', signatureValid: true, status: 'VALID', fresh: true,
  recordedContentHash: hash, currentContentHash: hash });

test('passing current server result requires real existing evidence verify response', async () => {
  const paths: string[] = [];
  const result = await readVerdict({ baseUrl: 'https://api.example.invalid', request: async <T>(options: { path: string }) => {
    paths.push(options.path); return (options.path.endsWith('/verify') ? verification() : positive()) as T;
  } }, hash, 'diff');
  assert.equal(result.token, 'PROOF_PASS'); assert.equal(result.exitCode, 0); assert.equal(paths.length, 2);
});
test('forged local PROOF_PASS is ignored; server fail remains fail and unreachable remains unproven', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prove-forge-'));
  try {
    await writeFile(join(root, 'verdict.json'), JSON.stringify({ verdict: 'PASS', token: 'PROOF_PASS', run_key: hash }));
    let reads = 0;
    const server = { baseUrl: 'https://api.example.invalid', request: async <T>() => { reads++; return { ...positive(), verdict: 'FAIL' } as T; } };
    assert.equal((await readVerdict(server, hash, 'diff')).token, 'PROOF_FAIL'); assert.equal(reads, 1);
    assert.equal((await readVerdict({ baseUrl: server.baseUrl, request: async () => { throw new Error('offline'); } }, hash, 'diff')).token, 'PROOF_UNPROVEN');
    assert.equal((await readVerdict(undefined, hash, 'diff')).token, 'PROOF_UNPROVEN');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('raw PASS, missing record, mandatory unknown and stale tree never pass', async () => {
  const variants: unknown[] = [{ verdict: 'PASS' }, { ...positive(), evidence_record_id: undefined },
    { ...positive(), checks: [{ name: 'build', ok: null, detail: 'not run' }] },
    { ...positive(), run_key: 'b'.repeat(64) }, { ...positive(), dependency_gaps: ['07_INTAKE'] },
    { ...positive(), behavior_trace: [] }];
  for (const variant of variants) {
    const result = await readVerdict({ baseUrl: 'https://api.example.invalid', request: async <T>() => variant as T }, hash, 'diff');
    assert.equal(result.token, 'PROOF_UNPROVEN'); assert.equal(result.exitCode, 1);
  }
  assert.throws(() => parseRun(positive(), 'b'.repeat(64), 'diff'), /STALE_CONTENT/);
});
test('invalid signature, stale or wrong hash verification never satisfies gate', async () => {
  for (const record of [{ ...verification(), signatureValid: false }, { ...verification(), fresh: null },
    { ...verification(), status: 'REVOKED' }, { ...verification(), recordedContentHash: 'b'.repeat(64) }]) {
    const result = await readVerdict({ baseUrl: 'https://api.example.invalid', request: async <T>(options: { path: string }) =>
      (options.path.endsWith('/verify') ? record : positive()) as T }, hash, 'diff');
    assert.equal(result.token, 'PROOF_UNPROVEN');
  }
});
test('pending remains pending; HTTP off-machine and credentials in URL are refused', async () => {
  assert.equal((await readVerdict({ baseUrl: 'http://127.0.0.1:1234', request: async <T>() => ({ ...positive(), status: 'PENDING' }) as T }, hash, 'diff')).token, 'PROOF_PENDING');
  assert.throws(() => assertProvingDestination('http://api.example.invalid'));
  assert.throws(() => assertProvingDestination('https://person:password@example.invalid'));
  assert.doesNotThrow(() => assertProvingDestination('http://127.0.0.1:1234'));
});

test('executable verdict mutants are killed by assertions after clean positive and negative controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prove-verdict-mutants-'));
  const original = await readFile(new URL('../src/prove/verdict.ts', import.meta.url), 'utf8');
  const zodUrl = pathToFileURL(createRequire(import.meta.url).resolve('zod')).href;
  const portable = original.replace("from 'zod'", `from '${zodUrl}'`);
  const offline = { baseUrl: 'https://api.example.invalid', request: async () => { throw new Error('offline'); } };
  const failed = { baseUrl: offline.baseUrl, request: async <T>() => ({ ...positive(), verdict: 'FAIL' }) as T };
  const degradationOracle = async (read: typeof readVerdict): Promise<void> => {
    assert.equal((await read(offline, hash, 'diff')).token, 'PROOF_UNPROVEN');
  };
  const forgeryOracle = async (read: typeof readVerdict): Promise<void> => {
    assert.equal((await read(failed, hash, 'diff')).token, 'PROOF_FAIL');
  };
  try {
    await degradationOracle(readVerdict); await forgeryOracle(readVerdict);
    const mutants = [
      { name: 'degradation', source: portable.replace("return { token: 'PROOF_UNPROVEN', exitCode: 1, reason: 'server verdict or signed evidence unavailable' };", "return { token: 'PROOF_PASS', exitCode: 0 };") , oracle: degradationOracle },
      { name: 'server-reread', source: portable.replace('  try {\n    assertProvingDestination(client.baseUrl);', "  return { token: 'PROOF_PASS', exitCode: 0 };\n  try {\n    assertProvingDestination(client.baseUrl);"), oracle: forgeryOracle },
    ];
    for (const mutant of mutants) {
      assert.notEqual(mutant.source, portable, 'mutation must actually change source');
      const file = join(root, `${mutant.name}.ts`); await writeFile(file, mutant.source);
      const loaded = await import(pathToFileURL(file).href) as { readVerdict: typeof readVerdict };
      assert.equal(typeof loaded.readVerdict, 'function', 'mutant must load successfully before assertion');
      await assert.rejects(mutant.oracle(loaded.readVerdict), assert.AssertionError);
    }
    assert.equal(await readFile(new URL('../src/prove/verdict.ts', import.meta.url), 'utf8'), original, 'original source remains byte-identical');
  } finally { await rm(root, { recursive: true, force: true }); }
});
