import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwfteClient, OperationDeadlineError } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { orchestrateSolution } from '../src/orchestrator.js';
import { orchestrateTools } from '../src/tools/orchestrate.js';
const client = () => new SwfteClient(loadConfig({ SWFTE_PAT: 'pat_test' } as never));
const plan = { name: 'bounded', components: ['first', 'second', 'third'].map(key => ({ key, kind: 'workflow' as const, prompt: key })) };

test('one deadline across components retains committed artifact and pending session; no later create or wire', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = 1000, starts = 0;
  const calls: string[] = [];
  Date.now = () => now;
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname; calls.push(`${options?.method} ${path}`);
    if (path.endsWith('/generate/async')) {
      starts++; now += starts === 1 ? 10 : 40;
      return Response.json({ sessionId: `session-${starts}` });
    }
    if (path.endsWith('/session-1/status')) {
      now += 20;
      return Response.json({ done: true, status: 'COMPLETED', finalResponse: { id: 'committed-1' } });
    }
    throw new Error(`Unexpected request ${path}`);
  };
  try {
    const report = await orchestrateSolution(client(), plan, { waitMs: 60, totalWaitMs: 60 });
    assert.equal(report.status, 'PARTIAL'); assert.equal(report.ok, false);
    assert.equal(report.components[0].id, 'committed-1');
    assert.equal(report.components[1].sessionId, 'session-2');
    assert.equal(report.components[1].state, 'pending');
    assert.equal(report.components[2].state, 'skipped');
    assert.equal(starts, 2); assert.equal(calls.length, 3);
    assert.equal(report.verification, undefined);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('ambiguous create deadline does not retry or start another component and retains generation session', async () => {
  const original = globalThis.fetch; let creates = 0, starts = 0;
  globalThis.fetch = async (url, opts) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/generate/async')) { starts++; return Response.json({ sessionId: 'known-session' }); }
    if (path.endsWith('/status')) return Response.json({ done: true, status: 'COMPLETED', finalResponse: { generatedWorkflow: { name: 'draft', nodes: [], connections: [] } } });
    if (opts?.method === 'POST') {
      creates++;
      return new Promise((_resolve, reject) => opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true }));
    }
    throw new Error(`Unexpected request ${path}`);
  };
  try {
    const report = await orchestrateSolution(client(), plan, { totalWaitMs: 100 });
    assert.equal(report.status, 'PARTIAL'); assert.equal(creates, 1); assert.equal(starts, 1);
    assert.equal(report.components[0].sessionId, 'known-session');
    assert.equal(report.components[0].state, 'pending');
    assert.match(report.components[0].detail, /may still have committed/);
  } finally { globalThis.fetch = original; }
});

test('dataset timeout preserves created dataset ID', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  globalThis.fetch = async () => { now += 100; return Response.json({ id: 'dataset-kept' }); };
  try {
    const report = await orchestrateSolution(client(), { name: 'dataset', components: [{ key: 'data', kind: 'dataset', knowledge: { name: 'data', documents: [{ name: 'doc', text: 'hello' }] } }] }, { totalWaitMs: 50 });
    assert.equal(report.status, 'PARTIAL'); assert.equal(report.components[0].id, 'dataset-kept');
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('expired operation cannot issue a request and scope does not leak to another caller', async () => {
  const c = client(); let calls = 0; const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return Response.json({ ok: true }); };
  try {
    await assert.rejects(c.withDeadline(Date.now() - 1, () => c.request({ method: 'POST', path: '/mutation' })), OperationDeadlineError);
    await c.request({ method: 'GET', path: '/independent' }); assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('schema and direct API reject excessive or invalid budgets', async () => {
  const schema = orchestrateTools.find(t => t.name === 'swfte_solution_build')!.inputSchema;
  assert.equal(schema.safeParse({ plan, waitMs: 600001 }).success, false);
  assert.equal(schema.safeParse({ plan, totalWaitMs: 600001 }).success, false);
  for (const totalWaitMs of [0, -1, Infinity, 600001]) await assert.rejects(orchestrateSolution(client(), plan, { totalWaitMs }));
});

test('operation deadline also bounds a binary response body after headers arrive', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => new Response(new ReadableStream({
    start(controller) {
      opts?.signal?.addEventListener('abort', () => controller.error(opts.signal?.reason), { once: true });
    },
  }));
  try {
    const c = client();
    await assert.rejects(c.withDeadline(Date.now() + 30, () => c.getBinary('/slow-body')));
  } finally { globalThis.fetch = original; }
});

// The component budget is 30ms of *simulated* time, advanced by the stub rather
// than by the wall clock. Under real time this test raced: the component
// deadline is fixed at `Date.now() + waitMs` before the build starts, so if the
// machine stalled for 30ms anywhere in the generate call — another process
// starting, a GC pause — `remainingMs()` hit zero and the client refused to
// issue the status request at all, giving 1 call instead of 2. Stubbing the
// clock, as the tests above and below this one already do, makes the budget
// arithmetic exact and never reaches a real timer.
test('component budget stops pending generation even with total time left', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = 1000, calls = 0;
  Date.now = () => now;
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).endsWith('/generate/async')) {
      // Cheap: the component still has budget left, so the status poll is due.
      now += 5;
      return Response.json({ sessionId: 'still-running' });
    }
    // The one poll we allow overruns the 30ms component budget, so the loop
    // exits after it rather than sleeping for another interval.
    now += 40;
    return Response.json({ done: false, status: 'GENERATING' });
  };
  try {
    const report = await orchestrateSolution(client(), plan, { waitMs: 30, totalWaitMs: 1000 });
    assert.equal(report.status, 'PARTIAL'); assert.equal(report.components[0].sessionId, 'still-running');
    assert.equal(report.components[0].state, 'pending');
    assert.equal(calls, 2, 'exactly one generate plus one status poll');
    assert.equal(report.components[1].state, 'skipped');
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('unexpected verifier exception cannot report READY and retains adopted IDs', async () => {
  const c = client();
  c.request = async () => ({ name: 'existing' }) as never;
  const report = await orchestrateSolution(c, { name: 'verify-error', components: [{ key: 'existing', kind: 'workflow', id: 'kept-id' }] }, {}, {
    verify: async () => { throw new Error('verification unavailable'); },
  });
  assert.equal(report.status, 'BROKEN'); assert.equal(report.ok, false);
  assert.equal(report.components[0].id, 'kept-id');
  assert.match(report.nextActions.join(' '), /verification unavailable/);
});

test('ordinary generation and dataset failures preserve known session and artifact IDs', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/generate/async')) return Response.json({ sessionId: 'failed-session' });
    return Response.json({ done: true, status: 'FAILED', error: 'generation failed' });
  };
  try {
    const report = await orchestrateSolution(client(), { name: 'failed', components: [plan.components[0]] });
    assert.equal(report.status, 'BROKEN'); assert.equal(report.components[0].sessionId, 'failed-session');
    assert.equal(report.components[0].state, 'failed');
    const c = client();
    c.request = async () => ({ id: 'created-dataset' }) as never;
    c.postMultipart = async () => { throw new Error('upload rejected'); };
    const dataset = await orchestrateSolution(c, { name: 'failed-dataset', components: [{ key: 'data', kind: 'dataset', knowledge: { name: 'data', documents: [{ name: 'doc', text: 'hello' }] } }] });
    assert.equal(dataset.status, 'BROKEN'); assert.equal(dataset.components[0].id, 'created-dataset');
    assert.match(dataset.components[0].detail, /upload rejected/);
  } finally { globalThis.fetch = original; }
});

test('unexpected wire exception becomes failed wire report without losing committed component IDs', async () => {
  const c = client(); c.request = async () => ({ name: 'existing' }) as never;
  const report = await orchestrateSolution(c, { name: 'wire-error', components: [
    { key: 'a', kind: 'workflow', id: 'artifact-a' }, { key: 'b', kind: 'workflow', id: 'artifact-b' },
  ], wiring: [{ from: 'a', to: 'b', relation: 'references' }] }, {}, {
    wire: async () => { throw new Error('wire response lost'); },
    verify: async () => ({ ok: true }) as never,
  });
  assert.equal(report.status, 'BROKEN'); assert.equal(report.ok, false);
  assert.deepEqual(report.components.map(c => c.id), ['artifact-a', 'artifact-b']);
  assert.equal(report.wires[0].state, 'failed'); assert.match(report.wires[0].detail, /wire response lost/);
});
