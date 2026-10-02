import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeImpact } from '../src/codemap/impact.js';

test('impact preserves unknown and pinned projections and rejects an unmeasured zero answer', async () => {
  const query = { artifactRef: 'workflow:wf_a', from: '1', to: '2' };
  const answer = { ...query, verdict: 'unknown', unknownReasons: [{ repoId: 'r_' + 'a'.repeat(32), reason: 'stale' }], breaking: [], cannotCheck: [], safe: [], pinned: [{ site: { id: 'cs_a' }, wouldBreakOnUpgrade: true }], otherVersions: 0 };
  const seen: any[] = [];
  const client = { request: async (request: unknown) => { seen.push(request); return answer; } };
  assert.deepEqual(await codeImpact(client as never, query), answer); assert.equal(seen[0].path, '/v2/codemap/impact');
  await assert.rejects(codeImpact({ request: async () => ({ ...answer, unknownReasons: [] }) } as never, query), /measured receipt/);
  await assert.rejects(codeImpact(client as never, { ...query, to: '../foreign' }), /Invalid/); assert.equal(seen.length, 1);
});
