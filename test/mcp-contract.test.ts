import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { mcpServerAdapter as adapter } from '../src/kinds/mcp-server.js';

function client(response: unknown) {
  const c = new SwfteClient(loadConfig({ SWFTE_PAT: 'pat_test' } as never));
  c.request = async () => response as never;
  return c;
}
test('MCP build extracts the actual backend artifact and persisted id', async () => {
  const generatedServer = { id: 'generated-id', name: 'Test', tools: [] };
  const c = client({ status: 'READY', savedArtifactId: 'saved-id', generatedServer });
  const { sessionId } = await adapter.build!(c, { prompt: 'Build a useful server' });
  const snapshot = await adapter.status!(c, sessionId);
  assert.equal(adapter.extractId!(snapshot), 'saved-id');
  assert.deepEqual(adapter.extractArtifact!(snapshot), generatedServer);
  await assert.rejects(adapter.status!(client({}), sessionId), /No MCP wizard session/);
});
test('MCP build cannot bypass deploy controls through options', async () => {
  const c = client({});
  let called = false;
  c.request = async () => { called = true; return {} as never; };
  for (const options of [{ autoDeploy: true }, { options: { autoDeploy: true } }]) {
    await assert.rejects(adapter.build!(c, { prompt: 'Build server', options }), /cannot auto-deploy/);
  }
  assert.equal(called, false);
});
test('MCP deploy sends the full saved server and reads nested deployment state', async () => {
  const calls: any[] = [];
  const c = client({});
  c.request = async (opts) => {
    calls.push(opts);
    return (opts.method === 'GET'
      ? { id: 'artifact', name: 'Server', tools: [{ name: 'search' }], transport: 'stdio', generatedCode: 'code' }
      : { status: 'DEPLOYING', deployment: { id: 'deploy', state: 'PROVISIONING', endpoint: 'https://mcp.test' } }) as never;
  };
  const result = await adapter.deploy!(c, 'artifact', {});
  assert.equal(calls[0].path, '/v2/mcp/wizard/artifacts/artifact');
  assert.equal(calls[1].body.server.name, 'Server');
  assert.equal(calls[1].body.server.configuration.transport, 'stdio');
  assert.equal(calls[1].body.server.generatedCode, 'code');
  assert.equal(calls[1].retries, 0);
  assert.equal(result.deploymentId, 'deploy');
  assert.equal(result.phase, 'PROVISIONING');
  assert.equal(result.endpoint, 'https://mcp.test');
});
