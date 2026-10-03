// Coordinator-applied MCP runner. Source-authored only; checks remain QUEUED/UNRUN.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const PROVIDER_PINS = Object.freeze({
  mutation: '24592040f179d0b2e6a06e30a187d038980254e062e445e4f6b0ca3d4f68e6d0',
  parser: 'cea23ac28f1fa8f782ee53cc0c9cae766732c9c43a26144b128ce0cadaced8d3',
});
// This URL is relative to the coordinator's destination scripts/foundation-repairs/env-controls.mjs.
// The proposed metadata copy is not an executable entrypoint.
const helperURL = new URL('../../../parallel-foundation-agents/scripts/foundation-repairs/mutation-source.mjs', import.meta.url);
const parserURL = new URL('./jvm-report.mjs', helperURL);
function pinRead(url) {
  const file = fileURLToPath(url), maximum = 8 * 1024 * 1024;
  const before = fs.lstatSync(file);
  assert(before.isFile() && !before.isSymbolicLink() && before.size <= maximum, 'Bounded regular provider required');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const current = fs.fstatSync(descriptor);
    assert(current.isFile() && current.size === before.size && current.ino === before.ino && current.dev === before.dev, 'Provider changed before pin read');
    const bytes = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      assert(read > 0, 'Provider truncated during pin read'); offset += read;
    }
    assert.equal(fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset), 0, 'Provider grew during pin read');
    const after = fs.fstatSync(descriptor), retained = fs.lstatSync(file);
    assert(after.size === current.size && after.mtimeMs === current.mtimeMs && after.ctimeMs === current.ctimeMs
      && after.mode === current.mode && retained.isFile() && !retained.isSymbolicLink() && retained.mode === current.mode
      && retained.ino === current.ino && retained.dev === current.dev && retained.size === current.size
      && retained.mtimeMs === current.mtimeMs && retained.ctimeMs === current.ctimeMs, 'Provider changed during pin read');
    return bytes;
  } finally { fs.closeSync(descriptor); }
}
function requireProviderPins() {
  assert.equal(digest(pinRead(helperURL)), PROVIDER_PINS.mutation, 'Mutation provider source pin changed');
  assert.equal(digest(pinRead(parserURL)), PROVIDER_PINS.parser, 'Parser dependency source pin changed');
}
requireProviderPins(); // Read-only before dynamic import; no application child or main on import.
const provider = await import(helperURL.href);
requireProviderPins(); // Detect provider replacement across import; exclusive freeze remains required.
const { prepareMutation, readBoundedFile, inspectSourceFreeze, bindOwnedFailureStream, MUTATION_LIMITS } = provider;
export const OwnedChildGate = provider.OwnedChildGate;
export const OwnedSourceMutations = provider.OwnedSourceMutations;

const ordinaryNames = [
  'production default paths are exact immutable strings; layout resolution performs no file I/O',
  'explicit neutral init creates real lock and empty named variables without writing credentials or .env files',
  'real neutral init merges existing values and unrelated content without replacement',
  'neutral writers retain credential refusal and atomic no-partial-write behavior',
  'configured neutral private files are excluded by real local scanning and example names remain code-eligible',
  'custom secret globs extend canonical private-file refusals and cannot make defaults uploadable',
  'configured example symlink is refused before any lock or example commit',
];
const invalidPaths = ['', '/tmp/escape', '../escape', 'a/../escape', 'a\\escape', 'C:/escape', 'a//escape', 'a/./escape', 'dot-env*', 'dot-env\u0000'];
export const ENV_NAMES = Object.freeze([...ordinaryNames,
  ...invalidPaths.map(value => `invalid explicit path is refused before init I/O: ${JSON.stringify(value)}`),
  'private and example paths cannot alias on a case-insensitive filesystem',
]);
export const ENV_CONTROLS = Object.freeze([
  { id: 'E3-required-variable', file: 'src/init.ts',
    from: 'writer.mergeEnv(writer.resolve(environmentFiles.example), CLIENT_ENV,',
    to: "writer.mergeEnv(writer.resolve(environmentFiles.example), CLIENT_ENV.filter(entry => entry.key !== 'SWFTE_BASE_URL'),",
    test: ordinaryNames[1] },
  { id: 'E3-private-files', file: 'src/env-files.ts',
    from: "return [files.plain, files.local].map(file => `**/${file.split('/').pop()!}`);",
    to: 'void files; return [];', test: ordinaryNames[4] },
  { id: 'E3-case-alias', file: 'src/env-files.ts',
    from: 'new Set(Object.values(result).map(file => file.toLowerCase())).size !== 3',
    to: 'new Set(Object.values(result)).size !== 3',
    test: ENV_NAMES.at(-1) },
].map(control => Object.freeze({ ...control, operations: Object.freeze([
  Object.freeze({ exactMatch: control.from, replacement: control.to, expectedMatchCount: 1 }),
]) })));
const RAW_LIMIT = 16 * 1024 * 1024;
const COUNTERS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

/** Strict single-file root TAP, not a YAML regex search through arbitrary diagnostic text. */
export function parseEnvTap(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length <= RAW_LIMIT, 'Raw TAP byte limit');
  const text = bytes.toString('utf8');
  assert(Buffer.from(text, 'utf8').equals(bytes), 'TAP UTF8 round trip required');
  assert(text.endsWith('\n'), 'Truncated TAP final line');
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  assert.equal(lines.shift(), 'TAP version 13', 'TAP version required');
  const cases = [], counts = Object.create(null);
  let subtest = null, last = null, diagnostic = null, plan = null, summary = false, duration = false;
  const scalar = raw => {
    if (/^'[^']*'$/.test(raw)) return raw.slice(1, -1);
    if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) { try { return JSON.parse(raw); } catch {} }
    return raw;
  };
  for (const line of lines) {
    if (diagnostic) {
      if (line === '  ...') { last.diagnostic = diagnostic.fields; diagnostic = null; continue; }
      assert(line.startsWith('  ') && line !== '  ---', 'Malformed or unterminated diagnostic');
      // Only exact two-space YAML mapping fields count. Nested expected/error/stack scalars cannot supply code/name.
      const field = /^  ([A-Za-z_][A-Za-z0-9_]*):(?: (.*))?$/.exec(line);
      if (field) {
        assert(!Object.hasOwn(diagnostic.fields, field[1]), 'Duplicate diagnostic field');
        diagnostic.fields[field[1]] = scalar(field[2] ?? '');
      } else assert(/^ {4,}/.test(line) || line.trim() === '', 'Malformed diagnostic indentation');
      continue;
    }
    if (line === '') continue;
    if (line === '  ---') {
      assert(last && !last.diagnostic && !summary, 'Unexpected or duplicate diagnostic');
      diagnostic = { fields: Object.create(null) }; continue;
    }
    const sub = /^# Subtest: (.*)$/.exec(line);
    if (sub) {
      assert(!summary && subtest === null, 'Unexpected Subtest');
      assert.equal(sub[1], ENV_NAMES[cases.length], 'Subtest differs from current inventory');
      subtest = sub[1]; last = null; continue;
    }
    const result = /^(not ok|ok) ([1-9][0-9]*) - (.*)$/.exec(line);
    if (result) {
      assert(!summary && subtest !== null, 'Unexpected test inventory row');
      const id = Number(result[2]);
      assert(Number.isSafeInteger(id) && id === cases.length + 1, 'Test id sequence invalid');
      assert.equal(result[3], subtest, 'Test inventory name differs from Subtest');
      assert.equal(result[3], ENV_NAMES[cases.length], 'Current test inventory differs');
      last = { id, name: result[3], passed: result[1] === 'ok', diagnostic: null };
      cases.push(last); subtest = null; continue;
    }
    const declared = /^1\.\.([0-9]+)$/.exec(line);
    if (declared) {
      assert(plan === null && subtest === null, 'Duplicate plan or incomplete inventory count');
      plan = Number(declared[1]); assert(Number.isSafeInteger(plan) && plan === ENV_NAMES.length, 'Invalid plan');
      summary = true; continue;
    }
    const counter = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (.*)$/.exec(line);
    if (counter) {
      assert(summary && !Object.hasOwn(counts, counter[1]), 'Duplicate counter or premature plan summary');
      assert(/^(0|[1-9][0-9]*)$/.test(counter[2]), 'Malformed counter');
      const value = Number(counter[2]); assert(Number.isSafeInteger(value), 'Unsafe counter integer');
      counts[counter[1]] = value; continue;
    }
    if (/^# duration_ms /.test(line)) {
      assert(summary && !duration && /^# duration_ms (?:[0-9]+(?:\.[0-9]+)?)$/.test(line), 'Malformed duration counter');
      const value = Number(line.slice('# duration_ms '.length)); assert(Number.isFinite(value), 'Unsafe duration counter');
      duration = true; continue;
    }
    // Ordinary console comments are not tests or diagnostics. Reserved malformed framing refuses.
    assert(line.startsWith('# ') && !/^# (?:Subtest:|tests\b|suites\b|pass\b|fail\b|cancelled\b|skipped\b|todo\b|duration_ms\b)/.test(line), 'Unexpected TAP structure');
  }
  assert(!diagnostic, 'Unterminated diagnostic');
  assert(plan === ENV_NAMES.length, 'Complete plan required');
  assert(subtest === null && cases.length === ENV_NAMES.length, 'Complete current inventory count required');
  for (const name of COUNTERS) assert(Object.hasOwn(counts, name), 'Missing counter: ' + name);
  assert(counts.tests === ENV_NAMES.length && counts.suites === 0, 'Counter inventory mismatch');
  for (const name of ['cancelled', 'skipped', 'todo']) assert.equal(counts[name], 0, 'Unsupported counter: ' + name);
  assert.equal(counts.pass, cases.filter(row => row.passed).length, 'Pass counter differs from actual cases');
  assert.equal(counts.fail, cases.filter(row => !row.passed).length, 'Fail counter differs from actual cases');
  assert.equal(counts.pass + counts.fail, counts.tests, 'Counter sum differs from inventory');
  for (const row of cases) {
    const fields = row.diagnostic;
    row.assertion = !row.passed && fields?.failureType === 'testCodeFailure'
      && fields?.code === 'ERR_ASSERTION' && fields?.name === 'AssertionError';
    if (row.passed) assert(!fields?.failureType && !fields?.code && !fields?.name, 'Passed case contains failure diagnostic');
    row.diagnostic = fields ? Object.fromEntries(['failureType', 'code', 'name'].filter(key => Object.hasOwn(fields, key)).map(key => {
      assert(typeof fields[key] === 'string' && fields[key].length <= 128, 'Diagnostic semantic field limit');
      return [key, fields[key]];
    })) : null;
  }
  return { counts: { ...counts }, cases };
}

export function evaluateEnvExecution(run, control = null) {
  if (!run || run.signal != null || run.spawnError != null || run.interrupted === true
      || run.logError || run.pipeErrors?.length || run.outputErrors?.length || !run.tap) return { accepted: false };
  const { counts, cases } = run.tap;
  if (!counts || !Array.isArray(cases) || cases.length !== ENV_NAMES.length
      || cases.some((row, index) => row.name !== ENV_NAMES[index]) || counts.tests !== ENV_NAMES.length
      || ['cancelled', 'skipped', 'todo'].some(key => counts[key] !== 0)) return { accepted: false };
  if (!control) return { accepted: run.exitCode === 0 && counts.pass === ENV_NAMES.length && counts.fail === 0 && cases.every(row => row.passed) };
  const failures = cases.filter(row => !row.passed);
  return { accepted: run.exitCode === 1 && failures.length > 0 && failures.length === counts.fail
    && failures.every(row => row.assertion === true)
    && failures.filter(row => row.name === control.test).length === 1 };
}

export function requireEnvAdmission({ phase, freeze, source, expected }) {
  assert(phase?.marker === 'VALIDATION' && phase.sourceFirst === false, 'Explicit validation phase required');
  assert(freeze?.current === true, 'Current exclusive source freeze required');
  assert(source && expected, 'Whole source identity required');
  for (const key of ['sha', 'tree', 'fingerprint']) {
    const pattern = key === 'fingerprint' ? /^[a-f0-9]{64}$/ : /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
    assert(typeof source[key] === 'string' && pattern.test(source[key]) && pattern.test(expected[key] ?? ''), 'Malformed source identity');
    assert.equal(source[key], expected[key], 'Current full source differs: ' + key);
  }
}

/** No backup sweep. Only pending mutations owned by this helper may restore after actual child close. */
export async function performOwnedMutation({ owner, childGate, control, original, admit, run, signalOwnedGroup }) {
  let execution = null, error = null, restoration;
  try {
    await admit('before-mutation'); assert(!childGate.interrupted, 'Interrupted mutation admission');
    const mutant = prepareMutation(original, control.operations);
    owner.writeMutation(control.file, mutant);
    await admit('before-run', { mutant });
    execution = await run({ mutant });
  } catch (failed) {
    error = failed;
    if (!childGate.canRestore) await childGate.stop('SIGTERM', signalOwnedGroup);
  } finally {
    await childGate.waitForClose();
    restoration = childGate.restoreWhenClosed(owner);
  }
  return { execution, error, restoration };
}

function mainSource(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const inventory = () => [git(['ls-files', '-z']), git(['ls-files', '--others', '--exclude-standard', '-z'])];
  const before = inventory(), sha = git(['rev-parse', 'HEAD']).trim(), tree = git(['rev-parse', 'HEAD^{tree}']).trim();
  const names = [...new Set(before.flatMap(text => text.split('\0')))].filter(file => file && !file.startsWith('.unlazy/')
    && (/^(src\/|api\/|test\/|scripts\/|docs\/)/.test(file) || ['package.json', 'package-lock.json', 'tsconfig.json', 'tsup.config.ts', 'README.md', 'LICENSE'].includes(file))).sort();
  assert(names.length > 0 && names.length <= 4096, 'Full source inventory limit');
  let total = 0;
  const modes = [];
  const files = names.map(file => {
    assert(!file.includes('\\') && !file.split('/').some(part => !part || part === '..' || part === '.'), 'Unsafe source path');
    const modeBefore = fs.lstatSync(path.join(root, file));
    const bytes = readBoundedFile(root, file, MUTATION_LIMITS.originalBytes); total += bytes.length;
    const modeAfter = fs.lstatSync(path.join(root, file));
    assert(modeBefore.mode === modeAfter.mode && modeBefore.ino === modeAfter.ino && modeBefore.dev === modeAfter.dev, 'Source mode or inode changed during observation');
    modes.push({ file, mode: modeAfter.mode });
    assert(total <= MUTATION_LIMITS.originalTotalBytes, 'Full source aggregate byte limit');
    return { file, sha256: digest(bytes) };
  });
  assert.deepEqual(inventory(), before, 'Source inventory changed during observation');
  assert.equal(git(['rev-parse', 'HEAD']).trim(), sha, 'Source commit changed during observation');
  assert.equal(git(['rev-parse', 'HEAD^{tree}']).trim(), tree, 'Source tree changed during observation');
  return { sha, tree, fingerprint: digest(JSON.stringify(files)), modeFingerprint: digest(JSON.stringify(modes)), files };
}

async function main(mode) {
  const root = fs.realpathSync(process.cwd());
  assert.equal(path.basename(root), 'parallel-foundation-mcp', 'Allocated MCP required');
  const backend = path.dirname(fileURLToPath(helperURL)).replace(/[\\/]scripts[\\/]foundation-repairs$/, '');
  const tracking = path.join(backend, '.unlazy/parallel/foundation-repairs');
  const phase = () => JSON.parse(readBoundedFile(backend, '.unlazy/parallel/foundation-repairs/progress.json', 1024 * 1024).toString('utf8')).phase;
  assert(['plan', 'all'].includes(mode), 'Use plan or all');
  // Hard refusal before any application child, source mutation or positive receipt command.
  if (mode === 'all') assert(phase()?.marker === 'VALIDATION' && phase()?.sourceFirst === false, 'Explicit validation phase required');
  const baseline = mainSource(root);
  const originals = new Map([...new Set(ENV_CONTROLS.map(control => control.file))].map(file => [file, readBoundedFile(root, file, MUTATION_LIMITS.originalBytes)]));
  for (const control of ENV_CONTROLS) prepareMutation(originals.get(control.file), control.operations);
  if (mode === 'plan') {
    console.log(JSON.stringify({ controls: ENV_CONTROLS.map(({ id, file, test }) => ({ id, file, test, beforeSha256: digest(originals.get(file)) })), names: ENV_NAMES, source: baseline, testsExecuted: 0, mutationsExecuted: 0 }, null, 2)); return;
  }
  const guardKey = digest(root).slice(0, 16);
  const guardFile = `/Users/dejanmaksimovic/Projects/Swfte/.unlazy/heavy/wt-${guardKey}/owner.json`;
  const guardBytes = readBoundedFile(path.dirname(guardFile), 'owner.json', 1024 * 1024);
  assert.equal(JSON.parse(guardBytes).pid, process.ppid, 'Launch directly through heavy.mjs');
  assert.equal(process.env.NODE_OPTIONS, '--max-old-space-size=1536', 'Bounded Node memory required');
  assert.equal(JSON.parse(readBoundedFile(backend, '.unlazy/parallel/foundation-repairs/dependency-maintenance-hold.json', 1024 * 1024)).held, false, 'Maintenance release required');
  const freezeFile = '.unlazy/foundation-repairs/contracts/mcp-env-source-freeze.json';
  const freezeBytes = readBoundedFile(root, freezeFile, 1024 * 1024), freeze = JSON.parse(freezeBytes);
  assert(freeze.active === true && freeze.allProductWritersFrozen === true && freeze.worktree === root
    && freeze.coordinator === '/root' && freeze.scope === 'foundation-repairs', 'Explicit MCP exclusive freeze required');
  assert.deepEqual(freeze.providerPins, PROVIDER_PINS, 'Frozen immutable providers required');
  for (const [file, original] of originals) assert(freeze.paths?.some(item => item.path === file && item.sha256 === digest(original)), 'Declared mutation path must be frozen');
  const childGate = new OwnedChildGate(), owner = new OwnedSourceMutations(root, originals);
  const admit = expected => {
    requireProviderPins();
    const current = mainSource(root);
    requireEnvAdmission({ phase: phase(), freeze: inspectSourceFreeze(root, freezeFile, freezeBytes), source: current, expected });
    assert.equal(current.modeFingerprint, baseline.modeFingerprint, 'Current full source modes changed');
    assert.equal(freeze.source?.modeFingerprint, baseline.modeFingerprint, 'Source freeze modes missing or changed');
    for (const key of ['sha', 'tree', 'fingerprint']) assert.equal(freeze.source?.[key], baseline[key], 'Source freeze baseline changed: ' + key);
    assert(!childGate.interrupted, 'Interrupted child admission');
  };
  admit(baseline);
  const startedAt = new Date().toISOString();
  const evidence = path.join(tracking, 'evidence', `mcp-env-controls-${startedAt.replaceAll(':', '-')}`);
  fs.mkdirSync(evidence, { recursive: true });
  for (const [file, bytes] of originals) fs.writeFileSync(path.join(evidence, `${path.basename(file)}.original`), bytes, { flag: 'wx' });
  const result = { startedAt, source: baseline, providerPins: PROVIDER_PINS, sourceFreeze: { path: freezeFile, sha256: digest(freezeBytes) }, controls: [], baselinePositive: null, restoredPositive: null, restorations: [], accepted: false };
  const signalOwnedGroup = (signal, child) => {
    assert(child && Number.isSafeInteger(child.pid) && child.pid > 0, 'Actual spawned detached child pid required');
    process.kill(-child.pid, signal); // Only this explicit spawned group; never enumerate other sessions.
  };
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => { result.interrupted = signal; void childGate.stop(signal, signalOwnedGroup); }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  let rawTotal = 0;
  const publicationErrors = [];
  const publicationFailure = bindOwnedFailureStream(process.stdout, childGate, signalOwnedGroup, error => {
    publicationErrors.push({ name: error.name, message: error.message, code: error.code }); result.accepted = false;
  });
  async function run(label, expected) {
    admit(expected);
    const logFile = path.join(evidence, label + '.tap'), out = fs.createWriteStream(logFile, { flags: 'wx' });
    let logError = null, bytesWritten = 0, forwarded = 0;
    const pipeErrors = [], outputErrors = [];
    const flushed = new Promise(resolve => { out.once('finish', resolve); out.once('error', resolve); });
    const logFailure = bindOwnedFailureStream(out, childGate, signalOwnedGroup, error => { logError = error; });
    const outputFailure = bindOwnedFailureStream(process.stdout, childGate, signalOwnedGroup, error => { outputErrors.push(error); });
    let exit, timeout;
    try {
      admit(expected);
      const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'test/env-files.test.ts'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = childGate.attach(child);
      timeout = setTimeout(() => logFailure(Object.assign(new Error('Owned child time limit'), { code: 'CHILD_TIMEOUT' })), 60000);
      timeout.unref?.();
      for (const stream of [child.stdout, child.stderr]) {
        assert(stream, 'Owned child pipe required');
        bindOwnedFailureStream(stream, childGate, signalOwnedGroup, error => { pipeErrors.push(error); });
        stream.on('data', bytes => {
          if (!logError && !childGate.interrupted) {
            if (bytesWritten + bytes.length > RAW_LIMIT || rawTotal + bytes.length > MUTATION_LIMITS.reportTotalBytes) logFailure(Object.assign(new Error('Raw log byte limit'), { code: 'LOG_LIMIT' }));
            else { bytesWritten += bytes.length; rawTotal += bytes.length; try { out.write(bytes); } catch (error) { logFailure(error); } }
          }
          if (!outputErrors.length && !childGate.interrupted) {
            if (forwarded + bytes.length > RAW_LIMIT) outputFailure(Object.assign(new Error('Forwarded output byte limit'), { code: 'OUTPUT_LIMIT' }));
            else { forwarded += bytes.length; try { process.stdout.write(bytes); } catch (error) { outputFailure(error); } }
          }
        });
      }
      exit = await closed;
    } catch (error) {
      if (!childGate.canRestore) await childGate.stop('SIGTERM', signalOwnedGroup);
      await childGate.waitForClose(); throw error;
    } finally {
      clearTimeout(timeout); // Cleared only after actual close, including the catch wait.
      out.end(); await flushed;
      process.stdout.removeListener('error', outputFailure);
    }
    admit(expected);
    assert(!logError && pipeErrors.length === 0 && outputErrors.length === 0, 'Owned output unavailable');
    const raw = readBoundedFile(backend, path.relative(backend, logFile), RAW_LIMIT), tap = parseEnvTap(raw);
    return { ...exit, tap, counts: tap.counts, failures: tap.cases.filter(row => !row.passed), log: { path: path.relative(backend, logFile), sha256: digest(raw), bytes: raw.length } };
  }
  const mutantIdentity = (file, mutant) => {
    assert(baseline.files.some(item => item.file === file), 'Mutant path absent from source inventory');
    const files = baseline.files.map(item => item.file === file ? { file, sha256: digest(mutant) } : item);
    return { ...baseline, files, fingerprint: digest(JSON.stringify(files)) };
  };
  try {
    result.baselinePositive = await run('baseline-positive', baseline);
    assert(evaluateEnvExecution(result.baselinePositive).accepted, 'Fresh complete baseline positive required');
    for (const control of ENV_CONTROLS) {
      assert(result.baselinePositive.tap.cases.some(row => row.name === control.test && row.passed), 'Exact target positive required');
      const mutant = prepareMutation(originals.get(control.file), control.operations), expected = mutantIdentity(control.file, mutant);
      const attempt = await performOwnedMutation({ owner, childGate, control, original: originals.get(control.file), signalOwnedGroup,
        admit(stage) { admit(stage === 'before-mutation' ? baseline : expected); },
        run() { return run(control.id, expected); } });
      result.restorations.push(attempt.restoration);
      assert(attempt.restoration.ok, 'Owned restoration conflict; preserve foreign work');
      if (attempt.error) throw attempt.error;
      admit(baseline);
      const check = { id: control.id, file: control.file, expectedTest: control.test, mutantSource: expected, ...attempt.execution,
        restoredFingerprint: baseline.fingerprint, killed: evaluateEnvExecution(attempt.execution, control).accepted };
      result.controls.push(check); assert(check.killed, 'Exact target behavioral assertion required: ' + control.id);
    }
    admit(baseline);
    result.restoredPositive = await run('restored-positive', baseline);
    assert(evaluateEnvExecution(result.restoredPositive).accepted, 'Fresh restored positive required');
    admit(baseline); result.afterSource = mainSource(root); admit(baseline); result.accepted = true;
  } catch (error) { result.failure = { name: error.name, message: error.message }; }
  finally {
    if (!childGate.canRestore) await childGate.stop('SIGTERM', signalOwnedGroup);
    await childGate.waitForClose();
    const restoration = childGate.restoreWhenClosed(owner); result.restorations.push(restoration);
    if (!restoration.ok || childGate.interrupted) result.accepted = false;
    result.stopErrors = childGate.stopErrors; result.finishedAt = new Date().toISOString();
    try { result.restoredSource = mainSource(root); if (result.accepted) admit(baseline); }
    catch (error) { result.accepted = false; result.failure = { name: error.name, message: error.message }; }
  }
  const resultFile = path.join(evidence, 'result.json'), pointerFile = path.join(tracking, 'reports/mcp-env-controls.json');
  fs.mkdirSync(path.dirname(pointerFile), { recursive: true });
  const writeReceipt = initial => {
    const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n'); assert(bytes.length <= RAW_LIMIT, 'Receipt byte limit');
    fs.writeFileSync(resultFile, bytes, { flag: initial ? 'wx' : 'w' });
    fs.writeFileSync(pointerFile, JSON.stringify({ path: path.relative(backend, resultFile), sha256: digest(bytes), accepted: result.accepted }, null, 2) + '\n');
  };
  try {
    if (childGate.interrupted || publicationErrors.length) result.accepted = false;
    result.publicationErrors = publicationErrors;
    writeReceipt(true);
    if (result.accepted) {
      try {
        admit(baseline);
        await new Promise((resolve, reject) => {
          try { process.stdout.write('FOUNDATION_MCP_ENV_CONTROLS_OK controls=3 restoredPositive=true\n', error => error ? reject(error) : resolve()); }
          catch (error) { reject(error); }
        });
        // A flushed token is not authoritative independently of its current accepted receipt.
        admit(baseline);
        assert(!publicationErrors.length && !childGate.interrupted, 'Interrupted or failed final publication');
      } catch (error) {
        result.accepted = false; result.failure = { name: error.name, message: error.message };
        result.publicationErrors = publicationErrors; writeReceipt(false);
      }
    }
    if (!result.accepted) process.exitCode = 1;
  } finally {
    // Keep lifetime output/signal fences through receipt, token flush and final source admission.
    process.stdout.removeListener('error', publicationFailure);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) await main(process.argv[2]);
