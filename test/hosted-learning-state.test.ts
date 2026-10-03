import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { HostedLearningState } from '../src/hosted-learning-state.js';
import { createHttpHandler, resolveClientFromAuth } from '../src/http.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { newCallContext, runInCall } from '../src/tracing.js';
import { LOCAL_STEPS_PATH, MCP_SESSION_HEADER, MCP_CLIENT_HEADER, TRACEPARENT_HEADER, type McpClientName } from '../src/learning-contract.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const config = (workspace = 'ws-a') => loadConfig({ SWFTE_PAT: 'pat_placeholder',
  SWFTE_WORKSPACE_ID: workspace, SWFTE_BASE_URL: 'https://fixture.invalid' } as never);
const auth = (token = 'pat_alice') => ({ token, clientId: 'verified-fixture', scopes: [] });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(predicate: () => boolean) {
  for (let n = 0; n < 100 && !predicate(); n++) await tick();
  assert.ok(predicate(), 'fixture effect must complete, not merely start');
}
const entry = (session = 'original-session', client: McpClientName = 'codex') => ({ sessionId: session, client,
  step: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), tool: 'swfte_build', resultClass: 'UNREACHED' as const, ms: 1 } });
function capture(status: () => number) {
  const posts: Array<{ headers: Record<string, string>; body: any }> = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    if (new URL(String(url)).pathname === LOCAL_STEPS_PATH) {
      posts.push({ headers: init.headers, body: JSON.parse(init.body) });
      return new Response('{"accepted":1}', { status: status() });
    }
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  return posts;
}
async function contact(resolve: ReturnType<typeof resolveClientFromAuth>, token = 'pat_alice', session = 'fresh-session') {
  const client = resolve(auth(token));
  await runInCall(newCallContext({ sessionId: session, client: 'claude-code', tool: 'swfte_build', args: {} }),
    () => client.request({ method: 'GET', path: '/v2/contact', retries: 0 }));
  return client;
}

test('fresh verified clients recover retained original session/client/span after completed transient refusal', async () => {
  let status = 503; const posts = capture(() => status);
  const resolve = resolveClientFromAuth(config()); const first = resolve(auth());
  first.recordLocalStep(entry());
  await settle(() => first.pendingLocalSteps.queued === 1 && posts.length === 1);
  status = 202;
  const second = await contact(resolve);
  assert.notEqual(first, second);
  await settle(() => posts.length === 2 && second.pendingLocalSteps.queued === 0);
  assert.deepEqual(posts[1], posts[0]);
  assert.equal(posts[1]!.headers[MCP_SESSION_HEADER], 'original-session');
  assert.equal(posts[1]!.headers[MCP_CLIENT_HEADER], 'codex');
  assert.equal(posts[1]!.headers[TRACEPARENT_HEADER], undefined);
});

test('actual fresh buildServer fallback sessions recover old batch without relabeling', async () => {
  let status = 503; const posts = capture(() => status);
  const resolve = resolveClientFromAuth(config());
  const call = async () => {
    const server: any = buildServer({ config: config(), resolveClient: resolve, localFilesystem: false });
    return server._requestHandlers.get('tools/call')({ method: 'tools/call',
      params: { name: 'not-a-real-tool', arguments: {} } }, { authInfo: auth() });
  };
  await call(); await settle(() => posts.length === 1); await tick(); await tick();
  const retained = posts[0]!; status = 202;
  await call(); await settle(() => posts.length >= 3);
  assert.deepEqual(posts[1], retained);
  assert.notEqual(posts[2]!.headers[MCP_SESSION_HEADER], retained.headers[MCP_SESSION_HEADER]);
  assert.equal(posts[1]!.body.steps[0].spanId, retained.body.steps[0].spanId);
});

test('actual stateless HTTP handler fresh servers retain original trace/span/session on next authenticated contact', async () => {
  let status = 503; const posts = capture(() => status);
  const cfg = config(); const resolve = resolveClientFromAuth(cfg);
  const handler = createHttpHandler({ config: cfg, resolveClient: resolve,
    authenticate: async () => ({ authInfo: auth() }) });
  const invoke = async (id: number) => {
    const response = await handler(new Request('https://mcp.fixture.invalid/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'not-a-real-tool', arguments: {} } }) }));
    const body = await response.text();
    assert.equal(response.status, 200); assert.match(body, /swfte-trace:/);
  };
  await invoke(1); await settle(() => posts.length === 1); await tick(); await tick();
  const retained = posts[0]!; status = 202;
  await invoke(2); await settle(() => posts.length >= 3);
  assert.deepEqual(posts[1], retained);
  assert.notEqual(posts[2]!.headers[MCP_SESSION_HEADER], retained.headers[MCP_SESSION_HEADER]);
});

test('different credential/workspace/backend never drains prior owner; original owner restores exact positive', async () => {
  let status = 503; const posts = capture(() => status); const registry = new HostedLearningState();
  const resolve = resolveClientFromAuth(config(), registry); const first = resolve(auth());
  first.recordLocalStep(entry()); await settle(() => first.pendingLocalSteps.queued === 1 && posts.length === 1);
  status = 202;
  await contact(resolve, 'pat_bob');
  await contact(resolveClientFromAuth(config('ws-b'), registry));
  await contact(resolveClientFromAuth({ ...config(), baseUrl: 'https://other.fixture.invalid' }, registry));
  await tick(); assert.equal(posts.length, 1);
  await contact(resolve); await settle(() => posts.length === 2 && first.pendingLocalSteps.queued === 0);
  assert.deepEqual(posts[1], posts[0]);
});

test('concurrent fresh contacts serialize one exact in-flight drain and retain later batches', async () => {
  let status = 503; const posts = capture(() => status); const resolve = resolveClientFromAuth(config());
  const first = resolve(auth()); first.recordLocalStep(entry());
  await settle(() => posts.length === 1 && first.pendingLocalSteps.queued === 1);
  let release!: () => void; let entered = false; const saved = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    if (new URL(String(url)).pathname === LOCAL_STEPS_PATH) {
      entered = true; await new Promise<void>((r) => { release = r; });
    }
    return saved(url, init);
  }) as typeof fetch;
  status = 202;
  await Promise.all([contact(resolve), contact(resolve)]);
  await settle(() => entered); assert.equal(posts.length, 1);
  release(); await settle(() => posts.length === 2 && first.pendingLocalSteps.queued === 0);
  assert.deepEqual(posts[1], posts[0]);
});

test('absolute expiry drops old pending span; fresh capture restores delivery without reviving expired batch', async () => {
  let clock = 100; let status = 503; const posts = capture(() => status);
  const registry = new HostedLearningState(() => clock); const resolve = resolveClientFromAuth(config(), registry);
  const first = resolve(auth()); first.recordLocalStep(entry());
  await settle(() => posts.length === 1 && first.pendingLocalSteps.queued === 1);
  clock += 300_000; assert.equal(registry.size, 0); assert.equal(registry.dropped, 1);
  status = 202; await contact(resolve); await tick(); assert.equal(posts.length, 1);
  resolve(auth()).recordLocalStep(entry('restored-session'));
  await settle(() => posts.length === 2);
  assert.equal(posts[1]!.headers[MCP_SESSION_HEADER], 'restored-session');
});

test('permanent refusal and telemetry disable explicitly discard retained bookkeeping; fresh enabled capture succeeds', async () => {
  let status = 403; const posts = capture(() => status); const registry = new HostedLearningState();
  const resolve = resolveClientFromAuth(config(), registry); const first = resolve(auth());
  first.recordLocalStep(entry()); await settle(() => first.pendingLocalSteps.dropped === 1);
  assert.equal(first.pendingLocalSteps.queued, 0);
  status = 503; first.recordLocalStep(entry()); await settle(() => first.pendingLocalSteps.queued === 1);
  const disabled = resolveClientFromAuth({ ...config(), telemetry: false }, registry)(auth());
  disabled.recordLocalStep(entry()); await tick(); assert.equal(first.pendingLocalSteps.queued, 0);
  status = 202; resolve(auth()).recordLocalStep(entry('restored-session'));
  await settle(() => posts.length === 3);
  assert.equal(posts[2]!.headers[MCP_SESSION_HEADER], 'restored-session');
});

test('slot and row limits refuse excess new scopes and preserve live in-flight serialization through expiry', () => {
  let clock = 10; const registry = new HostedLearningState(() => clock);
  const cfg = config(); const binding = registry.bind(cfg);
  const scope = { workspaceId: 'ws-a', sessionId: 'first', client: 'codex' as const };
  const state = binding.scope(scope)!;
  for (let n = 0; n < 201; n++) state.queue.push(entry());
  assert.equal(state.queue.size, 200); assert.equal(state.queue.dropped, 1);
  state.draining = true; state.inFlight = 1;
  for (let n = 1; n < 256; n++) assert.ok(registry.bind({ ...cfg, credential: `pat_owner_${n}` }).scope(scope));
  assert.equal(registry.size, 256);
  assert.equal(registry.bind({ ...cfg, credential: 'pat_overflow' }).scope(scope), undefined);
  clock += 300_000;
  assert.equal(binding.scope(scope), undefined); assert.equal(state.current(), false);
  assert.equal(registry.size, 1, 'expired in-flight tombstone remains');
  state.draining = false; state.inFlight = 0;
  const restored = binding.scope(scope)!;
  assert.notEqual(restored, state); assert.equal(restored.queue.size, 0); assert.equal(restored.current(), true);
});

test('actual held delivery expiry accounts once whether sweep precedes or follows completed transient refusal', async () => {
  for (const sweepWhileHeld of [false, true]) {
    let clock = 100; const registry = new HostedLearningState(() => clock);
    const cfg = config(); const resolve = resolveClientFromAuth(cfg, registry);
    const first = resolve(auth());
    const baseline = capture(() => 202);
    first.recordLocalStep(entry('baseline-current'));
    await settle(() => baseline.length === 1 && first.pendingLocalSteps.queued === 0);
    assert.equal(baseline[0]!.headers[MCP_SESSION_HEADER], 'baseline-current');
    // Capture the actual production state without a sweeping getter after expiry.
    const state = registry.bind({ ...cfg, credential: auth().token, credentialKind: 'pat' })
      .scope({ workspaceId: 'ws-a', sessionId: 'original-session', client: 'codex' })!;
    let release!: () => void, entered = false, completed = false;
    const posts: Array<{ body: any; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url: any, init: any = {}) => {
      if (new URL(String(url)).pathname !== LOCAL_STEPS_PATH) return new Response('{"ok":true}');
      posts.push({ body: JSON.parse(init.body), headers: init.headers });
      if (posts.length === 1) {
        entered = true; await new Promise<void>((r) => { release = r; });
        completed = true; return new Response('{"code":"UNAVAILABLE"}', { status: 503 });
      }
      return new Response('{"accepted":1}', { status: 202 });
    }) as typeof fetch;
    first.recordLocalStep(entry()); await settle(() => entered);
    assert.equal(state.inFlight, 1); assert.equal(state.draining, true);
    clock += 300_000;
    if (sweepWhileHeld) { assert.equal(registry.dropped, 1); assert.equal(registry.size, 1); }
    // In the late-sweep branch there has been NO registry contact/size/dropped getter since expiry.
    release(); await settle(() => completed && state.inFlight === 0 && state.draining === false);
    assert.equal(state.queue.size, 0); assert.equal(posts.length, 1);
    assert.equal(state.discarded, sweepWhileHeld ? 0 : 1, 'one accounting owner, never both sweep and batch');
    assert.equal(registry.dropped, 1); assert.equal(registry.size, 0);
    assert.equal(registry.dropped, 1, 'repeat sweep cannot count the batch twice');
    const fresh = await contact(resolve);
    assert.notEqual(fresh, first); await tick(); assert.equal(posts.length, 1, 'expired span is never retried');
    fresh.recordLocalStep(entry('fresh-after-expiry'));
    await settle(() => posts.length === 2 && fresh.pendingLocalSteps.queued === 0);
    assert.equal(posts[1]!.headers[MCP_SESSION_HEADER], 'fresh-after-expiry');
    assert.equal(registry.dropped, 1, 'fresh positive does not change expired-drop count');
  }
});
