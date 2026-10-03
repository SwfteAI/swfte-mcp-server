import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProofWatchScheduler, readCollectorActivity, watchProof, type ActivityRow, type WatchAttempt, watchAttempt } from '../src/prove/watch.js';
import { reportWatchAttempt } from '../src/prove/cli.js';
import { runSourceProof } from '../src/prove/source.js';
import { readPendingRun } from '../src/prove/verdict.js';
import { treeKey } from '../src/prove/treekey.js';
import type { TreeSnapshot, SourceIntake, ProofLearningBoundary } from '../src/prove/types.js';

function snapshot(key = 'a'.repeat(64)): TreeSnapshot {
  return { root: '/fixture', run_key: key, repo_fingerprint: 'b'.repeat(64), commit: null, dirty: true,
    manifest: { files: [], lockfiles: [] } };
}
const row = (kind: string, id: string, time: number, fields: Partial<ActivityRow> = {}): ActivityRow =>
  ({ event_id: id, event_ms: time, kind, producer: 'wrap', epistemic_class: 'behavior_trace', ...fields });

function deferredWatch<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('overlapping exported ticks await one actual admission and one accepted pending readback', async () => {
  let now = 1000, starts = 0, reads = 0;
  const id = `pr_${'a'.repeat(64)}`;
  const admitted = deferredWatch<void>(), start = deferredWatch<WatchAttempt>();
  const readEntered = deferredWatch<void>(), read = deferredWatch<WatchAttempt>();
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'diff', debounceMs: 1 }, {
    activity: async () => [row('file_change', 'file', 500), row('turn_outcome', 'verified', 600, { verified: true })],
    snapshot: async () => snapshot(), now: () => now, output: () => {},
    prove: async () => { starts++; admitted.resolve(); return start.promise; },
    reread: async (runId, tree, level, session) => {
      reads++; assert.equal(runId, id); assert.equal(tree.run_key, 'a'.repeat(64));
      assert.equal(level, 'diff'); assert.equal(session, 'session1'); readEntered.resolve(); return read.promise;
    },
  });
  await scheduler.tick(); now++;
  const first = scheduler.tick(); await admitted.promise;
  let overlapDone = false;
  const overlap = scheduler.tick().then(() => { overlapDone = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(starts, 1, 'deleting admission coalescing reaches a second prove at the deferred window');
  assert.equal(overlapDone, false, 'overlap completion waits for the admitted work');
  start.resolve({ kind: 'pending', runId: id, level: 'diff' }); await Promise.all([first, overlap]);
  now += 1000;
  const firstRead = scheduler.tick(); await readEntered.promise;
  let readDone = false;
  const overlapRead = scheduler.tick().then(() => { readDone = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.equal(starts, 1); assert.equal(readDone, false);
  read.resolve({ kind: 'complete' }); await Promise.all([firstRead, overlapRead]);
  now += 2000; await scheduler.tick(); assert.equal(starts, 1); assert.equal(reads, 1);
});

test('synchronous activity callback reentry cannot bypass exported tick admission', async () => {
  let now = 1000, starts = 0, activities = 0, reenter = false;
  let overlapping: Promise<void> | undefined;
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'diff', debounceMs: 1 }, {
    activity: async () => {
      activities++;
      if (reenter) { reenter = false; overlapping = scheduler.tick(); }
      return [row('file_change', 'file', 500), row('turn_outcome', 'verified', 600, { verified: true })];
    },
    snapshot: async () => snapshot(), now: () => now, output: () => {},
    prove: async () => { starts++; return { kind: 'complete' }; },
  });
  await scheduler.tick(); now++; reenter = true;
  await scheduler.tick(); assert.ok(overlapping); await overlapping;
  assert.equal(activities, 2, 'only the prime and eligible tick may enter the activity port');
  assert.equal(starts, 1);
});

test('failed coalesced admission clears the flight and preserves backoff and a later positive retry', async () => {
  let now = 1000, starts = 0;
  const entered = deferredWatch<void>(), failed = deferredWatch<WatchAttempt>();
  const output: string[] = [];
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'diff', debounceMs: 1 }, {
    activity: async () => [row('file_change', 'file', 500), row('turn_outcome', 'verified', 600, { verified: true })],
    snapshot: async () => snapshot(), now: () => now, output: line => output.push(line),
    prove: async () => { starts++; if (starts === 1) { entered.resolve(); return failed.promise; } return { kind: 'complete' }; },
  });
  await scheduler.tick(); now++;
  const first = scheduler.tick(); await entered.promise;
  const overlap = scheduler.tick();
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(starts, 1);
  failed.reject(new Error('deferred admission unavailable')); await Promise.all([first, overlap]);
  assert.equal(output.length, 1); assert.match(output[0]!, /^unproven:/u);
  await scheduler.tick(); now += 999; await scheduler.tick(); assert.equal(starts, 1);
  now++; await scheduler.tick(); assert.equal(starts, 2, 'failed flight must release for one eligible positive retry');
  now += 1000; await scheduler.tick(); assert.equal(starts, 2);
});

test('file change plus later measured check requires quiet debounce and launches once per tree', async () => {
  let now = 1000; let launches = 0;
  const activity = [row('file_change', 'file', 500), row('turn_outcome', 'verified', 600, { verified: true })];
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'diff', debounceMs: 20_000 }, {
    activity: async () => activity, snapshot: async () => snapshot(), prove: async () => { launches++; return { kind: 'complete' }; }, output: () => {}, now: () => now,
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
      activity: async () => rows, snapshot: async () => snapshot(), prove: async () => { launches++; return { kind: 'complete' }; }, output: () => {}, now: () => now,
    });
    await scheduler.tick(); now += 20; await scheduler.tick(); assert.equal(launches, 0);
  }
});
test('unrecorded tree mutation invalidates eligible verification until a later measured edit', async () => {
  let now = 1000; let key = 'a'.repeat(64); let launches = 0;
  const rows = [row('file_change', 'file', 500), row('turn_outcome', 'verified', 600, { verified: true })];
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'tree', debounceMs: 10 }, {
    activity: async () => rows, snapshot: async () => snapshot(key), prove: async () => { launches++; return { kind: 'complete' }; }, output: () => {}, now: () => now,
  });
  await scheduler.tick(); key = 'c'.repeat(64); now += 20; await scheduler.tick(); now += 20; await scheduler.tick(); assert.equal(launches, 0);
  rows.push(row('file_change', 'new-file', now), row('turn_outcome', 'new-verification', now, { verified: true }));
  await scheduler.tick(); now += 20; await scheduler.tick(); assert.equal(launches, 1);
});
test('collector/proving degradation prints unproven and abort releases opt-in process', async () => {
  const output: string[] = []; const abort = new AbortController();
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'diff' }, {
    activity: async () => { throw new Error('offline'); }, snapshot: async () => snapshot(), prove: async () => ({ kind: 'complete' }), output: line => output.push(line),
  });
  await scheduler.tick(); assert.match(output[0]!, /^unproven:/u); assert(!output.join('\n').includes('PROOF_PASS'));
  abort.abort();
  await watchProof({ path: '/fixture', sessionId: 'session1', level: 'diff', signal: abort.signal }, {
    activity: async () => [], snapshot: async () => snapshot(), prove: async () => ({ kind: 'complete' }), output: () => {},
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

test('dot collector identity refuses before even reading a nonexistent token file', async () => {
  let calls = 0;
  for (const id of ['.', '..']) await assert.rejects(readCollectorActivity(id, {
    tokenFile: '/nonexistent/collector-read.token', fetcher: async () => { calls++; throw new Error('transport'); },
  }), /Invalid collector session id/);
  assert.equal(calls, 0);
});
test('transient refusal retries with bounded backoff and fresh admission; complete unavailable stays terminal', async () => {
  let now = 1000; let starts = 0; let admissions = 0;
  const rows = [row('file_change', 'file', 500), row('turn_outcome', 'verified', 600, { verified: true })];
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'diff', debounceMs: 10 }, {
    activity: async () => rows, snapshot: async () => snapshot(), now: () => now, output: () => {},
    prove: async () => { starts++; admissions++; return starts === 1 ? { kind: 'retry' } : { kind: 'complete' }; },
  });
  await scheduler.tick(); now += 10; await scheduler.tick(); assert.equal(starts, 1);
  now += 999; await scheduler.tick(); assert.equal(starts, 1);
  now++; await scheduler.tick(); assert.equal(starts, 2); assert.equal(admissions, 2);
  now += 600_000; await scheduler.tick(); assert.equal(starts, 2);
  assert.deepEqual(watchAttempt({ token: 'PROOF_UNPROVEN', verdict: 'UNAVAILABLE' } as never), { kind: 'retry' });
  assert.deepEqual(watchAttempt({ status: 'COMPLETE', verdict: 'UNAVAILABLE' } as never), { kind: 'complete' });
});
test('pending work rereads actual run identity without another start and read failure preserves pending', async () => {
  let now = 1000; let starts = 0; let reads = 0;
  const id = `pr_${'a'.repeat(64)}`;
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'diff', debounceMs: 10 }, {
    activity: async () => [row('file_change', 'file', 500), row('turn_outcome', 'verified', 600, { verified: true })],
    snapshot: async () => snapshot(), now: () => now, output: () => {},
    prove: async () => { starts++; return { kind: 'pending', runId: id, level: 'diff' }; },
    reread: async (runId, tree, level) => { reads++; assert.equal(runId, id); assert.equal(tree.run_key, 'a'.repeat(64));
      assert.equal(level, 'diff'); if (reads === 1) throw new Error('offline'); return { kind: 'complete' }; },
  });
  await scheduler.tick(); now += 10; await scheduler.tick(); assert.equal(starts, 1);
  now += 1000; await scheduler.tick(); assert.equal(reads, 1); assert.equal(starts, 1);
  now += 1000; await scheduler.tick(); assert.equal(reads, 2); assert.equal(starts, 1);
  now += 600_000; await scheduler.tick(); assert.equal(reads, 2); assert.equal(starts, 1);
});
test('cancelled watch performs no activity, source admission or pending read', async () => {
  const abort = new AbortController(); abort.abort(); let effects = 0;
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'diff', signal: abort.signal }, {
    activity: async () => { effects++; return []; }, snapshot: async () => { effects++; return snapshot(); },
    prove: async () => { effects++; return { kind: 'complete' }; }, reread: async () => { effects++; return { kind: 'complete' }; }, output: () => {},
  });
  await scheduler.tick(); assert.equal(effects, 0);
});

test('actual watch output rereads a claimed PASS and never prints green for unavailable signing', async () => {
  const output: string[] = []; let reads = 0;
  const run = { schema: 'nexus.proof.v1', run_id: `pr_${'a'.repeat(64)}`, run_key: 'a'.repeat(64), level: 'diff',
    status: 'COMPLETE', verdict: 'PASS', checks: [], findings: [], dependency_gaps: [], behavior_trace: [], explained: [] };
  const outcome = await reportWatchAttempt({ baseUrl: 'https://api.example.invalid', request: async () => {
    reads++; throw new Error('canonical issuer unavailable');
  } }, run as never, line => output.push(line));
  assert.deepEqual(outcome, { kind: 'complete' }); assert.equal(reads, 1);
  assert.equal(output.length, 1); assert.match(output[0]!, /^PROOF_UNPROVEN/u);
  assert(!output.join('\n').includes('PROOF_PASS')); assert(!output.join('\n').includes('swfte · PASS'));
  const abort = new AbortController(); abort.abort();
  await reportWatchAttempt(undefined, run as never, line => output.push(line), abort.signal);
  assert.equal(output.length, 1); assert.equal(reads, 1);
});

test('backoff caps at sixty seconds and a failed pending identity substitution never restarts upload', async () => {
  let now = 1000; let starts = 0; let reads = 0;
  const id = `pr_${'a'.repeat(64)}`;
  const scheduler = new ProofWatchScheduler({ path: '/fixture', sessionId: 'session1', level: 'diff', debounceMs: 1 }, {
    activity: async () => [row('file_change', 'file', 500), row('turn_outcome', 'verified', 600, { verified: true })],
    snapshot: async () => snapshot(), now: () => now, output: () => {},
    prove: async () => { starts++; return { kind: 'pending', runId: id, level: 'diff' }; },
    reread: async () => { reads++; return { kind: 'pending', runId: `pr_${'b'.repeat(64)}`, level: 'diff' }; },
  });
  await scheduler.tick(); now++; await scheduler.tick();
  for (const delay of [1000, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    now += delay - 1; const before = reads; await scheduler.tick(); assert.equal(reads, before);
    now++; await scheduler.tick(); assert.equal(reads, before + 1);
  }
  assert.equal(starts, 1);
});

test('real source consumer refreshes refused consent then polls accepted run without uploading again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prove-watch-consent-'));
  let now = 1000; let consents = 0; let uploads = 0; let posts = 0; let gets = 0; let origins = 0;
  let key = ''; const runId = `pr_${'a'.repeat(64)}`;
  const intake: SourceIntake = {
    resolveLevel: async () => 'diff',
    authorizeSource: async () => { consents++; if (consents === 1) throw new Error('explicit consent refused'); return { fixtureConsent: true }; },
    prepareUpload: async ({ snapshot: tree }) => { uploads++; return { payloadRef: 'fixture_receipt', runKey: tree.run_key, manifest: tree.manifest }; },
  };
  const learning: ProofLearningBoundary = { proofOriginExcludedByDefault: () => true,
    withProofOrigin: async action => { origins++; return action(); } };
  const client = { baseUrl: 'https://api.example.invalid', request: async <T>(options: { method: string; path: string; body?: unknown }) => {
    if (options.method === 'POST') { posts++; key = (options.body as { run_key: string }).run_key; }
    else { gets++; assert.equal(options.path, `/v2/proving/runs/${runId}`); }
    return { schema: 'nexus.proof.v1', run_id: runId, run_key: key, level: 'diff',
      status: options.method === 'POST' ? 'PENDING' : 'COMPLETE', verdict: 'UNAVAILABLE',
      checks: [{ name: 'scan', ok: null, detail: 'fixture unmeasured', evidence_ref: null }], findings: [],
      dependency_gaps: [options.method === 'POST' ? 'RUN_PENDING' : 'PROVING_CAPACITY_UNAVAILABLE'],
      behavior_trace: [], explained: [] } as T;
  } };
  try {
    await promisify(execFile)('git', ['init', '-q', root]); await writeFile(join(root, 'source.ts'), 'const total = 2;');
    const scheduler = new ProofWatchScheduler({ path: root, sessionId: 'session1', level: 'diff', debounceMs: 10 }, {
      activity: async () => [row('file_change', 'file', 500), row('turn_outcome', 'verified', 600, { verified: true })],
      snapshot: treeKey, now: () => now, output: () => {},
      prove: async tree => watchAttempt(await runSourceProof(client, { path: tree.root, level: 'diff', expectedRunKey: tree.run_key, requestedChecks: ['scan'],
        sessionId: 'session1', trigger: 'verified_edit' }, { intake, learning })),
      reread: async (id, tree, level) => watchAttempt(await readPendingRun(client, id, tree.run_key, level)),
    });
    await scheduler.tick(); now += 10; await scheduler.tick();
    assert.equal(consents, 1); assert.equal(uploads, 0); assert.equal(posts, 0); assert.equal(origins, 0);
    now += 999; await scheduler.tick(); assert.equal(consents, 1);
    now++; await scheduler.tick(); assert.equal(consents, 2); assert.equal(uploads, 1); assert.equal(posts, 1); assert.equal(origins, 1);
    now += 1000; await scheduler.tick(); assert.equal(gets, 1);
    now += 600_000; await scheduler.tick();
    assert.equal(consents, 2); assert.equal(uploads, 1); assert.equal(posts, 1); assert.equal(origins, 1); assert.equal(gets, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('changed tree after scheduler verification has zero source effects until a new verified edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prove-watch-stale-'));
  let now = 1000; let consents = 0; let uploads = 0; let starts = 0; let mutate = true;
  const rows = [row('file_change', 'file', 500), row('turn_outcome', 'verified', 600, { verified: true })];
  const intake: SourceIntake = { resolveLevel: async () => 'diff',
    authorizeSource: async () => { consents++; return { explicitFixtureConsent: true }; },
    prepareUpload: async ({ snapshot: tree }) => { uploads++; return { payloadRef: 'fixture_receipt', runKey: tree.run_key, manifest: tree.manifest }; } };
  const learning: ProofLearningBoundary = { proofOriginExcludedByDefault: () => true, withProofOrigin: action => action() };
  const client = { baseUrl: 'https://api.example.invalid', request: async <T>(options: { body?: unknown }) => {
    starts++; const body = options.body as { run_key: string; level: string };
    return { schema: 'nexus.proof.v1', run_id: `pr_${'a'.repeat(64)}`, run_key: body.run_key, level: body.level,
      status: 'PENDING', verdict: 'UNAVAILABLE', checks: [], findings: [], dependency_gaps: ['RUN_PENDING'],
      behavior_trace: [], explained: [] } as T;
  } };
  try {
    await promisify(execFile)('git', ['init', '-q', root]); await writeFile(join(root, 'source.ts'), 'const total = 2;');
    const scheduler = new ProofWatchScheduler({ path: root, sessionId: 'session1', level: 'diff', debounceMs: 10 }, {
      activity: async () => rows, snapshot: treeKey, now: () => now, output: () => {},
      prove: async tree => {
        if (mutate) { mutate = false; await writeFile(join(root, 'source.ts'), 'const total = 3;'); }
        return watchAttempt(await runSourceProof(client, { path: tree.root, level: 'diff', expectedRunKey: tree.run_key,
          requestedChecks: ['scan'], sessionId: 'session1', trigger: 'verified_edit' }, { intake, learning }));
      },
    });
    await scheduler.tick(); now += 10; await scheduler.tick();
    assert.equal(consents, 0); assert.equal(uploads, 0); assert.equal(starts, 0);
    now += 2000; await scheduler.tick(); now += 2000; await scheduler.tick();
    assert.equal(consents, 0); assert.equal(uploads, 0); assert.equal(starts, 0);
    rows.push(row('file_change', 'new-file', now), row('turn_outcome', 'new-verified', now, { verified: true }));
    await scheduler.tick(); now += 10; await scheduler.tick();
    assert.equal(consents, 1); assert.equal(uploads, 1); assert.equal(starts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
