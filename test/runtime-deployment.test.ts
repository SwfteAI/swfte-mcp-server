import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowAdapter } from '../src/kinds/workflow.js';
import { widgetAdapter } from '../src/kinds/widget.js';
import { allTools } from '../src/tools/index.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ SWFTE_PAT: 'pat_fixture', SWFTE_ALLOW_DEPLOY: '1' });
function deployClient(status: any, started: any = { deploymentId: 'd1' }) {
  const requests: any[] = [];
  return { requests, client: { request: async (r: any) => { requests.push(r); return r.method === 'POST' ? started : status; }, pollUntil: async (get: () => Promise<any>) => ({ snapshot: await get(), timedOut: false }) } as any };
}
test('workflow deployment retains endpointUrl and invokeEndpoint without silently rewriting it', async () => {
  for (const [status, started, expected] of [
    [{ phase: 'READY', endpointUrl: 'https://fixture.invalid/agents/execute' }, { deploymentId: 'd1' }, 'https://fixture.invalid/agents/execute'],
    [{ phase: 'READY' }, { deploymentId: 'd1', invokeEndpoint: 'https://fixture.invalid/execute' }, 'https://fixture.invalid/execute'],
  ] as const) {
    const { client } = deployClient(status, started);
    const result = await workflowAdapter.deploy!(client, 'wf', { option: 'shared' });
    assert.equal(result.endpoint, expected);
    assert.equal(result.url, expected);
  }
});
test('managed schema and adapter forward actual DTO fields; legacy GPU maps into sizing', async () => {
  const tool = allTools.find(t => t.name === 'swfte_deploy')!;
  const input = tool.inputSchema.parse({ kind: 'workflow', id: 'wf', action: 'deploy', confirm: true, option: 'BYO', provider: 'digitalocean', cloudConnectionId: 'connection-1', providerConfigName: 'tenant-config', sizing: { nodeCount: 2, cpu: '500m', memoryGi: 8, replicas: 2 }, gpuTier: 't4', idleTimeoutSec: 600, path: 'crossplane', lifecycle: 'ON_DEMAND' });
  const { client, requests } = deployClient({ phase: 'READY' });
  await workflowAdapter.deploy!(client, 'wf', input);
  const body = requests[0].body;
  assert.equal(body.option, 'BYO_CLOUD_DEDICATED');
  for (const key of ['provider','cloudConnectionId','providerConfigName','idleTimeoutSec','path','lifecycle']) assert.equal(body[key], input[key]);
  assert.deepEqual(body.sizing, { ...input.sizing, gpuTier: 'T4' });
  assert.equal(body.gpuTier, undefined);
  assert.equal(body.secretId, undefined);
  assert.equal(tool.inputSchema.safeParse({ ...input, sizing: { estMonthlyUsd: 1 } }).success, false);
  assert.equal(tool.inputSchema.safeParse({ ...input, sizing: { cpu: '-2' } }).success, false);
});
test('unsupported secrets and conflicting GPU options fail before any backend call', async () => {
  const { client, requests } = deployClient({});
  await assert.rejects(workflowAdapter.deploy!(client, 'wf', { secretId: 'legacy' }), /UNSUPPORTED_DEPLOY_OPTION/);
  await assert.rejects(workflowAdapter.deploy!(client, 'wf', { gpuTier: 'T4', sizing: { gpuTier: 'H100' } }), /CONFLICTING/);
  const tool = allTools.find(t => t.name === 'swfte_deploy')!;
  await assert.rejects(tool.execute({ kind: 'widget', id: 'w', provider: 'aws' }, { client, config }), /only to workflows/);
  await assert.rejects(tool.execute({ kind: 'workflow', id: 'wf', secretId: 'legacy' }, { client, config }), /UNSUPPORTED_DEPLOY_OPTION/);
  assert.equal(requests.length, 0);
});
function widgetClient(options: { persistActive?: boolean; failPublic?: boolean } = {}) {
  const requests: any[] = []; const record: any = { id: 'w1', active: false, brain: { kind: 'agent', id: 'a1' } };
  return { requests, record, client: { request: async (r: any) => {
    requests.push(r);
    if (r.method === 'PUT') { assert.deepEqual(r.body, { active: true }); if (options.persistActive !== false) record.active = true; return { ...record }; }
    if (r.method === 'POST') { assert.equal(record.active, true); record.deploymentId = 'd1'; return { id: 'd1', status: 'LIVE', configSnapshot: { active: record.active } }; }
    if (r.path === '/v1/widgets/w1') { if (options.failPublic) throw Error('410 inactive runtime'); return { id: 'w1' }; }
    return { ...record };
  } } as any };
}
test('confirmed widget deployment enables and rereads active before creating LIVE snapshot', async () => {
  const { client, requests } = widgetClient();
  const result = await widgetAdapter.deploy!(client, 'w1', {});
  assert.equal(result.phase, 'LIVE');
  const raw = result.raw as any;
  assert.equal(raw.deployed.configSnapshot.active, true);
  assert.deepEqual(raw.checks, { live: true, active: true, deploymentPointerMatches: true, publicConfigReadable: true, runtimeVerified: false });
  assert.deepEqual(requests.map(r => r.method), ['GET','PUT','GET','POST','GET','GET']);
});
test('failed activation prevents snapshot; failed public readback preserves mutation receipt as UNVERIFIED', async () => {
  const noActivation = widgetClient({ persistActive: false });
  await assert.rejects(widgetAdapter.deploy!(noActivation.client, 'w1', {}), /ACTIVATION_NOT_PERSISTED/);
  assert.equal(noActivation.requests.some(r => r.method === 'POST'), false);
  const failedReadback = widgetClient({ failPublic: true });
  const result = await widgetAdapter.deploy!(failedReadback.client, 'w1', {});
  assert.equal(result.phase, 'UNVERIFIED');
  assert.equal(result.deploymentId, 'd1');
  assert.equal((result.raw as any).checks.publicConfigReadable, false);
});
test('expected HUMAN_INPUT pause stops polling and returns requirements without business success', async () => {
  const snapshot = { status: 'PAUSED', outputData: { human_review: { status: 'waiting', required_variables: ['decision','reviewedPacket'], prompt: 'Review exact packet', input_schema: { type: 'object' } } } };
  let terminalChecked = false;
  const client = { request: async () => ({ executionId: 'e1' }), pollUntil: async (_get: any, done: any) => { assert.equal(done(snapshot), true); assert.equal(done({ status: 'RUNNING' }), false); terminalChecked = true; return { snapshot, timedOut: false, elapsedMs: 0 }; } } as any;
  const result = await workflowAdapter.run!(client, 'wf', {});
  assert.equal(terminalChecked, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.needsHuman, true);
  assert.equal(result.waiting?.executionId, 'e1');
  assert.equal(result.waiting?.review?.path, '/v2/workflow-executions/e1/resume');
  assert.equal(result.waiting?.review?.requiresHumanDecision, true);
  assert.deepEqual((result.waiting?.details as any)[0].requiredVariables, ['decision','reviewedPacket']);
});
test('actual failure remains failure and an operator pause does not invent human requirements', async () => {
  for (const status of ['FAILED', 'PAUSED']) {
    const client = { request: async () => ({ executionId: 'e1' }), pollUntil: async (_get: any, done: any) => { assert.equal(done({ status }), true); return { snapshot: { status }, timedOut: false, elapsedMs: 0 }; } } as any;
    const result = await workflowAdapter.run!(client, 'wf', {});
    assert.equal(result.ok, false);
    assert.equal(Boolean(result.needsHuman), false);
    assert.equal(result.status, status);
    if (status === 'FAILED') assert.equal(result.waiting, undefined);
  }
});
test('widget verification rejects LIVE deployment with inactive public configuration', async () => {
  const client = { request: async (r: any) => r.path.endsWith('/deployments') ? [{ id: 'd1', status: 'LIVE' }] : { id: 'w1', active: false, deploymentId: 'd1', brain: { kind: 'agent', id: 'a1' } } } as any;
  const result = await widgetAdapter.verify!(client, 'w1', { requirePublished: true });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(c => c.id === 'active')?.ok, false);
  assert.equal(result.checks.find(c => c.id === 'deployed')?.ok, false);
});
