import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const root = process.cwd();
assert.equal(path.basename(root), 'parallel-foundation-mcp');
const backend = path.resolve(root, '../parallel-foundation-agents');
const tracking = path.join(backend, '.unlazy/parallel/foundation-repairs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = () => JSON.parse(execFileSync(process.execPath, ['scripts/foundation-repairs/check.mjs', 'source'], { cwd: root, encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }));
const controls = [
  { id: 'E3-required-variable', file: 'src/init.ts',
    from: 'writer.mergeEnv(writer.resolve(environmentFiles.example), CLIENT_ENV,',
    to: "writer.mergeEnv(writer.resolve(environmentFiles.example), CLIENT_ENV.filter(entry => entry.key !== 'SWFTE_BASE_URL'),",
    test: 'explicit neutral init creates real lock and empty named variables without writing credentials or .env files' },
  { id: 'E3-private-files', file: 'src/env-files.ts',
    from: "return [files.plain, files.local].map(file => `**/${file.split('/').pop()!}`);",
    to: 'void files; return [];',
    test: 'configured neutral private files are excluded by real local scanning and example names remain code-eligible' },
  { id: 'E3-case-alias', file: 'src/env-files.ts',
    from: 'new Set(Object.values(result).map(file => file.toLowerCase())).size !== 3',
    to: 'new Set(Object.values(result)).size !== 3',
    test: 'private and example paths cannot alias on a case-insensitive filesystem' },
];
const originals = new Map();
for (const control of controls) {
  const bytes = fs.readFileSync(path.join(root, control.file));
  const text = bytes.toString('utf8');
  assert.equal(text.split(control.from).length, 2, `Unique source anchor required: ${control.id}`);
  originals.set(control.file, bytes);
}
if (process.argv[2] === 'plan') {
  console.log(JSON.stringify({ controls: controls.map(({ id, file, test }) => ({ id, file, test, beforeSha256: hash(originals.get(file)) })), testsExecuted: 0, mutationsExecuted: 0 }, null, 2));
  process.exit(0);
}
assert.equal(process.argv[2], 'all', 'Use plan or all');
const guardKey = hash(root).slice(0, 16);
const guard = JSON.parse(fs.readFileSync(`/Users/dejanmaksimovic/Projects/Swfte/.unlazy/heavy/wt-${guardKey}/owner.json`, 'utf8'));
assert.equal(guard.pid, process.ppid, 'Launch directly through heavy.mjs');
assert.equal(process.env.NODE_OPTIONS, '--max-old-space-size=1536');
assert.equal(JSON.parse(fs.readFileSync(path.join(tracking, 'dependency-maintenance-hold.json'), 'utf8')).held, false);
execFileSync(process.execPath, ['scripts/foundation-repairs/check-result.mjs', 'env-files'], { cwd: root, stdio: 'inherit' });
const before = source();
const startedAt = new Date().toISOString();
const evidence = path.join(tracking, 'evidence', `mcp-env-controls-${startedAt.replaceAll(':', '-')}`);
fs.mkdirSync(evidence, { recursive: true });
for (const [file, bytes] of originals) fs.writeFileSync(path.join(evidence, `${path.basename(file)}.original`), bytes, { flag: 'wx' });
let child;
let interrupted = null;
const restore = () => {
  for (const [file, bytes] of originals) {
    fs.writeFileSync(path.join(root, file), bytes);
    assert.equal(hash(fs.readFileSync(path.join(root, file))), hash(bytes), `Exact restoration: ${file}`);
  }
};
const signalHandlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
  interrupted = signal;
  if (child) child.kill(signal);
}]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
async function run(id) {
  const log = path.join(evidence, `${id}.tap`);
  const out = fs.createWriteStream(log, { flags: 'wx' });
  child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'test/env-files.test.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => out.write(bytes));
  let exitCode;
  try { exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { child = undefined; await new Promise(resolve => out.end(resolve)); }
  const tap = fs.readFileSync(log, 'utf8');
  const n = name => Number([...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))].at(-1)?.[1] ?? NaN);
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name => [name, n(name)]));
  const blocks = tap.split(/(?=^not ok \d+ - )/m).filter(block => block.startsWith('not ok '));
  const failures = blocks.map(block => ({ name: block.split('\n')[0].replace(/^not ok \d+ - /, ''), assertion: /code: ['"]?ERR_ASSERTION['"]?/.test(block), diagnostic: block.slice(0, 16000) }));
  return { exitCode, counts, failures, log: { path: path.relative(backend, log), sha256: hash(tap) } };
}
const result = { startedAt, source: before, controls: [], restoredPositive: null, accepted: false };
try {
  for (const control of controls) {
    assert.equal(interrupted, null, `Interrupted: ${interrupted}`);
    const original = originals.get(control.file);
    assert.equal(hash(fs.readFileSync(path.join(root, control.file))), hash(original));
    const changed = original.toString('utf8').replace(control.from, control.to);
    let check;
    try {
      fs.writeFileSync(path.join(root, control.file), changed);
      const mutantSource = source();
      check = { id: control.id, file: control.file, expectedTest: control.test, mutantSource, ...(await run(control.id)) };
    } finally { restore(); }
    check.restoredFingerprint = source().fingerprint;
    check.killed = check.exitCode === 1 && check.counts.tests === 18 && check.counts.fail > 0
      && ['cancelled', 'skipped', 'todo'].every(key => check.counts[key] === 0)
      && check.failures.length === check.counts.fail && check.failures.every(failure => failure.assertion)
      && check.failures.some(failure => failure.name === control.test)
      && check.restoredFingerprint === before.fingerprint;
    result.controls.push(check);
    assert.equal(interrupted, null, `Interrupted: ${interrupted}`);
    assert(check.killed, `Expected behavioral assertion and exact restoration required: ${control.id}`);
  }
  result.restoredPositive = await run('restored-positive');
  assert.equal(interrupted, null, `Interrupted: ${interrupted}`);
  const positive = result.restoredPositive;
  assert(positive.exitCode === 0 && positive.counts.tests === 18 && positive.counts.pass === 18);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(positive.counts[key], 0);
  result.afterSource = source();
  assert.equal(result.afterSource.fingerprint, before.fingerprint);
  result.accepted = true;
} catch (error) {
  result.failure = error instanceof Error ? error.message : String(error);
} finally {
  restore();
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  result.finishedAt = new Date().toISOString();
  result.interrupted = interrupted;
  result.restoredSource = source();
  const file = path.join(evidence, 'result.json');
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  fs.mkdirSync(path.join(tracking, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(tracking, 'reports/mcp-env-controls.json'), JSON.stringify({ path: path.relative(backend, file), sha256: hash(fs.readFileSync(file)), accepted: result.accepted }, null, 2) + '\n');
}
if (!result.accepted) {
  console.error(`FOUNDATION_MCP_ENV_CONTROLS_FAILED ${result.failure}`);
  process.exit(1);
}
console.log('FOUNDATION_MCP_ENV_CONTROLS_OK controls=3 restoredPositive=true');
