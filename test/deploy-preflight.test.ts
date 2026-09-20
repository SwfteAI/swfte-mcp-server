import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allTools } from '../src/tools/index.js';
import { workflowAdapter } from '../src/kinds/workflow.js';
import { loadConfig } from '../src/config.js';

const workflow = () => ({ id: 'wf-first-deploy', name: 'First deployment', workspaceId: '1', status: 'DRAFT', enabled: false, published: false, nodes: {
  trigger: { id: 'trigger', type: 'MANUAL_TRIGGER', configuration: {} },
  finish: { id: 'finish', type: 'END', configuration: {} },
}, edges: [{ sourceNodeId: 'trigger', targetNodeId: 'finish' }] });
function fakeClient(record: any) {
  const requests: any[] = [];
  return { requests, client: {
    request: async (r: any) => {
      requests.push(r);
      if (r.method === 'POST') return { deploymentId: 'deployment-fixture', phase: 'READY' };
      if (r.path === '/v2/workflows/wf-first-deploy') return record;
      if (r.path.includes('/deploy/deployment-fixture/status')) return { phase: 'READY', endpoint: 'https://fixture.invalid/execute' };
      if (r.path.endsWith('/executions')) return [];
      if (r.path === '/v2/data-tables' || r.path.startsWith('/v1/knowledge-modules') || r.path.startsWith('/api/v2/datasets')) return [];
      throw Error('Unexpected route: '+r.path);
    },
    pollUntil: async (get: () => Promise<any>) => ({ snapshot: await get(), timedOut: false }),
  } as any };
}
const deploy = allTools.find(t => t.name === 'swfte_deploy')!;
const config = loadConfig({ SWFTE_PAT: 'pat_fixture', SWFTE_ALLOW_DEPLOY: '1' });
const input = { kind: 'workflow', id: 'wf-first-deploy', action: 'deploy', confirm: true, option: 'shared' };

test('first deployment retains preflight without requiring state that deployment establishes', async () => {
  const { client, requests } = fakeClient(workflow());
  const result = await deploy.execute(deploy.inputSchema.parse(input), { client, config }) as any;
  assert.equal(result.dryRun, false, JSON.stringify(result));
  assert.equal(result.preflight.expectLive, false);
  assert.equal(result.preflight.verdict, 'PASS');
  assert.ok(result.preflight.skippedRules.some((r: string) => r.startsWith('WF-PUBLISHED:')));
  assert.equal(result.readiness, 'DEPLOYMENT_RESULT_REQUIRES_RUNTIME_VERIFICATION');
  const writes = requests.filter(r => r.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.option, 'SHARED_CLOUD');
});

test('predeployment still refuses broken graph and makes no provisioning mutation', async () => {
  const broken = workflow();
  broken.edges.push({ sourceNodeId: 'finish', targetNodeId: 'nonexistent' });
  const { client, requests } = fakeClient(broken);
  const result = await deploy.execute(deploy.inputSchema.parse(input), { client, config }) as any;
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'PREFLIGHT_BLOCKED');
  assert.ok(result.blocking.some((r: any) => r.rule === 'WF-GRAPH-SOUND'));
  assert.equal(requests.filter(r => r.method === 'POST').length, 0);
});

test('managed deployment maps every advertised intent to actual backend enum', async () => {
  for (const [option, expected] of Object.entries({ BYO: 'BYO_CLOUD_DEDICATED', shared: 'SHARED_CLOUD', dedicated: 'DEDICATED_INSTANCE' })) {
    const { client, requests } = fakeClient(workflow());
    await workflowAdapter.deploy!(client, 'wf-first-deploy', { option: option as any });
    assert.equal(requests.find(r => r.method === 'POST').body.option, expected);
  }
});
