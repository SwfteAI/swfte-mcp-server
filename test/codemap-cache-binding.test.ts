import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { project } from './codemap-support.js';
import { currentBoundScan, repositoryIdentity, scanRepository, type ScanOptions } from '../src/codemap/scan.js';
import { drainQueue, QUEUE_DIR } from '../src/codemap/queue.js';
import { CACHE_BINDING, QUEUE_BINDINGS, stableJson } from '../src/codemap/binding.js';
import { PACKAGE_VERSION } from '../src/version.js';
import { DEFAULT_ENV_FILES } from '../src/codemap/walk.js';
import { fetchWorkspaceKey, repositoryOptIns, type UploadConfig } from '../src/codemap/upload.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' } }).trim();
}
async function fixture() {
  const root = project({
    '.gitignore': '.swfte/codemap/\nignored/\n',
    'package.json': '{"name":"cache-binding-fixture"}',
    'swfte.json': '{"version":1,"baseUrl":"http://127.0.0.1:8976","workspaceId":null,"artifacts":[]}',
    'src/main.ts': "import { Swfte } from '@swfte/sdk';\nconst client = new Swfte();\nclient.workflows.invoke('wf_a', { question: 'private-input-canary' });\n",
    'names-fixture': 'SWFTE_INITIAL=private-env-canary\n',
  });
  roots.push(root);
  const repoId = repositoryIdentity(root).repo.id;
  const seen: Array<{ path: string; method: string; body: any }> = [];
  const state = { blocked: false, optedIn: false, attribution: false, pathHashing: true, duplicate: false };
  const cfg: UploadConfig = { baseUrl: 'http://127.0.0.1:8976', credential: 'credential-canary-cache', credentialKind: 'pat', env: {},
    fetch: (async (url, init) => {
      if (state.blocked) throw new TypeError('network blocked');
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString()) : null;
      seen.push({ path, method, body });
      if (path.endsWith('/key')) return Response.json({ keyId: 'wk_cache', key: Buffer.alloc(32, 7).toString('base64') });
      if (path.endsWith('/manifests')) return Response.json({ status: state.duplicate ? 'duplicate' : 'stored', commitSha: body.commitSha, callSites: body.callSites.length });
      if (method === 'POST' && path.endsWith('/repos')) {
        state.optedIn = true; state.pathHashing = body.pathHashing; state.attribution = body.attribution;
        return Response.json({ repoId, pathHashing: state.pathHashing, attribution: state.attribution });
      }
      if (path.endsWith('/repos')) return Response.json({ repos: state.optedIn
        ? [{ repoId, pathHashing: state.pathHashing, attribution: state.attribution }] : [] });
      throw new Error('unexpected route');
    }) as typeof fetch };
  const options: ScanOptions = { hashPaths: true, detect: { envFiles: { secret: DEFAULT_ENV_FILES.secret, names: ['names-fixture'] } } };
  const posts = () => seen.filter(r => r.path.endsWith('/manifests'));
  return { root, cfg, state, seen, options, posts, online: () => scanRepository(root, cfg, { ...options, optIn: true }) };
}
function localFiles(root: string, rel = '.swfte/codemap'): string[] {
  return fs.readdirSync(join(root, rel), { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? localFiles(root, rel + '/' + e.name) : [fs.readFileSync(join(root, rel, e.name), 'utf8')]);
}

test('warm blocked-network reuse writes a bound manifest-only queue, and reconnect sends that current entry only once', async () => {
  const f = await fixture();
  const online = await f.online();
  assert.equal(online.status, 'stored');
  f.state.blocked = true;
  const offline = await scanRepository(f.root, f.cfg, f.options);
  assert.equal(offline.status, 'queued-offline');
  assert.equal(f.posts().length, 1);
  assert.deepEqual(fs.readdirSync(join(f.root, QUEUE_DIR)), [online.manifest.commitSha + '.json']);
  const files = localFiles(f.root);
  assert.equal(files.some(v => v.includes(Buffer.alloc(32, 7).toString('base64'))), false);
  assert.equal(files.some(v => v.includes(f.cfg.credential)), false);
  assert.equal(files.some(v => v.includes('private-input-canary') || v.includes('private-env-canary')), false);
  assert.equal(JSON.stringify(f.seen).includes('private-input-canary'), false);
  assert.equal(JSON.stringify(f.seen).includes('private-env-canary'), false);
  f.state.blocked = false;
  const before = f.posts().length;
  const connected = await scanRepository(f.root, f.cfg, f.options);
  assert.equal(connected.drained, 1);
  assert.equal(f.posts().length - before, 1);
  assert.equal(connected.manifest.scannedAt, offline.manifest.scannedAt);
  assert.deepEqual(fs.readdirSync(join(f.root, QUEUE_DIR)), []);
});

test('cold offline scans refuse instead of inventing the workspace key', async () => {
  const f = await fixture();
  await assert.rejects(scanRepository(f.root, null, { ...f.options, offline: true }), /No matching private scan cache/);
  assert.equal(f.posts().length, 0);
  assert.equal(fs.existsSync(join(f.root, QUEUE_DIR)), false);
});

test('an unconfirmed direct duplicate stays queued and cannot leave a report-authorizing current cache binding', async () => {
  const f = await fixture();
  f.state.duplicate = true;
  await assert.rejects(f.online(), /manifest identity|duplicate/i);
  assert.equal(f.posts().length, 1);
  const commit = repositoryIdentity(f.root).commitSha;
  assert.deepEqual(fs.readdirSync(join(f.root, QUEUE_DIR)), [commit + '.json']);
  assert.equal(fs.existsSync(join(f.root, CACHE_BINDING)), false);
  const workspace = await fetchWorkspaceKey(f.cfg);
  const consent = (await repositoryOptIns(f.cfg))[0]!;
  await assert.rejects(currentBoundScan(f.root, f.cfg, workspace, consent), /context/);
  const before = fs.readFileSync(join(f.root, QUEUE_DIR, commit + '.json'));
  const drained = await drainQueue(f.root, f.cfg);
  assert.deepEqual(drained.uploaded, []);
  assert.deepEqual(drained.remaining, [commit]);
  assert.deepEqual(fs.readFileSync(join(f.root, QUEUE_DIR, commit + '.json')), before);
});

test('a queued uncertain direct upload does not become confirmed cache context before a genuine stored acknowledgement', async () => {
  const f = await fixture();
  const originalFetch = f.cfg.fetch!;
  f.cfg.fetch = (async (url, init) => {
    if (new URL(String(url)).pathname.endsWith('/manifests')) throw new TypeError('upload blocked');
    return originalFetch(url, init);
  }) as typeof fetch;
  const queued = await f.online();
  assert.equal(queued.status, 'queued-offline');
  assert.equal(fs.existsSync(join(f.root, CACHE_BINDING)), false);
  f.cfg.fetch = originalFetch;
  const stored = await scanRepository(f.root, f.cfg, f.options);
  assert.equal(stored.status, 'stored');
  assert.equal(stored.drained, 1);
  assert.equal(fs.existsSync(join(f.root, CACHE_BINDING)), true);
});

test('source, nearest lock, package identity, env names, HEAD and remote changes make the warm cache unusable', async () => {
  for (const change of ['source', 'nearest-lock', 'package', 'env-names', 'head', 'branch', 'remote', 'ignored-source', 'assume-unchanged-source']) {
    const f = await fixture();
    await f.online();
    if (change === 'source') fs.appendFileSync(join(f.root, 'src/main.ts'), '\n// changed\n');
    if (change === 'nearest-lock') {
      git(f.root, ['update-index', '--assume-unchanged', 'swfte.json']);
      fs.writeFileSync(join(f.root, 'swfte.json'), JSON.stringify({ version: 1, baseUrl: f.cfg.baseUrl, artifacts: [{
        alias: 'one', catalogRef: 'workflow:wf_other', language: 'typescript', framework: 'node',
        outDir: 'src/generated', files: [], contractHash: 'a'.repeat(64), pinnedVersion: '1.0.7',
      }] }));
    }
    if (change === 'package') {
      git(f.root, ['update-index', '--assume-unchanged', 'package.json']);
      fs.writeFileSync(join(f.root, 'package.json'), '{"name":"other-package"}');
    }
    if (change === 'env-names') {
      git(f.root, ['update-index', '--assume-unchanged', 'names-fixture']);
      fs.writeFileSync(join(f.root, 'names-fixture'), 'SWFTE_DIFFERENT=private-env-canary\n');
    }
    if (change === 'head') git(f.root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '--quiet', '-m', 'new-head']);
    if (change === 'branch') git(f.root, ['branch', '-m', 'different-default']);
    if (change === 'remote') git(f.root, ['remote', 'add', 'origin', 'https://github.com/other/repository.git']);
    if (change === 'ignored-source') {
      fs.mkdirSync(join(f.root, 'ignored'));
      fs.writeFileSync(join(f.root, 'ignored/addition.ts'), "client.workflows.invoke('wf_other', {});\n");
    }
    if (change === 'assume-unchanged-source') {
      git(f.root, ['update-index', '--assume-unchanged', 'src/main.ts']);
      fs.appendFileSync(join(f.root, 'src/main.ts'), '\n// hidden dirty source\n');
      assert.equal(repositoryIdentity(f.root).dirty, false);
    }
    await assert.rejects(scanRepository(f.root, null, { ...f.options, offline: true }), /cache|Cached|changed/i, change);
    assert.equal(f.posts().length, 1, change);
    assert.equal(fs.existsSync(join(f.root, QUEUE_DIR)), false, change);
  }
});

test('privacy, attribution, ref, target, detector policy and scanner-origin changes cannot reuse a warm cache', async () => {
  for (const change of ['privacy', 'attribution', 'ref', 'target', 'cap', 'origin', 'preprocess', 'detectors']) {
    const f = await fixture();
    await f.online();
    const opts: ScanOptions = { ...f.options, offline: true };
    if (change === 'privacy') opts.hashPaths = false;
    if (change === 'attribution') opts.attribution = true;
    if (change === 'ref') opts.pr = 7;
    if (change === 'target') f.cfg.baseUrl = 'http://127.0.0.1:8977';
    if (change === 'cap') opts.detect = { ...opts.detect, maxFiles: 1 };
    if (change === 'origin') opts.scanner = 'ci';
    if (change === 'preprocess') opts.detect = { ...opts.detect, preprocess: file => file };
    if (change === 'detectors') opts.detect = { ...opts.detect, detectors: [] };
    await assert.rejects(scanRepository(f.root, f.cfg, opts), /cache|Cached|settings|changed/i, change);
    assert.equal(f.posts().length, 1, change);
    assert.equal(fs.existsSync(join(f.root, QUEUE_DIR)), false, change);
  }
});

test('legacy, corrupt, unknown-version and valid-MAC stale semantic-scanner cache metadata refuse', async () => {
  for (const change of ['missing', 'invalid-json', 'invalid-manifest-json', 'version', 'semantic-revision']) {
    const f = await fixture();
    await f.online();
    const path = join(f.root, CACHE_BINDING);
    if (change === 'missing') fs.unlinkSync(path);
    if (change === 'invalid-json') fs.writeFileSync(path, '{broken');
    if (change === 'invalid-manifest-json') fs.writeFileSync(join(f.root, '.swfte/codemap/manifest.json'), '{private-cache-canary');
    if (change === 'version' || change === 'semantic-revision') {
      const value = JSON.parse(fs.readFileSync(path, 'utf8'));
      if (change === 'version') value.version = 2;
      else {
        value.scannerVersion = '0.2.0+old-policy';
        const { mac: _old, ...payload } = value;
        value.mac = createHmac('sha256', Buffer.alloc(32, 7)).update('swfte.codemap/local-binding/1\n').update(stableJson(payload)).digest('hex');
      }
      fs.writeFileSync(path, JSON.stringify(value));
    }
    await assert.rejects(scanRepository(f.root, null, { ...f.options, offline: true }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /context|cache|Cached/i);
      assert.equal(error.message.includes('private-cache-canary'), false);
      return true;
    }, change);
    assert.equal(f.posts().length, 1, change);
    assert.equal(fs.existsSync(join(f.root, QUEUE_DIR)), false, change);
  }
});

test('the actual previous opaque-pin policy cannot authorize a warm cache or queued upload even with its valid workspace MAC', async () => {
  const f = await fixture();
  const stored = await f.online();
  assert.equal(stored.status, 'stored');
  f.state.blocked = true;
  const queued = await scanRepository(f.root, f.cfg, f.options);
  assert.equal(queued.status, 'queued-offline');
  for (const path of [join(f.root, CACHE_BINDING), join(f.root, QUEUE_BINDINGS, stored.manifest.commitSha + '.json')]) {
    const value = JSON.parse(fs.readFileSync(path, 'utf8'));
    value.scannerVersion = PACKAGE_VERSION + '+codemap-20261002-exact-pins-stored-ack-3';
    const { mac: _old, ...payload } = value;
    value.mac = createHmac('sha256', Buffer.alloc(32, 7))
      .update('swfte.codemap/local-binding/1\n').update(stableJson(payload)).digest('hex');
    fs.writeFileSync(path, JSON.stringify(value));
  }
  await assert.rejects(scanRepository(f.root, null, { ...f.options, offline: true }), /cache|Cached|context/i);
  f.state.blocked = false;
  const workspace = await fetchWorkspaceKey(f.cfg);
  const consent = (await repositoryOptIns(f.cfg))[0]!;
  await assert.rejects(currentBoundScan(f.root, f.cfg, workspace, consent), /context/i);
  const before = f.posts().length;
  const drained = await drainQueue(f.root, f.cfg);
  assert.deepEqual(drained.uploaded, []);
  assert.deepEqual(drained.remaining, [stored.manifest.commitSha]);
  assert.equal(f.posts().length, before);
  assert.equal(fs.existsSync(join(f.root, QUEUE_DIR, stored.manifest.commitSha + '.json')), true);
});

test('offline MACs are not permission truth: an altered candidate remains unuploadable when the actual server key returns', async () => {
  const f = await fixture();
  await f.online();
  const path = join(f.root, CACHE_BINDING);
  const value = JSON.parse(fs.readFileSync(path, 'utf8'));
  value.mac = '0'.repeat(64);
  fs.writeFileSync(path, JSON.stringify(value));
  assert.equal((await scanRepository(f.root, null, { ...f.options, offline: true })).status, 'queued-offline');
  assert.equal((await drainQueue(f.root, f.cfg)).uploaded.length, 0);
  assert.equal(f.posts().length, 1);
});

test('symlinked cache metadata refuses without reading or modifying an outside canary', async () => {
  const f = await fixture();
  await f.online();
  const outside = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'codemap-cache-outside-')));
  roots.push(outside);
  const canary = join(outside, 'canary.txt');
  fs.writeFileSync(canary, 'outside-unchanged');
  fs.unlinkSync(join(f.root, CACHE_BINDING));
  fs.symlinkSync(canary, join(f.root, CACHE_BINDING));
  await assert.rejects(scanRepository(f.root, null, { ...f.options, offline: true }), /symlink/i);
  assert.equal(fs.readFileSync(canary, 'utf8'), 'outside-unchanged');
  assert.equal(f.posts().length, 1);
});

test('dirty or ignored uncommitted source is never represented as a complete clean-commit manifest', async () => {
  for (const ignored of [false, true]) {
    const f = await fixture();
    if (ignored) {
      fs.mkdirSync(join(f.root, 'ignored'));
      fs.writeFileSync(join(f.root, 'ignored/addition.ts'), "client.workflows.invoke('wf_a', {});\n");
    } else fs.appendFileSync(join(f.root, 'src/main.ts'), '\n// uncommitted source\n');
    assert.equal((await f.online()).manifest.truncated, true);
    await assert.rejects(scanRepository(f.root, null, { ...f.options, offline: true }), /cache|changed/i);
  }
});
