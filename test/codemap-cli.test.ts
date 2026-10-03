import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanRepository, repositoryIdentity } from '../src/codemap/scan.js';
import type { UploadConfig } from '../src/codemap/upload.js';
import { parseArgs } from '../src/cli.js';
import { codeMapTools } from '../src/tools/codemap.js';
import { project } from './codemap-support.js';

test('explicit consent, keyed private upload, identical offline queue and changed-tree refusal', async () => {
  const root = project({ 'package.json': '{"name":"fixture"}', 'src/main.ts': "import { Swfte } from '@swfte/sdk';\nconst client = new Swfte();\nclient.workflows.invoke('wf_a', { question: 'canary_literal_7' });\n" });
  const seen: Array<{ path: string; body: any }> = [];
  let consent = false;
  const repoId = repositoryIdentity(root).repo.id;
  const cfg: UploadConfig = { baseUrl: 'https://api.swfte.com/agents', credential: 'fixture-secret', credentialKind: 'pat',
    fetch: (async (url, init) => {
      const path = new URL(String(url)).pathname.replace(/^\/agents/, '');
      const body = init?.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString()) : null;
      seen.push({ path, body });
      if (path.endsWith('/key')) return Response.json({ keyId: 'fixture', key: Buffer.alloc(32, 7).toString('base64') });
      if (path.endsWith('/manifests')) return Response.json({ status: 'stored', commitSha: body.commitSha, callSites: body.callSites.length });
      if (init?.method === 'POST') { consent = true; return Response.json({ repoId, pathHashing: true, attribution: false }); }
      return Response.json({ repos: consent ? [{ repoId, pathHashing: true, attribution: false }] : [] });
    }) as typeof fetch };
  try {
    await assert.rejects(scanRepository(root, cfg), /not opted in/);
    assert.equal(seen.some(request => request.path.endsWith('/key')), false);
    const uploaded = await scanRepository(root, cfg, { optIn: true, hashPaths: true });
    assert.equal(uploaded.status, 'stored'); assert.equal(uploaded.manifest.callSites.length, 1);
    const payload = seen.find(request => request.path.endsWith('/manifests'))!.body;
    assert.ok(payload.callSites[0].pathHash); assert.equal(payload.callSites[0].path, undefined);
    assert.equal(JSON.stringify(seen).includes('canary_literal_7'), false);
    for (const file of readdirSync(join(root, '.swfte/codemap'))) {
      assert.equal(readFileSync(join(root, '.swfte/codemap', file), 'utf8').includes(Buffer.alloc(32, 7).toString('base64')), false);
    }
    assert.equal((await scanRepository(root, null, { offline: true, hashPaths: true })).status, 'queued-offline');
    writeFileSync(join(root, 'src/main.ts'), "client.workflows.invoke('wf_b', {});\n");
    await assert.rejects(scanRepository(root, null, { offline: true }), /No matching private scan cache/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hosted scan refuses before source access; privacy flags are parsed explicitly', async () => {
  const tool = codeMapTools.find(tool => tool.name === 'swfte_code_map')!;
  await assert.rejects(tool.execute({ directory: '../../' }, { localFilesystem: false } as never), /hosted|locally|filesystem/i);
  const parsed = parseArgs(['scan', '--opt-in', '--hash-paths', '--tag', '--ci', '--pr', '12']);
  assert.equal(parsed.command, 'scan'); assert.equal(parsed.flags.get('pr')?.[0], '12');
});
