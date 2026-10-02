#!/usr/bin/env node
/**
 * Real source controls for original05 MCP Connections. Run only through heavy.
 * Requires a passing current focused baseline and typecheck. A control counts
 * only a named ERR_ASSERTION failure, never a compiler/loader/transport error.
 * Journals original bytes, restores each mutation, checks the complete source
 * fingerprint, then reruns the restored positive baseline. No backend calls.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HEAVY = '/Users/dejanmaksimovic/Projects/Swfte/.unlazy/tools/heavy.mjs';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const EVIDENCE = join(ROOT, '.unlazy/connections-mcp/mutation-evidence', RUN_ID);
const LOCK = join(ROOT, '.unlazy/connections-mcp/mutation-active.json');
const OWNED = ['src/connections.ts', 'src/client.ts', 'src/config.ts', 'src/tools/connect.ts',
  'src/tools/verify.ts', 'src/tools/ship.ts', 'test/connections.test.ts',
  'scripts/connections-parity.mjs', 'scripts/connections-mutations.mjs'];
const CANARY = ['meadow', 'willow', 'amber', 'fern'][randomInt(4)] + ' '
  + ['granite', 'river', 'sparrow', 'orchard'][randomInt(4)];
const receipt = { kind: 'original05-mcp-source-controls', state: 'REFUSED',
  startedAt: new Date().toISOString(), controls: [] };
const originals = new Map();
const expectedMutated = new Map();
let activeChild, phase = 'guard', lockFd, stopped = false;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const requireCondition = (condition, code) => { if (!condition) throw new Error(code); };
const regexp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const controls = [
  { id: 'M_ALIAS', path: 'src/connections.ts',
    target: 'the google-youtube alias uses the server canonical google provider',
    from: 'export async function inspectConnections(client: SwfteClient, workflow: unknown, workflowId?: string): Promise<ConnectionInspection> {\n  if (client.serverConnectionsEnabled) {',
    to: 'export async function inspectConnections(client: SwfteClient, workflow: unknown, workflowId?: string): Promise<ConnectionInspection> {\n  if (false) {' },
  { id: 'M11_CREDENTIAL_FIELD', path: 'src/connections.ts',
    target: 'actual MCP serialization preserves server-choice',
    from: '  return output;\n}\n\n/** Fixed text/envelope only:',
    to: '  (output as unknown as Record<string, unknown>).accessToken = ' + JSON.stringify(CANARY) + ';\n  return output;\n}\n\n/** Fixed text/envelope only:' },
  { id: 'M12_HIDDEN_CHOICE', path: 'src/connections.ts',
    target: 'a graph hint and local last-used ranking cannot replace the actual server choice',
    from: 'outcome: row.outcome, alternatives, choiceVisible: row.choiceVisible };',
    to: 'outcome: row.outcome, alternatives, choiceVisible: false };' },
  { id: 'M_NON404_FALLBACK', path: 'src/connections.ts',
    target: 'inventory403 refuses instead of deriving or reporting healthy',
    from: 'catch (error) { if (error instanceof SwfteApiError && error.status === 404) return null; throw error; }',
    to: 'catch (error) { if (error instanceof SwfteApiError) return null; throw error; }' },
  { id: 'M_UNAVAILABLE_EMPTY', path: 'src/connections.ts',
    target: 'inventory503 refuses instead of deriving or reporting healthy',
    from: '  } catch (error) {\n    throw connectionFailure(error);\n  }\n}\n\n/** Null means only',
    to: '  } catch (error) {\n    return options.path === CONNECTIONS ? [] : { bindings: [] };\n  }\n}\n\n/** Null means only' },
  { id: 'M_UNKNOWN_READY', path: 'src/connections.ts',
    target: 'a server-selected UNKNOWN handle cannot establish an AUTO_BOUND result',
    from: "!chosen || chosen.provider !== provider || chosen.status !== 'HEALTHY' || ids.has(id)",
    to: '!chosen || chosen.provider !== provider || ids.has(id)' },
  { id: 'M_WORKSPACE', path: 'src/connections.ts',
    target: 'both native reads retain the API-key workspace and auto-bind sends only the authoritative workflow id',
    from: 'client.request({ ...options, workspaceId: client.configuredWorkspaceId, retries: 0 })',
    to: "client.request({ ...options, workspaceId: 'foreign-workspace', retries: 0 })" },
  { id: 'M_DEFAULT_OFF', path: 'src/client.ts',
    target: 'true values configure a client without reading later process environment changes',
    from: 'return this.config.serverConnections === true;', to: 'return true;' },
  { id: 'M_FORCE_BYPASS', path: 'src/tools/ship.ts',
    target: 'a v2 missing connection blocks run even force=true',
    from: 'if (!input.force || client.serverConnectionsEnabled) {', to: 'if (!input.force) {' },
  { id: 'M_ERROR_DISCLOSURE', path: 'src/connections.ts',
    target: 'actual MCP serialization preserves refusal-canary',
    from: "message: 'Connections could not be checked. No verification or execution readiness was established.',",
    to: "message: error instanceof Error ? error.message : 'Connections unavailable.'," },
];

function requireHeavy() {
  const parent = execFileSync('ps', ['-p', String(process.ppid), '-o', 'args='], { encoding: 'utf8' });
  requireCondition(parent.includes(HEAVY) && !parent.includes('--min-free-gb'), 'HEAVY_GUARD_REQUIRED');
}
function fingerprint() {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'src', 'test', 'scripts', 'package.json', 'package-lock.json', 'tsup.config.ts'],
    { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const files = [...new Set([...listed, ...OWNED])].sort().map(path => ({ path, sha256: sha(readFileSync(join(ROOT, path))) }));
  return { aggregateSha256: sha(JSON.stringify(files)), files };
}
function restore() {
  for (const [path, mutatedSha256] of expectedMutated) {
    const original = originals.get(path);
    const current = readFileSync(join(ROOT, path));
    // A foreign writer is a refusal, never permission to overwrite their bytes.
    requireCondition(sha(current) === mutatedSha256 || sha(current) === sha(original), 'CONCURRENT_SOURCE_CHANGE');
    if (!current.equals(original)) writeFileSync(join(ROOT, path), original);
    requireCondition(readFileSync(join(ROOT, path)).equals(original), 'BYTE_RESTORATION_FAILED');
    expectedMutated.delete(path);
  }
}
function safeEnvironment() {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SWFTE_PAT: '', SWFTE_API_KEY: '',
    SWFTE_DEBUG: 'false', SWFTE_TELEMETRY: 'false', SWFTE_ALLOW_DEPLOY: 'false', SWFTE_MCP_SERVER_CONNECTIONS: 'false' };
}
async function command(program, args, name, timeoutMs = 90_000) {
  requireCondition(!stopped, 'INTERRUPTED');
  const child = spawn(program, args, { cwd: ROOT, env: safeEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  activeChild = child;
  let output = '', bytes = 0, exceeded = false;
  const terminate = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) { exceeded = true; terminate(); return; }
    output += String(chunk);
  });
  const timer = setTimeout(() => { exceeded = true; terminate(); }, timeoutMs);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ exitCode: code, signal }));
  }).finally(() => { clearTimeout(timer); activeChild = undefined; });
  const rawSha256 = sha(output);
  const redacted = output.replace(/\b(?:meadow|willow|amber|fern) (?:granite|river|sparrow|orchard)\b/g, '[REDACTED_CANARY]');
  writeFileSync(join(EVIDENCE, name + '.tap'), redacted);
  requireCondition(!exceeded && !stopped, 'BOUNDED_CHECK_REFUSED');
  return { ...result, output, outputBytes: bytes, outputSha256: rawSha256,
    redactedLogSha256: sha(redacted), log: name + '.tap' };
}
function summary(result) {
  const pass = [...result.output.matchAll(/^# pass (\d+)\s*$/gm)].at(-1)?.[1];
  const fail = [...result.output.matchAll(/^# fail (\d+)\s*$/gm)].at(-1)?.[1];
  const skip = [...result.output.matchAll(/^# skipped (\d+)\s*$/gm)].at(-1)?.[1];
  return { passed: pass === undefined ? null : Number(pass), failed: fail === undefined ? null : Number(fail),
    skipped: skip === undefined ? null : Number(skip) };
}
function evidence(result) { const { output, ...safe } = result; return { ...safe, ...summary(result) }; }
function passing(result) {
  const counts = summary(result);
  requireCondition(result.exitCode === 0 && counts.passed > 0 && counts.failed === 0, 'POSITIVE_BASELINE_REQUIRED');
}
function namedAssertion(result, target) {
  const lines = result.output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)not ok \d+ - (.+)$/.exec(lines[i]);
    if (!match || match[2] !== target) continue;
    const indent = match[1].length;
    let block = '';
    for (let j = i + 1; j < lines.length; j++) {
      const next = /^(\s*)(?:not )?ok \d+ - /.exec(lines[j]);
      if (next && next[1].length <= indent) break;
      block += lines[j] + '\n';
    }
    if (/code: ['"]ERR_ASSERTION['"]/.test(block)) return true;
  }
  return false;
}
const focused = pattern => ['--import', 'tsx', '--test', '--test-reporter=tap',
  ...(pattern ? ['--test-name-pattern=' + regexp(pattern)] : []), 'test/connections.test.ts'];

async function main() {
  requireHeavy();
  mkdirSync(EVIDENCE, { recursive: true });
  phase = 'ownership-lock';
  lockFd = openSync(LOCK, 'wx');
  writeFileSync(lockFd, JSON.stringify({ pid: process.pid, evidence: EVIDENCE, runId: RUN_ID }) + '\n');
  receipt.sourceBefore = fingerprint();
  receipt.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  for (const path of new Set(controls.map(control => control.path))) originals.set(path, readFileSync(join(ROOT, path)));
  const journal = [...originals].map(([path, bytes]) => ({ path, sha256: sha(bytes), bytesBase64: bytes.toString('base64') }));
  writeFileSync(join(EVIDENCE, 'original-bytes.json'), JSON.stringify(journal, null, 2) + '\n');
  phase = 'typecheck-baseline';
  const types = await command('npm', ['run', 'typecheck'], 'typecheck-baseline', 120_000);
  receipt.typecheck = evidence(types);
  requireCondition(types.exitCode === 0, 'CURRENT_TYPECHECK_REQUIRED');
  phase = 'focused-baseline';
  const baseline = await command(process.execPath, focused(), 'focused-baseline');
  passing(baseline);
  receipt.baseline = evidence(baseline);
  for (const control of controls) {
    phase = control.id + '-positive';
    requireCondition(fingerprint().aggregateSha256 === receipt.sourceBefore.aggregateSha256, 'SOURCE_CHANGED_BEFORE_CONTROL');
    const positive = await command(process.execPath, focused(control.target), control.id + '-positive');
    passing(positive);
    const original = originals.get(control.path);
    const source = original.toString('utf8');
    requireCondition(source.split(control.from).length === 2, 'MUTATION_ANCHOR_NOT_UNIQUE');
    const mutated = Buffer.from(source.replace(control.from, control.to), 'utf8');
    const expectedSha256 = sha(mutated);
    phase = control.id + '-mutation';
    // Persist the target hash before changing source so an interruption has an exact restoration journal.
    writeFileSync(join(EVIDENCE, 'active-control.json'), JSON.stringify({ id: control.id,
      path: control.path, originalSha256: sha(original), mutatedSha256: expectedSha256 }, null, 2) + '\n');
    expectedMutated.set(control.path, expectedSha256);
    writeFileSync(join(ROOT, control.path), mutated);
    let negative;
    try { negative = await command(process.execPath, focused(control.target), control.id + '-mutated'); }
    finally { restore(); }
    requireCondition(fingerprint().aggregateSha256 === receipt.sourceBefore.aggregateSha256, 'SOURCE_RESTORATION_MISMATCH');
    requireCondition(negative.exitCode !== 0 && summary(negative).failed > 0
      && namedAssertion(negative, control.target), 'CONTROL_MUST_FAIL_NAMED_ASSERTION');
    phase = control.id + '-restored';
    const restored = await command(process.execPath, focused(control.target), control.id + '-restored');
    passing(restored);
    receipt.controls.push({ id: control.id, path: control.path, target: control.target,
      originalSha256: sha(original), mutatedSha256: expectedSha256,
      positive: evidence(positive), negative: evidence(negative), restored: evidence(restored),
      assertionCode: 'ERR_ASSERTION', exactBytesRestored: true });
    writeFileSync(join(EVIDENCE, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
  phase = 'restored-full-positive';
  const restored = await command(process.execPath, focused(), 'restored-focused-baseline');
  passing(restored);
  receipt.restoredBaseline = evidence(restored);
  receipt.sourceAfter = fingerprint();
  requireCondition(receipt.sourceAfter.aggregateSha256 === receipt.sourceBefore.aggregateSha256, 'AGGREGATE_RESTORATION_FAILED');
  requireCondition(receipt.controls.length === controls.length, 'ALL_CONTROLS_REQUIRED');
  receipt.state = 'PASS';
  receipt.completedAt = new Date().toISOString();
  writeFileSync(join(EVIDENCE, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log('WR_MCP_MUTATIONS_OK controls=' + controls.length + ' assertionFailures=' + controls.length + ' exactRestoration=true');
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => {
  stopped = true;
  if (activeChild?.pid) { try { process.kill(-activeChild.pid, 'SIGKILL'); } catch {} }
});

main().catch(() => {
  receipt.state = 'REFUSED';
  receipt.phase = phase;
  receipt.completedAt = new Date().toISOString();
  try { restore(); receipt.exactBytesRestored = true; }
  catch { receipt.exactBytesRestored = false; receipt.restorationRequiresReview = true; }
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.error('WR_MCP_MUTATIONS_REFUSED phase=' + phase + ' evidence=' + EVIDENCE);
  process.exitCode = 1;
}).finally(() => {
  if (lockFd !== undefined) {
    closeSync(lockFd);
    // Leave the journal lock intact if exact restoration failed; the driver must inspect it.
    if (!receipt.restorationRequiresReview && existsSync(LOCK)) unlinkSync(LOCK);
  }
});
