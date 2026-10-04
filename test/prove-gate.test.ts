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
// Hermetic: a throwaway HOME, a throwaway git repo and a PATH-local `swfte` oracle per repo. The oracle records every
// invocation in a log, so a Nexus that never discovers or runs the ledger cannot make these tests pass vacuously.
// Nexus 0.3.4 does not turn a gate that was already recorded met back to unmet when `--reverify` fails, so the
// negative here is a gate whose oracle fails from the start (a separate repo), plus the reverify run itself reporting FAIL.
async function nexusRepo(oracleBody: string) {
  const root = await mkdtemp(join(tmpdir(), 'prove-real-nexus-')); const userConfig = await mkdtemp(join(tmpdir(), 'prove-nexus-home-'));
  const bins = join(root, 'bin'); await mkdir(bins);
  const oracle = join(bins, 'swfte'); const log = join(userConfig, 'oracle.log');
  const env = { ...process.env, HOME: userConfig, PATH: `${bins}:${process.env.PATH ?? ''}` };
  await exec('git', ['init', '-q', root]); await installProvingGate(root);
  const script = (body: string) => `#!/bin/sh\necho invoked >> '${log}'\n${body}\n`;
  await writeFile(oracle, script(oracleBody), { mode: 0o700 });
  const calls = async () => { try { return (await readFile(log, 'utf8')).split('\n').filter(Boolean).length; } catch { return 0; } };
  const cleanup = async () => { await rm(root, { recursive: true, force: true }); await rm(userConfig, { recursive: true, force: true }); };
  return { root, env, oracle, script, calls, cleanup };
}
async function nexusCheck(root: string, env: NodeJS.ProcessEnv, extra: string[]): Promise<{ output: string; code: number }> {
  try { const r = await exec('nexus', ['gates', 'check', '--approve', ...extra], { cwd: root, env, timeout: 30_000 }); return { output: r.stdout + r.stderr, code: 0 }; }
  catch (error) { const r = error as { code?: number; stdout?: string; stderr?: string }; if (r.code !== 1) throw error; return { output: (r.stdout ?? '') + (r.stderr ?? ''), code: 1 }; }
}
test('installed unmodified Nexus discovers PG and a passing oracle makes it met', async () => {
  const repo = await nexusRepo('printf "PROOF_PASS\\n"');
  try {
    const before = await nexusStatus(repo.root, repo.env);
    assert.equal(before.code, 1); assert.match(before.output, /PG.*\[unmet\]/u); assert.equal(await repo.calls(), 0);
    const passed = await nexusCheck(repo.root, repo.env, []);
    assert.equal(passed.code, 0); assert.match(passed.output, /PASS PG/u); assert.match(passed.output, /EXPECT=matched/u);
    assert.equal(await repo.calls(), 1, 'the oracle must actually have run');
    const after = await nexusStatus(repo.root, repo.env);
    assert.equal(after.code, 0); assert.match(after.output, /PG.*\[met\]/u);
  } finally { await repo.cleanup(); }
});
test('installed unmodified Nexus leaves PG unmet when the oracle fails, and a failing reverify reports FAIL', async () => {
  const failing = await nexusRepo('printf "PROOF_FAIL\\n"\nexit 1');
  const passing = await nexusRepo('printf "PROOF_PASS\\n"');
  try {
    const checked = await nexusCheck(failing.root, failing.env, []);
    assert.equal(checked.code, 1); assert.match(checked.output, /FAIL PG/u); assert.match(checked.output, /EXPECT=not matched/u);
    assert.equal(await failing.calls(), 1, 'the failing oracle must actually have run');
    const status = await nexusStatus(failing.root, failing.env);
    assert.equal(status.code, 1); assert.match(status.output, /PG.*\[unmet\]/u);
    // positive control in the same test: the identical flow with a passing oracle IS met, so "unmet" above is the oracle's doing
    assert.equal((await nexusCheck(passing.root, passing.env, [])).code, 0);
    assert.equal((await nexusStatus(passing.root, passing.env)).code, 0);
    // the oracle turning bad after a pass: the reverify run itself must fail and report the failing oracle
    await writeFile(passing.oracle, passing.script('printf "PROOF_FAIL\\n"\nexit 1'), { mode: 0o700 });
    const before = await passing.calls();
    const reverify = await nexusCheck(passing.root, passing.env, ['--reverify']);
    assert.equal(reverify.code, 1); assert.match(reverify.output, /FAIL PG/u);
    assert.equal(await passing.calls(), before + 1, 'reverify must re-run the oracle');
  } finally { await failing.cleanup(); await passing.cleanup(); }
});
