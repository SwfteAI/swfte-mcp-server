import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { agentAdapter } from '../src/kinds/agent.js';
import { whoamiTools } from '../src/tools/whoami.js';

const config = loadConfig({ SWFTE_PAT: 'pat_test' } as never);
function client(response: unknown) {
  const c = new SwfteClient(config);
  c.request = async () => response as never;
  return c;
}

test('agent run exposes live content response instead of silently dropping output', async () => {
  const raw = { content: 'STUDIO_E2E_OK', inputTokens: 31, provider: 'anthropic', model: 'claude-sonnet-4-6' };
  const result = await agentAdapter.run!(client(raw), 'owned-agent', { message: 'Reply with the marker' });
  assert.equal(result.ok, true);
  assert.equal(result.output, 'STUDIO_E2E_OK');
  assert.equal(result.degraded, false);
  assert.equal(result.raw, raw);
});

test('agent run retains textual legacy aliases and ignores empty or nontext aliases', async () => {
  for (const raw of [{ response: 'legacy' }, { reply: 'legacy' }, { message: 'legacy' }, { content: '', response: 'legacy' }, { content: {}, response: 'legacy' }]) {
    const result = await agentAdapter.run!(client(raw), 'owned-agent', {});
    assert.equal(result.output, 'legacy');
    assert.equal(result.ok, true);
  }
});

test('agent run does not report success for token-consuming empty replies', async () => {
  const result = await agentAdapter.run!(client({ content: '', inputTokens: 31 }), 'owned-agent', {});
  assert.equal(result.ok, false);
  assert.equal(result.output, '');
  assert.equal(result.status, 'EMPTY_RESPONSE');
  assert.equal(result.degraded, false);
});

test('whoami is disconnected when every identity probe fails at transport', async () => {
  const c = client(null);
  c.request = async () => { throw new Error('fetch failed'); };
  const result = await whoamiTools[0].execute({}, { client: c, config }) as any;
  assert.equal(result.connected, false);
  assert.equal(result.partialFailures.length, 3);
  assert.equal(result.identity, null);
});

test('whoami preserves partial availability when a probe succeeds', async () => {
  const c = client(null);
  c.request = async ({ path }) => {
    if (path === '/v2/workspace/members/me') return { workspaceId: 'test-workspace', role: 'MEMBER' } as never;
    throw new Error('fetch failed');
  };
  const result = await whoamiTools[0].execute({}, { client: c, config }) as any;
  assert.equal(result.connected, true);
  assert.equal(result.identity.workspaceId, 'test-workspace');
  assert.equal(result.partialFailures.length, 2);
});
