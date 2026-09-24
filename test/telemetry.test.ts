/**
 * Telemetry: counts-only usage events from swfte_find_existing, swfte_build,
 * swfte_adopt and swfte_scaffold_client.
 *
 * Pins the four promises the README makes: opt-out with SWFTE_TELEMETRY=0 sends
 * nothing; an event never blocks a tool (a telemetry call that never answers does
 * not delay the result); it is never retried (one attempt, even on 503 or a reset);
 * and it never fails a tool. Plus: the body is the four contract fields and nothing
 * else — no query, prompt or code travels.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { allTools } from '../src/tools/index.js';
import { decisionOf, emitTelemetry, telemetryBody, telemetryEnabled, TELEMETRY_PATH } from '../src/telemetry.js';

const PAT = 'pat_telemetrytestcredential1';
const realFetch = globalThis.fetch;

interface Call { method: string; path: string; body: any }
let calls: Call[] = [];

/** Every telemetry POST is answered by `telemetry`; everything else by `routes`. */
function installFetch(opts: {
  telemetry?: () => Promise<Response>;
  routes?: Array<[string, RegExp, unknown]>;
}) {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/agents/, '');
    const call = { method: String(init.method ?? 'GET'), path, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (path === TELEMETRY_PATH) {
      return opts.telemetry ? opts.telemetry() : new Response('{"accepted":true}', { status: 202 });
    }
    const hit = (opts.routes ?? []).find(([m, re]) => m === call.method && re.test(path));
    if (!hit) return new Response(JSON.stringify({ code: 'NO_ROUTE' }), { status: 599 });
    return new Response(JSON.stringify(hit[2]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const tool = (name: string) => {
  const t = allTools.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
};

function ctx(env: Record<string, string> = {}) {
  const config = loadConfig({ SWFTE_PAT: PAT, ...env } as never);
  return { client: new SwfteClient(config), config };
}

/** Lets fire-and-forget work (microtasks + the mocked fetch) finish. */
const settle = () => new Promise((r) => setTimeout(r, 20));
const telemetryCalls = () => calls.filter((c) => c.path === TELEMETRY_PATH);

const SEARCH_HIT = {
  items: [
    {
      catalogRef: 'workflow:wf_1', kind: 'workflow', id: 'wf_1', workspaceId: 'ws', scope: 'workspace',
      name: 'Invoice Extractor', description: 'Extracts invoices', source: 'workflow_v2', listingId: null, facets: [],
      evidence: { level: 'validated', runs: { total: 9, succeeded: 9, failed: 0 }, successRate: 1, lastRunAt: null, evals: 1, reviews: { approve: 1, reject: 0 }, reasons: [] },
      updatedAt: '2026-09-20T00:00:00Z', shapeHash: null,
    },
  ],
  nextCursor: null,
  degraded: [],
};

let tmp = '';
let prevCwd = '';
beforeEach(() => {
  calls = [];
  prevCwd = process.cwd();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-telemetry-')));
  process.chdir(tmp);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe('telemetry: opt-out', () => {
  test('SWFTE_TELEMETRY=0 / false / off / no disables it; unset or anything else leaves it on', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) assert.equal(telemetryEnabled({ SWFTE_TELEMETRY: v }), false, v);
    for (const v of [undefined, '', '1', 'true', 'on']) assert.equal(telemetryEnabled({ SWFTE_TELEMETRY: v } as never), true, String(v));
    assert.equal(loadConfig({ SWFTE_PAT: PAT, SWFTE_TELEMETRY: '0' } as never).telemetry, false);
    assert.equal(loadConfig({ SWFTE_PAT: PAT } as never).telemetry, true);
  });

  test('with SWFTE_TELEMETRY=0 a search sends no telemetry at all', async () => {
    installFetch({ routes: [['GET', /^\/v2\/catalog\/search$/, SEARCH_HIT]] });
    const res: any = await tool('swfte_find_existing').execute({ query: 'invoice' } as never, ctx({ SWFTE_TELEMETRY: '0' }));
    await settle();
    assert.equal(res.recommendation.action, 'REUSE');
    assert.equal(telemetryCalls().length, 0);
    assert.equal(calls.length, 1);
  });
});

describe('telemetry: what is sent', () => {
  test('find_existing reports a search and the recommended decision — never the query', async () => {
    installFetch({ routes: [['GET', /^\/v2\/catalog\/search$/, SEARCH_HIT]] });
    await tool('swfte_find_existing').execute({ query: 'Acme Corp overdue invoices', facets: { domain: 'finance' } } as never, ctx());
    await settle();
    const bodies = telemetryCalls().map((c) => c.body);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], { event: 'search', client: bodies[0].client });
    assert.deepEqual(bodies[1], { event: 'reuse_decision', client: bodies[1].client, catalogRef: 'workflow:wf_1', decision: 'reuse' });
    assert.match(bodies[0].client, /^mcp\/\d+\.\d+\.\d+/);
    for (const b of bodies) {
      assert.deepEqual(Object.keys(b).filter((k) => !['event', 'catalogRef', 'decision', 'client'].includes(k)), []);
      assert.ok(!JSON.stringify(b).includes('Acme'));
      assert.ok(!JSON.stringify(b).includes('finance'));
    }
    assert.ok(telemetryCalls().every((c) => c.method === 'POST'));
  });

  test('adopt reports the new catalogRef; scaffold the bound one', async () => {
    installFetch({
      routes: [
        ['POST', /^\/v2\/catalog\/workflow\/wf_1\/adopt$/, { catalogRef: 'workflow:wf_9', kind: 'workflow', id: 'wf_9', forkedFrom: 'workflow:wf_1', tailoringApplied: false, needsInput: [] }],
        ['GET', /^\/v2\/catalog\/workflow\/wf_1$/, { ...SEARCH_HIT.items[0], provenance: null, evidenceRecords: [], dependencies: [], reviews: [] }],
        ['GET', /^\/v2\/catalog\/workflow\/wf_1\/contract$/, {
          catalogRef: 'workflow:wf_1',
          invoke: { method: 'POST', path: '/v2/workflows/wf_1/invoke', auth: 'api_key', async: true, statusPath: '/v2/workflows/executions/{executionId}/status' },
          inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
          outputSchema: {},
          snippets: { curl: '', typescript: '', python: '', mcp: '' },
          embed: null,
        }],
      ],
    });
    const adopted: any = await tool('swfte_adopt').execute({ catalogRef: 'workflow:wf_1', name: 'Mine' } as never, ctx());
    assert.equal(adopted.catalogRef, 'workflow:wf_9');
    await tool('swfte_scaffold_client').execute({ catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'src/swfte', pin: false, complianceScan: false } as never, ctx());
    await settle();
    const bodies = telemetryCalls().map((c) => c.body);
    assert.deepEqual(bodies.map((b) => [b.event, b.catalogRef]), [['adopt', 'workflow:wf_9'], ['scaffold', 'workflow:wf_1']]);
  });

  test('build reports the artifact it persisted', async () => {
    const sent: any[] = [];
    const client = {
      request: async (r: any) => {
        sent.push(r);
        return r.path === TELEMETRY_PATH ? {} : { sessionId: 's1' };
      },
      pollUntil: async () => ({ snapshot: { done: true, status: 'COMPLETED', sessionId: 's1', nodes: [], edges: [], speculativeNodes: [], finalResponse: { workflowId: 'wf_new', id: 'wf_new' } }, timedOut: false, elapsedMs: 1, polls: 1 }),
    };
    const config = loadConfig({ SWFTE_PAT: PAT, SWFTE_TOOLS: 'core' } as never);
    const res: any = await tool('swfte_build').execute({ kind: 'workflow', prompt: 'Review the release evidence' } as never, { client: client as any, config });
    await settle();
    const t = sent.filter((r) => r.path === TELEMETRY_PATH);
    assert.equal(t.length, 1);
    assert.deepEqual(t[0].body, { event: 'build', client: t[0].body.client, catalogRef: `workflow:${res.id}` });
    assert.equal(t[0].retries, 0);
    assert.ok(!JSON.stringify(t[0].body).includes('release evidence'));
  });

  test('the generation figure is labelled an estimate and nothing adds it up', async () => {
    installFetch({ routes: [['GET', /^\/v2\/catalog\/search$/, SEARCH_HIT]] });
    const res: any = await tool('swfte_find_existing').execute({ query: 'invoice' } as never, ctx({ SWFTE_TELEMETRY: '0' }));
    const est = res.recommendation.generationAvoidedEstimate;
    assert.equal(est.estimate, true);
    assert.match(est.basis, /estimate/);
    assert.match(est.note, /not a measurement and not a saving/);
    assert.equal(res.recommendation.generationAvoided, undefined);
    const keys = JSON.stringify(res).match(/"[A-Za-z]+":/g) ?? [];
    assert.deepEqual(keys.filter((k) => /sav(ed|ing)|total(tokens|seconds)|cumulative/i.test(k)), []);
  });

  test('the body builder drops anything it does not know and refuses a decision-less reuse_decision', () => {
    const body = telemetryBody({ event: 'search', catalogRef: 'workflow:ok_1', ...({ query: 'secret', prompt: 'x' } as object) } as never);
    assert.deepEqual(Object.keys(body!).sort(), ['catalogRef', 'client', 'event']);
    assert.equal(telemetryBody({ event: 'search', catalogRef: 'not a ref with spaces' })!.catalogRef, undefined);
    assert.equal(telemetryBody({ event: 'reuse_decision' }), null);
    assert.equal(telemetryBody({ event: 'nonsense' as never }), null);
    assert.equal(decisionOf('INSPECT_BEFORE_REUSE'), 'inspect');
    assert.equal(decisionOf('SOMETHING'), null);
  });
});

describe('telemetry: best effort', () => {
  test('never blocks: a telemetry call that never answers does not delay the tool', async () => {
    installFetch({ telemetry: () => new Promise<Response>(() => undefined), routes: [['GET', /^\/v2\/catalog\/search$/, SEARCH_HIT]] });
    const started = Date.now();
    const res: any = await Promise.race([
      tool('swfte_find_existing').execute({ query: 'invoice' } as never, ctx()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('tool waited for telemetry')), 1_000)),
    ]);
    assert.equal(res.recommendation.action, 'REUSE');
    assert.ok(Date.now() - started < 1_000);
  });

  test('never retried: a 503 and a connection reset each get exactly one attempt', async () => {
    for (const fail of [
      () => Promise.resolve(new Response('{}', { status: 503 })),
      () => Promise.reject(new Error('connection reset')),
    ]) {
      calls = [];
      installFetch({ telemetry: fail });
      const c = ctx();
      emitTelemetry(c, { event: 'build' });
      await new Promise((r) => setTimeout(r, 1_500));
      assert.equal(telemetryCalls().length, 1);
    }
  });

  test('never fails a tool: telemetry failures and even a throwing client leave the result intact', async () => {
    installFetch({ telemetry: () => Promise.reject(new Error('down')), routes: [['GET', /^\/v2\/catalog\/search$/, SEARCH_HIT]] });
    const res: any = await tool('swfte_find_existing').execute({ query: 'invoice' } as never, ctx());
    assert.equal(res.recommendation.action, 'REUSE');
    const throwing = { request: () => { throw new Error('sync boom'); } };
    assert.doesNotThrow(() => emitTelemetry({ client: throwing as never, config: { telemetry: true } }, { event: 'search' }));
    await settle();
  });
});
