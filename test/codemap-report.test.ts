import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postVerifyResult, type UploadConfig } from '../src/codemap/upload.js';

test('pass/fail/unchecked all store closed metadata; diagnostics cannot cross the boundary', async () => {
  const seen: any[] = [];
  const cfg: UploadConfig = { baseUrl: 'https://api.swfte.com', credential: 'fixture', credentialKind: 'pat',
    fetch: (async (_url, init) => { seen.push(JSON.parse(Buffer.from(init!.body as Uint8Array).toString())); return Response.json({ stored: true }); }) as typeof fetch };
  const row = { repoId: 'r_' + 'a'.repeat(32), commitSha: 'b'.repeat(40), artifactRef: 'workflow:wf_a', alias: 'answer', drift: ['OUTPUT_REMOVED:answer'] };
  for (const status of ['pass', 'fail', 'unchecked'] as const) await postVerifyResult(cfg, { ...row, status });
  assert.deepEqual(seen.map(row => row.status), ['pass', 'fail', 'unchecked']);
  await assert.rejects(postVerifyResult(cfg, { ...row, status: 'fail', drift: ['source = secret()'] }), /non-metadata/);
  assert.equal(seen.length, 3);
  await assert.rejects(postVerifyResult({ ...cfg, baseUrl: 'http://api.swfte.com', env: { SWFTE_BASE_URL: 'http://api.swfte.com' } }, { ...row, status: 'pass' }), /HTTPS/);
});
