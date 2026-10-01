import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { allTools } from '../src/tools/index.js';
import { reviewTools, REVIEW_KINDS } from '../src/tools/review.js';
import { releaseTools } from '../src/tools/releases.js';
import { SwfteApiError } from '../src/client.js';
import type { ToolContext } from '../src/tools/_types.js';

const contentHash = `sha256:${'a'.repeat(64)}`;
const planHash = `sha256:${'b'.repeat(64)}`;
const proposal = { releaseId: 'release/a', expectedContentHash: contentHash, expectedPlanHash: planHash, desiredStage: 'AB', candidateWeight: 5000 };
const action = { id: 'action_1', capability: 'release.ramp', target: { kind: 'model', id: 'model_1' },
  environment: 'production', status: 'PROPOSED', requiresApproval: true, contentHash, planHash,
  params: { releaseId: 'release/a', stage: 'AB', candidateWeight: '5000' } };

function harness(name: string, reply: unknown) {
  const tool = [...reviewTools, ...releaseTools].find(t => t.name === name)!;
  const calls: any[] = [];
  const ctx = { client: { request: async (request: unknown) => {
    calls.push(request); if (reply instanceof Error) throw reply; return reply;
  } } } as unknown as ToolContext;
  return { calls, run: (input: unknown) => tool.execute(tool.inputSchema.parse(input), ctx) };
}

describe('Slack, review and release MCP boundaries', () => {
  test('published registry has every seam once and exposes no Slack decisions or outbound operations', () => {
    for (const t of [...reviewTools, ...releaseTools]) assert.equal(allTools.filter(x => x.name === t.name).length, 1);
    assert.equal(allTools.some(t => /slack.*(?:install|message|approve|decide)|(?:approve|decide).*slack/.test(t.name)), false);
    assert.equal(allTools.some(t => /review.*(?:view|mark|run)|action.*approve/.test(t.name)), false);
    for (const t of reviewTools) assert.equal(t.readOnly, true);
    assert.deepEqual(new Set(REVIEW_KINDS), new Set(['workflow', 'agent', 'chatflow', 'model', 'application', 'widget', 'studio-change']));
  });

  test('all review inputs refuse tenant, linked human, signature and room-view injection before any client call', () => {
    for (const kind of REVIEW_KINDS) {
      for (const injected of [{ workspaceId: 'foreign' }, { userId: 'approver' }, { via: 'slack' }, { signatureAccepted: true }, { roomViewed: true }]) {
        const h = harness('swfte_proof_bundle', {});
        assert.throws(() => h.run({ kind, artifactId: 'artifact', contentHash, ...injected }));
        assert.equal(h.calls.length, 0);
      }
    }
    const h = harness('swfte_review_room', {});
    assert.throws(() => h.run({ actionId: 'a', contentHash, recordView: true }));
    assert.equal(h.calls.length, 0);
  });

  test('release mutations require both complete hashes and reject callback identity overrides', () => {
    for (const name of ['swfte_release_pause', 'swfte_release_rollback', 'swfte_release_propose_ramp']) {
      const base = name.endsWith('ramp') ? proposal : { releaseId: 'r', expectedContentHash: contentHash, expectedPlanHash: planHash, trigger: 'operator' };
      for (const key of ['expectedContentHash', 'expectedPlanHash']) {
        for (const value of [undefined, 'latest', 'sha256:'+ 'a'.repeat(32), 'sha256:'+ 'A'.repeat(64)]) {
          const h = harness(name, {}); assert.throws(() => h.run({ ...base, [key]: value })); assert.equal(h.calls.length, 0);
        }
      }
      for (const extra of [{ workspaceId: 'foreign' }, { userId: 'approver' }, { via: 'slack' }, { highRiskAcknowledged: true }]) {
        const h = harness(name, {}); assert.throws(() => h.run({ ...base, ...extra })); assert.equal(h.calls.length, 0);
      }
    }
  });

  test('same hashes cannot substitute a different release, step, weight or approval state', async () => {
    for (const changed of [{ capability: 'workflow.deploy' }, { status: 'APPROVED' }, { requiresApproval: false },
      { params: { ...action.params, releaseId: 'another' } }, { params: { ...action.params, stage: 'COMPLETE' } },
      { params: { ...action.params, candidateWeight: '10000' } }, { params: undefined }]) {
      const h = harness('swfte_release_propose_ramp', { ...action, ...changed });
      await assert.rejects(h.run(proposal), /requested release step and human approval state/);
      assert.equal(h.calls.length, 1); assert.equal(h.calls[0].retries, 0);
    }
  });

  test('COMPLETE uses the server release.complete capability without executing or changing traffic', async () => {
    const h = harness('swfte_release_propose_ramp', { ...action, capability: 'release.complete',
      params: { ...action.params, stage: 'COMPLETE', candidateWeight: '10000' } });
    const result = await h.run({ ...proposal, desiredStage: 'COMPLETE', candidateWeight: 10000 }) as any;
    assert.equal(result.capability, 'release.complete'); assert.equal(result.changesTraffic, false);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].path, '/v2/releases/release%2Fa/propose-next-step');
    assert.match(result.instructions, /Pending human approval/);
  });

  test('authority, stale hash and missing runtime refusals propagate with one call and no substitute action', async () => {
    for (const [status, code] of [[403, 'APPROVER_REQUIRED'], [409, 'STALE_CONTENT'], [503, 'ACTION_RUNTIME_UNAVAILABLE']] as const) {
      const error = new SwfteApiError({ status, code, message: code, method: 'POST', path: '/v2/releases/r/propose-next-step' });
      const h = harness('swfte_release_propose_ramp', error);
      await assert.rejects(h.run(proposal), e => e === error);
      assert.equal(h.calls.length, 1); assert.equal(h.calls[0].retries, 0);
    }
  });

  test('read-only room preserves explicit historical absence and performs one GET even when evidence is missing', async () => {
    const reply = { action: { contentHash, planHash }, requestedHash: contentHash, packet: null,
      reports: [{ type: 'confidence', state: 'absent', reason: 'CONFIDENCE_RUNTIME_UNAVAILABLE' }], proofSuiteAvailable: false };
    const h = harness('swfte_review_room', reply);
    assert.deepEqual(await h.run({ actionId: 'a?view=true', contentHash }), reply);
    assert.deepEqual(h.calls, [{ method: 'GET', path: '/v2/review/a%3Fview%3Dtrue', query: { hash: contentHash }, retries: 1 }]);
  });
});
