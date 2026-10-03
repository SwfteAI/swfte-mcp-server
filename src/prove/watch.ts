import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { treeKey } from './treekey.js';
import type { ProofLevel, TreeSnapshot } from './types.js';

export interface ActivityRow {
  event_id: string; event_ms: number | null; kind: string; producer: string;
  epistemic_class: string | null; verified?: boolean | null; passed?: boolean | null;
}
export interface WatchOptions { path: string; sessionId: string; level: ProofLevel; debounceMs?: number; pollMs?: number; signal: AbortSignal }
export type WatchAttempt = { kind: 'retry' } | { kind: 'complete' }
  | { kind: 'pending'; runId: string; level: ProofLevel };
/** Local refusal has no accepted run; a canonical COMPLETE result is terminal, including UNAVAILABLE. */
export function watchAttempt(result: { token?: string; status?: string; run_id?: string; level?: ProofLevel }): WatchAttempt {
  if (result.token !== undefined) return { kind: 'retry' };
  if (result.status === 'COMPLETE') return { kind: 'complete' };
  if (result.status === 'PENDING' && result.run_id && /^pr_[a-f0-9]{64}$/u.test(result.run_id) && result.level) {
    return { kind: 'pending', runId: result.run_id, level: result.level };
  }
  throw new Error('Unrecognized proof attempt');
}
export interface WatchPorts {
  activity(sessionId: string): Promise<ActivityRow[]>;
  snapshot(path: string): Promise<TreeSnapshot>;
  prove(snapshot: TreeSnapshot, level: ProofLevel, sessionId: string): Promise<WatchAttempt>;
  reread?(runId: string, snapshot: TreeSnapshot, level: ProofLevel, sessionId: string): Promise<WatchAttempt>;
  output(message: string): void;
  now?: () => number;
}
interface WatchState { pending?: Extract<WatchAttempt, { kind: 'pending' }>; failures: number; nextAt: number }

/** Read token is opened afresh each call, never falls back to collector.token. */
export async function readCollectorActivity(sessionId: string, options: {
  tokenFile?: string; port?: number; fetcher?: typeof fetch;
} = {}): Promise<ActivityRow[]> {
  if (['.', '..'].includes(sessionId) || !/^[A-Za-z0-9._:-]{1,200}$/u.test(sessionId)) throw new Error('Invalid collector session id');
  const port = options.port ?? 8791;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback collector port');
  const tokenFile = options.tokenFile ?? join(homedir(), '.nexus', 'collector-read.token');
  if (!tokenFile.endsWith('/collector-read.token')) throw new Error('Only the collector read-token file is accepted');
  const parent = await lstat(dirname(tokenFile));
  if (!parent.isDirectory() || parent.isSymbolicLink() || process.platform !== 'win32' && ((parent.mode & 0o022) !== 0)) {
    throw new Error('Collector token directory is unsafe');
  }
  const file = await open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let token: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 100 || process.platform !== 'win32'
      && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid())) throw new Error('Collector read token is unsafe');
    token = (await file.readFile('utf8')).trim();
  } finally { await file.close(); }
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('Malformed collector read token');
  const response = await (options.fetcher ?? fetch)(`http://127.0.0.1:${port}/v1/sessions/${encodeURIComponent(sessionId)}/activity?limit=1000`,
    { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error('Collector read unavailable');
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('Collector response too large');
  const body: unknown = JSON.parse(text);
  if (!body || typeof body !== 'object' || !Array.isArray((body as { activity?: unknown }).activity)) throw new Error('Invalid collector activity');
  return ((body as { activity: unknown[] }).activity).filter((row): row is ActivityRow => {
    if (!row || typeof row !== 'object') return false;
    const item = row as ActivityRow;
    return typeof item.event_id === 'string' && typeof item.kind === 'string' && item.producer === 'wrap'
      && typeof item.event_ms === 'number' && Number.isFinite(item.event_ms);
  });
}

/** Pure state machine makes verified ordering, quiet tree and reuse observable independently of I/O. */
export class ProofWatchScheduler {
  private readonly seen = new Set<string>();
  private readonly launched = new Set<string>();
  private readonly attempts = new Map<string, WatchState>();
  private fileChangeAt: number | null = null;
  private verifiedAt: number | null = null;
  private lastTree: string | null = null;
  private quietSince = 0;
  private inFlight: Promise<void> | undefined;
  constructor(private readonly options: Omit<WatchOptions, 'signal'> & { signal?: AbortSignal }, private readonly ports: WatchPorts) {
    const debounce = options.debounceMs ?? 20_000;
    if (!Number.isFinite(debounce) || debounce < 1 || debounce > 600_000) throw new Error('Invalid proof debounce');
  }
  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.options.signal?.aborted) return Promise.resolve();
    // Register before invoking ports: even a synchronous callback can reenter tick().
    const flight = Promise.resolve().then(() => this.tickOnce()).finally(() => {
      if (this.inFlight === flight) this.inFlight = undefined;
    });
    this.inFlight = flight;
    return flight;
  }
  private async tickOnce(): Promise<void> {
    if (this.options.signal?.aborted) return;
    try {
      const now = (this.ports.now ?? Date.now)();
      const rows = await this.ports.activity(this.options.sessionId);
      if (this.options.signal?.aborted) return;
      let newFileChange = false;
      for (const row of [...rows].sort((a, b) => (a.event_ms ?? 0) - (b.event_ms ?? 0))) {
        if (this.seen.has(row.event_id) || !row.event_id || row.producer !== 'wrap' || row.event_ms == null
          || row.event_ms > now || row.epistemic_class !== 'behavior_trace') continue;
        this.seen.add(row.event_id);
        if (row.kind === 'file_change') { this.fileChangeAt = row.event_ms; this.verifiedAt = null; newFileChange = true; this.quietSince = now; }
        else if (this.fileChangeAt !== null && row.event_ms >= this.fileChangeAt
          && ((row.kind === 'turn_outcome' && row.verified === true) || (row.kind === 'execution_feedback' && row.passed === true))) {
          this.verifiedAt = row.event_ms;
        }
      }
      if (this.seen.size > 10_000) { this.seen.clear(); this.fileChangeAt = null; this.verifiedAt = null; this.quietSince = now; }
      const snapshot = await this.ports.snapshot(this.options.path);
      if (this.options.signal?.aborted) return;
      if (snapshot.run_key !== this.lastTree) {
        this.lastTree = snapshot.run_key; this.quietSince = now;
        if (!newFileChange) this.verifiedAt = null;
      }
      if (this.fileChangeAt === null || this.verifiedAt === null || this.launched.has(snapshot.run_key)
        || now - this.quietSince < (this.options.debounceMs ?? 20_000)) return;
      const existing = this.attempts.get(snapshot.run_key);
      // Keep accepted identities rather than evicting them and later replaying their effects.
      if (!existing && this.attempts.size >= 1_000) {
        this.ports.output('unproven: pending proof capacity exhausted'); return;
      }
      const state: WatchState = existing ?? { failures: 0, nextAt: 0 };
      if (now < state.nextAt || this.options.signal?.aborted) return;
      this.attempts.set(snapshot.run_key, state);
      try {
        const outcome = state.pending
          ? await this.readPending(state.pending, snapshot)
          : await this.ports.prove(snapshot, this.options.level, this.options.sessionId);
        if (this.options.signal?.aborted) return;
        if (outcome.kind === 'complete') {
          this.launched.add(snapshot.run_key); this.attempts.delete(snapshot.run_key);
          if (this.launched.size > 1_000) this.launched.delete(this.launched.values().next().value!);
        } else if (outcome.kind === 'pending') {
          if (state.pending && (outcome.runId !== state.pending.runId || outcome.level !== state.pending.level)) {
            throw new Error('Pending proof identity changed');
          }
          state.pending = outcome; state.failures = 0; state.nextAt = (this.ports.now ?? Date.now)() + 1000;
        } else {
          // An unavailable read cannot discard the accepted identity and replay its effects.
          this.backoff(state, (this.ports.now ?? Date.now)());
        }
      } catch {
        this.backoff(state, (this.ports.now ?? Date.now)());
        if (!this.options.signal?.aborted) this.ports.output('unproven: proving attempt or pending read unavailable');
      }
    } catch { if (!this.options.signal?.aborted) this.ports.output('unproven: collector, source consent, quota or proving service unavailable'); }
  }
  private backoff(state: { failures: number; nextAt: number }, now: number): void {
    state.failures = Math.min(state.failures + 1, 7);
    state.nextAt = now + Math.min(60_000, 1000 * 2 ** (state.failures - 1));
  }
  private readPending(pending: Extract<WatchAttempt, { kind: 'pending' }>, snapshot: TreeSnapshot): Promise<WatchAttempt> {
    if (!this.ports.reread) throw new Error('Pending proof reader unavailable');
    return this.ports.reread(pending.runId, snapshot, pending.level, this.options.sessionId);
  }
}

/** Opt-in process only; it writes no Nexus event, ledger row, policy or hook. */
export async function watchProof(options: WatchOptions, ports: WatchPorts): Promise<void> {
  const poll = options.pollMs ?? 2_000;
  if (!Number.isFinite(poll) || poll < 100 || poll > 60_000) throw new Error('Invalid watch poll interval');
  const scheduler = new ProofWatchScheduler(options, ports);
  while (!options.signal.aborted) {
    await scheduler.tick();
    try { await delay(poll, undefined, { signal: options.signal }); }
    catch { if (options.signal.aborted) return; throw new Error('Proof watch wait unavailable'); }
  }
}
export const defaultWatchSnapshot = treeKey;
