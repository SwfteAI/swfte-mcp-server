import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { agentAdapter } from '../src/kinds/agent.js';
const config = loadConfig({ SWFTE_PAT: 'pat_test' } as never);
async function verify(agent: unknown) {
  const client = new SwfteClient(config);
  client.request = async () => agent as never;
  return agentAdapter.verify!(client, 'owned', { run: false });
}
test('combined system prompt and persona is valid against current runtime contract', async () => {
  const r = await verify({ model: 'valid-model', agentType: 'CUSTOM', systemPrompt: 'Reply with marker', persona: 'Helpful', capabilityTier: 'CONVERSATIONAL', agentName: 'test' });
  assert.equal(r.checks.find(c => c.id === 'prompt-effective')?.ok, true);
  assert.ok(r.checks.find(c => c.id === 'persisted')?.detail?.includes('test'));
});
test('placeholder models and absent instructions fail verification', async () => {
  const r = await verify({ model: 'none', agentType: 'CUSTOM' });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find(c => c.id === 'complete')?.ok, false);
  assert.equal(r.checks.find(c => c.id === 'prompt-effective')?.ok, false);
});
