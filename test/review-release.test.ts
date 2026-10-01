import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewTools, REVIEW_KINDS } from '../src/tools/review.js';
import { releaseTools } from '../src/tools/releases.js';
import type { ToolContext } from '../src/tools/_types.js';

const contentHash = `sha256:${'a'.repeat(64)}`;
const planHash = `sha256:${'b'.repeat(64)}`;
const all = [...reviewTools, ...releaseTools];
function harness(name: string, reply: unknown) {
  const calls: any[] = [];
  const tool = all.find(t => t.name === name)!;
  assert.ok(tool);
  const ctx = { client: { request: async (request: unknown) => { calls.push(request); return reply; } } } as unknown as ToolContext;
  return { calls, run: (input: unknown) => tool.execute(tool.inputSchema.parse(input), ctx) };
}

describe('exact-hash review and release MCP contracts', () => {
  test('room read keeps URL hash and has no room-view write', async () => {
    const h = harness('swfte_review_room', { packet: null, reason: 'HISTORICAL_PACKET_UNAVAILABLE' });
    const result = await h.run({ actionId: 'act/a', contentHash });
    assert.deepEqual(h.calls, [{ method: 'GET', path: '/v2/review/act%2Fa', query: { hash: contentHash }, retries: 1 }]);
    assert.deepEqual(result, { packet: null, reason: 'HISTORICAL_PACKET_UNAVAILABLE' });
  });
  test('every original kind is sent with an exact proof subject hash', async () => {
    for (const kind of REVIEW_KINDS) {
      const h = harness('swfte_proof_bundle', { confidence: { status: 'absent' } });
      await h.run({ kind, artifactId: 'artifact', contentHash });
      assert.equal(h.calls[0].path, `/v2/proof-bundles/${kind}/artifact`);
      assert.deepEqual(h.calls[0].query, { hash: contentHash });
    }
  });
  test('hash prefixes and unknown workspace override cannot reach the client', () => {
    for (const bad of ['a'.repeat(12), 'sha256:'+ 'G'.repeat(64), 'latest', '']) {
      const h = harness('swfte_review_room', {});
      assert.throws(() => h.run({ actionId: 'a', contentHash: bad })); assert.equal(h.calls.length, 0);
    }
    const h = harness('swfte_release_pause', {});
    assert.throws(() => h.run({ releaseId: 'r', expectedContentHash: contentHash, expectedPlanHash: planHash, trigger: 'operator', workspaceId: 'foreign' }));
    assert.equal(h.calls.length, 0);
  });
  test('ramp calls only propose-next-step and preserves both hashes in presented action', async () => {
    const action = { id: 'act_r', capability: 'release.ramp', target: { kind: 'model', id: 'm' }, params: { releaseId: 'r', stage: 'AB', candidateWeight: '5000' }, environment: 'production', status: 'PROPOSED', requiresApproval: true, contentHash, planHash };
    const h = harness('swfte_release_propose_ramp', action);
    const result = await h.run({ releaseId: 'r', expectedContentHash: contentHash, expectedPlanHash: planHash, desiredStage: 'AB', candidateWeight: 5000 }) as any;
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, '/v2/releases/r/propose-next-step');
    assert.equal(h.calls[0].retries, 0); assert.equal(result.changesTraffic, false);
    assert.equal(result.contentHash, contentHash); assert.equal(result.planHash, planHash);
    assert.match(result.instructions, /Pending human approval/);
  });
  test('mismatched proposal response is refused', async () => {
    const h = harness('swfte_release_propose_ramp', { contentHash, planHash: `sha256:${'c'.repeat(64)}` });
    await assert.rejects(h.run({ releaseId: 'r', expectedContentHash: contentHash, expectedPlanHash: planHash, desiredStage: 'AB', candidateWeight: 5000 }), /does not match/);
  });
  test('safe-direction controls are exact-hash calls with no action creation or retry', async () => {
    for (const name of ['pause', 'rollback']) {
      const h = harness(`swfte_release_${name}`, { stage: name === 'pause' ? 'PAUSED' : 'ROLLED_BACK', candidateWeight: 0 });
      await h.run({ releaseId: 'r', expectedContentHash: contentHash, expectedPlanHash: planHash, trigger: 'operator' });
      assert.equal(h.calls[0].path, `/v2/releases/r/${name}`); assert.equal(h.calls[0].retries, 0);
      assert.deepEqual(h.calls[0].body, { expectedContentHash: contentHash, expectedPlanHash: planHash, trigger: 'operator' });
    }
  });
  test('underpowered and mismatch source facts pass through without invented metrics', async () => {
    for (const reply of [{ withheld: 'ALLOCATION_MISMATCH', primary: null }, { underpowered: true, primary: { outcome: 'INCONCLUSIVE_UNDERPOWERED' } }]) {
      const h = harness('swfte_release_report', reply);
      assert.deepEqual(await h.run({ releaseId: 'r' }), reply);
    }
  });
  test('no new tool grants a decision or direct step-up', () => {
    assert.equal(all.some(t => /approve|execute|direct_ramp/.test(t.name)), false);
    for (const t of all.filter(t=>t.name==='swfte_review_room'||t.name==='swfte_proof_bundle')) assert.equal(t.readOnly, true);
    assert.equal(releaseTools.filter(t=>/propose/.test(t.name)).length, 1);
  });
});
