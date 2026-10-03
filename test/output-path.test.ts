import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import type { CatalogContract } from '../src/catalog.js';
import { clientInfo, renderPythonClient, renderTypeScriptClient, type ClientSpec } from '../src/codegen.js';
import { workflowGolden } from './fixtures/phase5-contracts/index.js';

/**
 * invoke.outputPath: the backend (agents-service #472) tells the client where the workflow's declared output
 * sits in the status envelope. The contract is the synced backend golden; the status snapshots below are shaped
 * by that golden's own outputSchema description ("execution.outputData.parameters[\"end_1\"]").
 */
const golden = workflowGolden() as unknown as CatalogContract;
const PATH = ['execution', 'outputData', 'parameters', 'end_1'];
const FINAL = { amount: 10, summary: 'refund approved', _workflow_completed: true, _end_time: '2026-10-03T10:00:00Z' };
const ACCEPTED = { executionId: 'exec-1', status: 'PENDING' };
const snapshot = (end: unknown, status = 'SUCCEEDED') => ({
  execution: { id: 'exec-1', status, outputData: { status: 'ok', parameters: { end_1: end, other_end: { not: 'this one' } } } },
});

const specFor = (contract: CatalogContract): ClientSpec => ({
  catalogRef: contract.catalogRef, kind: 'workflow', id: 'wf_1', name: 'Refund triage', alias: 'refund-triage', contract,
  contractHash: contract.contractHash!, defaultBaseUrl: 'https://api.example.test/agents', pinnedVersion: null,
});
const spec = specFor(golden);
const withPath = (outputPath: unknown): ClientSpec =>
  specFor({ ...golden, invoke: { ...golden.invoke, outputPath: outputPath as string[] } });
const withoutPath = (): ClientSpec => {
  const { outputPath: _dropped, ...invoke } = golden.invoke;
  return specFor({ ...golden, invoke });
};

function load(source: string, s: ClientSpec) {
  const exports: Record<string, Function> = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, URL, AbortController, setTimeout, clearTimeout }, { timeout: 1000 });
  return exports[clientInfo(s, 'typescript').fn]!;
}
async function invokeTs(source: string, polled: unknown, s: ClientSpec = spec): Promise<any> {
  return load(source, s)({ customerEmail: 'a@example.test', amount: 10 }, {
    apiKey: 'pat_TESTONLY1234', pollIntervalMs: 0, timeoutMs: 1000,
    fetch: async (_url: string, init: RequestInit) => new Response(JSON.stringify(init.method === 'POST' ? ACCEPTED : polled),
      { status: init.method === 'POST' ? 202 : 200, headers: { 'content-type': 'application/json' } }),
  });
}
const plain = (value: unknown) => (typeof value === 'function' ? '[function]' : JSON.parse(JSON.stringify(value ?? null)));
// Python probes get data through json.loads, since JSON true/null are not Python literals.
const py = (value: unknown) => `json.loads(${JSON.stringify(JSON.stringify(value))})`;

function python(t: TestContext, s: ClientSpec, body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'swfte-outputpath-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'client.py'), renderPythonClient(s));
  const probe = `import runpy, json\nc = runpy.run_path(${JSON.stringify(join(dir, 'client.py'))})\n${body}`;
  const result = spawnSync('python3', ['-c', probe], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
}

test('the synced backend golden declares the output path the clients must follow', () => {
  assert.deepEqual(golden.invoke.outputPath, PATH);
});

test('generated TypeScript returns the declared outputPath value, not the outputData wrapper', async () => {
  const result = await invokeTs(renderTypeScriptClient(spec), snapshot(FINAL));
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.output), FINAL);
  assert.notDeepEqual(plain(result.output), plain(snapshot(FINAL).execution.outputData));
});

test('negative control: the previous wrapper reader returns the wrong value for the same response', async () => {
  const source = renderTypeScriptClient(spec);
  const start = source.indexOf('const outputOf =');
  const end = source.indexOf('\n/**', start);
  assert.ok(start >= 0 && end > start, 'locate the generated output reader');
  const legacy = source.slice(0, start)
    + 'const outputOf = (s: any, _strict: boolean): unknown => s?.execution?.outputData ?? s?.outputData ?? s?.output ?? s?.result;\n'
    + source.slice(end);
  const result = await invokeTs(legacy, snapshot(FINAL));
  assert.notDeepEqual(plain(result.output), FINAL);
  assert.deepEqual(plain(result.output), plain(snapshot(FINAL).execution.outputData));
});

for (const final of [false, 0, null, '']) {
  test(`generated TypeScript preserves an explicit ${JSON.stringify(final)} at the declared path`, async () => {
    const result = await invokeTs(renderTypeScriptClient(spec), snapshot(final));
    assert.equal(result.ok, true);
    assert.equal(result.output, final);
  });
}

test('a successful run missing the declared path is refused, never guessed from the wrapper', async () => {
  await assert.rejects(invokeTs(renderTypeScriptClient(spec), { execution: { id: 'exec-1', status: 'SUCCEEDED', outputData: { parameters: {} } } }), /outputPath/);
});

test('a failed run without the declared path still reports its status instead of throwing', async () => {
  const result = await invokeTs(renderTypeScriptClient(spec), { execution: { id: 'exec-1', status: 'FAILED', outputData: null } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.output, undefined);
});

for (const key of ['constructor', '__proto__']) {
  test(`generated TypeScript refuses an inherited-only ${key} instead of treating it as the output`, async () => {
    const s = withPath(['execution', 'outputData', 'parameters', key]);
    const polled = snapshot(FINAL);
    assert.equal(Object.hasOwn(polled.execution.outputData.parameters, key), false);
    assert.equal(key in polled.execution.outputData.parameters, true);
    const source = renderTypeScriptClient(s);
    await assert.rejects(invokeTs(source, polled, s), /outputPath/);
    const unsafe = source.replace('!Object.prototype.hasOwnProperty.call(value, key)', '!(key in value)');
    assert.notEqual(unsafe, source, 'control changes the generated reader');
    const result = await invokeTs(unsafe, polled, s);
    assert.notDeepEqual(plain(result.output), FINAL, 'the inherited-property control admits a wrong value');
  });
}

test('malformed outputPath is refused by both generators', () => {
  for (const outputPath of [[], [''], [1], ['execution', null], 'execution.outputData', false, {}]) {
    for (const render of [renderTypeScriptClient, renderPythonClient]) {
      assert.throws(() => render(withPath(outputPath)), /outputPath/, JSON.stringify(outputPath));
    }
  }
});

test('absent outputPath keeps the legacy wrapper fallback', async () => {
  const result = await invokeTs(renderTypeScriptClient(withoutPath()), snapshot(FINAL), withoutPath());
  assert.deepEqual(plain(result.output), plain(snapshot(FINAL).execution.outputData));
});

test('generated Python returns the declared outputPath value and preserves false, 0 and None', t => {
  python(t, spec, `
snap = ${py(snapshot(FINAL))}
assert c['_output'](snap) == ${py(FINAL)}
for final in [False, 0, None, '']:
    snap['execution']['outputData']['parameters']['end_1'] = final
    assert c['_output'](snap) == final and type(c['_output'](snap)) is type(final)
`);
});

test('generated Python refuses a successful run missing the path but reports a failed run', t => {
  python(t, spec, `
missing = {'execution': {'status': 'SUCCEEDED', 'outputData': {'parameters': {}}}}
try:
    c['_output'](missing)
except ValueError as e:
    assert 'outputPath' in str(e)
else:
    raise AssertionError('missing declared path was silently accepted')
assert c['_output'](missing, False) is None
calls = []
def fake_call(method, path, *args):
    calls.append(method)
    return ${py(ACCEPTED)} if method == 'POST' else {'execution': {'status': 'FAILED', 'outputData': None}}
fn = c[${JSON.stringify(clientInfo(spec, 'python').fn)}]
fn.__globals__['_call'] = fake_call
r = fn({'customerEmail': 'a@example.test', 'amount': 10}, api_key='pat_TESTONLY1234', poll_interval_s=0, timeout_s=1)
assert r['ok'] is False and r['status'] == 'FAILED' and r['output'] is None
`);
});

test('generated Python follows the declared path through an invoke and a poll', t => {
  python(t, spec, `
calls = []
def fake_call(method, path, *args):
    calls.append((method, path))
    return ${py(ACCEPTED)} if method == 'POST' else ${py(snapshot(FINAL))}
fn = c[${JSON.stringify(clientInfo(spec, 'python').fn)}]
fn.__globals__['_call'] = fake_call
r = fn({'customerEmail': 'a@example.test', 'amount': 10}, api_key='pat_TESTONLY1234', poll_interval_s=0, timeout_s=1)
assert r['ok'] is True and r['output'] == ${py(FINAL)}
assert [m for m, _ in calls] == ['POST', 'GET']
`);
});

test('generated Python legacy fallback applies only when outputPath is absent', t => {
  python(t, withoutPath(), `
snap = ${py(snapshot(FINAL))}
assert c['_output'](snap) == snap['execution']['outputData']
`);
});

test('generated Python refuses inherited-only attributes as the output', t => {
  python(t, withPath(['execution', 'outputData', 'parameters', 'constructor']), `
inherited = type('InheritedOnly', (dict,), {'constructor': 'wrong'})()
snap = {'execution': {'status': 'SUCCEEDED', 'outputData': {'parameters': inherited}}}
try:
    c['_output'](snap)
except ValueError as e:
    assert 'outputPath' in str(e)
else:
    raise AssertionError('inherited attribute was mistaken for a declared JSON field')
`);
});
