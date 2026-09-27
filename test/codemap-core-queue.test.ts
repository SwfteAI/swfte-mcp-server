/**
 * The offline queue (docs/codemap/CONTRACT.md §7): `.swfte/codemap/queue/<commitSha>.json`, manifest
 * JSON only, idempotent by commitSha, drained with one upload per entry.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PathConfinementError } from '../src/fsguard.js';
import { serializeManifest } from '../src/codemap/manifest.js';
import { dequeue, drainQueue, enqueue, listQueue, QUEUE_DIR, uploadOrQueue } from '../src/codemap/queue.js';
import { CodemapApiError, type UploadConfig, type uploadManifest } from '../src/codemap/upload.js';
import type { Manifest } from '../src/codemap/types.js';

const REPO = 'r_0123456789abcdef0123456789abcdef';
const sha = (c: string) => c.repeat(40);

function manifest(commitSha: string, scannedAt = '2026-09-27T12:00:00Z'): Manifest {
  return {
    schema: 'swfte.codemap/1',
    repo: { id: REPO, provider: 'github', defaultBranch: 'main' },
    commitSha,
    ref: { kind: 'default' },
    scannedAt,
    scanner: 'cli',
    pathHashing: false,
    truncated: false,
    notAnalysed: {},
    envVarNames: [],
    callSites: [],
  };
}

const cfg = (fetchFn: typeof fetch): UploadConfig => ({ baseUrl: 'https://api.swfte.com/agents', credential: 'pat_test_credential', credentialKind: 'pat', env: {}, fetch: fetchFn });

/** An upload stub: answers per commit from `answers`, counting calls. */
function stubUpload(answers: Record<string, 'stored' | 'duplicate' | 'offline' | 'refused'>) {
  const calls: string[] = [];
  const fn = (async (_cfg: UploadConfig, _repoId: string, m: Manifest) => {
    calls.push(m.commitSha);
    const a = answers[m.commitSha] ?? 'stored';
    if (a === 'refused') throw new CodemapApiError(400, 'ALLOWLIST_VIOLATION', 'refused', '/callSites');
    if (a === 'offline') return { status: 'offline', commitSha: m.commitSha, reason: 'unreachable' };
    return { status: a, commitSha: m.commitSha, callSites: 0 };
  }) as typeof uploadManifest;
  return { calls, fn };
}

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cmap-queue-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const queued = () => (fs.existsSync(join(root, QUEUE_DIR)) ? fs.readdirSync(join(root, QUEUE_DIR)).sort() : []);

describe('enqueue and list', () => {
  test('writes .swfte/codemap/queue/<commitSha>.json holding exactly the serialized manifest', () => {
    const rel = enqueue(root, manifest(sha('a')));
    assert.equal(rel, `${QUEUE_DIR}/${sha('a')}.json`);
    assert.equal(fs.readFileSync(join(root, rel), 'utf8'), `${serializeManifest(manifest(sha('a')))}\n`);
  });

  test('idempotent by commitSha: the same commit queued twice is one entry (the latest scan)', () => {
    enqueue(root, manifest(sha('a'), '2026-09-27T12:00:00Z'));
    enqueue(root, manifest(sha('a'), '2026-09-27T13:00:00Z'));
    enqueue(root, manifest(sha('a'), '2026-09-27T13:00:00Z'));
    assert.deepEqual(queued(), [`${sha('a')}.json`]);
    const [e] = listQueue(root);
    assert.ok(e && 'manifest' in e && e.manifest.scannedAt === '2026-09-27T13:00:00Z');
  });

  test('a manifest the allowlist refuses is not queued, and nothing is written', () => {
    const bad = { ...manifest(sha('b')), source: 'const x = 1' } as unknown as Manifest;
    assert.throws(() => enqueue(root, bad), /ALLOWLIST_VIOLATION/);
    assert.deepEqual(queued(), []);
  });

  test('list: oldest scan first; foreign files ignored; a tampered or mismatched entry is reported invalid', () => {
    enqueue(root, manifest(sha('c'), '2026-09-27T15:00:00Z'));
    enqueue(root, manifest(sha('d'), '2026-09-27T11:00:00Z'));
    const dir = join(root, QUEUE_DIR);
    fs.writeFileSync(join(dir, 'notes.txt'), 'ignored');
    fs.writeFileSync(join(dir, `${sha('e')}.json`), JSON.stringify({ ...manifest(sha('e')), snippet: 'secret()' }));
    fs.writeFileSync(join(dir, `${sha('f')}.json`), serializeManifest(manifest(sha('1'))));
    const list = listQueue(root);
    assert.deepEqual(list.map((e) => e.commitSha), [sha('e'), sha('f'), sha('d'), sha('c')]);
    const invalid = Object.fromEntries(list.filter((e) => 'invalid' in e).map((e) => [e.commitSha, (e as { invalid: string }).invalid]));
    assert.deepEqual(invalid, { [sha('e')]: 'ALLOWLIST_VIOLATION at /snippet', [sha('f')]: 'ALLOWLIST_VIOLATION at /commitSha' });
    assert.ok(!JSON.stringify(list).includes('secret()'));
  });

  test('a symlinked queue directory is refused; nothing is written through it', () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cmap-queue-out-')));
    try {
      fs.mkdirSync(join(root, '.swfte'));
      fs.symlinkSync(elsewhere, join(root, '.swfte/codemap'));
      assert.throws(() => enqueue(root, manifest(sha('a'))), PathConfinementError);
      assert.deepEqual(fs.readdirSync(elsewhere), []);
      assert.throws(() => dequeue(root, '../../x'), /40-hex/);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('drain', () => {
  test('stored and duplicate both remove the entry; each entry is uploaded exactly once', async () => {
    enqueue(root, manifest(sha('a'), '2026-09-27T10:00:00Z'));
    enqueue(root, manifest(sha('b'), '2026-09-27T11:00:00Z'));
    const up = stubUpload({ [sha('a')]: 'stored', [sha('b')]: 'duplicate' });
    const r = await drainQueue(root, cfg(fetch), { upload: up.fn });
    assert.deepEqual(up.calls, [sha('a'), sha('b')]);
    assert.deepEqual(r.uploaded.map((u) => [u.commitSha, u.status]), [[sha('a'), 'stored'], [sha('b'), 'duplicate']]);
    assert.deepEqual(r.remaining, []);
    assert.deepEqual(queued(), []);
  });

  test('offline stops the drain and keeps that entry and every later one, untried', async () => {
    enqueue(root, manifest(sha('a'), '2026-09-27T10:00:00Z'));
    enqueue(root, manifest(sha('b'), '2026-09-27T11:00:00Z'));
    enqueue(root, manifest(sha('c'), '2026-09-27T12:00:00Z'));
    const up = stubUpload({ [sha('b')]: 'offline' });
    const r = await drainQueue(root, cfg(fetch), { upload: up.fn });
    assert.deepEqual(up.calls, [sha('a'), sha('b')]);
    assert.equal(r.offline, true);
    assert.deepEqual(r.remaining, [sha('b'), sha('c')]);
    assert.deepEqual(queued(), [`${sha('b')}.json`, `${sha('c')}.json`]);
  });

  test('a refused or invalid entry is kept and reported, never re-sent in the same drain, and the rest continue', async () => {
    enqueue(root, manifest(sha('a'), '2026-09-27T10:00:00Z'));
    enqueue(root, manifest(sha('b'), '2026-09-27T11:00:00Z'));
    fs.writeFileSync(join(root, QUEUE_DIR, `${sha('9')}.json`), '{not json');
    const up = stubUpload({ [sha('a')]: 'refused' });
    const r = await drainQueue(root, cfg(fetch), { upload: up.fn });
    assert.deepEqual(up.calls, [sha('a'), sha('b')], 'the invalid entry is never uploaded');
    assert.deepEqual(r.failed, [{ commitSha: sha('9'), code: 'INVALID_QUEUE_ENTRY' }, { commitSha: sha('a'), code: 'ALLOWLIST_VIOLATION' }]);
    assert.deepEqual(queued(), [`${sha('9')}.json`, `${sha('a')}.json`]);
  });

  test('end to end: offline upload queues the manifest; a later drain with the real upload stores and removes it', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const r1 = await uploadOrQueue(root, cfg(down), REPO, manifest(sha('a')));
    assert.equal(r1.status, 'queued-offline');
    assert.deepEqual(queued(), [`${sha('a')}.json`]);

    let posts = 0;
    const up = (async (_u: string | URL, init?: RequestInit) => {
      posts++;
      assert.equal(Buffer.from(init!.body as Uint8Array).toString('utf8'), serializeManifest(manifest(sha('a'))));
      return new Response(JSON.stringify({ status: 'stored', commitSha: sha('a'), callSites: 0 }), { status: 200 });
    }) as typeof fetch;
    const r2 = await drainQueue(root, cfg(up));
    assert.equal(posts, 1);
    assert.deepEqual(r2.uploaded, [{ commitSha: sha('a'), status: 'stored', callSites: 0 }]);
    assert.deepEqual(queued(), []);
    const r3 = await drainQueue(root, cfg(up));
    assert.equal(posts, 1, 'an empty queue sends nothing');
    assert.deepEqual(r3, { uploaded: [], failed: [], remaining: [], offline: false });
  });
});
