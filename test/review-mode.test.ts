import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SwfteClient, SwfteApiError } from '../src/client.js';
import { reviewModeTools, reviewHref } from '../src/tools/review-mode.js';
import { allTools } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/_types.js';
import type { ServerConfig } from '../src/config.js';

const H = `sha256:${'1'.repeat(64)}`;
const PLAN = `sha256:${'4'.repeat(64)}`;
const RV = 'rv_2b7e41aabbcc';

const config = (): ServerConfig => ({ baseUrl: 'https://api.swfte.test/agents', credential: 'pat_local_fixture', credentialKind: 'pat', workspaceId: 'ws_a',
  userAgent: 'review-mode-test', debug: false, enabledGroups: new Set(), allowDeploy: false, defaultWaitMs: 1000, telemetry: false });

type Call = { method: string; path: string; body?: any };
const session = (over: Record<string, unknown> = {}) => ({ id: RV, kind: 'workflow', artifactId: 'wf_content_pipeline', version: 'v7', contentHash: H, planHash: null, actionId: null,
  role: 'compliance', status: 'OPEN', artifactReadOnly: true, stale: false,
  items: [{ id: 'item_1', title: 'No customer data leaves the EU', status: 'UNCHECKED', evidence: [], suggestion: { result: 'FAILED', reason: 'slack.com is in the US', evidence: [{ kind: 'node', ref: 'slack-approval' }, { kind: 'run', ref: 'r_8f3a', environment: 'SANDBOX' }] } },
    { id: 'item_2', title: 'Every source is on the approved list', status: 'PASSED', evidence: [] }],
  findings: [{ id: 'fd_91c0', itemId: 'item_1', severity: 'HIGH', status: 'WAITING_FOR_A_PERSON' }], ...over });

/** A client whose answers a test scripts per route; every call is recorded so a test can see exactly what was asked. */
function harness(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const ctx = { config: config(), client: { request: async (r: any) => {
    const call: Call = { method: r.method, path: r.path, body: r.body };
    calls.push(call);
    const key = `${r.method} ${r.path.replace(/rv_[0-9a-f]{12}/, ':id').replace(/item_\d+/, ':item')}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unscripted ${key}`);
    const out = handler(call);
    if (out instanceof Error) throw out;
    return out;
  } } } as unknown as ToolContext;
  return { calls, run: (name: string, input: unknown) => { const t = reviewModeTools.find(x => x.name === name)!; assert.ok(t, name); return t.execute(t.inputSchema.parse(input), ctx); } };
}

const ARTIFACT_WRITE = /^\/v2\/(workflows|agents|chatflows|models|applications|widgets)\/[^/]+/;
/** The property under test: nothing a review tool sends can touch an artifact's own routes with a write method. */
function touchesArtifact(calls: Call[]): Call[] { return calls.filter(c => c.method !== 'GET' && ARTIFACT_WRITE.test(c.path)); }

afterEach(() => { delete process.env.SWFTE_STUDIO_URL; });

describe('review mode MCP tools', () => {
  test('there are six tools, registered, and the descriptions say what a token cannot do', () => {
    assert.deepEqual(reviewModeTools.map(t => t.name), ['swfte_review_start', 'swfte_review_items', 'swfte_review_check', 'swfte_review_finding', 'swfte_review_signoff', 'swfte_review_status']);
    for (const t of reviewModeTools) assert.ok(allTools.some(x => x.name === t.name), `${t.name} is advertised`);
    assert.match(reviewModeTools.find(t => t.name === 'swfte_review_check')!.description, /SUGGESTION/);
    assert.match(reviewModeTools.find(t => t.name === 'swfte_review_signoff')!.description, /review:signoff/);
  });

  test('start posts the exact pinned version and answers the review id, read-only on the artifact', async () => {
    const h = harness({ 'POST /v2/review/sessions': () => session() });
    const out: any = await h.run('swfte_review_start', { kind: 'workflow', artifactId: 'wf_content_pipeline', contentHash: H, role: 'compliance' });
    assert.deepEqual(h.calls[0].body, { kind: 'workflow', artifactId: 'wf_content_pipeline', contentHash: H, role: 'compliance' });
    assert.equal(out.reviewId, RV);
    assert.equal(out.artifactReadOnly, true);
    assert.deepEqual(out.pinned, { version: 'v7', contentHash: H });
    assert.equal(out.items, 2);
  });

  test('start refuses a loose hash or a made-up kind before any request leaves', () => {
    const h = harness({});
    assert.throws(() => h.run('swfte_review_start', { kind: 'workflow', artifactId: 'wf', contentHash: 'abc' }));
    assert.throws(() => h.run('swfte_review_start', { kind: 'spreadsheet', artifactId: 'wf', contentHash: H }));
    assert.equal(h.calls.length, 0);
  });

  test('items and status only ever read', async () => {
    const h = harness({ 'GET /v2/review/sessions/:id/items': () => ({ items: session().items }),
      'GET /v2/review/sessions/:id/status': () => ({ status: 'OPEN', stale: false, items: { passed: 1, failed: 0, needsInfo: 0, unchecked: 1 }, signoff: { ready: false, blockedBy: ['item_1'] }, quorum: { required: 2, signed: 0 } }) });
    const items: any = await h.run('swfte_review_items', { reviewId: RV });
    assert.equal(items[0].suggested, 'FAILED');
    assert.equal(items[1].status, 'PASSED');
    const status: any = await h.run('swfte_review_status', { reviewId: RV });
    assert.deepEqual(status.signoff.blockedBy, ['item_1']);
    assert.ok(h.calls.every(c => c.method === 'GET'));
    assert.equal(reviewModeTools.find(t => t.name === 'swfte_review_items')!.readOnly, true);
    assert.equal(reviewModeTools.find(t => t.name === 'swfte_review_status')!.readOnly, true);
  });

  test('check records a suggestion only, with the evidence it cites', async () => {
    const h = harness({ 'POST /v2/review/sessions/:id/items/:item/check': () => session() });
    const out: any = await h.run('swfte_review_check', { reviewId: RV, itemId: 'item_1', question: 'Validate that no customer data leaves the EU' });
    assert.equal(out.recorded, 'SUGGESTION_ONLY');
    assert.equal(out.suggested, 'FAILED');
    assert.deepEqual(out.evidence.map((e: any) => e.kind), ['node', 'run']);
    assert.equal(h.calls[0].path, `/v2/review/sessions/${RV}/items/item_1/check`);
  });

  test('finding records a fact that waits for a person and decides nothing', async () => {
    const h = harness({ 'POST /v2/review/sessions/:id/findings': () => session() });
    const out: any = await h.run('swfte_review_finding', { reviewId: RV, itemId: 'item_1', severity: 'HIGH', note: 'Summary text can name customers' });
    assert.equal(out.status, 'WAITING_FOR_A_PERSON');
    assert.deepEqual(out.needsHuman, ['request_changes', 'accept_risk']);
    assert.deepEqual(h.calls[0].body, { itemId: 'item_1', severity: 'HIGH', note: 'Summary text can name customers' });
  });

  test('no review tool can reach an artifact write route, and the checker really does catch one', async () => {
    const h = harness({
      'POST /v2/review/sessions': () => session(), 'GET /v2/review/sessions/:id': () => session(), 'GET /v2/review/sessions/:id/items': () => ({ items: [] }),
      'GET /v2/review/sessions/:id/status': () => ({ status: 'OPEN', items: {}, signoff: {}, quorum: {} }),
      'POST /v2/review/sessions/:id/items/:item/check': () => session(), 'POST /v2/review/sessions/:id/findings': () => session(),
      'POST /v2/review/sessions/:id/signoff': () => ({ status: 'SIGNED', signedBy: { user: 'priya', via: 'token' }, actionId: 'act_1', quorum: { required: 1, signed: 1 } }),
    });
    await h.run('swfte_review_start', { kind: 'workflow', artifactId: 'wf', contentHash: H });
    await h.run('swfte_review_items', { reviewId: RV });
    await h.run('swfte_review_status', { reviewId: RV });
    await h.run('swfte_review_check', { reviewId: RV, itemId: 'item_1' });
    await h.run('swfte_review_finding', { reviewId: RV, itemId: 'item_1', severity: 'LOW', note: 'x' });
    await h.run('swfte_review_signoff', { reviewId: RV });
    assert.ok(h.calls.length >= 7);
    assert.deepEqual(touchesArtifact(h.calls), []);
    assert.ok(h.calls.every(c => c.path.startsWith('/v2/review/sessions')));
    // negative control: the same checker flags a call a mutated tool would make
    assert.equal(touchesArtifact([...h.calls, { method: 'PUT', path: '/v2/workflows/wf_content_pipeline', body: {} }]).length, 1);
  });

  test('signoff without the review:signoff scope answers NEEDS_INTERACTIVE_SESSION with a Studio link and signs nothing', async () => {
    process.env.SWFTE_STUDIO_URL = 'https://studio.swfte.com';
    const h = harness({
      'GET /v2/review/sessions/:id': () => session({ actionId: 'act_7f21' }),
      'POST /v2/review/sessions/:id/signoff': () => new SwfteApiError({ status: 403, code: 'NEEDS_INTERACTIVE_SESSION', message: 'not granted', method: 'POST', path: '/x' }),
    });
    const out: any = await h.run('swfte_review_signoff', { reviewId: RV });
    assert.equal(out.status, 'NEEDS_INTERACTIVE_SESSION');
    assert.equal(out.openItems, 1);
    const url = new URL(out.url);
    assert.equal(url.pathname, '/v2/studio/review/workflow/wf_content_pipeline');
    assert.equal(url.searchParams.get('hash'), H);
    assert.equal(url.searchParams.get('review'), RV);
    assert.equal(url.searchParams.get('action'), 'act_7f21');
    assert.notEqual(out.status, 'SIGNED');
  });

  test('signoff with the scope signs, bound to the pinned hashes, and reports it counts as its owner', async () => {
    const h = harness({
      'GET /v2/review/sessions/:id': () => session({ planHash: PLAN, actionId: 'act_7f21' }),
      'POST /v2/review/sessions/:id/signoff': () => ({ status: 'AWAITING_QUORUM', reviewId: RV, actionId: 'act_7f21', signedBy: { user: 'priya.raman', via: 'token' }, quorum: { required: 2, signed: 1, people: ['priya.raman'] } }),
    });
    const out: any = await h.run('swfte_review_signoff', { reviewId: RV, note: 'Reviewed, signing', acknowledged: true });
    const post = h.calls.find(c => c.method === 'POST')!;
    assert.equal(post.body.expectedContentHash, H);
    assert.equal(post.body.expectedPlanHash, PLAN);
    assert.equal(post.body.acknowledged, true);
    assert.equal(out.status, 'AWAITING_QUORUM');
    assert.deepEqual(out.signedBy, { user: 'priya.raman', via: 'token', scope: 'review:signoff' });
    assert.deepEqual(out.quorum, { required: 2, distinctPeople: 1, countedAs: 'priya.raman', waitingFor: 1 });
  });

  test('signoff refuses a hash the review is not pinned to, with no sign-off request sent', async () => {
    const h = harness({ 'GET /v2/review/sessions/:id': () => session({ planHash: PLAN }), 'POST /v2/review/sessions/:id/signoff': () => ({ status: 'SIGNED' }) });
    await assert.rejects(h.run('swfte_review_signoff', { reviewId: RV, expectedContentHash: `sha256:${'9'.repeat(64)}` }), (e: any) => e.code === 'STALE_CONTENT');
    await assert.rejects(h.run('swfte_review_signoff', { reviewId: RV, expectedPlanHash: `sha256:${'9'.repeat(64)}` }), (e: any) => e.code === 'STALE_PLAN');
    assert.ok(h.calls.every(c => c.method === 'GET'));
  });

  test('another failure from the server is passed through, not turned into a Studio link', async () => {
    const h = harness({ 'GET /v2/review/sessions/:id': () => session(), 'POST /v2/review/sessions/:id/signoff': () => new SwfteApiError({ status: 409, code: 'ITEMS_OPEN', message: 'These checks are still open', method: 'POST', path: '/x' }) });
    await assert.rejects(h.run('swfte_review_signoff', { reviewId: RV }), (e: any) => e.code === 'ITEMS_OPEN');
  });

  test('through the real client, a 403 NEEDS_INTERACTIVE_SESSION body becomes the Studio-link answer', async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input); const method = init?.method ?? 'GET'; seen.push(`${method} ${new URL(url).pathname}`);
      if (method === 'GET') return new Response(JSON.stringify(session()), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ error: 'NEEDS_INTERACTIVE_SESSION', message: 'Sign-off is a decision.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const cfg = config();
      const ctx = { client: new SwfteClient(cfg), config: cfg } as ToolContext;
      const t = reviewModeTools.find(x => x.name === 'swfte_review_signoff')!;
      const out: any = await t.execute(t.inputSchema.parse({ reviewId: RV }), ctx);
      assert.equal(out.status, 'NEEDS_INTERACTIVE_SESSION');
      assert.deepEqual(seen, [`GET /agents/v2/review/sessions/${RV}`, `POST /agents/v2/review/sessions/${RV}/signoff`]);
    } finally { globalThis.fetch = original; }
  });

  test('the Studio link reuses the exact-packet pattern and refuses an unsafe base URL', () => {
    process.env.SWFTE_STUDIO_URL = 'https://user:pw@studio.swfte.com';
    assert.throws(() => reviewHref('workflow', 'wf', H, RV));
    process.env.SWFTE_STUDIO_URL = 'http://evil.example.com';
    assert.throws(() => reviewHref('workflow', 'wf', H, RV));
    process.env.SWFTE_STUDIO_URL = 'http://localhost:3309';
    assert.equal(new URL(reviewHref('workflow', 'wf 1', H, RV)).pathname, '/v2/studio/review/workflow/wf%201');
  });
});
