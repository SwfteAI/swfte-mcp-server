// Authored checks, currently UNRUN. Synthetic TAP below is parser input, never a runtime receipt.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  ENV_NAMES, ENV_CONTROLS, parseEnvTap, evaluateEnvExecution, requireEnvAdmission,
  performOwnedMutation, OwnedChildGate, OwnedSourceMutations,
} from './env-controls.mjs';

function tap(failed = [], diagnostic = "  failureType: 'testCodeFailure'\n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  operator: 'strictEqual'\n") {
  const lines = ['TAP version 13'];
  ENV_NAMES.forEach((name, index) => {
    lines.push('# Subtest: ' + name, (failed.includes(name) ? 'not ok ' : 'ok ') + (index + 1) + ' - ' + name);
    if (failed.includes(name)) lines.push('  ---', diagnostic.trimEnd(), '  ...');
  });
  lines.push('1..18', '# tests 18', '# suites 0', '# pass ' + (18 - failed.length), '# fail ' + failed.length, '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 1');
  return Buffer.from(lines.join('\n') + '\n');
}
function execution(bytes, exitCode = 0) { return { exitCode, signal: null, spawnError: null, tap: parseEnvTap(bytes) }; }
const identity = { sha: '1'.repeat(40), tree: '2'.repeat(40), fingerprint: '3'.repeat(64) };
const admission = { phase: { marker: 'VALIDATION', sourceFirst: false }, freeze: { current: true }, source: identity, expected: identity };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-env-runner-'));
  fs.writeFileSync(path.join(root, 'first.ts'), 'first original\n');
  fs.writeFileSync(path.join(root, 'second.ts'), 'second original\n');
  const owner = new OwnedSourceMutations(root, new Map([['first.ts', Buffer.from('first original\n')], ['second.ts', Buffer.from('second original\n')]]));
  return { root, owner, close() { assert(path.basename(root).startsWith('foundation-env-runner-')); fs.rmSync(root, { recursive: true }); } };
}
const control = { file: 'first.ts', operations: [{ exactMatch: 'first original', replacement: 'first mutant', expectedMatchCount: 1 }] };
const original = Buffer.from('first original\n');

test('complete current eighteen-case inventory is a positive, not an inferred count', () => {
  const run = execution(tap());
  assert.deepEqual(run.tap.cases.map(row => row.name), ENV_NAMES);
  assert.equal(evaluateEnvExecution(run).accepted, true);
  for (const selected of ENV_CONTROLS) assert.equal(run.tap.cases.filter(row => row.name === selected.test && row.passed).length, 1);
});
test('each genuine exact named assertion is a negative and cannot be replaced by another failure', () => {
  for (const selected of ENV_CONTROLS) {
    assert.equal(evaluateEnvExecution(execution(tap([selected.test]), 1), selected).accepted, true);
    const other = ENV_NAMES.find(name => name !== selected.test);
    assert.equal(evaluateEnvExecution(execution(tap([other]), 1), selected).accepted, false);
  }
});
test('substring counterfeit target is not current inventory', () => {
  const name = ENV_CONTROLS[0].test;
  assert.throws(() => parseEnvTap(Buffer.from(tap().toString().replaceAll(name, name + ' counterfeit'))), /inventory|Subtest/);
});
test('duplicate counters cannot replace the final summary', () => {
  assert.throws(() => parseEnvTap(Buffer.concat([tap(), Buffer.from('# tests 18\n')])), /counter/);
});
test('unsafe counts and NaN counts are refused', () => {
  assert.throws(() => parseEnvTap(Buffer.from(tap().toString().replace('# tests 18', '# tests 9007199254740992'))), /counter|integer/);
  assert.throws(() => parseEnvTap(Buffer.from(tap().toString().replace('# tests 18', '# tests NaN'))), /counter/);
});
test('missing test and truncated plan never supply a positive', () => {
  assert.throws(() => parseEnvTap(Buffer.from(tap().toString().replace(/^ok 18 - .*\n/m, ''))), /inventory|count/);
  assert.throws(() => parseEnvTap(Buffer.from(tap().toString().replace('1..18\n', ''))), /plan/);
});
test('duplicate test IDs cannot satisfy the declared cardinality', () => {
  assert.throws(() => parseEnvTap(Buffer.from(tap().toString().replace('ok 2 - ', 'ok 1 - '))), /id|sequence/);
});
test('a compile exception or TypeError is not a killed assertion control', () => {
  const selected = ENV_CONTROLS[0];
  for (const name of ['TypeError', 'SyntaxError']) {
    const bytes = tap([selected.test], "  failureType: 'testCodeFailure'\n  code: 'ERR_TEST_FAILURE'\n  name: '" + name + "'\n");
    assert.equal(evaluateEnvExecution(execution(bytes, 1), selected).accepted, false);
  }
});
test('ERR_ASSERTION embedded in another diagnostic value cannot certify an assertion', () => {
  const selected = ENV_CONTROLS[0];
  const bytes = tap([selected.test], "  failureType: 'testCodeFailure'\n  code: 'ERR_TEST_FAILURE'\n  name: 'TypeError'\n  expected: |\n    code: 'ERR_ASSERTION'\n");
  assert.equal(evaluateEnvExecution(execution(bytes, 1), selected).accepted, false);
});
test('duplicated or unterminated diagnostic blocks are refused', () => {
  const selected = ENV_CONTROLS[0];
  assert.throws(() => parseEnvTap(tap([selected.test], "  code: 'ERR_ASSERTION'\n  code: 'ERR_TEST_FAILURE'\n")), /diagnostic/);
  assert.throws(() => parseEnvTap(Buffer.from(tap([selected.test]).toString().replace('  ...\n', ''))), /diagnostic/);
});
test('unexpected skip cancellation todo or signal cannot supply accepted evidence', () => {
  const selected = ENV_CONTROLS[0];
  for (const counter of ['skipped', 'cancelled', 'todo']) assert.throws(() => parseEnvTap(Buffer.from(tap().toString().replace('# ' + counter + ' 0', '# ' + counter + ' 1'))), /counter|unsupported/);
  assert.equal(evaluateEnvExecution({ ...execution(tap()), signal: 'SIGTERM' }).accepted, false);
  assert.equal(evaluateEnvExecution({ ...execution(tap()), spawnError: { code: 'ENOENT' } }).accepted, false);
  assert.equal(evaluateEnvExecution(execution(tap([selected.test]), 0), selected).accepted, false);
});
test('raw report limit and non-UTF8 bytes are refused before parsing', () => {
  assert.throws(() => parseEnvTap(Buffer.alloc(16 * 1024 * 1024 + 1)), /byte/);
  assert.throws(() => parseEnvTap(Buffer.from([0xff])), /UTF8/);
});
test('phase freeze and whole-source identity each independently refuse admission', () => {
  assert.doesNotThrow(() => requireEnvAdmission(admission));
  assert.throws(() => requireEnvAdmission({ ...admission, phase: { marker: 'IMPLEMENTATION_FIRST_TEN_SESSIONS_20261002', sourceFirst: true } }), /phase/);
  assert.throws(() => requireEnvAdmission({ ...admission, phase: {} }), /phase/);
  assert.throws(() => requireEnvAdmission({ ...admission, freeze: { current: false } }), /freeze/);
  for (const field of ['sha', 'tree', 'fingerprint']) assert.throws(() => requireEnvAdmission({ ...admission, source: { ...identity, [field]: '4'.repeat(identity[field].length) } }), /source/);
});
test('unmutated foreign edit survives runner finally and blocks a restored-source admission', async () => {
  const f = fixture();
  try {
    const result = await performOwnedMutation({ owner: f.owner, childGate: new OwnedChildGate(), control, original, admit() {}, signalOwnedGroup() {}, async run() { fs.writeFileSync(path.join(f.root, 'second.ts'), 'foreign edit\n'); return { done: true }; } });
    assert.equal(result.restoration.ok, true);
    assert.equal(fs.readFileSync(path.join(f.root, 'first.ts'), 'utf8'), 'first original\n');
    assert.equal(fs.readFileSync(path.join(f.root, 'second.ts'), 'utf8'), 'foreign edit\n');
    assert.throws(() => requireEnvAdmission({ ...admission, source: { ...identity, fingerprint: '5'.repeat(64) } }), /source/);
  } finally { f.close(); }
});
test('unmutated foreign deletion is not recreated by runner finally', async () => {
  const f = fixture();
  try {
    const result = await performOwnedMutation({ owner: f.owner, childGate: new OwnedChildGate(), control, original, admit() {}, signalOwnedGroup() {}, async run() { fs.unlinkSync(path.join(f.root, 'second.ts')); return { done: true }; } });
    assert.equal(result.restoration.ok, true);
    assert.equal(fs.existsSync(path.join(f.root, 'second.ts')), false);
    assert.equal(fs.readFileSync(path.join(f.root, 'first.ts'), 'utf8'), 'first original\n');
  } finally { f.close(); }
});
test('foreign edit of owned mutant is preserved and reported as conflict', async () => {
  const f = fixture();
  try {
    const result = await performOwnedMutation({ owner: f.owner, childGate: new OwnedChildGate(), control, original, admit() {}, signalOwnedGroup() {}, async run() { fs.writeFileSync(path.join(f.root, 'first.ts'), 'foreign owned-path edit\n'); return { done: true }; } });
    assert.equal(result.restoration.ok, false);
    assert.equal(result.restoration.conflicts[0].file, 'first.ts');
    assert.equal(fs.readFileSync(path.join(f.root, 'first.ts'), 'utf8'), 'foreign owned-path edit\n');
  } finally { f.close(); }
});
test('child error does not open restoration; actual close restores owned bytes', async () => {
  const f = fixture(); const child = new EventEmitter(); const gate = new OwnedChildGate({ graceMs: 100 }); const signals = [];
  try {
    const pending = performOwnedMutation({ owner: f.owner, childGate: gate, control, original, admit() {}, signalOwnedGroup(signal, actual) { assert.equal(actual, child); signals.push(signal); }, async run() { gate.attach(child); child.emit('error', Object.assign(new Error('owned signal error'), { code: 'ESRCH' })); throw new Error('run failed'); } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fs.readFileSync(path.join(f.root, 'first.ts'), 'utf8'), 'first mutant\n');
    assert.equal(gate.canRestore, false); assert.deepEqual(signals, ['SIGTERM']);
    child.emit('close', 1, null);
    const result = await pending;
    assert.equal(result.restoration.ok, true); assert.equal(result.error.message, 'run failed');
    assert.equal(fs.readFileSync(path.join(f.root, 'first.ts'), 'utf8'), 'first original\n');
  } finally { if (!gate.canRestore) child.emit('close', 1, null); f.close(); }
});
test('failed admission never writes source or dispatches a child', async () => {
  const f = fixture(); let dispatches = 0;
  try {
    const result = await performOwnedMutation({ owner: f.owner, childGate: new OwnedChildGate(), control, original, admit() { throw new Error('freeze revoked'); }, signalOwnedGroup() {}, async run() { dispatches++; } });
    assert.equal(result.error.message, 'freeze revoked'); assert.equal(dispatches, 0);
    assert.equal(fs.readFileSync(path.join(f.root, 'first.ts'), 'utf8'), 'first original\n');
  } finally { f.close(); }
});
