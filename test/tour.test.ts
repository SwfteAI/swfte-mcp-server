import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadConfig } from '../src/config.js';
import { allTools } from '../src/tools/index.js';
import { selectTools } from '../src/server.js';
import { buildTourLink } from '../src/tools/tour.js';

const tour = allTools.find((t) => t.name === 'swfte_tour')!;
const config = loadConfig({ SWFTE_PAT: 'pat_test' } as never);
// No backend call: any client use fails the test.
const client = new Proxy({}, { get() { throw new Error('swfte_tour must not touch the client'); } }) as never;
const run = (input: Record<string, unknown>): Promise<any> =>
  tour.execute(tour.inputSchema.parse(input), { client, config });

const savedStudioUrl = process.env.SWFTE_STUDIO_URL;
afterEach(() => {
  if (savedStudioUrl === undefined) delete process.env.SWFTE_STUDIO_URL;
  else process.env.SWFTE_STUDIO_URL = savedStudioUrl;
});

describe('swfte_tour', () => {
  test('is a read-only core tool in the default surface', () => {
    assert.equal(tour.group, 'core');
    assert.equal(tour.readOnly, true);
    assert.ok(selectTools(allTools, config).some((t) => t.name === 'swfte_tour'));
  });

  test('default track returns the start link and all 21 steps over 12 chapters', async () => {
    delete process.env.SWFTE_STUDIO_URL;
    const r = await run({});
    assert.equal(r.track, 'sandbox-first');
    assert.equal(r.link, 'https://studio.swfte.com/v2/studio/welcome?tour=sandbox-first');
    assert.equal(r.warnings, undefined);
    assert.equal(r.steps.length, 21);
    assert.equal(new Set(r.steps.map((s: any) => s.chapter)).size, 12);
    assert.match(r.howToUse, /link/);
    for (const s of r.steps) {
      assert.equal(typeof s.enterprise, 'boolean');
      assert.ok(s.id && s.title && s.chapter >= 1);
    }
    assert.ok(r.steps.some((s: any) => s.enterprise));
    assert.deepEqual(r.steps[0].mcp.tool, 'swfte_build');
  });

  test('a known step is put in the link without a warning', async () => {
    const r = await run({ step: 'connections-intro' });
    assert.equal(r.link, 'https://studio.swfte.com/v2/studio/welcome?tour=sandbox-first&step=connections-intro');
    assert.equal(r.warnings, undefined);
  });

  test('an unknown step still returns the link, with a warning that lists valid ids', async () => {
    const r = await run({ step: 'no-such-step' });
    assert.match(r.link, /tour=sandbox-first&step=no-such-step$/);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /no-such-step/);
    assert.match(r.warnings[0], /step 1/);
    assert.match(r.warnings[0], /sandbox-pill/);
  });

  test('an unknown track is an error', async () => {
    await assert.rejects(run({ track: 'nope' }), /Unknown tour track "nope"/);
  });

  test('workflowId is appended as &id= and fills <workflowId> in the args', async () => {
    const r = await run({ step: 'sandbox-pill', workflowId: 'wf_123' });
    assert.equal(r.link, 'https://studio.swfte.com/v2/studio/welcome?tour=sandbox-first&step=sandbox-pill&id=wf_123');
    const text = JSON.stringify(r.steps);
    assert.ok(!text.includes('<workflowId>'));
    assert.ok(text.includes('wf_123'));
    // Without it the placeholder stays for the agent to fill.
    assert.ok(JSON.stringify((await run({})).steps).includes('<workflowId>'));
  });

  test('SWFTE_STUDIO_URL overrides the base and trailing slashes are dropped', async () => {
    process.env.SWFTE_STUDIO_URL = 'http://localhost:3300/';
    const r = await run({});
    assert.equal(r.link, 'http://localhost:3300/v2/studio/welcome?tour=sandbox-first');
  });

  test('buildTourLink encodes values', () => {
    assert.equal(
      buildTourLink('https://x.test', 'sandbox-first', 'a b', 'w&1'),
      'https://x.test/v2/studio/welcome?tour=sandbox-first&step=a+b&id=w%261',
    );
  });

  test('snapshot cross-check: every agentEquivalent.tool in the checked-in JSON is a registered tool', () => {
    const data = JSON.parse(readFileSync(new URL('../src/guidance/tour-sandbox-first.json', import.meta.url), 'utf8'));
    const registered = new Set(allTools.map((t) => t.name));
    const missing = data.steps.filter((s: any) => s.mcp && !registered.has(s.mcp.tool)).map((s: any) => `${s.id}:${s.mcp.tool}`);
    assert.deepEqual(missing, []);
    assert.ok(data.steps.filter((s: any) => s.mcp).length >= 20);
  });
});
