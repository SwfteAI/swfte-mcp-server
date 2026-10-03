import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { LocalStepQueue, newCallContext, runInCall, recordEcho, resultTraceId, withTrace, parseTraceparent } from '../src/tracing.js';
import { LOCAL_STEPS_PATH, TRACE_META_KEY, TRACEPARENT_HEADER } from '../src/learning-contract.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const config = (workspace = 'ws-a') => loadConfig({ SWFTE_PAT: ['pat', 'learning', workspace].join('_'),
  SWFTE_WORKSPACE_ID: workspace, SWFTE_BASE_URL: 'https://fixture.invalid' } as never);
const context = () => newCallContext({ sessionId: 'mcp-session-test', client: 'codex', tool: 'swfte_build',
  args: { prompt: 'private customer prose', connection: 'conn_fixture', count: 3 } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('a foreign valid echo never replaces the tool identity; final trailer is unique', () => {
  const call = context();
  recordEcho(call, 'ab'.repeat(16));
  assert.equal(resultTraceId(call), call.traceId);
  recordEcho(call, call.traceId);
  const original = { content: [{ type: 'text', text: 'ordinary result' }], _meta: { safe: true } };
  const stamped = withTrace(withTrace(original, call.traceId), call.traceId);
  assert.equal(stamped.content.length, 2);
  assert.equal(stamped.content.at(-1)?.text, `swfte-trace: ${call.traceId}`);
  assert.equal((stamped._meta as any)[TRACE_META_KEY], call.traceId);
  assert.equal((stamped._meta as any).safe, true);
  assert.equal(parseTraceparent(`00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`), undefined);
});

test('subrequests and retries share a tool trace but use distinct spans', async () => {
  const calls: any[] = [];
  let first = true;
  globalThis.fetch = (async (_url: any, init: any) => {
    calls.push(init);
    const status = first ? 503 : 200;
    first = false;
    return new Response('{"ok":true}', { status, headers: { 'X-Swfte-Trace-Id': 'ab'.repeat(16) } });
  }) as typeof fetch;
  const client = new SwfteClient(config());
  const call = context();
  await runInCall(call, async () => {
    await client.request({ method: 'GET', path: '/v2/read', retries: 1 });
    await client.request({ method: 'GET', path: '/v2/read-again', retries: 0 });
  });
  assert.equal(call.requests, 3);
  const ids = calls.map((c) => parseTraceparent(c.headers[TRACEPARENT_HEADER])!);
  assert.ok(ids.every((id) => id.traceId === call.traceId));
  assert.equal(new Set(ids.map((id) => id.spanId)).size, 3);
  assert.equal(resultTraceId(call), call.traceId);
});

test('a client timeout queues only value-free CLIENT_TIMEOUT metadata and no mutation retry', async () => {
  let attempts = 0;
  globalThis.fetch = ((_url: any, init: any) => {
    attempts++;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort',
      () => reject(new DOMException('deadline', 'AbortError')), { once: true }));
  }) as typeof fetch;
  const client = new SwfteClient(config());
  const call = context();
  await assert.rejects(runInCall(call, () => client.request({ method: 'POST', path: '/v2/mutation', timeoutMs: 5 })));
  assert.equal(attempts, 1);
  assert.equal(client.pendingLocalSteps.queued, 1);
  const step = client.pendingLocalSteps.steps[0]!;
  assert.equal(step.resultClass, 'CLIENT_TIMEOUT');
  assert.equal(step.traceId, call.traceId);
  assert.deepEqual(step.argShape, { prompt: 'string', connection: 'handle', count: 'integer' });
  assert.doesNotMatch(JSON.stringify(step), /private customer prose|conn_fixture|deadline/);
});

test('a deadline while consuming a response body is also a single CLIENT_TIMEOUT attempt', async () => {
  let attempts = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    attempts++;
    const response = new Response('', { status: 200 });
    response.text = () => new Promise((_resolve, reject) => init.signal.addEventListener('abort',
      () => reject(new DOMException('stream deadline', 'AbortError')), { once: true }));
    return response;
  }) as typeof fetch;
  const client = new SwfteClient(config());
  await assert.rejects(runInCall(context(), () => client.request({ method: 'POST', path: '/v2/mutation', timeoutMs: 5 })));
  assert.equal(attempts, 1);
  assert.equal(client.pendingLocalSteps.queued, 1);
  assert.equal(client.pendingLocalSteps.steps[0]?.resultClass, 'CLIENT_TIMEOUT');
});

test('queue remains bounded and batches never mix workspace, session or client', () => {
  const q = new LocalStepQueue(3);
  const entry = (ws: string, n: number) => ({ workspaceId: ws, sessionId: 'mcp-session-test', client: 'codex' as const,
    step: { traceId: n.toString(16).padStart(32, '1'), spanId: n.toString(16).padStart(16, '1'),
      tool: 'swfte_build', resultClass: 'UNREACHED' as const, ms: 1 } });
  q.push(entry('ws-a', 1)); q.push(entry('ws-b', 2)); q.push(entry('ws-a', 3)); q.push(entry('ws-b', 4));
  assert.equal(q.size, 3); assert.equal(q.dropped, 1);
  const batch = q.takeBatch(50);
  assert.equal(batch.length, 2);
  assert.ok(batch.every((e) => e.workspaceId === 'ws-b'));
  assert.equal(q.size, 1);
});

test('transient local-ingest refusal retains same span for later delivery, with no recursive capture', async () => {
  const seen: any[] = [];
  let status = 503;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    seen.push({ path: new URL(String(url)).pathname, ...init });
    return new Response(status === 503 ? '{"code":"UNAVAILABLE"}' : '{"accepted":1}', { status });
  }) as typeof fetch;
  const client = new SwfteClient(config());
  const call = context();
  const step = { traceId: call.traceId, spanId: '1'.repeat(16), tool: call.tool, resultClass: 'UNREACHED' as const, ms: 1 };
  client.recordLocalStep({ step, sessionId: call.sessionId, client: call.client });
  await settle();
  assert.equal(seen.length, 1);
  assert.equal(client.pendingLocalSteps.queued, 1);
  status = 202;
  await runInCall(context(), () => client.request({ method: 'GET', path: '/v2/recovered', retries: 0 }));
  await settle();
  const posts = seen.filter((r) => r.path === LOCAL_STEPS_PATH);
  assert.equal(posts.length, 2);
  assert.equal(JSON.parse(posts[0].body).steps[0].spanId, JSON.parse(posts[1].body).steps[0].spanId);
  assert.ok(posts.every((p) => p.headers[TRACEPARENT_HEADER] === undefined));
  assert.equal(client.pendingLocalSteps.queued, 0);
});

test('captured client config is immutable across caller mutation and independent credentials', async () => {
  const seen: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => { seen.push(init); return new Response('{"ok":true}'); }) as typeof fetch;
  const firstConfig = config('ws-a');
  const first = new SwfteClient(firstConfig);
  const firstCredential = firstConfig.credential;
  firstConfig.credential = config('ws-b').credential;
  firstConfig.workspaceId = 'ws-b';
  await first.request({ method: 'GET', path: '/v2/read', retries: 0 });
  await new SwfteClient(config('ws-b')).request({ method: 'GET', path: '/v2/read', retries: 0 });
  assert.equal(seen[0].headers.Authorization, `Bearer ${firstCredential}`);
  assert.notEqual(seen[0].headers.Authorization, seen[1].headers.Authorization);
});
