/**
 * The offline queue (docs/codemap/CONTRACT.md §7): `.swfte/codemap/queue/<commitSha>.json`, one
 * manifest per commit, manifest JSON only (the allowlist serializer's output, nothing else), written
 * through ConfinedWriter.
 *
 *   enqueue      idempotent by commitSha: the same commit queued twice is one file (the latest scan)
 *   listQueue    reads each entry back through the allowlist; a file that fails it is reported, not sent
 *   drainQueue   uploads each entry once; `stored` and `duplicate` both remove it; offline stops the
 *                drain and keeps the rest; a refusal keeps the file and is reported
 */
import fs from 'node:fs';
import { ConfinedWriter } from '../fsguard.js';
import { cmp } from './fingerprint.js';
import { checkManifest, ManifestViolationError, serializeManifest } from './manifest.js';
import type { Manifest } from './types.js';
import { CodemapApiError, uploadManifest, type UploadConfig, type UploadOptions, type UploadResult } from './upload.js';
import { readConfined } from './walk.js';

export const QUEUE_DIR = '.swfte/codemap/queue';
const ENTRY = /^([0-9a-f]{40})\.json$/;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

export type QueueEntry =
  | { commitSha: string; path: string; manifest: Manifest }
  | { commitSha: string; path: string; invalid: string };

export interface DrainResult {
  uploaded: Array<{ commitSha: string; status: 'stored' | 'duplicate'; callSites: number }>;
  /** Refused by the server or by the allowlist; the file is kept. */
  failed: Array<{ commitSha: string; code: string }>;
  /** Still queued after the drain. */
  remaining: string[];
  offline: boolean;
}

const entryPath = (commitSha: string) => `${QUEUE_DIR}/${commitSha}.json`;

/** Queue a manifest for a later upload. Returns the queue file's path relative to the root. */
export function enqueue(root: string, manifest: Manifest): string {
  const checked = checkManifest(manifest);
  const body = `${serializeManifest(checked)}\n`;
  const writer = new ConfinedWriter({ root });
  const rel = entryPath(checked.commitSha);
  writer.create(writer.resolve(rel), body, true);
  writer.commit();
  return rel;
}

/** Every queued manifest, oldest scan first, each re-checked by the allowlist. */
export function listQueue(root: string): QueueEntry[] {
  const writer = new ConfinedWriter({ root });
  const dirAbs = writer.resolve(QUEUE_DIR);
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<QueueEntry & { scannedAt: string }> = [];
  for (const d of names) {
    const m = ENTRY.exec(d.name);
    if (!m || !d.isFile()) continue;
    const commitSha = m[1]!;
    const rel = entryPath(commitSha);
    const text = readConfined(writer, rel, MAX_QUEUED_BYTES);
    if (text === null) {
      out.push({ commitSha, path: rel, invalid: 'unreadable or too large', scannedAt: '' });
      continue;
    }
    try {
      const manifest = checkManifest(JSON.parse(text));
      if (manifest.commitSha !== commitSha) throw new ManifestViolationError('ALLOWLIST_VIOLATION', '/commitSha', 'does not match the queue file name');
      out.push({ commitSha, path: rel, manifest, scannedAt: manifest.scannedAt });
    } catch (err) {
      const why = err instanceof ManifestViolationError ? `${err.code} at ${err.pointer || '(document)'}` : 'not valid JSON';
      out.push({ commitSha, path: rel, invalid: why, scannedAt: '' });
    }
  }
  out.sort((a, b) => cmp(a.scannedAt, b.scannedAt) || cmp(a.commitSha, b.commitSha));
  return out.map(({ scannedAt: _s, ...e }) => e as QueueEntry);
}

/** Remove one queue entry (confined; a symlink in its place is refused, never followed). */
export function dequeue(root: string, commitSha: string): boolean {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('A queue entry is named by a 40-hex commit SHA.');
  const writer = new ConfinedWriter({ root });
  const abs = writer.resolve(entryPath(commitSha));
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!st.isFile()) throw new Error(`${entryPath(commitSha)} is not a regular file; left in place.`);
  fs.unlinkSync(abs);
  return true;
}

/** Upload now, or queue the manifest when the server cannot be reached. */
export function uploadOrQueue(root: string, cfg: UploadConfig, repoId: string, manifest: Manifest, opts: Omit<UploadOptions, 'queue'> = {}): Promise<UploadResult> {
  return uploadManifest(cfg, repoId, manifest, { ...opts, queue: { enqueue: (m) => enqueue(root, m) } });
}

/**
 * Upload every queued manifest once, oldest first. `upload` is injectable for tests; it defaults to
 * uploadManifest (without a queue: a manifest is never re-queued from inside the drain).
 */
export async function drainQueue(
  root: string,
  cfg: UploadConfig,
  opts: { gzip?: boolean; upload?: typeof uploadManifest } = {}
): Promise<DrainResult> {
  const upload = opts.upload ?? uploadManifest;
  const result: DrainResult = { uploaded: [], failed: [], remaining: [], offline: false };
  const entries = listQueue(root);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (result.offline) {
      result.remaining.push(e.commitSha);
      continue;
    }
    if (!('manifest' in e)) {
      result.failed.push({ commitSha: e.commitSha, code: 'INVALID_QUEUE_ENTRY' });
      result.remaining.push(e.commitSha);
      continue;
    }
    let r: UploadResult;
    try {
      r = await upload(cfg, e.manifest.repo.id, e.manifest, { gzip: opts.gzip });
    } catch (err) {
      if (err instanceof CodemapApiError || err instanceof ManifestViolationError) {
        result.failed.push({ commitSha: e.commitSha, code: err.code });
        result.remaining.push(e.commitSha);
        continue;
      }
      throw err;
    }
    if (r.status === 'stored' || r.status === 'duplicate') {
      dequeue(root, e.commitSha);
      result.uploaded.push({ commitSha: e.commitSha, status: r.status, callSites: r.callSites });
    } else {
      result.offline = true;
      result.remaining.push(e.commitSha);
    }
  }
  return result;
}
