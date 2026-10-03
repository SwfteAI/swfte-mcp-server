import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_ROOT, sha256 } from './fixtures/phase5-contracts/index.js';

const SCRIPT = new URL('../scripts/sync-derived-fixture.mjs', import.meta.url).pathname;
const GOLDEN = 'two-input-workflow.golden.json';
const fixture = (name: string) => readFileSync(new URL(name, FIXTURE_ROOT));

test('the committed golden, its .sha256, the captured workflow and the provenance all agree', () => {
  const golden = fixture(GOLDEN);
  const digest = sha256(golden);
  assert.equal(fixture(`${GOLDEN}.sha256`).toString('utf8').trim(), `${digest}  ${GOLDEN}`, 'the .sha256 file disagrees with the golden bytes');
  assert.equal(JSON.parse(fixture('provenance.json').toString('utf8')).derivedGoldenSha256, digest, 'provenance disagrees with the golden bytes');
  assert.ok(fixture('workflow_wf_1.contract.json').equals(golden), 'the captured unpinned workflow must equal the golden');
  assert.equal(fixture('workflow_wf_1.contract.json.sha256').toString('utf8').trim(), `${digest}  workflow_wf_1.contract.json`);
  assert.deepEqual(JSON.parse(golden.toString('utf8')).invoke.outputPath, ['execution', 'outputData', 'parameters', 'end_1']);
});

/** A throwaway agents-service root holding the golden, plus a private copy of the fixture folder. */
function sandbox(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'swfte-fixture-sync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const backend = join(dir, 'agents-service');
  const goldenDir = join(backend, 'src/test/resources/catalog/g3');
  mkdirSync(goldenDir, { recursive: true });
  const backendGolden = join(goldenDir, 'two-input-workflow.contract.json');
  writeFileSync(backendGolden, fixture(GOLDEN));
  const fixtures = join(dir, 'fixtures');
  cpSync(new URL('./', FIXTURE_ROOT).pathname, fixtures, { recursive: true });
  const run = (...extra: string[]) => spawnSync(process.execPath, [SCRIPT, backend, '--fixtures', fixtures, ...extra], { encoding: 'utf8' });
  return { backendGolden, fixtures, run };
}

test('check passes when the copy equals the backend golden', t => {
  const { run } = sandbox(t);
  const result = run('--check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DERIVED_FIXTURE_IN_SYNC/);
});

test('check fails when the .sha256 and the golden disagree (negative control)', t => {
  const { fixtures, run } = sandbox(t);
  writeFileSync(join(fixtures, `${GOLDEN}.sha256`), `${'0'.repeat(64)}  ${GOLDEN}\n`);
  const result = run('--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DERIVED_FIXTURE_DRIFT.*two-input-workflow\.golden\.json\.sha256/);
});

test('check fails when the copied golden bytes differ from the backend', t => {
  const { fixtures, run } = sandbox(t);
  writeFileSync(join(fixtures, GOLDEN), Buffer.concat([readFileSync(join(fixtures, GOLDEN)), Buffer.from(' ')]));
  const result = run('--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DERIVED_FIXTURE_DRIFT/);
});

test('check fails when the backend golden moves on and the copy does not', t => {
  const { backendGolden, run } = sandbox(t);
  const moved = JSON.parse(readFileSync(backendGolden, 'utf8'));
  moved.invoke.outputPath = ['execution', 'outputData', 'parameters', 'end_2'];
  writeFileSync(backendGolden, JSON.stringify(moved, null, 2));
  const result = run('--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DERIVED_FIXTURE_DRIFT/);
});

test('sync repairs every mirrored record and a following check passes', t => {
  const { backendGolden, fixtures, run } = sandbox(t);
  const moved = JSON.parse(readFileSync(backendGolden, 'utf8'));
  moved.invoke.outputPath = ['execution', 'outputData', 'parameters', 'end_2'];
  writeFileSync(backendGolden, JSON.stringify(moved, null, 2));
  const synced = run();
  assert.equal(synced.status, 0, synced.stderr);
  const digest = sha256(readFileSync(backendGolden));
  assert.ok(readFileSync(join(fixtures, GOLDEN)).equals(readFileSync(backendGolden)));
  assert.equal(readFileSync(join(fixtures, `${GOLDEN}.sha256`), 'utf8'), `${digest}  ${GOLDEN}\n`);
  assert.equal(JSON.parse(readFileSync(join(fixtures, 'provenance.json'), 'utf8')).derivedGoldenSha256, digest);
  assert.equal(run('--check').status, 0);
});

test('--expect-sha refuses a backend golden with another digest and changes nothing', t => {
  const { fixtures, run } = sandbox(t);
  const before = readFileSync(join(fixtures, GOLDEN));
  const result = run('--expect-sha', '1'.repeat(64));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected 1{64}; nothing changed/);
  assert.ok(readFileSync(join(fixtures, GOLDEN)).equals(before));
});

test('a missing backend golden is an error, not a silent pass', t => {
  const { backendGolden, run } = sandbox(t);
  rmSync(backendGolden);
  const result = run('--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backend golden not found/);
});
