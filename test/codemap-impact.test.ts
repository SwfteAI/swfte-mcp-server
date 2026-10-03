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


test('impact rejects full raw identity control suffixes before any request', async () => {
  const query = { artifactRef: 'workflow:wf_a', from: 'custom@v3:release+build', to: 'v4' };
  let requests = 0;
  const client = { request: async () => { requests++; throw new Error('unexpected transport'); } };
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029', '\0', '\t', '\nend', '\x7f']) {
    for (const field of ['artifactRef', 'from', 'to'] as const) {
      await assert.rejects(codeImpact(client as never, { ...query, [field]: query[field] + suffix }), /Invalid code impact/);
      assert.equal(requests, 0);
    }
  }
});

test('impact forwards raw opaque labels and exact current length limits', async () => {
  const seen: unknown[] = [];
  const client = { request: async (request: { query: object }) => {
    seen.push(request);
    return { ...request.query, verdict: 'known', breaking: [], cannotCheck: [], safe: [], pinned: [], unknownReasons: [] };
  } };
  for (const label of ['custom@v3:release+build', '0', '-1', '2147483648', 'a'.repeat(128)]) {
    const query = { artifactRef: 'workflow:' + 'x'.repeat(128), from: label, to: label };
    await codeImpact(client as never, query);
    assert.deepEqual((seen.at(-1) as {query: object}).query, query);
  }
  const count = seen.length;
  await assert.rejects(codeImpact(client as never, { artifactRef: 'workflow:wf_a', from: 'x'.repeat(129), to: 'v3' }), /Invalid/);
  assert.equal(seen.length, count);
});
