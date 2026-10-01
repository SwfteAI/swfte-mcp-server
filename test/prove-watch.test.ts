import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ProofWatchScheduler, readCollectorActivity, watchProof, type ActivityRow } from '../src/prove/watch.js';
import type { TreeSnapshot } from '../src/prove/types.js';

function snapshot(key = 'a'.repeat(64)): TreeSnapshot {
  return { root: '/fixture', run_key: key, repo_fingerprint: 'b'.repeat(64), commit: null, dirty: true,
    manifest: { files: [], lockfiles: [] } };
}
const row = (kind: string, id: string, time: number, fields: Partial<ActivityRow> = {}): ActivityRow =>
  ({ event_id: id, event_ms: time, kind, producer: 'wrap', epistemic_class: 'behavior_trace', ...fields });

test('file change plus later measured check requires quiet debounce and launches once per tree', async () => {
  let now = 1000; let launches = 0;
  const activity = [row('file_change', 'file', 500), row('turn_outcome', 'verified', 600, { verified: true })];
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'diff', debounceMs: 20_000 }, {
    activity: async () => activity, snapshot: async () => snapshot(), prove: async () => { launches++; }, output: () => {}, now: () => now,
  });
  await scheduler.tick(); assert.equal(launches, 0); now += 19_999; await scheduler.tick(); assert.equal(launches, 0);
  now++; await scheduler.tick(); assert.equal(launches, 1); now += 30_000; await scheduler.tick(); assert.equal(launches, 1);
});
test('wrong order, unverified and author explanation do not trigger', async () => {
  for (const rows of [
    [row('turn_outcome', 'first', 400, { verified: true }), row('file_change', 'file', 500)],
    [row('file_change', 'file', 500), row('turn_outcome', 'not-verified', 600, { verified: false })],
    [row('file_change', 'file', 500), row('turn_outcome', 'author', 600, { verified: true, epistemic_class: 'rationalisation' })],
    [row('turn_outcome', 'no-edit', 600, { verified: true })],
  ]) {
    let now = 1000; let launches = 0;
    const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'diff', debounceMs: 10 }, {
      activity: async () => rows, snapshot: async () => snapshot(), prove: async () => { launches++; }, output: () => {}, now: () => now,
    });
    await scheduler.tick(); now += 20; await scheduler.tick(); assert.equal(launches, 0);
  }
});
test('unrecorded tree mutation invalidates eligible verification until a later measured edit', async () => {
  let now = 1000; let key = 'a'.repeat(64); let launches = 0;
  const rows = [row('file_change', 'file', 500), row('turn_outcome', 'verified', 600, { verified: true })];
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'tree', debounceMs: 10 }, {
    activity: async () => rows, snapshot: async () => snapshot(key), prove: async () => { launches++; }, output: () => {}, now: () => now,
  });
  await scheduler.tick(); key = 'c'.repeat(64); now += 20; await scheduler.tick(); now += 20; await scheduler.tick(); assert.equal(launches, 0);
  rows.push(row('file_change', 'new-file', now), row('turn_outcome', 'new-verification', now, { verified: true }));
  await scheduler.tick(); now += 20; await scheduler.tick(); assert.equal(launches, 1);
});
test('collector/proving degradation prints unproven and abort releases opt-in process', async () => {
  const output: string[] = []; const abort = new AbortController();
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'diff' }, {
    activity: async () => { throw new Error('offline'); }, snapshot: async () => snapshot(), prove: async () => {}, output: line => output.push(line),
  });
  await scheduler.tick(); assert.match(output[0]!, /^unproven:/u); assert(!output.join('\n').includes('PROOF_PASS'));
  abort.abort();
  await watchProof({ path: '/fixture', sessionId: 'session1', level: 'diff', signal: abort.signal }, {
    activity: async () => [], snapshot: async () => snapshot(), prove: async () => {}, output: () => {},
  });
});
test('collector uses read-only token at call time, fixed loopback and no write methods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prove-token-')); await chmod(root, 0o700);
  const file = join(root, 'collector-read.token'); let previous = '';
  const fetcher: typeof fetch = async (url, init) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:8791\/v1\/sessions\/session1\/activity/u);
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
    previous = (init?.headers as { Authorization: string }).Authorization;
    return new Response(JSON.stringify({ activity: [row('file_change', 'file', 500)] }), { status: 200 });
  };
  try {
    await writeFile(file, 'a'.repeat(64), { mode: 0o600 });
    assert.equal((await readCollectorActivity('session1', { tokenFile: file, fetcher })).length, 1);
    assert.equal(previous, `Bearer ${'a'.repeat(64)}`);
    await writeFile(file, 'b'.repeat(64)); await readCollectorActivity('session1', { tokenFile: file, fetcher });
    assert.equal(previous, `Bearer ${'b'.repeat(64)}`);
    await assert.rejects(readCollectorActivity('session1', { tokenFile: join(root, 'collector.token'), fetcher }), /read-token/);
    await chmod(file, 0o644); await assert.rejects(readCollectorActivity('session1', { tokenFile: file, fetcher }), /unsafe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('real redirect boundary refuses to forward collector token to a second listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prove-redirect-')); await chmod(root, 0o700);
  const file = join(root, 'collector-read.token'); await writeFile(file, 'a'.repeat(64), { mode: 0o600 });
  let forwarded = 0;
  const canary = createServer((_request, response) => { forwarded++; response.end('{}'); });
  canary.listen(0, '127.0.0.1'); await once(canary, 'listening'); const canaryPort = (canary.address() as { port: number }).port;
  const collector = createServer((_request, response) => { response.writeHead(302, { Location: `http://127.0.0.1:${canaryPort}/capture` }); response.end(); });
  collector.listen(0, '127.0.0.1'); await once(collector, 'listening'); const port = (collector.address() as { port: number }).port;
  try {
    await assert.rejects(readCollectorActivity('session1', { tokenFile: file, port })); assert.equal(forwarded, 0);
  } finally {
    await new Promise<void>(resolve => collector.close(() => resolve()));
    await new Promise<void>(resolve => canary.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
});
