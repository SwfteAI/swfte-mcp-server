import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { mcpServerAdapter as adapter } from '../src/kinds/mcp-server.js';
import { ADAPTERS } from '../src/kinds/index.js';
import { allTools } from '../src/tools/index.js';

const config = loadConfig({ SWFTE_PAT: 'pat_fixture' });
const artifact = { name: 'fixture', description: 'fixture', tools: [{ name: 'echo' }], generatedCode: 'const echo = () => 1;', packageJson: '{}' };
function buildClient(build: unknown, configuration: unknown = { valid: true }) {
  const c = new SwfteClient(config);
  const calls: any[] = [];
  c.request = async (opts) => {
    calls.push(opts);
    if (opts.method === 'GET') return artifact as never;
    const result = opts.path.endsWith('/validate-build') ? build : configuration;
    if (result instanceof Error) throw result;
    return result as never;
  };
  return { c, calls };
}
for (const [label, build] of Object.entries({
  failed: { success: false, buildAttempted: true, errors: ['syntax error'] },
  skipped: { success: true, buildAttempted: false },
  malformed: { success: true },
  unavailable: new Error('compiler unavailable'),
})) {
  test(`MCP verify rejects ${label} compilation`, async () => {
    const { c } = buildClient(build);
    const report = await adapter.verify(c, 'artifact', {});
    assert.equal(report.ok, false);
    assert.equal(report.checks.find(c => c.id === 'builds')?.ok, false);
    assert.ok(!report.nextActions.some(a => /Looks healthy|swfte_deploy/.test(a)));
  });
}
test('MCP verify compiles the retrieved code snapshot and names runtime limitation', async () => {
  const { c, calls } = buildClient({ success: true, buildAttempted: true, validationMethod: 'tsc' });
  const report = await adapter.verify(c, 'artifact', {});
  assert.equal(report.ok, true);
  assert.deepEqual(calls.find(c => c.path.endsWith('/validate-build')).body, { serverName: artifact.name, code: artifact.generatedCode, packageJson: artifact.packageJson });
  assert.ok(report.nextActions.some(a => a.includes('runtime health remains unverified')));
});
test('MCP verify fails requested unsupported execution', async () => {
  const { c } = buildClient({ success: true, buildAttempted: true });
  const report = await adapter.verify(c, 'artifact', { run: true });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(c => c.id === 'execution')?.ok, false);
});
test('MCP verify fails unavailable configuration even with a successful compiler', async () => {
  const { c } = buildClient({ success: true, buildAttempted: true }, new Error('validator unavailable'));
  assert.equal((await adapter.verify(c, 'artifact', {})).ok, false);
});
for (const status of [202, 409]) {
  test(`MCP steering preserves empty HTTP ${status}`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status });
    try {
      const tool = allTools.find(t => t.name === 'swfte_build_steer')!;
      const result = await tool.execute({ kind: 'mcp-server', sessionId: 'live-session', instruction: 'Use Postgres' }, { client: new SwfteClient(config), config }) as any;
      assert.equal(result.accepted, status === 202);
      assert.equal(result.status, status === 202 ? 'accepted' : 'inactive');
    } finally { globalThis.fetch = original; }
  });
}
test('MCP synthetic session steering does not call backend', async () => {
  const c = new SwfteClient(config);
  c.request = async () => { throw new Error('must not call'); };
  assert.deepEqual(await adapter.steer!(c, 'mcpwiz-completed', 'Use Postgres'), { accepted: false, status: 'inactive' });
});
test('single and batch verify both reject missing workflow credentials', async () => {
  const original = ADAPTERS.workflow!.verify;
  ADAPTERS.workflow!.verify = async () => ({ ok: true, kind: 'workflow', id: 'wf', checks: [], nextActions: [] });
  const c = new SwfteClient(config);
  c.request = async ({ path }) => {
    if (path === '/v2/workflows/wf') return { nodes: [{ id: 'notion', type: 'NOTION', configuration: { oauthProvider: 'notion' } }] } as never;
    if (path === '/v2/workflows/nodes/catalog') return [] as never;
    if (path === '/v1/secrets/oauth/integrations') return { integrations: {} } as never;
    throw new Error(`Unexpected path ${path}`);
  };
  try {
    const single = await allTools.find(t => t.name === 'swfte_verify')!.execute({ kind: 'workflow', id: 'wf' }, { client: c, config }) as any;
    const batch = await allTools.find(t => t.name === 'swfte_verify_batch')!.execute({ targets: [{ kind: 'workflow', id: 'wf' }] }, { client: c, config }) as any;
    assert.equal(single.ok, false);
    assert.equal(batch.ok, false);
    assert.deepEqual(batch.reports[0], single);
    assert.equal(batch.failed, 1);
  } finally { ADAPTERS.workflow!.verify = original; }
});
