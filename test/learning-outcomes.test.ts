/**
 * G-OUT: swfte_report_outcome and swfte_propose_rule post their gpu-deploy-mcp-shaped bodies to the review
 * queue (POST /v2/learning/outcomes and /v2/learning/proposals), say that a human reviews them and that
 * they never count as evidence, and send no other request.
 *
 * Driven through the real MCP server and SwfteClient against a mocked global fetch, so every request the
 * tools make is visible.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { buildServer, selectTools } from '../src/server.js';
import { allTools } from '../src/tools/index.js';
import { learningTools } from '../src/tools/learning.js';
import {
  LOCAL_STEPS_PATH,
  OUTCOMES_PATH,
  PROPOSALS_PATH,
  TRACE_META_KEY,
  TRACE_TRAILER_RE,
} from '../src/learning-contract.js';

const PAT = ['pat', 'outcome', 'fixture'].join('_');
const config = () => loadConfig({ SWFTE_PAT: PAT, SWFTE_BASE_URL: 'https://learning.test/agents', SWFTE_TOOLS: 'core,learning' } as never);

interface Seen {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
}

const realFetch = globalThis.fetch;
let seen: Seen[] = [];
let reply: (s: Seen) => Response = (s) =>
  new Response(JSON.stringify({ id: 'rq_1', kind: s.path === OUTCOMES_PATH ? 'outcome' : 'proposal', status: 'pending', createdAt: '2026-09-27T00:00:00Z' }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  seen = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const s: Seen = {
      method: init.method ?? 'GET',
      path: url.pathname.replace(/^\/agents/, ''),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
    };
    seen.push(s);
    if (s.path === LOCAL_STEPS_PATH) return new Response('{"accepted":1}', { status: 202 });
    return reply(s);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  reply = (s) =>
    new Response(JSON.stringify({ id: 'rq_1', kind: s.path === OUTCOMES_PATH ? 'outcome' : 'proposal', status: 'pending', createdAt: '2026-09-27T00:00:00Z' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
});

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const server: any = buildServer({ config: config(), resolveClient: () => new SwfteClient(config()) });
  return server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } }, {});
}

/** Let any fire-and-forget work settle so "no other request" is measured after it, not before. */
const settle = () => new Promise((r) => setTimeout(r, 50));

const TRACE = 'c0ffee00'.repeat(4);
const TRACE2 = '0123456789abcdef'.repeat(2);

const tool = (name: string) => {
  const t = allTools.find((x) => x.name === name);
  assert.ok(t, `${name} is not registered`);
  return t!;
};

describe('review-queue tools (G-OUT)', () => {
  test('swfte_report_outcome posts exactly its typed fields to the outcomes queue, once', async () => {
    const res = await call('swfte_report_outcome', {
      traceId: TRACE,
      outcome: 'partial',
      summary: 'Two of three nodes ran; the Slack step needs a channel.',
      executionIds: ['exec_1', 'exec_2'],
    });
    await settle();
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(seen.length, 1, `expected one request, saw ${seen.map((s) => `${s.method} ${s.path}`).join(', ')}`);
    const [s] = seen;
    assert.equal(s!.method, 'POST');
    assert.equal(s!.path, OUTCOMES_PATH);
    assert.deepEqual(s!.body, {
      traceId: TRACE,
      outcome: 'partial',
      summary: 'Two of three nodes ran; the Slack step needs a channel.',
      executionIds: ['exec_1', 'exec_2'],
    });
    assert.equal(JSON.parse(res.content[0].text).status, 'pending');
    assert.match(res.content.at(-1).text, TRACE_TRAILER_RE);
    assert.ok(res._meta[TRACE_META_KEY]);
  });

  test('unset optional fields are left out of the outcome body', async () => {
    await call('swfte_report_outcome', { traceId: TRACE, outcome: 'succeeded' });
    await settle();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.body, { traceId: TRACE, outcome: 'succeeded' });
  });

  test('swfte_propose_rule posts exactly its typed fields to the proposals queue, once', async () => {
    const res = await call('swfte_propose_rule', {
      rule: 'Set the Slack channel before the first run.',
      rationale: 'Three runs failed at the Slack node with no channel bound.',
      errorSignature: 'http:400:CHANNEL_REQUIRED',
      traceIds: [TRACE, TRACE2],
    });
    await settle();
    assert.equal(res.isError, undefined, res.content?.[0]?.text);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.method, 'POST');
    assert.equal(seen[0]!.path, PROPOSALS_PATH);
    assert.deepEqual(seen[0]!.body, {
      rule: 'Set the Slack channel before the first run.',
      rationale: 'Three runs failed at the Slack node with no channel bound.',
      errorSignature: 'http:400:CHANNEL_REQUIRED',
      traceIds: [TRACE, TRACE2],
    });
  });

  test('unset optional fields are left out of the proposal body', async () => {
    await call('swfte_propose_rule', { rule: 'r', rationale: 'because' });
    await settle();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.body, { rule: 'r', rationale: 'because' });
  });

  test('extra arguments never reach the body', async () => {
    await call('swfte_report_outcome', { traceId: TRACE, outcome: 'failed', evidenceLevel: 'verified', workspaceId: 'ws_other' });
    await call('swfte_propose_rule', { rule: 'r', rationale: 'x', status: 'accepted' });
    await settle();
    assert.deepEqual(seen.map((s) => s.body), [
      { traceId: TRACE, outcome: 'failed' },
      { rule: 'r', rationale: 'x' },
    ]);
  });

  test('a mutation is sent once: a 503 is not retried into a duplicate review entry', async () => {
    reply = () => new Response('{"code":"UNAVAILABLE","message":"down"}', { status: 503 });
    const res = await call('swfte_report_outcome', { traceId: TRACE, outcome: 'failed' });
    await settle();
    assert.equal(res.isError, true);
    assert.equal(seen.length, 1);
  });

  test('the backend refusal (flag off) is passed through as a structured error', async () => {
    reply = () => new Response('{"code":"NOT_FOUND","message":"Not found"}', { status: 404 });
    const res = await call('swfte_propose_rule', { rule: 'r', rationale: 'x' });
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.code, 'NOT_FOUND');
    assert.equal(body.request, `POST ${PROPOSALS_PATH}`);
  });

  test('invalid input is refused before any review-queue request', async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['swfte_report_outcome', { outcome: 'succeeded' }],
      ['swfte_report_outcome', { traceId: 'XYZ', outcome: 'succeeded' }],
      ['swfte_report_outcome', { traceId: '0'.repeat(32), outcome: 'succeeded' }],
      ['swfte_report_outcome', { traceId: TRACE.toUpperCase(), outcome: 'succeeded' }],
      ['swfte_report_outcome', { traceId: TRACE, outcome: 'great' }],
      ['swfte_report_outcome', { traceId: TRACE, outcome: 'failed', summary: 'x'.repeat(1001) }],
      ['swfte_report_outcome', { traceId: TRACE, outcome: 'failed', executionIds: Array.from({ length: 21 }, (_, i) => `e${i}`) }],
      ['swfte_propose_rule', { rationale: 'x' }],
      ['swfte_propose_rule', { rule: 'x'.repeat(501), rationale: 'x' }],
      ['swfte_propose_rule', { rule: 'r', rationale: 'x'.repeat(2001) }],
      ['swfte_propose_rule', { rule: 'r', rationale: 'x', errorSignature: 'e'.repeat(129) }],
      ['swfte_propose_rule', { rule: 'r', rationale: 'x', traceIds: ['nope'] }],
      ['swfte_propose_rule', { rule: 'r', rationale: 'x', traceIds: Array.from({ length: 21 }, () => TRACE) }],
    ];
    for (const [name, args] of bad) {
      const res = await call(name, args);
      assert.equal(res.isError, true, `${name} accepted ${JSON.stringify(args).slice(0, 80)}`);
      assert.match(res.content[0].text, /^Invalid input/);
    }
    await settle();
    // Only the learning loop's own local steps (a refused call made no backend request); nothing queued.
    assert.deepEqual(seen.filter((s) => s.path !== LOCAL_STEPS_PATH), []);
  });

  test('the boundaries themselves are accepted', async () => {
    await call('swfte_report_outcome', {
      traceId: TRACE,
      outcome: 'failed',
      summary: 'x'.repeat(1000),
      executionIds: Array.from({ length: 20 }, (_, i) => `e${i}`),
    });
    await call('swfte_propose_rule', {
      rule: 'x'.repeat(500),
      rationale: 'y'.repeat(2000),
      errorSignature: 'e'.repeat(128),
      traceIds: Array.from({ length: 20 }, () => TRACE),
    });
    await settle();
    assert.deepEqual(seen.map((s) => s.path), [OUTCOMES_PATH, PROPOSALS_PATH]);
  });

  test('descriptions say a human reviews the entry and that it never counts as evidence', () => {
    for (const name of ['swfte_report_outcome', 'swfte_propose_rule']) {
      const d = tool(name).description;
      assert.match(d, /a human reviews/i, `${name} does not say a human reviews it`);
      assert.match(d, /never counts as evidence/i, `${name} does not say it never counts as evidence`);
      assert.match(d, /review queue/i);
      // Copy rule: never claim certification or proof.
      assert.doesNotMatch(d, /\b(certified|proven|verified)\b/i, `${name} uses a claim word`);
    }
  });

  test('both are registered once, in the opt-in learning group: advertised when named, never in a stock install', () => {
    for (const name of ['swfte_report_outcome', 'swfte_propose_rule']) {
      assert.equal(allTools.filter((t) => t.name === name).length, 1, `${name} registered more than once`);
      assert.equal(tool(name).group, 'learning');
      assert.ok(learningTools.some((t) => t.name === name));
    }
    const named = selectTools(allTools, loadConfig({ SWFTE_PAT: PAT, SWFTE_TOOLS: 'core,learning' } as never));
    assert.ok(named.some((t) => t.name === 'swfte_report_outcome'));
    assert.ok(named.some((t) => t.name === 'swfte_propose_rule'));
    // The stock surface stays at its ceiling: the learning tools do not spend the default budget.
    const stock = selectTools(allTools, loadConfig({ SWFTE_PAT: PAT } as never));
    assert.ok(!stock.some((t) => t.name === 'swfte_report_outcome'));
    assert.ok(!stock.some((t) => t.name === 'swfte_propose_rule'));
  });
});
