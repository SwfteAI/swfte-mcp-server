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
import { SwfteClient } from '../src/client.js';
import { allTools } from '../src/tools/index.js';
import { validateSpecYaml } from '../src/tools/simulations.js';

const WS = 'ws-fixture-1';
// Workspace-scoped credential mode: the client sends X-Workspace-ID (PAT mode lets the server derive it).
const config = () => ({ ...loadConfig({ SWFTE_PAT: 'pat_fake_value', SWFTE_WORKSPACE_ID: WS } as never), credentialKind: 'api-key' as const });

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
  return t!.execute(parsed, { client: new SwfteClient(config()), config: config() }) as Promise<any>;
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
