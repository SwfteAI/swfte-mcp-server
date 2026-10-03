import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { project } from './codemap-support.js';
import { contractHash, type CatalogContract } from '../src/catalog.js';
import { renderTypeScriptClient } from '../src/codegen.js';
import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { ConfinedWriter } from '../src/fsguard.js';
import { serializeLock } from '../src/lock.js';
import { verifyProject } from '../src/bake.js';
import { repositoryIdentity, scanRepository } from '../src/codemap/scan.js';
import { reportVerification, verifyProjectWithSnapshot } from '../src/codemap/report.js';
import { bindManifest, CACHE_BINDING, stableJson } from '../src/codemap/binding.js';
import { fetchWorkspaceKey, repositoryOptIns, type UploadConfig } from '../src/codemap/upload.js';
import { runCli } from '../src/cli.js';

const realFetch = globalThis.fetch;
const roots: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function git(root: string, args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'pipe',
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' } });
}
async function fixture(options: { missingClient?: boolean; unpinned?: boolean; emptySchemas?: boolean; pinnedVersion?: string } = {}) {
  const env = { SWFTE_PAT: 'pat_fixture_report_credential', SWFTE_BASE_URL: 'http://127.0.0.1:8976', SWFTE_TELEMETRY: '0' };
  const config = loadConfig(env);
  const version = options.unpinned ? null : options.pinnedVersion ?? '1.0.7';
  const live: CatalogContract = { catalogRef: 'workflow:wf_a',
    invoke: { method: 'POST', path: '/v2/workflows/wf_a/invoke', auth: 'api_key', async: true,
      statusPath: '/v2/workflows/executions/{executionId}/status' },
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } };
  if (options.emptySchemas) { live.inputSchema = {}; live.outputSchema = {}; }
  const hash = contractHash(live);
  const pinned = { ...live, invoke: { ...live.invoke, path: version ? '/v2/workflows/wf_a/versions/' + version + '/invoke' : live.invoke.path } };
  const generated = renderTypeScriptClient({ catalogRef: live.catalogRef, kind: 'workflow', id: 'wf_a', name: 'Answer', alias: 'answer',
    contract: pinned, contractHash: hash, defaultBaseUrl: config.baseUrl, pinnedVersion: version });
  const files: Record<string, string> = {
    '.gitignore': '.swfte/codemap/\n',
    'package.json': '{"name":"report-fixture","type":"module"}',
    'src/main.ts': "import { Swfte } from '@swfte/sdk';\nconst client = new Swfte();\nclient.workflows.invoke('wf_a', { question: 'report-source-canary' });\n",
    'swfte.json': serializeLock({ version: 1, baseUrl: config.baseUrl, workspaceId: null, artifacts: [{
      catalogRef: live.catalogRef, alias: 'answer', language: 'typescript', framework: 'nextjs', outDir: 'src/swfte',
      contractHash: hash, pinnedVersion: version, files: ['src/swfte/answer.ts'],
    }] }),
  };
  if (!options.missingClient) files['src/swfte/answer.ts'] = generated;
  const root = project(files);
  roots.push(root);
  const repoId = repositoryIdentity(root).repo.id;
  const state = { keyId: 'wk_report', key: Buffer.alloc(32, 7), optedIn: false, pathHashing: false, attribution: false,
    pin: 'published' as 'published' | 'missing' | 'unsupported' | 'mismatch' | 'null-schema' | 'wrong-route', compatible: false, unchecked: false };
  const seen: Array<{ path: string; method: string; body: any }> = [];
  let onVerify: (() => void) | undefined;
  let onRepoRead: (() => void) | undefined;
  let onPinResponse: (() => void) | undefined;
  const handler: typeof fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString()) : null;
    seen.push({ path, method, body });
    if (path === '/v2/codemap/key') return Response.json({ keyId: state.keyId, key: state.key.toString('base64') });
    if (path === '/v2/codemap/repos') {
      if (method === 'POST') {
        state.optedIn = true; state.pathHashing = body.pathHashing; state.attribution = body.attribution;
        return Response.json({ repoId, pathHashing: state.pathHashing, attribution: state.attribution });
      }
      const change = onRepoRead; onRepoRead = undefined; change?.();
      return Response.json({ repos: state.optedIn ? [{ repoId, pathHashing: state.pathHashing, attribution: state.attribution }] : [] });
    }
    if (path.endsWith('/manifests')) return Response.json({ status: 'stored', commitSha: body.commitSha, callSites: body.callSites.length });
    if (path === '/v2/codemap/verify-results') return Response.json({ stored: true });
    if (path === '/v2/catalog/upgrades') {
      const change = onVerify; onVerify = undefined; change?.();
      if (state.unchecked) return Response.json({ truncated: true });
      return Response.json({ items: [{ catalogRef: live.catalogRef, currentHash: hash,
        latestHash: state.compatible ? 'c'.repeat(64) : hash, latestVersion: '1.0.8',
        breaking: false, requiresReapproval: false, capabilityChanges: [] }] });
    }
    if (path === '/v2/catalog/workflow/wf_a/contract') {
      return Response.json(state.compatible ? { ...live, inputSchema: { ...live.inputSchema,
        properties: { question: { type: 'string' }, optional: { type: 'string' } } } } : live);
    }
    if (path === '/v2/workflows/wf_a/schema') return Response.json(live);
    if (path === '/v2/workflows/wf_a/versions/' + encodeURIComponent(version ?? '') + '/schema') {
      const change = onPinResponse; onPinResponse = undefined; change?.();
      if (state.pin === 'missing') return Response.json({ code: 'VERSION_NOT_PUBLISHED' }, { status: 404 });
      if (state.pin === 'unsupported') return Response.json({ code: 'UNSUPPORTED_METHOD' }, { status: 404 });
      return Response.json({ ...pinned, invoke: state.pin === 'wrong-route'
        ? { ...pinned.invoke, path: '/v2/workflows/wf_a/versions/1.0.8/invoke' } : pinned.invoke,
        inputSchema: state.pin === 'mismatch'
        ? { type: 'object', properties: { question: { type: 'integer' } }, required: ['question'] }
        : state.pin === 'null-schema' ? null : pinned.inputSchema });
    }
    return Response.json({ code: 'NO_ROUTE' }, { status: 404 });
  }) as typeof fetch;
  globalThis.fetch = handler;
  const cfg: UploadConfig = { ...config, env, fetch: handler };
  const ctx = { client: new SwfteClient(config), config, writer: new ConfinedWriter({ root }) };
  await scanRepository(root, cfg, { optIn: true });
  const reports = () => seen.filter(r => r.path === '/v2/codemap/verify-results');
  const verify = () => verifyProjectWithSnapshot(ctx, cfg);
  return { root, env, config, cfg, ctx, state, seen, reports, verify,
    onVerify: (fn: () => void) => { onVerify = fn; },
    onRepoRead: (fn: () => void) => { onRepoRead = fn; },
    onPinResponse: (fn: () => void) => { onPinResponse = fn; }, generated, live };
}

test('actual generated client and exact semantic pin produce measured pass metadata, and a genuine broken pin posts fail', async () => {
  for (const broken of [false, true]) {
    const f = await fixture();
    if (broken) f.state.pin = 'missing';
    const report = await f.verify();
    assert.equal(report.exitCode, broken ? 1 : 0);
    assert.equal(await reportVerification(f.root, f.cfg, report), 1);
    assert.equal(f.reports().length, 1);
    const row = f.reports()[0]!.body;
    assert.equal(row.status, broken ? 'fail' : 'pass');
    assert.equal(row.commitSha, repositoryIdentity(f.root).commitSha);
    assert.equal(row.artifactRef, 'workflow:wf_a');
    assert.equal(row.alias, 'answer');
    assert.deepEqual(Object.keys(row).sort(), ['alias', 'artifactRef', 'commitSha', 'drift', 'repoId', 'status']);
    assert.equal(JSON.stringify(row).includes('report-source-canary'), false);
    assert.equal(JSON.stringify(row).includes(f.cfg.credential), false);
    assert.ok(f.seen.some(r => r.path === '/v2/workflows/wf_a/versions/1.0.7/schema'));
    assert.equal(f.seen.some(r => /\/versions\/(0|1)\/schema$/.test(r.path)), false);
  }
});

test('a stable genuinely missing client posts its actual failure, and uncheckable upgrades post unchecked rather than pass', async () => {
  const missing = await fixture({ missingClient: true });
  const failed = await missing.verify();
  assert.equal(failed.exitCode, 1);
  assert.ok(failed.problems.some(p => p.kind === 'missing'));
  assert.equal(await reportVerification(missing.root, missing.cfg, failed), 1);
  assert.equal(missing.reports()[0]!.body.status, 'fail');
  const unchecked = await fixture();
  unchecked.state.unchecked = true;
  const report = await unchecked.verify();
  assert.equal(report.exitCode, 2);
  assert.equal(await reportVerification(unchecked.root, unchecked.cfg, report), 1);
  assert.equal(unchecked.reports()[0]!.body.status, 'unchecked');
});

test('unsupported and changed exact-version schema/hash cannot post an otherwise passing report', async () => {
  for (const pin of ['unsupported', 'mismatch', 'null-schema', 'wrong-route'] as const) {
    const f = await fixture();
    f.state.pin = pin;
    const ordinary = await verifyProject(f.ctx);
    assert.equal(ordinary.exitCode, 0);
    await assert.rejects(f.verify(), /context/);
    assert.equal(f.reports().length, 0);
  }
});

test('actual explicit empty pin schemas remain distinguishable from missing-schema fallback sentinels', async () => {
  const f = await fixture({ emptySchemas: true });
  const report = await f.verify();
  assert.equal(report.exitCode, 0);
  assert.equal(await reportVerification(f.root, f.cfg, report), 1);
  assert.equal(f.reports()[0]!.body.status, 'pass');
});

test('a compatible live optional-input upgrade stays compatible without moving or guessing the selected pin', async () => {
  for (const unpinned of [false, true]) {
    const f = await fixture({ unpinned });
    f.state.compatible = true;
    const report = await f.verify();
    assert.equal(report.exitCode, 0);
    assert.equal(await reportVerification(f.root, f.cfg, report), 1);
    assert.equal(f.reports()[0]!.body.status, 'pass');
    if (unpinned) assert.equal(f.seen.some(r => r.path.includes('/versions/')), false);
    else assert.ok(f.seen.filter(r => r.path.includes('/versions/')).every(r => r.path.includes('/versions/1.0.7/')));
  }
});

test('fabricated, cloned or altered caller reports and weakened exit codes do not acquire measured-report authority', async () => {
  const f = await fixture();
  const report = await f.verify();
  await assert.rejects(reportVerification(f.root, f.cfg, structuredClone(report)), /context/);
  report.problems.push({ kind: 'missing', alias: 'answer', catalogRef: 'workflow:wf_a', detail: 'report-source-canary', fix: 'repair' });
  await assert.rejects(reportVerification(f.root, f.cfg, report), /context/);
  const broken = await fixture();
  broken.state.pin = 'missing';
  const failed = await broken.verify();
  await assert.rejects(reportVerification(broken.root, broken.cfg, failed, 0), /context/);
  assert.equal(f.reports().length, 0);
  assert.equal(broken.reports().length, 0);
});

test('temporary caller-report mutation during awaited capture cannot confirm a missing pin as pass', async () => {
  const f = await fixture();
  const report = await f.verify();
  const original = structuredClone(report);
  f.state.pin = 'missing';
  f.onRepoRead(() => {
    report.exitCode = 1;
    report.problems.push({ kind: 'vanished', alias: 'answer', catalogRef: 'workflow:wf_a', detail: 'temporary caller mutation', fix: 'restore pin' });
  });
  f.onPinResponse(() => Object.assign(report, structuredClone(original)));
  await assert.rejects(reportVerification(f.root, f.cfg, report, 0), /context/);
  assert.equal(f.reports().length, 0);
});

test('caller mutation after the first asynchronous report check is refused before any POST', async () => {
  const f = await fixture();
  const report = await f.verify();
  f.onRepoRead(() => { report.remoteChecked = false; });
  await assert.rejects(reportVerification(f.root, f.cfg, report), /context/);
  assert.equal(f.reports().length, 0);
});

test('actual client transport and supplied configuration must share one identity before verification', async () => {
  for (const change of ['target', 'workspace', 'credential-kind', 'configuration-credential'] as const) {
    const f = await fixture();
    if (change === 'configuration-credential') f.ctx.config = { ...f.config, credential: 'pat_foreign_fixture_credential' };
    else f.ctx.client = new SwfteClient({ ...f.config,
      ...(change === 'target' ? { baseUrl: 'http://127.0.0.1:8977' } : {}),
      ...(change === 'workspace' ? { workspaceId: 'foreign-workspace' } : {}),
      ...(change === 'credential-kind' ? { credentialKind: 'api-key' as const } : {}) });
    const before = f.seen.length;
    await assert.rejects(f.verify(), /context/);
    assert.equal(f.seen.length, before, change);
    assert.equal(f.reports().length, 0, change);
  }
});

test('changing the original client configuration during verification or reporting cannot redirect owned transport', async () => {
  const during = await fixture();
  during.onVerify(() => { during.config.baseUrl = 'http://127.0.0.1:8977'; });
  await assert.rejects(during.verify(), /context/);
  assert.equal(during.reports().length, 0);
  const after = await fixture();
  const report = await after.verify();
  after.onRepoRead(() => { after.config.workspaceId = 'foreign-workspace'; });
  await assert.rejects(reportVerification(after.root, after.cfg, report), /context/);
  assert.equal(after.reports().length, 0);
});

test('a changed reporting credential cannot reuse a measured report under another identity', async () => {
  const f = await fixture();
  const report = await f.verify();
  await assert.rejects(reportVerification(f.root, { ...f.cfg, credential: 'pat_other_fixture_credential' }, report), /context/);
  assert.equal(f.reports().length, 0);
});

test('dot segments and encoded or non-version locks never resolve a confirmed pin to the live schema', async () => {
  for (const version of ['.', '..', '%2e%2e', '1%252e0%252e7', ' 1.0.7', '1.0.7\n']) {
    const f = await fixture({ pinnedVersion: version });
    await assert.rejects(f.verify(), /context/);
    assert.equal(f.reports().length, 0, version);
    assert.equal(f.seen.some(row => row.path === '/v2/workflows/wf_a/schema'), false, version);
  }
});

test('supported numeric and exact semantic suffix pins stay on their exact version routes', async () => {
  for (const version of ['5', '1.0.7-beta.1+build.7', 'v3', 'custom@v3:release']) {
    const f = await fixture({ pinnedVersion: version });
    const report = await f.verify();
    assert.equal(report.exitCode, 0, version);
    assert.equal(await reportVerification(f.root, f.cfg, report), 1, version);
    assert.ok(f.seen.some(row => row.path === '/v2/workflows/wf_a/versions/' + encodeURIComponent(version) + '/schema'));
    assert.equal(f.seen.some(row => row.path === '/v2/workflows/wf_a/schema'), false, version);
  }
});

test('preexisting dirty and hidden changed generated/source bytes cannot be attributed to a clean commit', async () => {
  for (const change of ['dirty-source', 'hidden-source', 'hidden-client']) {
    const f = await fixture();
    const path = change === 'hidden-client' ? 'src/swfte/answer.ts' : 'src/main.ts';
    if (change !== 'dirty-source') git(f.root, ['update-index', '--assume-unchanged', path]);
    fs.appendFileSync(join(f.root, path), '\n// changed-before-verify\n');
    await assert.rejects(f.verify(), /context/);
    assert.equal(f.reports().length, 0, change);
  }
});

test('actual before/after verification rejects changes to HEAD, source, lock and generated bytes during the real upgrade request', async () => {
  for (const change of ['head', 'branch', 'source', 'lock', 'client']) {
    const f = await fixture();
    f.onVerify(() => {
      if (change === 'head') git(f.root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '--quiet', '-m', 'changed-head']);
      else if (change === 'branch') git(f.root, ['branch', '-m', 'different-default']);
      else {
        const path = change === 'lock' ? 'swfte.json' : change === 'client' ? 'src/swfte/answer.ts' : 'src/main.ts';
        git(f.root, ['update-index', '--assume-unchanged', path]);
        fs.appendFileSync(join(f.root, path), change === 'lock' ? '\n ' : '\n// changed-during-verify\n');
      }
    });
    await assert.rejects(f.verify(), /context/);
    assert.equal(f.reports().length, 0, change);
  }
});

test('HEAD/source/key/consent/pin changes after actual verification refuse before CI POST', async () => {
  for (const change of ['head', 'branch', 'source', 'key', 'key-id', 'revoked', 'privacy', 'attribution', 'pin']) {
    const f = await fixture();
    const report = await f.verify();
    if (change === 'head') git(f.root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '--quiet', '-m', 'changed-after']);
    if (change === 'branch') git(f.root, ['branch', '-m', 'different-default']);
    if (change === 'source') fs.appendFileSync(join(f.root, 'src/main.ts'), '\n// changed-after\n');
    if (change === 'key') f.state.key = Buffer.alloc(32, 9);
    if (change === 'key-id') f.state.keyId = 'wk_foreign';
    if (change === 'revoked') f.state.optedIn = false;
    if (change === 'privacy') f.state.pathHashing = true;
    if (change === 'attribution') f.state.attribution = true;
    if (change === 'pin') f.state.pin = 'missing';
    await assert.rejects(reportVerification(f.root, f.cfg, report), /context/);
    assert.equal(f.reports().length, 0, change);
  }
});

test('missing/stale/truncated bound scans, unsupported lock schema and traversal/symlink artifacts fail closed', async () => {
  for (const change of ['missing-scan', 'truncated', 'lock-version', 'traversal', 'symlink']) {
    const f = await fixture();
    if (change === 'missing-scan') fs.unlinkSync(join(f.root, '.swfte/codemap/manifest.json'));
    if (change === 'truncated') {
      const path = join(f.root, '.swfte/codemap/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
      manifest.truncated = true;
      const old = JSON.parse(fs.readFileSync(join(f.root, CACHE_BINDING), 'utf8'));
      const binding = bindManifest(f.cfg, await fetchWorkspaceKey(f.cfg), (await repositoryOptIns(f.cfg))[0]!,
        manifest, old.sourceDigest, old.policyDigest);
      fs.writeFileSync(path, JSON.stringify(manifest));
      fs.writeFileSync(join(f.root, CACHE_BINDING), stableJson(binding));
    }
    if (change === 'lock-version' || change === 'traversal') {
      const path = join(f.root, 'swfte.json');
      git(f.root, ['update-index', '--assume-unchanged', 'swfte.json']);
      const lock = JSON.parse(fs.readFileSync(path, 'utf8'));
      if (change === 'lock-version') lock.version = 999;
      else lock.artifacts[0].files = ['../../outside-canary'];
      fs.writeFileSync(path, JSON.stringify(lock));
    }
    if (change === 'symlink') {
      const outside = project({ 'canary.ts': 'outside-unchanged\n' });
      roots.push(outside);
      fs.unlinkSync(join(f.root, 'src/swfte/answer.ts'));
      fs.symlinkSync(join(outside, 'canary.ts'), join(f.root, 'src/swfte/answer.ts'));
      await assert.rejects(f.verify(), /context|symlink/);
      assert.equal(fs.readFileSync(join(outside, 'canary.ts'), 'utf8'), 'outside-unchanged\n');
    } else await assert.rejects(f.verify(), /context|ALLOWLIST|schema version|outside/i);
    assert.equal(f.reports().length, 0, change);
  }
});

test('the actual CLI splice preserves pass/fail exits and rejects dirty/unsupported/offline reporting without a POST', async () => {
  for (const mode of ['pass', 'broken-pin', 'dirty', 'unsupported', 'offline']) {
    const f = await fixture();
    if (mode === 'broken-pin') f.state.pin = 'missing';
    if (mode === 'unsupported') f.state.pin = 'unsupported';
    if (mode === 'dirty') fs.appendFileSync(join(f.root, 'src/main.ts'), '\n// dirty-cli\n');
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['verify', '--report', ...(mode === 'offline' ? ['--offline'] : [])],
      { cwd: f.root, env: f.env, out: value => out.push(value), err: value => err.push(value) });
    assert.equal(code, mode === 'pass' ? 0 : mode === 'offline' ? 2 : 1, mode);
    assert.equal(f.reports().length, mode === 'pass' || mode === 'broken-pin' ? 1 : 0, mode);
    if (mode === 'pass') assert.match(out.join('\n'), /SWFTE_VERIFY_REPORTED 1/);
    if (mode === 'broken-pin') assert.equal(f.reports()[0]!.body.status, 'fail');
    if (mode !== 'pass') assert.equal(out.join('\n').includes('SWFTE_VERIFY_OK'), false);
  }
});
