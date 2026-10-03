/**
 * The offline queue (docs/codemap/CONTRACT.md §7): `.swfte/codemap/queue/<commitSha>.json`, one
 * manifest per commit, manifest JSON only (the allowlist serializer's output, nothing else), written
 * through ConfinedWriter.
 *
 *   enqueue      idempotent by commitSha: the same commit queued twice is one file (the latest scan)
 *   listQueue    reads each entry back through the allowlist; a file that fails it is reported, not sent
 *   drainQueue   uploads each entry once; only `stored` removes it; offline stops the drain and
 *                keeps the rest; an unconfirmed duplicate or refusal keeps the file and is reported
 */
import fs from 'node:fs';
import { ConfinedWriter } from '../fsguard.js';
import { cmp } from './fingerprint.js';
import { checkManifest, ManifestViolationError, serializeManifest } from './manifest.js';
import type { Manifest } from './types.js';
import { CodemapApiError, uploadManifest, type UploadConfig, type UploadOptions, type UploadResult } from './upload.js';
import { readConfined } from './walk.js';
import { bindingError, checkBinding, compatibleBindings, digest, queueBindingPath, stableJson, verifyBinding, type LocalBinding } from './binding.js';
import { CodemapOfflineError, fetchWorkspaceKey, repositoryOptIns, type RepositoryOptIn, type WorkspaceKey } from './upload.js';

export const QUEUE_DIR = '.swfte/codemap/queue';
const ENTRY = /^([0-9a-f]{40})\.json$/;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

export type QueueEntry =
  | { commitSha: string; path: string; manifest: Manifest; binding?: LocalBinding; bindingError?: string;
      manifestFileDigest: string; bindingFileDigest?: string }
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

interface Admission { cfg: UploadConfig; workspace: WorkspaceKey; consent: RepositoryOptIn }
interface EntryFingerprint { manifestFileDigest: string; bindingFileDigest?: string }

/** Serializes only local pair mutation; never holds a lock while awaiting network. */
function withEntryLock<T>(root: string, commitSha: string, action: (writer: ConfinedWriter) => T): T {
  queueBindingPath(commitSha);
  const writer = new ConfinedWriter({ root });
  const dir = '.swfte/codemap/queue-locks';
  fs.mkdirSync(writer.resolve(dir), { recursive: true });
  const rel = `${dir}/${commitSha}.lock`;
  const path = writer.resolve(rel);
  let fd: number;
  try { fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw bindingError('QUEUE_BUSY');
    throw err;
  }
  try { return action(writer); }
  finally { fs.closeSync(fd); fs.unlinkSync(writer.resolve(rel)); }
}

function readPair(root: string, writer: ConfinedWriter, commitSha: string): QueueEntry {
  const rel = entryPath(commitSha);
  const text = readConfined(writer, rel, MAX_QUEUED_BYTES);
  if (text === null) return { commitSha, path: rel, invalid: 'unreadable or too large' };
  let manifest: Manifest;
  try {
    manifest = checkManifest(JSON.parse(text));
    if (manifest.commitSha !== commitSha) throw new ManifestViolationError('ALLOWLIST_VIOLATION', '/commitSha', 'does not match the queue file name');
  } catch (err) {
    return { commitSha, path: rel, invalid: err instanceof ManifestViolationError
      ? `${err.code} at ${err.pointer || '(document)'}` : 'not valid JSON' };
  }
  const body = readConfined(writer, queueBindingPath(commitSha), 16 * 1024);
  let binding: LocalBinding | undefined;
  let error: string | undefined;
  if (body === null) error = 'MISSING_LOCAL_BINDING';
  else {
    try { binding = checkBinding(JSON.parse(body), manifest); }
    catch (err) { error = err instanceof CodemapApiError ? err.code : 'INVALID_LOCAL_BINDING'; }
  }
  return { commitSha, path: rel, manifest, ...(binding ? { binding } : {}), ...(error ? { bindingError: error } : {}),
    manifestFileDigest: digest(text), ...(body !== null ? { bindingFileDigest: digest(body) } : {}) };
}

/** Queue a manifest for a later upload. Returns the queue file's path relative to the root. */
export function enqueue(root: string, manifest: Manifest, binding?: LocalBinding, admission?: Admission): string {
  const checked = checkManifest(manifest);
  const body = `${serializeManifest(checked)}\n`;
  const rel = entryPath(checked.commitSha);
  if (binding) {
    binding = checkBinding(binding, checked);
    if (admission) verifyBinding(binding, checked, admission.cfg, admission.workspace, admission.consent);
  }
  withEntryLock(root, checked.commitSha, writer => {
    if (fs.existsSync(writer.resolve(rel))) {
      const old = readPair(root, writer, checked.commitSha);
      if (!('manifest' in old)) throw bindingError('QUEUE_ENTRY_CONFLICT');
      if (binding) {
        if (!old.binding || !compatibleBindings(old.binding, binding)) throw bindingError('QUEUE_ENTRY_CONFLICT');
        if (stableJson(old.binding) !== stableJson(binding) || old.manifestFileDigest !== digest(body)) {
          if (!admission) throw bindingError('QUEUE_ENTRY_CONFLICT');
          verifyBinding(old.binding, old.manifest, admission.cfg, admission.workspace, admission.consent);
        }
      } else if (old.binding || old.bindingFileDigest) throw bindingError('QUEUE_ENTRY_CONFLICT');
    }
    if (binding) writer.create(writer.resolve(queueBindingPath(checked.commitSha)), stableJson(binding) + '\n', true);
    writer.create(writer.resolve(rel), body, true);
    writer.commit();
  });
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
    try {
      const entry = withEntryLock(root, commitSha, locked => readPair(root, locked, commitSha));
      out.push({ ...entry, scannedAt: 'manifest' in entry ? entry.manifest.scannedAt : '' });
    } catch (err) {
      if (!(err instanceof CodemapApiError)) throw err;
      out.push({ commitSha, path: rel, invalid: err.code, scannedAt: '' });
    }
  }
  out.sort((a, b) => cmp(a.scannedAt, b.scannedAt) || cmp(a.commitSha, b.commitSha));
  return out.map(({ scannedAt: _s, ...e }) => e as QueueEntry);
}

/** Remove one queue entry (confined; a symlink in its place is refused, never followed). */
export function dequeue(root: string, commitSha: string, expected?: EntryFingerprint): boolean {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('A queue entry is named by a 40-hex commit SHA.');
  return withEntryLock(root, commitSha, writer => {
    const abs = writer.resolve(entryPath(commitSha));
    if (!fs.existsSync(abs)) return false;
    if (expected) {
      const current = readPair(root, writer, commitSha);
      if (!('manifest' in current) || current.manifestFileDigest !== expected.manifestFileDigest
        || current.bindingFileDigest !== expected.bindingFileDigest) return false;
    }
    if (!fs.lstatSync(abs).isFile()) throw bindingError('INVALID_QUEUE_ENTRY');
    const sidecar = writer.resolve(queueBindingPath(commitSha));
    if (fs.existsSync(sidecar) && !fs.lstatSync(sidecar).isFile()) throw bindingError('INVALID_LOCAL_BINDING');
    fs.unlinkSync(writer.resolve(entryPath(commitSha)));
    if (fs.existsSync(sidecar)) fs.unlinkSync(writer.resolve(queueBindingPath(commitSha)));
    return true;
  });
}

/** Upload now, or queue the manifest when the server cannot be reached. */
export async function uploadOrQueue(root: string, cfg: UploadConfig, repoId: string, manifest: Manifest,
  opts: Omit<UploadOptions, 'queue'> & { binding?: LocalBinding; workspace?: WorkspaceKey; consent?: RepositoryOptIn } = {}): Promise<UploadResult> {
  if (!opts.binding || !opts.workspace || !opts.consent) throw bindingError('MISSING_LOCAL_BINDING');
  verifyBinding(opts.binding, manifest, cfg, opts.workspace, opts.consent);
  const admission = { cfg, workspace: opts.workspace, consent: opts.consent };
  try {
    const consent = (await repositoryOptIns(cfg)).find(r => r.repoId === repoId);
    if (!consent) throw new CodemapApiError(404, 'REPO_NOT_OPTED_IN', 'Repository consent was not confirmed.');
    const workspace = await fetchWorkspaceKey(cfg);
    verifyBinding(opts.binding, manifest, cfg, workspace, consent);
  } catch (err) {
    if (!(err instanceof CodemapOfflineError)) throw err;
    return { status: 'queued-offline', commitSha: manifest.commitSha, reason: 'Repository context could not be refreshed while offline.',
      queuedAt: enqueue(root, manifest, opts.binding, admission) };
  }
  const receipt = await uploadManifest(cfg, repoId, manifest, { gzip: opts.gzip,
    queue: { enqueue: m => enqueue(root, m, opts.binding, admission) } });
  if (receipt.status === 'duplicate') {
    // The legacy server only confirms the commit/ref tuple, not this manifest's bytes.
    // Without new admission here, enqueue preserves a concurrent replacement instead of overwriting it.
    enqueue(root, manifest, opts.binding);
    throw new CodemapApiError(409, 'UNCONFIRMED_MANIFEST_DUPLICATE',
      'Stored manifest identity was not confirmed by the duplicate response; the scan remains queued.');
  }
  return receipt;
}

/**
 * Upload every queued manifest once, oldest first. `upload` is injectable for tests; it defaults to
 * uploadManifest (without a queue: a manifest is never re-queued from inside the drain).
 */
export async function drainQueue(
  root: string,
  cfg: UploadConfig,
  opts: { gzip?: boolean; upload?: typeof uploadManifest;
    onAcknowledged?: (manifest: Manifest, binding: LocalBinding, result: Extract<UploadResult, { status: 'stored' | 'duplicate' }>) => void } = {}
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
    if (!e.binding) {
      result.failed.push({ commitSha: e.commitSha, code: e.bindingError ?? 'MISSING_LOCAL_BINDING' });
      result.remaining.push(e.commitSha);
      continue;
    }
    let r: UploadResult;
    try {
      const consent = (await repositoryOptIns(cfg)).find(r => r.repoId === e.manifest.repo.id);
      if (!consent) throw new CodemapApiError(404, 'REPO_NOT_OPTED_IN', 'Repository consent was not confirmed.');
      const workspace = await fetchWorkspaceKey(cfg);
      verifyBinding(e.binding, e.manifest, cfg, workspace, consent);
      r = await upload(cfg, e.manifest.repo.id, e.manifest, { gzip: opts.gzip });
    } catch (err) {
      if (err instanceof CodemapOfflineError) {
        result.offline = true;
        result.remaining.push(e.commitSha);
        continue;
      }
      if (err instanceof CodemapApiError || err instanceof ManifestViolationError) {
        result.failed.push({ commitSha: e.commitSha, code: err.code });
        result.remaining.push(e.commitSha);
        continue;
      }
      throw err;
    }
    if (r.status === 'stored') {
      if (!dequeue(root, e.commitSha, e)) result.remaining.push(e.commitSha);
      result.uploaded.push({ commitSha: e.commitSha, status: r.status, callSites: r.callSites });
      opts.onAcknowledged?.(e.manifest, e.binding, r);
    } else if (r.status === 'duplicate') {
      result.failed.push({ commitSha: e.commitSha, code: 'UNCONFIRMED_MANIFEST_DUPLICATE' });
      result.remaining.push(e.commitSha);
    } else {
      result.offline = true;
      result.remaining.push(e.commitSha);
    }
  }
  result.remaining = listQueue(root).map(e => e.commitSha);
  return result;
}
