import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lensEnabled, parseLensUri, readCodeMapLens } from '../src/codemap/lens.js';

test('lens is off by default and reads exact authenticated API metadata for plain/hashed paths', async () => {
  assert.equal(lensEnabled({}), false);
  const repo = 'r_' + 'a'.repeat(32);
  const query = parseLensUri(`swfte://codemap/${repo}/file/src%2Fmain.ts`)!;
  assert.deepEqual(query, { repoId: repo, path: 'src/main.ts' });
  assert.equal(parseLensUri(`swfte://codemap/${repo}/file/..%2Fescape`), null);
  assert.ok(parseLensUri(`swfte://codemap/${repo}/file/ph_${'b'.repeat(32)}`)?.pathHash);
  const response = { items: [{ callSiteId: 'cs_' + '1'.repeat(24), line: 42, symbol: 'run', artifact: { kind: 'workflow', id: 'wf_a' }, pin: '1', drift: null, calls24h: null, errors24h: null }] };
  const client = { request: async (request: any) => { assert.deepEqual(request.query, query); return response; } };
  assert.deepEqual(await readCodeMapLens(client as never, query), response);
});
