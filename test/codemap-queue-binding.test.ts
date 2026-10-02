import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { enqueue, drainQueue, listQueue, QUEUE_DIR, uploadOrQueue } from '../src/codemap/queue.js';
import { bindManifest, bindingTarget, digest, queueBindingPath, stableJson } from '../src/codemap/binding.js';
import { fetchWorkspaceKey, repositoryOptIns, type UploadConfig } from '../src/codemap/upload.js';
import type { Manifest } from '../src/codemap/types.js';

const REPO = 'r_' + 'a'.repeat(32);
const SHA = 'b'.repeat(40);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root(): string {
  const value = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'codemap-binding-')));
  roots.push(value);
  return value;
}
function manifest(scannedAt = '2026-10-01T12:00:00Z'): Manifest {
  return { schema: 'swfte.codemap/1', repo: { id: REPO, provider: 'none', defaultBranch: 'main' },
    commitSha: SHA, ref: { kind: 'default' }, scannedAt, scanner: 'cli', pathHashing: false,
    truncated: false, notAnalysed: {}, envVarNames: [], callSites: [] };
}
async function fixture() {
  const directory = root();
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  const state = { keyId: 'wk_fixture_a', key: Buffer.alloc(32, 7), optedIn: true,
    pathHashing: false, attribution: false, offline: false, duplicate: false };
  let onPost: (() => void) | undefined;
  const cfg: UploadConfig = { baseUrl: 'http://127.0.0.1:8976', credential: 'credential-canary-guard', credentialKind: 'pat', env: {},
    fetch: (async (url, init) => {
      if (state.offline) throw new TypeError('blocked');
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString()) : null;
      seen.push({ method, path, body });
      assert.equal(init?.redirect, 'manual');
      if (path.endsWith('/key')) return Response.json({ keyId: state.keyId, key: state.key.toString('base64') });
      if (path.endsWith('/repos')) return Response.json({ repos: state.optedIn
        ? [{ repoId: REPO, pathHashing: state.pathHashing, attribution: state.attribution }] : [] });
      assert.equal(path, '/v2/codemap/repos/' + REPO + '/manifests');
      onPost?.();
      return Response.json({ status: state.duplicate ? 'duplicate' : 'stored', commitSha: SHA, callSites: 0 });
    }) as typeof fetch };
  const workspace = await fetchWorkspaceKey(cfg);
  const consent = (await repositoryOptIns(cfg))[0]!;
  function bound(m: Manifest) {
    return bindManifest(cfg, workspace, consent, m, digest('observed-fixture-source'), digest('fixture-policy'));
  }
  function queue(m = manifest()) {
    const binding = bound(m);
    enqueue(directory, m, binding, { cfg, workspace, consent });
    return binding;
  }
  const posts = () => seen.filter(s => s.method === 'POST');
  return { directory, seen, state, cfg, workspace, consent, bound, queue, posts, onPost: (fn: () => void) => { onPost = fn; } };
}

test('a fetched key and consent bind metadata-only queue files; only a stored receipt removes the matching pair', async () => {
  for (const duplicate of [false, true]) {
    const f = await fixture();
    const binding = f.queue();
    const body = fs.readFileSync(join(f.directory, QUEUE_DIR, SHA + '.json'), 'utf8');
    assert.equal(JSON.parse(body).mac, undefined);
    const sidecar = fs.readFileSync(join(f.directory, queueBindingPath(SHA)), 'utf8');
    assert.equal(sidecar.includes(f.state.key.toString('base64')), false);
    assert.equal(sidecar.includes(f.cfg.credential), false);
    assert.equal(sidecar.includes('observed-fixture-source'), false);
    assert.deepEqual(fs.readdirSync(join(f.directory, QUEUE_DIR)), [SHA + '.json']);
    assert.equal(binding.target, bindingTarget(f.cfg));
    f.state.duplicate = duplicate;
    const result = await drainQueue(f.directory, f.cfg);
    assert.equal(f.posts().length, 1);
    assert.equal(result.uploaded.length, duplicate ? 0 : 1);
    assert.deepEqual(result.remaining, duplicate ? [SHA] : []);
    assert.equal(fs.existsSync(join(f.directory, queueBindingPath(SHA))), duplicate);
    if (duplicate) {
      assert.equal(result.failed[0]!.code, 'UNCONFIRMED_MANIFEST_DUPLICATE');
      assert.equal(fs.readFileSync(join(f.directory, QUEUE_DIR, SHA + '.json'), 'utf8'), body);
      assert.equal(fs.readFileSync(join(f.directory, queueBindingPath(SHA)), 'utf8'), sidecar);
    } else {
      await drainQueue(f.directory, f.cfg);
      assert.equal(f.posts().length, 1);
    }
  }
});

test('legacy or incomplete queue pairs stay local and cannot be relabeled by current credentials', async () => {
  for (const missing of ['legacy', 'sidecar']) {
    const f = await fixture();
    if (missing === 'legacy') enqueue(f.directory, manifest());
    else { f.queue(); fs.unlinkSync(join(f.directory, queueBindingPath(SHA))); }
    const before = fs.readFileSync(join(f.directory, QUEUE_DIR, SHA + '.json'));
    const result = await drainQueue(f.directory, f.cfg);
    assert.equal(f.posts().length, 0);
    assert.deepEqual(result.remaining, [SHA]);
    assert.equal(result.failed[0]!.code, 'MISSING_LOCAL_BINDING');
    assert.deepEqual(fs.readFileSync(join(f.directory, QUEUE_DIR, SHA + '.json')), before);
    assert.throws(() => f.queue(), /context/);
  }
});

test('fresh workspace/key/target/privacy/attribution and revocation controls prevent all mismatched uploads', async () => {
  for (const change of ['tenant-key', 'key-id', 'target', 'path-privacy', 'attribution', 'revoked']) {
    const f = await fixture();
    f.queue();
    if (change === 'tenant-key') f.state.key = Buffer.alloc(32, 9);
    if (change === 'key-id') f.state.keyId = 'wk_rotated';
    if (change === 'target') f.cfg.baseUrl = 'http://127.0.0.1:8977';
    if (change === 'path-privacy') f.state.pathHashing = true;
    if (change === 'attribution') f.state.attribution = true;
    if (change === 'revoked') f.state.optedIn = false;
    const result = await drainQueue(f.directory, f.cfg);
    assert.equal(f.posts().length, 0, change);
    assert.deepEqual(result.remaining, [SHA], change);
    assert.equal(result.failed.length, 1, change);
    assert.equal(fs.existsSync(join(f.directory, queueBindingPath(SHA))), true, change);
  }
});

test('altered manifest/ref/source/mac/scanner and unknown sidecar versions/fields refuse without exposing planted values', async () => {
  for (const change of ['manifest', 'ref', 'source', 'mac', 'scanner', 'version', 'unknown']) {
    const f = await fixture();
    f.queue();
    const path = join(f.directory, change === 'manifest' || change === 'ref'
      ? QUEUE_DIR + '/' + SHA + '.json' : queueBindingPath(SHA));
    const row = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (change === 'manifest') row.scannedAt = '2026-10-01T13:00:00Z';
    if (change === 'ref') row.ref = { kind: 'pr', pr: 2 };
    if (change === 'source') row.sourceDigest = 'c'.repeat(64);
    if (change === 'mac') row.mac = 'd'.repeat(64);
    if (change === 'scanner') row.scannerVersion = '0.2.999';
    if (change === 'version') row.version = 2;
    if (change === 'unknown') row.sourceValue = 'canary_private_source_value';
    fs.writeFileSync(path, JSON.stringify(row));
    const result = await drainQueue(f.directory, f.cfg);
    assert.equal(f.posts().length, 0, change);
    assert.deepEqual(result.remaining, [SHA], change);
    assert.equal(JSON.stringify(result).includes('canary_private_source_value'), false);
  }
});

test('a valid MAC from an earlier semantic scanner policy is refused even with the same package version and source', async () => {
  const f = await fixture();
  f.queue();
  const path = join(f.directory, queueBindingPath(SHA));
  const value = JSON.parse(fs.readFileSync(path, 'utf8'));
  value.scannerVersion = '0.2.0+old-policy';
  const { mac: _old, ...payload } = value;
  value.mac = createHmac('sha256', f.workspace.key).update('swfte.codemap/local-binding/1\n').update(stableJson(payload)).digest('hex');
  fs.writeFileSync(path, stableJson(value));
  assert.equal((await drainQueue(f.directory, f.cfg)).uploaded.length, 0);
  assert.equal(f.posts().length, 0);
  assert.equal(fs.existsSync(path), true);
});

test('same-commit foreign ref/key or unconfirmed offline replacement cannot overwrite a queued binding', async () => {
  const f = await fixture();
  const old = f.queue();
  const original = fs.readFileSync(join(f.directory, queueBindingPath(SHA)));
  const pr = { ...manifest(), ref: { kind: 'pr' as const, pr: 7 } };
  assert.throws(() => enqueue(f.directory, pr, f.bound(pr), { cfg: f.cfg, workspace: f.workspace, consent: f.consent }), /context/);
  const next = manifest('2026-10-01T13:00:00Z');
  assert.throws(() => enqueue(f.directory, next, f.bound(next)), /context/);
  assert.throws(() => enqueue(f.directory, manifest()), /context/);
  assert.deepEqual(fs.readFileSync(join(f.directory, queueBindingPath(SHA))), original);
  assert.deepEqual(listQueue(f.directory).filter(e => 'manifest' in e).map(e => 'manifest' in e ? e.binding?.mac : null), [old.mac]);
});

test('a newer enqueue during an in-flight receipt stays queued and is only removed on its own matching acknowledgement', async () => {
  const f = await fixture();
  f.queue();
  const next = manifest('2026-10-01T13:00:00Z');
  f.onPost(() => { enqueue(f.directory, next, f.bound(next), { cfg: f.cfg, workspace: f.workspace, consent: f.consent }); });
  const first = await drainQueue(f.directory, f.cfg);
  assert.equal(first.uploaded.length, 1);
  assert.deepEqual(first.remaining, [SHA]);
  assert.equal(JSON.parse(fs.readFileSync(join(f.directory, QUEUE_DIR, SHA + '.json'), 'utf8')).scannedAt, next.scannedAt);
  f.onPost(() => {});
  f.state.duplicate = true;
  const duplicate = await drainQueue(f.directory, f.cfg);
  assert.deepEqual(duplicate.remaining, [SHA]);
  assert.deepEqual(duplicate.uploaded, []);
  assert.equal(duplicate.failed[0]!.code, 'UNCONFIRMED_MANIFEST_DUPLICATE');
  assert.equal(JSON.parse(fs.readFileSync(join(f.directory, QUEUE_DIR, SHA + '.json'), 'utf8')).scannedAt, next.scannedAt);
  assert.equal(f.posts().length, 2);
});

test('real legacy same-commit duplicate semantics cannot acknowledge an incoming changed body or remove its pair', async () => {
  const f = await fixture();
  const stored = manifest();
  const incoming = manifest('2026-10-01T13:00:00Z');
  f.queue(incoming);
  const manifestBefore = fs.readFileSync(join(f.directory, QUEUE_DIR, SHA + '.json'));
  const bindingBefore = fs.readFileSync(join(f.directory, queueBindingPath(SHA)));
  f.state.duplicate = true;
  let acknowledged = 0;
  const result = await drainQueue(f.directory, f.cfg, { onAcknowledged: () => { acknowledged++; } });
  // The actual IngestService branch ignores incoming bytes after tuple duplication and
  // returns the incoming count. Equal counts therefore do not establish equal bodies.
  assert.equal(f.posts()[0]!.body && (f.posts()[0]!.body as Manifest).scannedAt, incoming.scannedAt);
  assert.notEqual(incoming.scannedAt, stored.scannedAt);
  assert.equal(incoming.callSites.length, stored.callSites.length);
  assert.equal(acknowledged, 0);
  assert.deepEqual(result.uploaded, []);
  assert.deepEqual(result.remaining, [SHA]);
  assert.deepEqual(fs.readFileSync(join(f.directory, QUEUE_DIR, SHA + '.json')), manifestBefore);
  assert.deepEqual(fs.readFileSync(join(f.directory, queueBindingPath(SHA))), bindingBefore);
});

test('offline refresh queues the originally bound pair and reconnect uploads once without reporting an offline success', async () => {
  const f = await fixture();
  const m = manifest();
  f.state.offline = true;
  const offline = await uploadOrQueue(f.directory, f.cfg, REPO, m, { binding: f.bound(m), workspace: f.workspace, consent: f.consent });
  assert.equal(offline.status, 'queued-offline');
  assert.equal(f.posts().length, 0);
  assert.equal((await drainQueue(f.directory, f.cfg)).offline, true);
  f.state.offline = false;
  assert.equal((await drainQueue(f.directory, f.cfg)).uploaded.length, 1);
  assert.deepEqual((await drainQueue(f.directory, f.cfg)).remaining, []);
  assert.equal(f.posts().length, 1);
});

test('sidecar and lock symlinks or traversal cannot write or upload outside the repository', async () => {
  for (const part of ['queue-bindings', 'queue-locks']) {
    const f = await fixture();
    const outside = root();
    const canary = join(outside, 'canary.txt');
    fs.writeFileSync(canary, 'unchanged');
    fs.mkdirSync(join(f.directory, '.swfte/codemap'), { recursive: true });
    fs.symlinkSync(outside, join(f.directory, '.swfte/codemap', part));
    assert.throws(() => f.queue(), /symlink|context/i);
    assert.deepEqual(fs.readdirSync(outside), ['canary.txt']);
    assert.equal(fs.readFileSync(canary, 'utf8'), 'unchanged');
    assert.equal(f.posts().length, 0);
  }
  assert.throws(() => queueBindingPath('../../outside'), /context/);
});

test('credential-bearing target components are rejected before any queue data is written', async () => {
  const f = await fixture();
  for (const target of ['https://user:password@api.swfte.com', 'https://api.swfte.com/?key=private', 'https://api.swfte.com/#private']) {
    f.cfg.baseUrl = target;
    assert.throws(() => f.bound(manifest()), /credential|context/);
  }
  assert.equal(fs.existsSync(join(f.directory, '.swfte')), false);
  assert.equal(f.posts().length, 0);
});

test('a local pair mutation lock blocks enqueue and drain instead of removing another writer lock', async () => {
  const f = await fixture();
  f.queue();
  const path = join(f.directory, '.swfte/codemap/queue-locks', SHA + '.lock');
  fs.writeFileSync(path, '');
  assert.throws(() => f.queue(), /context/);
  assert.equal((await drainQueue(f.directory, f.cfg)).uploaded.length, 0);
  assert.equal(fs.existsSync(path), true);
  assert.equal(f.posts().length, 0);
});
