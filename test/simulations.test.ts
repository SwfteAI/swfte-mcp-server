/**
 * Swfte Simulations MCP tools.
 * Provenance: original (Swfte Simulations). Not derived from MiroFish.
 *
 * validate runs locally against the v1 schema; the API tools run against a
 * mocked global fetch that records method, path, query and headers.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SwfteApiError, SwfteClient } from '../src/client.js';
import { allTools } from '../src/tools/index.js';
import { summarizeRun, validateSpecObject, validateSpecYaml } from '../src/tools/simulations.js';

const WS = 'ws-fixture-1';
// Workspace-scoped credential mode: the client sends X-Workspace-ID (PAT mode lets the server derive it).
const config = () => ({ ...loadConfig({ SWFTE_PAT: 'pat_fake_value', SWFTE_WORKSPACE_ID: WS } as never), credentialKind: 'api-key' as const });
const unboundConfig = () => ({ ...loadConfig({ SWFTE_PAT: 'pat_fake_value' } as never), credentialKind: 'api-key' as const });

// Copied from agents-service testkit Fixtures.VALID_YAML.
const VALID_YAML = `apiVersion: swfte.dev/simulation/v1
kind: Simulation
metadata: { name: content-pipeline-standard, labels: { team: editorial } }
spec:
  mode: proving
  target: { kind: workflow, id: wf_fixture_1, version: 4, environment: sandbox }
  profile: standard
  seed: 7741
  budget: { usdPersonas: 8, usdSystemUnderTest: 12, usdReport: 4, maxSteps: 20000 }
  population:
    packs: [ swfte/core-users@1, swfte/chaos@1, swfte/insurance-claimants@1 ]
    archetypes: { user: 600, adversary: 0, chaos: 150, auditor: 50, stakeholder: 50 }
  interfaces: [ api, chat, workflow ]
  data: { synthetic: { fromSchemas: true, locales: [ en-GB, de-DE ] } }
  traffic: { profile: bursty, peakRps: 20, durationMinutes: 30 }
  faults: { packs: [ swfte/slack-rate-limit@1, swfte/s3-slow@1 ] }
  scenarios: { packs: [ swfte/golden-support@1 ] }
  graders: [ swfte/function@1, swfte/robustness@1, swfte/security-owasp-llm@1,
             swfte/privacy-pii@1, swfte/compliance@1, swfte/behaviour-grounding@1,
             swfte/load-cost@1, swfte/completeness@1 ]
  frameworks: [ gdpr, soc2, owasp-llm ]
  report: { sections: [ swfte/standard@1 ], formats: [ markdown, json ] }
  stop: { intervalHalfWidth: 0.05, onBudget: report_unknowns }
`;

/* ── mocked fetch ── */
interface Seen { method: string; path: string; query: Record<string, string>; body: any; headers: Record<string, string> }
let seen: Seen[] = [];
let routes: Array<[string, RegExp, (r: Seen) => { status?: number; body?: unknown; text?: string }]> = [];
const realFetch = globalThis.fetch;
const route = (method: string, re: RegExp, out: { status?: number; body?: unknown; text?: string }) => routes.unshift([method, re, () => out]);

beforeEach(() => {
  seen = [];
  routes = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const req: Seen = {
      method: String(init.method ?? 'GET'),
      path: url.pathname.replace(/^\/agents/, ''),
      query: Object.fromEntries(url.searchParams.entries()),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers ?? {},
    };
    seen.push(req);
    const hit = routes.find(([m, re]) => m === req.method && re.test(req.path));
    if (!hit) return new Response(JSON.stringify({ code: 'NO_ROUTE' }), { status: 404 });
    const out = hit[2](req);
    const text = out.text ?? (out.body === undefined ? '' : JSON.stringify(out.body));
    return new Response(text, { status: out.status ?? 200, headers: { 'content-type': out.text ? 'text/markdown' : 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const run = async (name: string, input: unknown) => {
  const t = allTools.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  const parsed = t!.inputSchema.parse(input);
  // A per-call workspaceId is honoured only when the API-key credential has no configured workspace; with one
  // configured the client refuses a different one (WORKSPACE_OVERRIDE). Tests that choose a workspace say so.
  const cfg = (input as { workspaceId?: string } | null)?.workspaceId !== undefined ? unboundConfig() : config();
  return t!.execute(parsed, { client: new SwfteClient(cfg), config: cfg }) as Promise<any>;
};
const wsHeader = (s: Seen) => s.headers['X-Workspace-ID'];

const RUN_ID = 'sim_0123abcd';
const RUN = {
  id: RUN_ID, workspaceId: WS, mode: 'proving', profile: 'standard', status: 'RUNNING', specHash: 'hash-fixture', specVersion: 'v1', seed: 7741,
  target: { kind: 'workflow', id: 'wf_fixture_1', version: 4, environment: 'sandbox' },
  budget: { usdPersonas: 8, usdSystemUnderTest: 12, usdReport: 4, maxSteps: 20000 },
  counters: { personas: 10, sessionsPlanned: 10, sessionsDone: 4, sessionsUnknown: 1, steps: 120, findings: 2, usdPersonas: 0.5, usdSystemUnderTest: 1.25, usdReport: 0 },
  coverage: [
    { elementId: 'n1', dimension: 'FUNCTION', applicable: true, passes: 3, fails: 0, unknowns: 0, outcome: 'PASS', evidenceIds: ['ev_x_1'] },
    { elementId: 'n2', dimension: 'FUNCTION', applicable: true, passes: 2, fails: 0, unknowns: 1, outcome: 'UNKNOWN', evidenceIds: [] },
    { elementId: 'n1', dimension: 'SECURITY', applicable: true, passes: 0, fails: 1, unknowns: 0, outcome: 'FAIL', evidenceIds: ['ev_x_2'] },
    { elementId: 'n1', dimension: 'LOAD_COST', applicable: false, passes: 0, fails: 0, unknowns: 0, outcome: 'UNKNOWN', evidenceIds: [] },
  ],
  completeness: 0.4, createdAt: '2026-09-26T00:00:00Z',
};
// Mirrors SavedValidationPacks schema1 + raw TargetRef wire fields; not a signed integrity/runtime receipt.
function savedMaterialFixture(runId: string, workspaceId: string) {
  return {
    ref: `validation/${runId}@1`, runId, workspaceId, contentHash: 'sha256:' + 'a'.repeat(64),
    payload: { schemaVersion: 1, sourceRunId: runId, evidenceKind: 'simulation', artifactKind: 'workflow', industry: null,
      target: { kind: 'WORKFLOW', id: 'wf_fixture_1', workspaceId, environment: 'sandbox', version: null,
        actualVersion: null, instanceIds: [], contentHash: 'sha256:' + 'b'.repeat(64) },
      sourceSpecHash: 'c'.repeat(64),
      spec: { apiVersion: 'swfte.dev/simulation/v1', kind: 'Simulation', metadata: { name: 'saved' },
        spec: { mode: 'proving', profile: 'standard', target: { kind: 'workflow', id: 'wf_fixture_1', environment: 'sandbox' }, graders: ['swfte/function@1'] } },
      sourcePacks: [{ ref: 'swfte/core-users@1', kind: 'PERSONA', manifestHash: 'd'.repeat(64) }],
      unavailableDeclarations: ['swfte/unavailable@1'], scenarios: [], faults: [], findings: [],
      evidenceHeads: { ses_actual: 'e'.repeat(64) }, sourceStatus: 'DONE' },
  }
}
function savedCreatedFixture(workspaceId: string) {
  return { id: 'sim_new01', workspaceId, name: 'saved reuse', status: 'CREATED', specHash: 'f'.repeat(64), specVersion: 'v1', seed: 7741, mode: 'proving', profile: 'standard',
    budget: { usdPersonas: 8, usdSystemUnderTest: 12, usdReport: 4, maxSteps: 20000 },
    counters: { personas: 0, sessionsPlanned: 0, sessionsDone: 0, sessionsUnknown: 0, steps: 0, findings: 0, usdPersonas: 0, usdSystemUnderTest: 0, usdReport: 0 },
    coverage: [], completeness: 0, routing: null, createdAt: '2026-10-02T00:00:00Z', startedAt: null, finishedAt: null, error: null,
    target: { kind: 'workflow', id: 'wf_fixture_1', environment: 'sandbox', version: null, actualVersion: null,
      contentHash: 'sha256:' + 'b'.repeat(64) } }
}

const VALIDATION_PACK = savedMaterialFixture(RUN_ID, WS);

/* ── validate ── */
describe('swfte_simulation_validate (local)', () => {
  const codesAt = (yaml: string) => validateSpecYaml(yaml).errors.map((e) => `${e.path} ${e.code}`);

  test('the canonical example is valid, with no network call', async () => {
    const r = await run('swfte_simulation_validate', { yaml: VALID_YAML });
    assert.deepEqual(r, { valid: true, errors: [] });
    assert.equal(seen.length, 0);
  });

  test('accepts a spec object', async () => {
    const r = await run('swfte_simulation_validate', {
      spec: { apiVersion: 'swfte.dev/simulation/v1', kind: 'Simulation', metadata: { name: 'x' }, spec: { mode: 'feature', target: { kind: 'agent', id: 'ag_1' }, profile: 'quick', graders: ['swfte/function@1'] } },
    });
    assert.equal(r.valid, true);
  });

  test('unknown field', () => {
    assert.deepEqual(codesAt(VALID_YAML.replace('  profile: standard', '  profile: standard\n  turbo: true')), ['/spec/turbo UNKNOWN_FIELD']);
  });
  test('bad enum', () => {
    assert.deepEqual(codesAt(VALID_YAML.replace('mode: proving', 'mode: chaos-monkey')), ['/spec/mode ENUM']);
  });
  test('bad pack ref', () => {
    assert.deepEqual(codesAt(VALID_YAML.replace('swfte/chaos@1', 'swfte/chaos')), ['/spec/population/packs/1 PATTERN']);
  });
  test('environment production', () => {
    assert.deepEqual(codesAt(VALID_YAML.replace('environment: sandbox', 'environment: production')), ['/spec/target/environment CONST']);
  });
  test('negative budget', () => {
    assert.deepEqual(codesAt(VALID_YAML.replace('usdPersonas: 8', 'usdPersonas: -1')), ['/spec/budget/usdPersonas MINIMUM']);
  });
  test('YAML syntax error', () => {
    const r = validateSpecYaml(VALID_YAML.replace('profile: standard', 'profile: [standard'));
    assert.equal(r.valid, false);
    assert.equal(r.errors[0]!.code, 'YAML_SYNTAX');
  });
  test('missing required, duplicate grader, wrong type', () => {
    assert.deepEqual(codesAt(VALID_YAML.replace('kind: Simulation\n', '')), ['/kind REQUIRED']);
    assert.deepEqual(codesAt(VALID_YAML.replace('swfte/robustness@1', 'swfte/function@1')), ['/spec/graders/1 DUPLICATE']);
    assert.deepEqual(codesAt(VALID_YAML.replace('seed: 7741', 'seed: 1.5')), ['/spec/seed TYPE']);
  });
  test('label key escaping in JSON pointer', () => {
    assert.deepEqual(codesAt(VALID_YAML.replace('team: editorial', '"a/b": 3')), ['/metadata/labels/a~1b TYPE']);
  });
  test('rejects both or neither of yaml/spec', async () => {
    await assert.rejects(run('swfte_simulation_validate', {}), /exactly one/);
  });

  test('nonfinite JSON objects and YAML prices cannot validate as free budgets', () => {
    assert.equal(validateSpecYaml(VALID_YAML).valid, true);
    for (const price of [NaN, Infinity, -Infinity]) {
      const result = validateSpecObject({ apiVersion: 'swfte.dev/simulation/v1', kind: 'Simulation', metadata: { name: 'x' },
        spec: { mode: 'feature', target: { kind: 'agent', id: 'ag_1' }, profile: 'quick', graders: ['swfte/function@1'], budget: { usdPersonas: price } } });
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(error => error.path === '/spec/budget/usdPersonas' && error.code === 'TYPE'));
    }
    assert.ok(codesAt(VALID_YAML.replace('usdPersonas: 8', 'usdPersonas: .nan')).includes('/spec/budget/usdPersonas TYPE'));
    assert.equal(seen.length, 0);
  });
});

/* ── API tools ── */
describe('simulation API tools', () => {
  test('create posts yaml and returns the run', async () => {
    route('POST', /^\/v2\/simulations$/, { status: 201, body: RUN });
    const r = await run('swfte_simulation_create', { yaml: VALID_YAML });
    assert.equal(seen[0]!.method, 'POST');
    assert.equal(seen[0]!.path, '/v2/simulations');
    assert.equal(wsHeader(seen[0]!), WS);
    assert.equal(seen[0]!.body.yaml, VALID_YAML);
    assert.deepEqual([r.created, r.run.id, r.run.status, r.run.specHash], [true, RUN_ID, 'RUNNING', 'hash-fixture']);
  });

  test('create returns server validation errors', async () => {
    route('POST', /^\/v2\/simulations$/, { status: 400, body: { valid: false, specHash: null, errors: [{ path: '/spec/target/id', code: 'TARGET_NOT_OWNED', message: 'not in this workspace' }] } });
    const r = await run('swfte_simulation_create', { spec: { kind: 'Simulation' }, workspaceId: 'ws-other' });
    assert.equal(r.created, false);
    assert.equal(r.errors[0].code, 'TARGET_NOT_OWNED');
    assert.equal(wsHeader(seen[0]!), 'ws-other');
  });

  test('explicit saved pack reuse creates once in the chosen workspace without starting', async () => {
    const created = savedCreatedFixture('ws-explicit');
    route('POST', new RegExp(`^/v2/simulations/validation-packs/${RUN_ID}/reuse$`), { status: 201, body: created });
    const result = await run('swfte_simulation_create', { validationPackRunId: RUN_ID, workspaceId: 'ws-explicit', acceptableUseAcknowledged: true });
    assert.equal(result.created, true);
    assert.deepEqual(result.run.target, created.target);
    assert.equal(result.run.status, 'CREATED');
    assert.deepEqual(seen.map(request => [request.method, request.path, wsHeader(request), request.body]), [
      ['POST', `/v2/simulations/validation-packs/${RUN_ID}/reuse`, 'ws-explicit', { acceptableUseAcknowledged: true }],
    ]);
    assert.equal(seen.some(request => request.path.endsWith('/start') || request.path.endsWith('/estimate')), false);
  });

  test('saved pack reuse retains conflicts and forbids implicit or competing sources', async () => {
    route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status: 409, body: { error: 'VALIDATION_PACK_UNAVAILABLE', message: 'source pack changed or disabled' } });
    const result = await run('swfte_simulation_create', { validationPackRunId: RUN_ID });
    assert.deepEqual([result.created, result.code, result.message], [false, 'VALIDATION_PACK_UNAVAILABLE', 'source pack changed or disabled']);
    assert.equal(seen.length, 1);
    for (const input of [{}, { yaml: VALID_YAML, validationPackRunId: RUN_ID }, { spec: {}, validationPackRunId: RUN_ID }, { yaml: VALID_YAML, spec: {} }]) {
      await assert.rejects(run('swfte_simulation_create', input), /exactly one/);
    }
    assert.equal(seen.length, 1);
    route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status: 404, body: { code: 'NOT_FOUND' } });
    await assert.rejects(run('swfte_simulation_create', { validationPackRunId: RUN_ID, workspaceId: 'foreign' }),
      (error: unknown) => error instanceof SwfteApiError && error.status === 404 && error.code === 'NOT_FOUND');
    assert.equal(wsHeader(seen[1]!), 'foreign');
    assert.equal(seen.some(request => request.path.endsWith('/start')), false);
  });

  test('start estimates then starts', async () => {
    route('POST', /\/estimate$/, { body: { sessions: 10, steps: 100, usdByRole: {}, usdCeiling: 3, unpricedModels: [], withinBudget: true } });
    route('POST', /\/start$/, { status: 202 });
    const r = await run('swfte_simulation_start', { id: RUN_ID });
    assert.deepEqual(seen.map((s) => `${s.method} ${s.path} ${wsHeader(s)}`), [
      `POST /v2/simulations/${RUN_ID}/estimate ${WS}`,
      `POST /v2/simulations/${RUN_ID}/start ${WS}`,
    ]);
    assert.equal(r.started, true);
    assert.equal(r.estimate.usdCeiling, 3);
  });

  test('start refuses when over budget and asked to', async () => {
    route('POST', /\/estimate$/, { body: { sessions: 10, steps: 100, usdByRole: {}, usdCeiling: 90, unpricedModels: [], withinBudget: false } });
    const r = await run('swfte_simulation_start', { id: RUN_ID, onlyIfWithinBudget: true });
    assert.equal(r.started, false);
    assert.equal(seen.some((s) => s.path.endsWith('/start')), false);
  });

  test('budget-aware start refuses unknown prices and malformed estimates before start admission', async () => {
    const priced = { sessions: 10, steps: 100, usdByRole: {}, usdCeiling: 3, unpricedModels: [], withinBudget: true };
    const cases: Array<[unknown, string]> = [
      [{ ...priced, unpricedModels: ['unknown/provider'] }, 'ESTIMATE_UNPRICED'],
      [null, 'ESTIMATE_UNAVAILABLE'], [{}, 'ESTIMATE_UNAVAILABLE'],
      [{ ...priced, unpricedModels: undefined }, 'ESTIMATE_UNAVAILABLE'],
      [{ ...priced, withinBudget: undefined }, 'ESTIMATE_UNAVAILABLE'],
      [{ ...priced, withinBudget: 'true' }, 'ESTIMATE_UNAVAILABLE'],
      [{ ...priced, usdCeiling: undefined }, 'ESTIMATE_UNAVAILABLE'],
      [{ ...priced, usdCeiling: NaN }, 'ESTIMATE_UNAVAILABLE'],
      [{ ...priced, usdCeiling: Infinity }, 'ESTIMATE_UNAVAILABLE'],
      [{ ...priced, usdCeiling: -1 }, 'ESTIMATE_UNAVAILABLE'],
    ];
    for (const [estimate, reason] of cases) {
      const requestsBefore = seen.length;
      route('POST', /\/estimate$/, { body: estimate });
      const result = await run('swfte_simulation_start', { id: RUN_ID, estimate: false, onlyIfWithinBudget: true });
      assert.deepEqual([result.started, result.reason], [false, reason]);
      assert.equal(seen.length, requestsBefore + 1);
      assert.equal(seen.at(-1)!.path, `/v2/simulations/${RUN_ID}/estimate`);
    }
    assert.equal(seen.some(request => request.path.endsWith('/start')), false);
    route('POST', /\/estimate$/, { body: priced });
    route('POST', /\/start$/, { status: 202 });
    const positive = await run('swfte_simulation_start', { id: RUN_ID, onlyIfWithinBudget: true });
    assert.equal(positive.started, true);
    assert.equal(seen.filter(request => request.path.endsWith('/start')).length, 1);
  });

  test('start without estimate', async () => {
    route('POST', /\/start$/, { status: 202 });
    await run('swfte_simulation_start', { id: RUN_ID, estimate: false });
    assert.deepEqual(seen.map((s) => s.path), [`/v2/simulations/${RUN_ID}/start`]);
  });

  test('status summarises coverage; UNKNOWN is not counted as pass', async () => {
    route('GET', /^\/v2\/simulations\/sim_/, { body: RUN });
    const r = await run('swfte_simulation_status', { id: RUN_ID });
    assert.equal(seen[0]!.method, 'GET');
    assert.equal(seen[0]!.path, `/v2/simulations/${RUN_ID}`);
    assert.equal(wsHeader(seen[0]!), WS);
    assert.equal(r.status, 'RUNNING');
    assert.equal(r.terminal, false);
    assert.deepEqual(r.coverage.FUNCTION, { pass: 1, fail: 0, unknown: 1, notApplicable: 0 });
    assert.deepEqual(r.coverage.SECURITY, { pass: 0, fail: 1, unknown: 0, notApplicable: 0 });
    assert.deepEqual(r.coverage.LOAD_COST, { pass: 0, fail: 0, unknown: 0, notApplicable: 1 });
    assert.deepEqual(r.budget.usdSystemUnderTest, { spent: 1.25, limit: 12 });
  });

  test('status retains selected actual version and full hash; unknown spend stays unknown', async () => {
    const target = { ...RUN.target, contentHash: 'sha256:' + 'c'.repeat(64), actualVersion: '4', instanceIds: ['overlay_actual'] };
    route('GET', /^\/v2\/simulations\/sim_/, { body: { ...RUN, target, counters: { ...RUN.counters, usdSystemUnderTest: undefined } } });
    const result = await run('swfte_simulation_status', { id: RUN_ID });
    assert.deepEqual(result.target, target);
    assert.deepEqual(result.budget.usdSystemUnderTest, { spent: null, limit: 12 });
    for (const spend of [undefined, null, NaN, Infinity, -Infinity, -1]) {
      const summary = summarizeRun({ ...RUN, counters: { ...RUN.counters, usdPersonas: spend } } as never);
      assert.equal(summary.budget!.usdPersonas.spent, null);
    }
    assert.equal(summarizeRun({ ...RUN, counters: { ...RUN.counters, usdPersonas: 0 } } as never).budget!.usdPersonas.spent, 0);
  });

  test('findings filters and marks gaps', async () => {
    const f = (id: string, severity: string, dimension: string, gap: boolean) => ({ id, severity, dimension, gap, title: id, description: '', affectedElements: [], sessionId: null, step: null, evidenceIds: [], graderId: 'swfte/function@1', suggestedFix: null, rerunCommand: null });
    route('GET', /\/findings$/, { body: { findings: [f('a', 'HIGH', 'SECURITY', false), f('b', 'MEDIUM', 'FUNCTION', true), f('c', 'LOW', 'SECURITY', true)] } });
    const r = await run('swfte_simulation_findings', { id: RUN_ID, dimension: ['SECURITY'] });
    assert.equal(seen[0]!.path, `/v2/simulations/${RUN_ID}/findings`);
    assert.equal(wsHeader(seen[0]!), WS);
    assert.deepEqual(r.findings.map((x: any) => `${x.id}:${x.gap}`), ['a:false', 'c:true']);
    assert.match(r.findings[1].kind, /GAP/);
    const hi = await run('swfte_simulation_findings', { id: RUN_ID, severity: ['HIGH'], includeGaps: false });
    assert.deepEqual(hi.findings.map((x: any) => x.id), ['a']);
  });

  test('report md vs json', async () => {
    route('GET', /\/report$/, { text: '# Report\n\nSupports your audit; not an audit opinion.\n' });
    const md = await run('swfte_simulation_report', { id: RUN_ID, format: 'md' });
    assert.equal(seen[0]!.query.format, 'md');
    assert.equal(seen[0]!.headers.Accept, 'text/markdown');
    assert.equal(wsHeader(seen[0]!), WS);
    assert.match(md.markdown, /^# Report/);
    assert.equal(md.disclaimer, 'Supports your audit; not an audit opinion.');

    route('GET', /\/report$/, { body: { runId: RUN_ID, overall: 'UNKNOWN', sections: [] } });
    const js = await run('swfte_simulation_report', { id: RUN_ID });
    assert.equal(seen[1]!.query.format, 'json');
    assert.equal(js.report.overall, 'UNKNOWN');
  });

  test('saved report material is read from the private endpoint with actual identity and simulation provenance', async () => {
    route('GET', /\/validation-packs\/sim_[^/]+$/, { body: VALIDATION_PACK });
    const result = await run('swfte_simulation_report', { id: RUN_ID, format: 'validation-pack' });
    assert.deepEqual(result.pack, VALIDATION_PACK);
    assert.deepEqual([result.format, result.evidenceKind], ['validation-pack', 'simulation']);
    assert.equal(result.disclaimer, 'Supports your audit; not an audit opinion.');
    assert.deepEqual(seen.map(request => [request.method, request.path, wsHeader(request)]), [
      ['GET', `/v2/simulations/validation-packs/${RUN_ID}`, WS],
    ]);
  });

  test('saved material refuses foreign, malformed and runtime-receipt responses without fabrication', async () => {
    for (const invalid of [null, {}, { ...VALIDATION_PACK, runId: 'sim_other' }, { ...VALIDATION_PACK, ref: 'public/template@1' },
      { ...VALIDATION_PACK, workspaceId: 'foreign' }, { ...VALIDATION_PACK, contentHash: 'hash-unbound' },
      { ...VALIDATION_PACK, payload: { ...VALIDATION_PACK.payload, sourceRunId: 'sim_other' } },
      { ...VALIDATION_PACK, payload: { ...VALIDATION_PACK.payload, evidenceKind: 'runtime-receipt' } }]) {
      route('GET', /\/validation-packs\/sim_[^/]+$/, { body: invalid });
      await assert.rejects(run('swfte_simulation_report', { id: RUN_ID, format: 'validation-pack' }), /VALIDATION_PACK_INVALID/);
    }
    route('GET', /\/validation-packs\/sim_[^/]+$/, { status: 404, body: { code: 'NOT_FOUND' } });
    await assert.rejects(run('swfte_simulation_report', { id: RUN_ID, format: 'validation-pack', workspaceId: 'foreign' }),
      (error: unknown) => error instanceof SwfteApiError && error.status === 404);
    assert.equal(seen.every(request => request.method === 'GET'), true);
  });


  test('saved produced nullable terminal envelope remains simulation material', async () => {
    for (const status of ['DONE', 'FAILED', 'STOPPED', 'BUDGET_EXHAUSTED']) {
      const pack = savedMaterialFixture(RUN_ID, WS); pack.payload.sourceStatus = status;
      route('GET', /\/validation-packs\/sim_[^/]+$/, { body: pack });
      assert.deepEqual((await run('swfte_simulation_report', { id: RUN_ID, format: 'validation-pack' })).pack, pack);
    }
    assert.equal(seen.every(request => request.method === 'GET'), true);
  });
  test('saved malformed complete payload refuses before reuse', async () => {
    const pack = savedMaterialFixture(RUN_ID, WS);
    for (const payload of [{ ...pack.payload, spec: { ...pack.payload.spec, spec: [] } },
      { ...pack.payload, unavailableDeclarations: [null] }, { ...pack.payload, scenarios: {} },
      { ...pack.payload, evidenceHeads: { session: false } }, { ...pack.payload, sourceSpecHash: 'short' }]) {
      route('GET', /\/validation-packs\/sim_[^/]+$/, { body: { ...pack, payload } });
      await assert.rejects(run('swfte_simulation_report', { id: RUN_ID, format: 'validation-pack' }), /VALIDATION_PACK_INVALID/);
    }
    assert.equal(seen.every(request => request.method === 'GET'), true);
  });
  test('saved target and provenance shape refuses without fake receipt', async () => {
    const pack = savedMaterialFixture(RUN_ID, WS);
    for (const payload of [{ ...pack.payload, sourcePacks: [{ ...pack.payload.sourcePacks[0], manifestHash: 'short' }] },
      { ...pack.payload, sourceStatus: 'RUNNING' }, { ...pack.payload, target: { ...pack.payload.target, kind: 'workflow' } },
      { ...pack.payload, target: { ...pack.payload.target, version: 1.5 } },
      { ...pack.payload, target: { ...pack.payload.target, workspaceId: 'foreign' } }]) {
      route('GET', /\/validation-packs\/sim_[^/]+$/, { body: { ...pack, payload } });
      await assert.rejects(run('swfte_simulation_report', { id: RUN_ID, format: 'validation-pack' }), /VALIDATION_PACK_INVALID/);
    }
  });
  test('saved reuse requires current CREATED response identity', async () => {
    const created = savedCreatedFixture(WS);
    for (const invalid of [{ ...created, status: 'RUNNING' }, { id: 'sim_new01' }, {}, null,
      { ...created, specHash: 'short' }, { ...created, target: { ...created.target, environment: 'production' } },
      { ...created, target: { ...created.target, kind: 'WORKFLOW' } },
      { ...created, target: { ...created.target, version: 1.5 } }]) {
      route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status: 201, body: invalid });
      await assert.rejects(run('swfte_simulation_create', { validationPackRunId: RUN_ID }), /VALIDATION_PACK_REUSE_INVALID/);
    }
    route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status: 201, body: created });
    assert.equal((await run('swfte_simulation_create', { validationPackRunId: RUN_ID })).created, true);
    assert.equal(seen.every(request => request.path.endsWith('/reuse')), true);
  });
  test('a workspace chosen per call cannot override a configured API-key workspace (no request is sent)', async () => {
    const t = allTools.find((x) => x.name === 'swfte_simulation_create')!;
    const cfg = config();
    const before = seen.length;
    await assert.rejects(
      t.execute(t.inputSchema.parse({ spec: { kind: 'Simulation' }, workspaceId: 'ws-other' }), { client: new SwfteClient(cfg), config: cfg }),
      (error: unknown) => error instanceof SwfteApiError && error.status === 403 && error.code === 'WORKSPACE_OVERRIDE');
    assert.equal(seen.length, before);
  });

  test('saved reuse binds explicit and configured workspace', async () => {
    route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status: 201, body: savedCreatedFixture('foreign') });
    await assert.rejects(run('swfte_simulation_create', { validationPackRunId: RUN_ID }), /VALIDATION_PACK_REUSE_INVALID/);
    route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status: 201, body: savedCreatedFixture('explicit') });
    assert.equal((await run('swfte_simulation_create', { validationPackRunId: RUN_ID, workspaceId: 'explicit' })).created, true);
    route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status: 201, body: savedCreatedFixture(WS) });
    assert.equal((await run('swfte_simulation_create', { validationPackRunId: RUN_ID })).created, true);
    assert.deepEqual(seen.map(wsHeader), [WS, 'explicit', WS]);
  });
  test('saved reuse preserves conflict and missing errors without start', async () => {
    for (const status of [400, 409]) {
      route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status, body: { valid: false, code: 'ACTUAL_REFUSAL', errors: [] } });
      const result = await run('swfte_simulation_create', { validationPackRunId: RUN_ID });
      assert.equal(result.created, false); assert.equal(result.code, 'ACTUAL_REFUSAL');
    }
    route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status: 404, body: { code: 'NOT_FOUND' } });
    await assert.rejects(run('swfte_simulation_create', { validationPackRunId: RUN_ID }), (error: unknown) => error instanceof SwfteApiError && error.status === 404);
    assert.equal(seen.every(request => request.path.endsWith('/reuse')), true);
  });


  test('saved reuse refuses incomplete typed runs', async () => {
    const created = savedCreatedFixture(WS)
    const invalidRuns: unknown[] = []
    for (const field of ['budget', 'counters', 'coverage', 'completeness', 'seed', 'mode', 'profile', 'specVersion', 'createdAt']) {
      const missing: Record<string, unknown> = { ...created }; delete missing[field]; invalidRuns.push(missing)
    }
    invalidRuns.push({ ...created, budget: { ...created.budget, usdPersonas: 'free' } },
      { ...created, budget: { ...created.budget, maxSteps: 1.5 } },
      { ...created, counters: { ...created.counters, sessionsDone: -1 } },
      { ...created, counters: { ...created.counters, usdSystemUnderTest: 'unknown' } },
      { ...created, coverage: [{}] }, { ...created, completeness: 2 }, { ...created, seed: '7741' },
      { ...created, routing: { chains: { PERSONA: [false] } } }, { ...created, finishedAt: false }, { ...created, name: false })
    for (const invalid of invalidRuns) {
      route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status: 201, body: invalid });
      await assert.rejects(run('swfte_simulation_create', { validationPackRunId: RUN_ID }), /VALIDATION_PACK_REUSE_INVALID/);
    }
    // Java long transport may round; finite integer is admitted without asserting numeric integrity.
    const complete = { ...created, name: null, seed: 9223372036854775807,
      routing: { chains: { PERSONA: ['provider/model'] }, residencyApplied: true },
      coverage: [{ elementId: 'n1', dimension: 'FUNCTION', applicable: true, passes: 0, fails: 0, unknowns: 1, outcome: 'UNKNOWN', evidenceIds: ['ev_actual'] }] }
    route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status: 201, body: complete });
    const result = await run('swfte_simulation_create', { validationPackRunId: RUN_ID });
    assert.equal(result.created, true); assert.equal(result.run.status, 'CREATED');
    assert.equal(seen.every(request => request.path.endsWith('/reuse')), true);
  });
  test('saved reuse requires consumable run identifiers', async () => {
    const created = savedCreatedFixture(WS);
    for (const id of ['sim_a-b', 'sim_a_b', 'sim_', 'sim_' + 'a'.repeat(65)]) {
      route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status: 201, body: { ...created, id } });
      await assert.rejects(run('swfte_simulation_create', { validationPackRunId: RUN_ID }), /VALIDATION_PACK_REUSE_INVALID/);
    }
    for (const id of ['sim_' + 'a'.repeat(32), 'sim_' + 'A1'.repeat(32)]) {
      route('POST', /\/validation-packs\/[^/]+\/reuse$/, { status: 201, body: { ...created, id } });
      assert.equal((await run('swfte_simulation_create', { validationPackRunId: RUN_ID })).run.id, id);
    }
  });

  test('registry still exposes exactly the six original simulation tools', () => {
    assert.deepEqual(allTools.filter(tool => tool.name.startsWith('swfte_simulation_')).map(tool => tool.name).sort(), [
      'swfte_simulation_create', 'swfte_simulation_findings', 'swfte_simulation_report', 'swfte_simulation_start', 'swfte_simulation_status', 'swfte_simulation_validate',
    ]);
  });

  test('descriptions carry the honesty wording', () => {
    const d = (n: string) => allTools.find((t) => t.name === n)!.description;
    assert.match(d('swfte_simulation_report'), /Supports your audit; not an audit opinion\./);
    assert.match(d('swfte_simulation_report'), /UNKNOWN is never PASS/);
    assert.match(d('swfte_simulation_validate'), /swfte_simulation_create/);
  });

  test('rejects a malformed run id before any request', async () => {
    await assert.rejects(run('swfte_simulation_status', { id: '../etc' }));
    assert.equal(seen.length, 0);
  });
});
