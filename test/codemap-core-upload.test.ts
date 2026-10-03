/**
 * The only network path of the code map (docs/codemap/CONTRACT.md §4, §7).
 *
 * Two structural properties are proven from the source, with the TypeScript compiler API walking the
 * static import graph (type-only and dynamic imports included):
 *   - upload.ts never reaches the compliance transport (src/compliance.ts, src/tools/compliance.ts);
 *   - nothing upload.ts reaches can touch the filesystem, so the workspace key cannot land on disk.
 * The walker is itself checked against a file that does reach compliance.ts (a positive control).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';

import { UntrustedHostError } from '../src/hosts.js';
import { serializeManifest } from '../src/codemap/manifest.js';
import { CodemapApiError, CodemapOfflineError, fetchWorkspaceKey, uploadManifest, type UploadConfig } from '../src/codemap/upload.js';
import type { Manifest } from '../src/codemap/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src');
const REPO = 'r_0123456789abcdef0123456789abcdef';
const SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

/** Every file reachable from `entry` by static imports; bare specifiers are returned as-is. */
function importGraph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const imp of info.importedFiles) {
      const spec = imp.fileName;
      if (!spec.startsWith('.')) {
        bare.add(spec);
        continue;
      }
      const base = resolve(dirname(file), spec);
      const candidates = [base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), base, `${base}.ts`, join(base, 'index.ts')];
      const hit = candidates.find((c) => existsSync(c) && !c.endsWith('/'));
      assert.ok(hit, `unresolved import ${spec} in ${file}`);
      queue.push(hit);
    }
  }
  return { files, bare };
}

function manifest(extra: Record<string, unknown> = {}): Manifest {
  return {
    schema: 'swfte.codemap/1',
    repo: { id: REPO, provider: 'github', defaultBranch: 'main' },
    commitSha: SHA,
    ref: { kind: 'default' },
    scannedAt: '2026-09-27T12:00:00Z',
    scanner: 'cli',
    pathHashing: false,
    truncated: false,
    notAnalysed: {},
    envVarNames: ['SWFTE_WORKFLOW_ID'],
    callSites: [
      {
        id: 'cs_0123456789abcdef01234567',
        path: 'src/a.ts',
        line: 3,
        symbol: 'submit',
        language: 'typescript',
        sdk: 'node',
        op: 'run',
        artifact: { kind: 'workflow', id: 'wf_1', unresolved: false, pinnedVersion: null, alias: null, environment: null },
        contractHash: null,
        inputKeys: [],
        outputKeys: [],
        managed: 'typed-client',
      },
    ],
    ...extra,
  } as Manifest;
}

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, fn };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function cfg(fetchFn: typeof fetch, over: Partial<UploadConfig> = {}): UploadConfig {
  return { baseUrl: 'https://api.swfte.com/agents', credential: 'pat_test_credential', credentialKind: 'pat', env: {}, fetch: fetchFn, ...over };
}

describe('import graph', () => {
  test('upload.ts never reaches src/compliance.ts or src/tools/compliance.ts, directly or transitively', () => {
    const { files } = importGraph(join(SRC, 'codemap/upload.ts'));
    assert.ok(files.has(join(SRC, 'codemap/manifest.ts')) && files.has(join(SRC, 'hosts.ts')), 'the walker follows imports');
    for (const forbidden of [join(SRC, 'compliance.ts'), join(SRC, 'tools/compliance.ts')]) {
      assert.ok(!files.has(forbidden), `upload.ts reaches ${forbidden}: ${[...files].map((f) => f.slice(SRC.length + 1)).join(', ')}`);
    }
  });

  test('positive control: the same walker finds compliance.ts from a file that does import it', () => {
    const { files } = importGraph(join(SRC, 'tools/compliance.ts'));
    assert.ok(files.has(join(SRC, 'compliance.ts')));
  });

  test('nothing upload.ts reaches can touch the filesystem (the workspace key never lands on disk)', () => {
    const { bare } = importGraph(join(SRC, 'codemap/upload.ts'));
    const fsModules = [...bare].filter((b) => /^(node:)?fs(\/promises)?$/.test(b));
    assert.deepEqual(fsModules, []);
  });

  test('upload.ts is the only network path: no other core module fetches or imports a network module', () => {
    for (const f of ['walk.ts', 'detect.ts', 'fingerprint.ts', 'manifest.ts', 'queue.ts']) {
      const text = readFileSync(join(SRC, 'codemap', f), 'utf8');
      assert.doesNotMatch(text, /\bfetch\s*\(/, f);
      const { importedFiles } = ts.preProcessFile(text, true, true);
      for (const imp of importedFiles) assert.doesNotMatch(imp.fileName, /^(node:)?(https?|http2|net|tls|dgram|undici)$/, `${f} imports ${imp.fileName}`);
    }
  });
});

describe('uploadManifest', () => {
  test('stored: POSTs the serialized manifest to /v2/codemap/repos/{repoId}/manifests with the credential', async () => {
    const f = fakeFetch(() => json(200, { status: 'stored', commitSha: SHA, callSites: 1 }));
    const r = await uploadManifest(cfg(f.fn), REPO, manifest());
    assert.deepEqual(r, { status: 'stored', commitSha: SHA, callSites: 1 });
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0]!;
    assert.equal(url, `https://api.swfte.com/agents/v2/codemap/repos/${REPO}/manifests`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    const h = init.headers as Record<string, string>;
    assert.equal(h.Authorization, 'Bearer pat_test_credential');
    assert.equal(h['X-API-Key'], undefined, 'a PAT is not copied into a second header');
    assert.equal(Buffer.from(init.body as Uint8Array).toString('utf8'), serializeManifest(manifest()));
  });

  test('duplicate is reported as duplicate', async () => {
    const f = fakeFetch(() => json(200, { status: 'duplicate', commitSha: SHA, callSites: 1 }));
    assert.equal((await uploadManifest(cfg(f.fn), REPO, manifest())).status, 'duplicate');
  });

  test('a stored receipt must acknowledge the count in the sent manifest, without an offline fallback', async () => {
    for (const callSites of [0, 2]) {
      let queued = 0;
      const f = fakeFetch(() => json(200, { status: 'stored', commitSha: SHA, callSites }));
      await assert.rejects(uploadManifest(cfg(f.fn), REPO, manifest(), {
        queue: { enqueue: () => { queued++; return 'unexpected-queue'; } },
      }), (e: unknown) => e instanceof CodemapApiError && e.code === 'UNEXPECTED_ANSWER' && e.status === 200);
      assert.equal(f.calls.length, 1);
      assert.equal(JSON.parse(Buffer.from(f.calls[0]!.init.body as Uint8Array).toString('utf8')).callSites.length, 1);
      assert.equal(queued, 0, 'an inconsistent receipt is not an offline upload');
    }
  });

  test('a genuine empty manifest can be acknowledged as stored with zero call sites', async () => {
    const f = fakeFetch(() => json(200, { status: 'stored', commitSha: SHA, callSites: 0 }));
    assert.deepEqual(await uploadManifest(cfg(f.fn), REPO, manifest({ callSites: [] })), {
      status: 'stored', commitSha: SHA, callSites: 0,
    });
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.parse(Buffer.from(f.calls[0]!.init.body as Uint8Array).toString('utf8')).callSites.length, 0);
  });

  test('a legacy duplicate remains an unconfirmed duplicate even when its count differs', async () => {
    const f = fakeFetch(() => json(200, { status: 'duplicate', commitSha: SHA, callSites: 2 }));
    assert.deepEqual(await uploadManifest(cfg(f.fn), REPO, manifest()), {
      status: 'duplicate', commitSha: SHA, callSites: 2,
    });
    assert.equal(f.calls.length, 1);
  });

  test('gzip: Content-Encoding gzip and the decoded body is the serialized manifest', async () => {
    const f = fakeFetch(() => json(200, { status: 'stored', commitSha: SHA, callSites: 1 }));
    await uploadManifest(cfg(f.fn), REPO, manifest(), { gzip: true });
    const { init } = f.calls[0]!;
    assert.equal((init.headers as Record<string, string>)['Content-Encoding'], 'gzip');
    assert.equal(gunzipSync(init.body as Uint8Array).toString('utf8'), serializeManifest(manifest()));
  });

  test('an api-key credential sends X-API-Key and the workspace header', async () => {
    const f = fakeFetch(() => json(200, { status: 'stored', commitSha: SHA, callSites: 1 }));
    await uploadManifest(cfg(f.fn, { credentialKind: 'api-key', credential: 'sk-swfte-' + 'x'.repeat(4), workspaceId: 'ws_1' }), REPO, manifest());
    const h = f.calls[0]!.init.headers as Record<string, string>;
    assert.equal(h['X-API-Key'], 'sk-swfte-xxxx');
    assert.equal(h['X-Workspace-ID'], 'ws_1');
  });

  test('a network failure is offline, never stored; with a queue it is queued-offline', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const r = await uploadManifest(cfg(f.fn), REPO, manifest());
    assert.equal(r.status, 'offline');
    const queued: Manifest[] = [];
    const q = await uploadManifest(cfg(f.fn), REPO, manifest(), { queue: { enqueue: (m) => (queued.push(m), '.swfte/codemap/queue/x.json') } });
    assert.deepEqual(q, { status: 'queued-offline', commitSha: SHA, reason: 'the server could not be reached', queuedAt: '.swfte/codemap/queue/x.json' });
    assert.equal(queued.length, 1);
    assert.equal(serializeManifest(queued[0]), serializeManifest(manifest()));
  });

  test('an unavailable server (503, 429) is offline too', async () => {
    for (const status of [503, 429, 502]) {
      const f = fakeFetch(() => json(status, { error: 'x' }));
      assert.equal((await uploadManifest(cfg(f.fn), REPO, manifest())).status, 'offline', String(status));
    }
  });

  test('a refusal throws with the code and pointer and is not queued', async () => {
    const queued: Manifest[] = [];
    const queue = { enqueue: (m: Manifest) => (queued.push(m), 'q') };
    const bad = fakeFetch(() => json(400, { error: 'ALLOWLIST_VIOLATION', pointer: '/callSites/0/symbol' }));
    await assert.rejects(uploadManifest(cfg(bad.fn), REPO, manifest(), { queue }), (e: unknown) => e instanceof CodemapApiError && e.code === 'ALLOWLIST_VIOLATION' && e.pointer === '/callSites/0/symbol' && e.status === 400);
    const missing = fakeFetch(() => json(404, { error: 'REPO_NOT_OPTED_IN' }));
    await assert.rejects(uploadManifest(cfg(missing.fn), REPO, manifest(), { queue }), (e: unknown) => e instanceof CodemapApiError && e.code === 'REPO_NOT_OPTED_IN');
    assert.equal(queued.length, 0);
  });

  test('a 200 without a receipt for this commit is never reported as uploaded', async () => {
    for (const body of [{}, { status: 'stored', commitSha: 'f'.repeat(40), callSites: 1 }, { status: 'ok', commitSha: SHA, callSites: 1 }, { status: 'stored', commitSha: SHA }]) {
      const f = fakeFetch(() => json(200, body));
      await assert.rejects(uploadManifest(cfg(f.fn), REPO, manifest()), (e: unknown) => e instanceof CodemapApiError && e.code === 'UNEXPECTED_ANSWER');
    }
  });

  test('a redirect is refused and the credential is not forwarded', async () => {
    const f = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/steal' } }));
    await assert.rejects(uploadManifest(cfg(f.fn), REPO, manifest()), (e: unknown) => e instanceof CodemapApiError && e.code === 'UNEXPECTED_REDIRECT');
    assert.equal(f.calls.length, 1);
  });

  test('the credential goes only to an operator-set or allowed host; nothing is sent otherwise', async () => {
    const f = fakeFetch(() => json(200, { status: 'stored', commitSha: SHA, callSites: 1 }));
    await assert.rejects(uploadManifest(cfg(f.fn, { baseUrl: 'https://attacker.example.com' }), REPO, manifest()), UntrustedHostError);
    await assert.rejects(uploadManifest(cfg(f.fn, { baseUrl: 'http://api.swfte.com/agents' }), REPO, manifest()), UntrustedHostError);
    await assert.rejects(uploadManifest(cfg(f.fn, { baseUrl: 'https://u:p@api.swfte.com/agents', env: { SWFTE_BASE_URL: 'https://u:p@api.swfte.com/agents' } }), REPO, manifest()), UntrustedHostError);
    assert.equal(f.calls.length, 0);
    await uploadManifest(cfg(f.fn, { baseUrl: 'https://staging.acme.dev', env: { SWFTE_BASE_URL: 'https://staging.acme.dev' } }), REPO, manifest());
    await uploadManifest(cfg(f.fn, { baseUrl: 'https://codemap.acme.dev', env: { SWFTE_ALLOWED_HOSTS: '*.acme.dev' } }), REPO, manifest());
    assert.equal(f.calls.length, 2);
  });

  test('the allowlist runs on every upload: an extra field or another repo is refused before sending', async () => {
    const f = fakeFetch(() => json(200, { status: 'stored', commitSha: SHA, callSites: 1 }));
    await assert.rejects(uploadManifest(cfg(f.fn), REPO, manifest({ source: 'const x = 1' })), /ALLOWLIST_VIOLATION at \/source/);
    await assert.rejects(uploadManifest(cfg(f.fn), 'r_ffffffffffffffffffffffffffffffff', manifest()), (e: unknown) => e instanceof CodemapApiError && e.code === 'REPO_MISMATCH');
    await assert.rejects(uploadManifest(cfg(f.fn), '../../v2/admin', manifest()), (e: unknown) => e instanceof CodemapApiError && e.code === 'INVALID_REPO_ID');
    assert.equal(f.calls.length, 0);
  });
});

describe('fetchWorkspaceKey', () => {
  const b64 = Buffer.alloc(32, 9).toString('base64');

  test('returns the 32-byte key in memory; serializing the result never carries it', async () => {
    const f = fakeFetch(() => json(200, { keyId: 'k1', key: b64 }));
    const k = await fetchWorkspaceKey(cfg(f.fn));
    assert.equal(f.calls[0]!.url, 'https://api.swfte.com/agents/v2/codemap/key');
    assert.equal(f.calls[0]!.init.method, 'GET');
    assert.equal(k.keyId, 'k1');
    assert.deepEqual(Buffer.from(k.key), Buffer.alloc(32, 9));
    assert.equal(JSON.stringify(k), '{"keyId":"k1"}');
    assert.ok(!Object.keys(k).includes('key'));
  });

  test('404 before any opt-in, a malformed key, and an unreachable server are errors, not keys', async () => {
    await assert.rejects(fetchWorkspaceKey(cfg(fakeFetch(() => json(404, { error: 'NOT_FOUND' })).fn)), (e: unknown) => e instanceof CodemapApiError && e.code === 'NOT_FOUND');
    await assert.rejects(fetchWorkspaceKey(cfg(fakeFetch(() => json(200, { keyId: 'k1', key: Buffer.alloc(16).toString('base64') })).fn)), (e: unknown) => e instanceof CodemapApiError && e.code === 'UNEXPECTED_ANSWER');
    await assert.rejects(fetchWorkspaceKey(cfg(fakeFetch(() => json(200, { key: b64 })).fn)), CodemapApiError);
    await assert.rejects(fetchWorkspaceKey(cfg(fakeFetch(() => { throw new TypeError('fetch failed'); }).fn)), CodemapOfflineError);
    await assert.rejects(fetchWorkspaceKey(cfg(fakeFetch(() => json(200, {})).fn, { baseUrl: 'https://evil.example' })), UntrustedHostError);
  });
});
