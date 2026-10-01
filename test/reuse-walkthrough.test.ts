import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { SwfteApiError, SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { allTools } from '../src/tools/index.js';
import { getPrompt } from '../src/prompts.js';
import type { ToolContext } from '../src/tools/_types.js';
import { capturedFixtures, workflowGolden, type BackendContract } from './fixtures/phase5-contracts/index.js';

interface Wire { method: string; path: string; query: Record<string, string>; body: unknown; auth: string | null }
interface Scenario {
  level?: 'corroborated' | 'verified' | 'observed' | 'unmeasured';
  empty?: boolean;
  contract?: BackendContract;
  searchStatus?: number;
  detailStatus?: number;
  contractStatus?: number;
}
/** Enumerated from current src/kinds/* build adapters and tools/code translation. */
const GENERATION_PATHS = [
  /^\/v2\/workflows\/wizard\/generate\/async$/,
  /^\/v2\/agents\/wizard\/generate\/async$/,
  /^\/api\/v2\/chatflow\/generate\/async$/,
  /^\/v2\/widgets\/wizard\/generate\/async$/,
  /^\/v2\/applications\/wizard\/blueprint\/async$/,
  /^\/v2\/mcp\/wizard\/generate$/,
  /^\/v2\/modules(?:\/[^/]+\/build)?$/,
  /^\/v2\/workflows\/[^/]+\/translate-to-execution$/,
];
const CREDENTIAL = 'pat_PHASE5_REUSE_FIXTURE';
const ORIGINAL_FETCH = globalThis.fetch;
function harness(t: TestContext, scenario: Scenario = {}) {
  const config = loadConfig({ SWFTE_PAT: CREDENTIAL, SWFTE_BASE_URL: 'https://api.example.test/agents', SWFTE_TELEMETRY: '0' });
  const context: ToolContext = { client: new SwfteClient(config), config, localFilesystem: false };
  const contract = scenario.contract ?? workflowGolden(), ref = contract.catalogRef;
  const [kind, id] = ref.split(':');
  const entry = { catalogRef: ref, kind, id, workspaceId: 'ws-fixture', scope: 'workspace',
    source: 'workflow_v2', name: 'Refund triage', description: 'Refund triage by amount and customer email',
    updatedAt: '2026-09-20T10:00:00Z', evidence: { level: scenario.level ?? 'corroborated',
      runs: { total: 20, succeeded: 20, failed: 0 }, reasons: ['Synthetic recorded-run evidence for the test backend'],
      independentWorkspaces: 2, successRate: 1 }, facets: [], dependencies: [], reviews: [] };
  const wire: Wire[] = [], unexpected: Wire[] = [];
  t.after(() => { globalThis.fetch = ORIGINAL_FETCH; });
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input)), path = url.pathname.replace(/^\/agents/, ''), method = init.method ?? 'GET';
    assert.equal(url.origin, 'https://api.example.test', 'All requests stay on the configured stub backend');
    const request = { method, path, query: Object.fromEntries(url.searchParams.entries()),
      body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get('authorization') };
    wire.push(request);
    if (method === 'GET' && path === '/v2/catalog/search') {
      if (scenario.searchStatus) return reply({ code: `HTTP_${scenario.searchStatus}`, message: 'Catalog search access refused' }, scenario.searchStatus);
      return reply({ items: scenario.empty ? [] : [entry], nextCursor: null, degraded: [] });
    }
    if (method === 'GET' && path === `/v2/catalog/${kind}/${encodeURIComponent(id!)}`) {
      return scenario.detailStatus ? reply({ code: `HTTP_${scenario.detailStatus}`, message: 'Catalog entry access refused' }, scenario.detailStatus) : reply(entry);
    }
    if (method === 'GET' && path === `/v2/catalog/${kind}/${encodeURIComponent(id!)}/contract`) {
      return scenario.contractStatus ? reply({ code: `HTTP_${scenario.contractStatus}`, message: 'Contract access refused' }, scenario.contractStatus) : reply(contract);
    }
    if (method === 'POST' && path === '/v2/workflows/wizard/generate/async') {
      return reply({ sessionId: 'phase5-build-fixture' }, 202);
    }
    if (method === 'GET' && path === '/v2/workflows/wizard/phase5-build-fixture/status') {
      return reply({ sessionId: 'phase5-build-fixture', status: 'COMPLETED', done: true, finalResponse: { workflowId: 'created-fixture' } });
    }
    if (method === 'POST' && path === '/v2/actions/act-fixture/execute') {
      return reply({ code: 'ACTION_NOT_APPROVED', message: 'Pending human approval' }, 409);
    }
    if (method === 'GET' && path === '/v2/actions/act-fixture') {
      return reply({ actionId: 'act-fixture', capability: 'workflow.deploy', target: { kind: 'workflow', id: 'wf_1' },
        environment: 'development', params: {}, status: 'PROPOSED', createdAt: '2026-10-01T10:00:00Z', result: null });
    }
    unexpected.push(request); return reply({ code: 'NOT_FOUND', message: 'Unexpected fixture request' }, 404);
  }) as typeof fetch;
  const call = async (name: string, input: unknown): Promise<any> => {
    const tool = allTools.find(tool => tool.name === name);
    assert.ok(tool, `Real registered tool ${name} exists`);
    return tool.execute(tool.inputSchema.parse(input), context);
  };
  return { context, wire, unexpected, call, ref };
}
function generation(wire: Wire[]) {
  return wire.filter(request => request.method === 'POST' && GENERATION_PATHS.some(path => path.test(request.path)));
}
function assertNoBuild(wire: Wire[]) { assert.equal(generation(wire).length, 0, 'A suitable existing artifact causes zero builds or source translation calls'); }
function fitsRefundInputs(context: any): boolean {
  const contract = context.contract, input = contract?.inputSchema;
  return !!contract?.invoke?.path && input?.properties?.amount?.type === 'number'
    && input?.properties?.customerEmail?.type === 'string' && Array.isArray(input.required)
    && input.required.includes('amount') && input.required.includes('customerEmail');
}
/** Deterministic agent-shaped execution of the production prompt; no LLM or network. */
async function walkthrough(h: ReturnType<typeof harness>) {
  const search = await h.call('swfte_find_existing', { query: 'refund triage', kinds: ['workflow'] });
  assert.ok(Array.isArray(search.results)); assert.equal('items' in search, false);
  let context: any;
  if (search.recommendation.action !== 'BUILD') {
    context = await h.call('swfte_get_context', { catalogRef: search.recommendation.catalogRef });
    // Authorization/unavailable transport is an error, never evidence that a new build is justified.
    if (context.contractError) throw new Error(`Contract access failed: ${context.contractError.code}`);
    if (fitsRefundInputs(context)) {
      const scaffold = await h.call('swfte_scaffold_client', { catalogRef: context.catalogRef, alias: 'derived-refund',
        framework: 'plain-ts', language: 'typescript', targetDir: 'src/phase5', pin: false, complianceScan: false });
      return { path: 'REUSE', search, context, scaffold };
    }
  }
  const build = await h.call('swfte_build', { kind: 'workflow', prompt: 'Refund triage by numeric amount and customer email', waitMs: 5000 });
  return { path: 'BUILD', search, context, build };
}

test('reuse corroborated and verified search context scaffold never generate artifacts', async t => {
  for (const level of ['corroborated', 'verified'] as const) {
    const h = harness(t, { level }), result = await walkthrough(h);
    assert.equal(result.path, 'REUSE'); assert.equal(result.search.recommendation.action, 'REUSE');
    assert.equal(h.wire[0]!.path, '/v2/catalog/search'); assert.equal(h.wire[0]!.query.kinds, 'workflow');
    assert.equal(result.context.catalogRef, h.ref); assert.ok(result.context.contract.invoke);
    assert.ok(h.wire.some(request => request.path === '/v2/catalog/workflow/wf_1/contract'));
    assertNoBuild(h.wire); assert.equal(h.wire.filter(request => request.method !== 'GET').length, 0);
    assert.equal(h.unexpected.length, 0); assert.ok(h.wire.every(request => request.auth === `Bearer ${CREDENTIAL}`));
    const generated = result.scaffold.files.find((file: any) => file.path === 'src/phase5/derived-refund.ts');
    assert.ok(generated?.content); assert.match(generated.content, /amount: number/); assert.match(generated.content, /customerEmail: string/);
    assert.ok(!generated.content.includes(CREDENTIAL)); assert.equal(result.scaffold.pinnedVersion, null);
    const lock = result.scaffold.files.find((file: any) => file.path === 'swfte.json');
    assert.ok(lock?.content); assert.equal(JSON.parse(lock.content).artifacts[0].catalogRef, h.ref);
  }
});

test('reuse observed candidate is inspected and scaffolded only with a fitting contract', async t => {
  let h = harness(t, { level: 'observed' }), result = await walkthrough(h);
  assert.equal(result.search.recommendation.action, 'INSPECT_BEFORE_REUSE'); assert.equal(result.path, 'REUSE');
  assert.ok(result.context.contract.invoke); assert.ok(result.scaffold.files.length); assertNoBuild(h.wire);
  const unsuitable = structuredClone(workflowGolden());
  unsuitable.inputSchema = { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] };
  h = harness(t, { level: 'observed', contract: unsuitable }); result = await walkthrough(h);
  assert.equal(result.search.recommendation.action, 'INSPECT_BEFORE_REUSE'); assert.equal(result.path, 'BUILD');
  assert.equal(generation(h.wire).length, 1); assert.equal(result.scaffold, undefined); assert.equal(h.unexpected.length, 0);
});

test('reuse empty search calls the real workflow build exactly once', async t => {
  const h = harness(t, { empty: true }), result = await walkthrough(h);
  assert.equal(result.path, 'BUILD'); assert.equal(result.search.recommendation.action, 'BUILD');
  assert.equal(h.wire[0]!.path, '/v2/catalog/search'); assert.equal(generation(h.wire).length, 1);
  assert.equal(generation(h.wire)[0]!.path, '/v2/workflows/wizard/generate/async');
  assert.ok(h.wire.some(request => request.path === '/v2/workflows/wizard/phase5-build-fixture/status'));
  assert.ok(h.wire.every(request => !/\/catalog\/workflow\//.test(request.path)));
  assert.equal(result.context, undefined); assert.equal(result.scaffold, undefined); assert.equal(h.unexpected.length, 0);
  assert.throws(() => assertNoBuild(h.wire), { code: 'ERR_ASSERTION' });
});

test('reuse unmeasured candidate without a contract builds and kills the no build oracle', async t => {
  const unavailable = capturedFixtures().cases.find(row => row.catalogRef === 'workflow:wf_pub')!.contract;
  assert.equal(unavailable.invoke, null); assert.ok(unavailable.invokeUnavailableReason);
  const h = harness(t, { level: 'unmeasured', contract: unavailable }), result = await walkthrough(h);
  assert.equal(result.search.recommendation.action, 'INSPECT_BEFORE_REUSE'); assert.equal(result.path, 'BUILD');
  assert.equal(result.context.contract.invoke, null); assert.equal(result.scaffold, undefined);
  assert.equal(generation(h.wire).length, 1); assert.equal(h.unexpected.length, 0);
  await assert.rejects(async () => assertNoBuild(h.wire), { code: 'ERR_ASSERTION' });
});

test('reuse authorization and contract errors stop before scaffold or build', async t => {
  for (const scenario of [{ searchStatus: 403 }, { detailStatus: 403 }, { detailStatus: 404 },
    { contractStatus: 403 }, { contractStatus: 404 }]) {
    const h = harness(t, scenario);
    await assert.rejects(walkthrough(h), error => error instanceof SwfteApiError || (error instanceof Error && error.message.startsWith('Contract access failed:')));
    assertNoBuild(h.wire); assert.equal(h.unexpected.length, 0);
    assert.ok(h.wire.every(request => request.method === 'GET'));
    assert.ok(h.wire.filter(request => request.path === '/v2/catalog/workflow/wf_1').length <= 1, 'No scaffold detail refetch after a failed context');
  }
});

test('reuse production prompt orders search context scaffold before conditional build', () => {
  const prompt = getPrompt('reuse-then-build', { goal: 'refund triage', kind: 'workflow' });
  const text = prompt.messages[0]!.content.text;
  const search = text.indexOf('swfte_find_existing'), context = text.indexOf('swfte_get_context');
  const scaffold = text.indexOf('swfte_scaffold_client'), build = text.indexOf('swfte_build');
  assert.ok(search >= 0 && search < context && context < scaffold && scaffold < build);
  assert.match(text, /Only if the recommendation is BUILD \(or no candidate fits the contract\)/);
  assert.match(text, /Do not regenerate what already exists/);
  const removed = text.replace('swfte_find_existing', 'find tool removed');
  assert.throws(() => assert.ok(removed.indexOf('swfte_find_existing') >= 0), { code: 'ERR_ASSERTION' });
});

test('reuse existing action gate remains blocked without approval', async t => {
  const h = harness(t), result = await h.call('swfte_execute_approved_action', { actionId: 'act-fixture' });
  assert.equal(result.executed, false); assert.equal(result.blocked, 'NOT_APPROVED'); assert.equal(result.status, 409);
  assert.equal(result.action.status, 'PROPOSED'); assertNoBuild(h.wire);
  assert.equal(h.wire.filter(request => request.method === 'POST').length, 1);
  assert.equal(h.wire[0]!.path, '/v2/actions/act-fixture/execute'); assert.equal(h.unexpected.length, 0);
});
