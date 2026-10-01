import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installProvingGate, PG_LEDGER } from '../src/prove/gate.js';
const exec = promisify(execFile);
async function nexusStatus(root: string, env: NodeJS.ProcessEnv): Promise<{ output: string; code: number }> {
  try { const result = await exec('nexus', ['gates', 'status'], { cwd: root, env, timeout: 20_000 }); return { output: result.stdout + result.stderr, code: 0 }; }
  catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    if (result.code !== 1) throw error;
    return { output: (result.stdout ?? '') + (result.stderr ?? ''), code: 1 };
  }
}

test('installer writes fixed ledger, preserves existing files and never changes gate mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prove-gate-'));
  try {
    const installed = await installProvingGate(root);
    assert.equal(installed.mode, 'unchanged'); assert.equal(installed.watchStarted, false);
    assert.equal(await readFile(installed.path, 'utf8'), PG_LEDGER);
    await assert.rejects(installProvingGate(root), (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
    assert.equal(await readFile(installed.path, 'utf8'), PG_LEDGER);
    assert(!PG_LEDGER.includes('enforce')); assert(PG_LEDGER.includes('CHECK: swfte prove verdict --tree HEAD+worktree'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('installer refuses outbound Nexus directory symlink with a confined positive control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prove-gate-link-')); const outside = await mkdtemp(join(tmpdir(), 'prove-gate-outside-'));
  try {
    await symlink(outside, join(root, '.nexus')); await assert.rejects(installProvingGate(root), /confined/);
    await assert.rejects(readFile(join(outside, 'gates', 'proving-ground.md')));
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test('installed unmodified Nexus discovers and adjudicates PG, FAIL negative leaves it unmet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prove-real-nexus-')); const userConfig = await mkdtemp(join(tmpdir(), 'prove-nexus-home-'));
  const bins = join(root, 'bin'); await mkdir(bins);
  const oracle = join(bins, 'swfte');
  const env = { ...process.env, HOME: userConfig, PATH: `${bins}:${process.env.PATH ?? ''}` };
  try {
    await exec('git', ['init', '-q', root]); await installProvingGate(root);
    await writeFile(oracle, '#!/bin/sh\nprintf "PROOF_PASS\\n"\n', { mode: 0o700 });
    const before = await nexusStatus(root, env);
    assert.equal(before.code, 1); assert.match(before.output, /PG.*\[unmet\]/u);
    const passed = await exec('nexus', ['gates', 'check', '--approve'], { cwd: root, env, timeout: 30_000 });
    assert.match(passed.stdout + passed.stderr, /PG/u);
    const success = await nexusStatus(root, env);
    assert.equal(success.code, 0); assert.match(success.output, /PG.*\[met\]/u);
    await writeFile(oracle, '#!/bin/sh\nprintf "PROOF_FAIL\\n"\nexit 1\n');
    let failed = '';
    try { const checked = await exec('nexus', ['gates', 'check', '--approve', '--reverify'], { cwd: root, env, timeout: 30_000 }); failed = checked.stdout + checked.stderr; }
    catch (error) { failed = (error as { stdout?: string }).stdout ?? ''; }
    assert.match(failed, /PG/u);
    const failure = await nexusStatus(root, env);
    assert.equal(failure.code, 1); assert.match(failure.output, /PG.*\[unmet\]/u);
  } finally { await rm(root, { recursive: true, force: true }); await rm(userConfig, { recursive: true, force: true }); }
});
