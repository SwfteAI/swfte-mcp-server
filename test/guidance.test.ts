import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advise, adapterCapabilities, wizardContext } from '../src/guidance/index.js';
import { allTools } from '../src/tools/index.js';
import { ADAPTERS } from '../src/kinds/index.js';
import { loadConfig } from '../src/config.js';
import { SwfteClient, SwfteApiError } from '../src/client.js';

// Telemetry off: this suite pins the build request; test/telemetry.test.ts covers the events.
const config = () => loadConfig({ SWFTE_PAT: 'pat_guidance_test', SWFTE_TOOLS: 'core', SWFTE_TELEMETRY: '0' });
const facts = { sharedState: false, sharedReviewUI: false, adaptiveInvestigation: false, boundedSteps: true, existingSystemOfRecord: true };

test('explicit design facts distinguish products, bounded workflows and adaptive investigation', () => {
  assert.equal(advise(facts).recommendation, 'workflow');
  assert.equal(advise({ ...facts, adaptiveInvestigation: true }).recommendation, 'agentic');
  assert.equal(advise({ ...facts, sharedState: true, sharedReviewUI: true, existingSystemOfRecord: false }).recommendation, 'product');
  assert.equal(advise({ ...facts, sharedState: true, sharedReviewUI: true }).recommendation, 'workflow');
  assert.equal(advise({}).recommendation, null);
  assert.equal(advise({}).status, 'NEEDS_DESIGN_FACTS');
  assert.deepEqual(advise({}).composition, []);
  assert.equal(advise({ boundedSteps: true, adaptiveInvestigation: false }).status, 'PROVISIONAL');
});

test('all 15 cases resolve references and selected examples do not override explicit design', () => {
  const index = advise({}).caseIndex;
  assert.equal(index.length, 15);
  for (const c of index) {
    const result = advise(facts, [c.id]);
    assert.equal(result.recommendation, 'workflow');
    assert.equal(result.examples.length, 1);
    assert.ok(result.examples[0]!.referenceIds.every(id => result.references.some(r => r.id === id)));
    assert.ok(result.examples[0]!.acceptance.length > 0);
  }
  assert.throws(() => advise(facts, ['invented']), /UNKNOWN_CASE_STUDY/);
});

test('wizard guidance preserves prompt, selected form and exact case/reference acceptance data', () => {
  const id = advise({}).caseIndex[0]!.id;
  const result = wizardContext('Keep this exact customer requirement.', { form: 'workflow', caseStudyIds: [id] });
  assert.ok(result.startsWith('Keep this exact customer requirement.'));
  const data = JSON.parse(result.split('[Studio design guidance]\n')[1]!);
  assert.equal(data.form, 'workflow');
  assert.equal(data.examples[0].id, id);
  assert.ok(data.examples[0].controls.length);
  assert.ok(data.references[0].url.startsWith('https://'));
  assert.throws(() => wizardContext('prompt', { caseStudyIds: ['missing'] }), /no build was started/);
});

test('capabilities are derived from adapters and do not invent per-kind deployment options', async () => {
  for (const row of adapterCapabilities()) {
    for (const verb of row.verbs) assert.equal(typeof (ADAPTERS as any)[row.kind][verb], 'function');
  }
  assert.equal(adapterCapabilities('agent')[0]!.verbs.includes('deploy'), false);
  assert.deepEqual(adapterCapabilities('widget')[0]!.deployment.capacityIntents, []);
  assert.deepEqual(adapterCapabilities('workflow')[0]!.deployment.capacityIntents, ['shared', 'dedicated', 'BYO']);
  const tool = allTools.find(t => t.name === 'swfte_capabilities')!;
  const ctx = { config: config(), client: { request: () => { throw new Error('Guidance must not call the network'); } } as any };
  const result = await tool.execute({}, ctx) as any;
  assert.equal(result.evidenceLevel, 'LOCAL_IMPLEMENTATION_ONLY');
  assert.equal(result.deploymentEnabled, false);
  assert.ok(result.tools.some((t: any) => t.name === 'swfte_solution_advise'));
  assert.ok(!result.tools.some((t: any) => t.name === 'swfte_analytics_agent'));
  assert.ok(tool.inputSchema.safeParse({ kind: 'imaginary' }).success === false);
});

test('both wizard tool paths reject unknown reference IDs before any API mutation', async () => {
  const client = new Proxy({}, { get: () => { throw new Error('Unexpected client access'); } });
  for (const name of ['swfte_build', 'swfte_solution_build']) {
    const tool = allTools.find(t => t.name === name)!;
    const input = name === 'swfte_build' ? { kind: 'workflow', prompt: 'Build a useful review', designContext: { caseStudyIds: ['missing'] } } : { plan: { name: 'Review', components: [{ key: 'review', kind: 'workflow', prompt: 'Build a useful review' }], designContext: { caseStudyIds: ['missing'] } } };
    await assert.rejects(tool.execute(tool.inputSchema.parse(input), { client: client as any, config: config() }), /UNKNOWN_CASE_STUDY/);
  }
});

test('build passes selected guidance to actual adapter request', async () => {
  const calls: any[] = [];
  const client = {
    request: async (request: any) => { calls.push(request); return { sessionId: 'fixture-session' }; },
    pollUntil: async () => ({ snapshot: { done: false, nodes: [], edges: [], speculativeNodes: [], status: 'BUILDING' }, timedOut: true, elapsedMs: 0, polls: 1 }),
  };
  const tool = allTools.find(t => t.name === 'swfte_build')!;
  await tool.execute({ kind: 'workflow', prompt: 'Review the release evidence', designContext: { form: 'workflow', caseStudyIds: ['S09'] } }, { client: client as any, config: config() });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.description.includes('S09'));
  assert.ok(calls[0].body.description.includes('[Studio design guidance]'));
  assert.equal(calls[0].body.autoCreate, false);
});

test('HTTP failures receive recovery guidance through the actual client without mutation retries', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [403, 405, 409, 429]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response('<html>Rejected</html>', { status }); };
      const client = new SwfteClient(config());
      await assert.rejects(client.request({ method: 'PUT', path: '/v2/agents/id' }), (error: unknown) => {
        assert.ok(error instanceof SwfteApiError);
        assert.equal(error.toJSON().request, 'PUT /v2/agents/id');
        assert.ok(String(error.toJSON().suggestedAction).length > 30);
        return true;
      });
      assert.equal(calls, 1);
    }
  } finally { globalThis.fetch = original; }
});

test('hosted app wizard injects design references without forwarding MCP-only fields', async () => {
  const tool = allTools.find(t => t.name === 'swfte_app_wizard_create')!;
  const requests: any[] = [];
  const parsed = tool.inputSchema.parse({ name: 'Review dashboard', prompt: 'Build a shared editorial review dashboard', confirm: true, designContext: { form: 'product', caseStudyIds: ['S01'] } });
  await tool.execute(parsed, { client: { request: async (r: any) => { requests.push(r); return {}; } } as any, config: { ...config(), allowDeploy: true } });
  assert.equal(requests[0].body.designContext, undefined);
  assert.equal(requests[0].body.confirm, undefined);
  assert.ok(requests[0].body.prompt.includes('[Studio design guidance]'));
  assert.ok(requests[0].body.prompt.includes('S01'));
});
