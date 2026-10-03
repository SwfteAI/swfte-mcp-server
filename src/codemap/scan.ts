/** Local source becomes allowlisted metadata only; workspace keys never touch disk. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { ConfinedWriter, confineDirectory } from '../fsguard.js';
import { detectProject, detectProjectWithReader, type DetectOptions } from './detect.js';
import { withNativeScanReader, type NativeScanReader } from './native-reader.js';
import { assignIds, providerOf, repoIdFromRemote, repoIdLocal, type AssignedSite } from './fingerprint.js';
import { buildManifest, checkManifest, serializeManifest } from './manifest.js';
import { drainQueue, enqueue, uploadOrQueue } from './queue.js';
import { CodemapApiError, CodemapOfflineError, fetchWorkspaceKey, optInRepository, repositoryOptIns, type UploadConfig, type UploadResult } from './upload.js';
import { DEFAULT_ENV_FILES, DEFAULT_MAX_FILES, DEFAULT_MAX_FILE_BYTES, DEFAULT_SKIP_DIRS, envFileKind, readConfined, walkProjectWithReader, WalkError } from './walk.js';
import { tagCallSites } from './tag.js';
import { provenanceForSites } from './provenance.js';
import type { Manifest, ManifestRepo, Scanner } from './types.js';
import { bindManifest, bindingError, bindingTarget, CACHE_BINDING, digest, readBinding, SCANNER_BINDING_VERSION, SCANNER_POLICY_REVISION, stableJson, verifyBinding, type LocalBinding } from './binding.js';
import type { RepositoryOptIn, WorkspaceKey } from './upload.js';

const CACHE = '.swfte/codemap/manifest.json';
const SETTINGS = '.swfte/codemap/repository.json';
const SOURCES = '.swfte/codemap/source-hashes.json';
const CALLERS = '.swfte/codemap/callers.json';

export interface ScanOptions {
  offline?: boolean; optIn?: boolean; hashPaths?: boolean; attribution?: boolean; tag?: boolean;
  scanner?: Scanner; pr?: number; detect?: DetectOptions;
}
export interface ScanResult {
  status: 'stored' | 'duplicate' | 'queued-offline';
  manifest: Manifest; queuedAt?: string; tagged: string[]; drained: number;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' } }).trim();
}
export function repositoryIdentity(root: string): { repo: ManifestRepo; commitSha: string; dirty: boolean } {
  confineDirectory('.', root);
  const commitSha = git(root, ['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('Code map needs a real Git commit.');
  let remote: string | null = null;
  try { remote = git(root, ['config', '--get', 'remote.origin.url']); } catch { /* local repository */ }
  let branch = 'main';
  try { branch = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); }
  catch { try { branch = git(root, ['symbolic-ref', '--short', 'HEAD']); } catch { /* detached HEAD */ } }
  if (!/^[A-Za-z0-9_.@:/+-]{1,128}$/.test(branch)) throw new Error('Repository branch name cannot be represented safely.');
  const first = git(root, ['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0]!;
  const id = remote ? repoIdFromRemote(remote) : repoIdLocal(root, first);
  const name = basename(root);
  const displayName = /^[A-Za-z0-9_.@:/+-]{1,128}$/.test(name) ? name : undefined;
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=all']).split('\n')
    .some(line => line && !line.slice(3).startsWith('.swfte/codemap/'));
  return { repo: { id, provider: providerOf(remote), defaultBranch: branch, ...(displayName ? { displayName } : {}) }, commitSha, dirty };
}

/** Actual HEAD blob inventory; local-only Git with protocol/lazy-fetch disabled. */
export function committedBlobs(root: string): Map<string, string> {
  const tracked = new Map<string, string>();
  for (const record of git(root, ['ls-tree', '-rz', '--full-tree', 'HEAD']).split('\0')) {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\r\n]+)$/.exec(record);
    if (match) tracked.set(match[3]!, match[2]!);
  }
  return tracked;
}

function localJson(root: string, path: string): unknown {
  const text = readConfined(new ConfinedWriter({ root }), path, 2 * 1024 * 1024);
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch { throw bindingError('INVALID_SCAN_CACHE'); }
}
function cache(root: string, manifest: Manifest, sources: Record<string, string>, binding: LocalBinding, confirmed = true): void {
  const writer = new ConfinedWriter({ root });
  // Local scan metadata alone cannot authorize a CI report. Invalidate an older receipt before
  // writing the new candidate, including when the later upload fails or remains unconfirmed.
  const receipt = writer.resolve(CACHE_BINDING);
  if (existsSync(receipt)) {
    if (!lstatSync(receipt).isFile()) throw bindingError('INVALID_LOCAL_BINDING');
    unlinkSync(writer.resolve(CACHE_BINDING));
  }
  writer.create(writer.resolve(CACHE), serializeManifest(manifest) + '\n', true);
  writer.create(writer.resolve(SETTINGS), JSON.stringify({ repoId: manifest.repo.id, pathHashing: manifest.pathHashing }) + '\n', true);
  // Local-only path/hash inventory detects a changed working tree before an offline cached manifest is reused.
  writer.create(writer.resolve(SOURCES), JSON.stringify(sources) + '\n', true);
  if (confirmed) writer.create(writer.resolve(CACHE_BINDING), stableJson(binding) + '\n', true);
  writer.commit();
}

/** Local SDK stack attribution uses only unambiguous lines; it is never uploaded. */
function cacheCallers(root: string, sites: AssignedSite[]): void {
  const groups = new Map<string, string[]>()
  for (const { site, id } of sites) {
    if (site.op === 'read-output') continue
    const key = `${site.relPath}:${site.line}`
    groups.set(key, [...(groups.get(key) ?? []), id])
  }
  const entries: Record<string, string> = {}
  for (const [key, ids] of groups) if (ids.length === 1) entries[key] = ids[0]!
  const writer = new ConfinedWriter({ root })
  writer.create(writer.resolve(CALLERS), JSON.stringify({ version: 1, root: resolve(root), entries }) + '\n', true)
  writer.commit()
}

async function sourceHashes(root: string, options?: DetectOptions): Promise<{ outcome: Awaited<ReturnType<typeof detectProject>>; hashes: Record<string, string>; sourceDigest: string; commitCurrent: boolean }> {
  return withNativeScanReader(root, reader => sourceHashesWithReader(reader, root, options));
}

/** Private borrowed pass: no network/queue await may be introduced inside this lifetime. */
async function sourceHashesWithReader(reader: NativeScanReader, root: string, options?: DetectOptions): Promise<{
  outcome: Awaited<ReturnType<typeof detectProject>>; hashes: Record<string, string>; sourceDigest: string; commitCurrent: boolean;
}> {
  const observed = new Map<string, string>();
  const outcome = await detectProjectWithReader(reader, { ...options, preprocess: file => {
    observed.set(file.relPath, createHash('sha256').update(file.text).digest('hex'));
    return options?.preprocess ? options.preprocess(file) : file;
  } });
  if (outcome.truncated) throw new Error('Source scan incomplete; no bound scan can be admitted.');
  const hashes: Record<string, string> = {};
  const tracked = committedBlobs(root);
  let commitCurrent = true;
  for (const path of [...outcome.packages.keys()].sort()) {
    const text = reader.readText(path, options?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    if (text === null) throw new Error('Source changed during scan; run it again.');
    hashes[path] = createHash('sha256').update(text).digest('hex');
    const blobHash = createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex');
    if (tracked.get(path) !== blobHash) commitCurrent = false;
    if (hashes[path] !== observed.get(path)) throw new Error('Source changed during scan; run it again.');
  }
  const context = walkProjectWithReader(reader, options);
  if (context.truncated) throw new Error('Source metadata scan incomplete; no bound scan can be admitted.');
  const metadataPaths = new Set(context.locks.map(lock => (lock.dir ? lock.dir + '/' : '') + 'swfte.json'));
  const markers = ['package.json', 'pyproject.toml', 'setup.cfg', 'pom.xml', 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'];
  for (const pkg of context.packages) {
    const directory = reader.list(pkg.dir);
    if (directory === null) throw new Error('Source metadata changed during scan; run it again.');
    const files = new Set(directory.entries.filter(entry => entry.kind === 'file').map(entry => entry.name));
    for (const marker of markers) {
      const path = (pkg.dir ? pkg.dir + '/' : '') + marker;
      if (files.has(marker)) metadataPaths.add(path);
    }
  }
  const metadataHashes: Record<string, string | null> = {};
  for (const path of [...metadataPaths].sort()) {
    if (envFileKind(basename(path), options?.envFiles ?? DEFAULT_ENV_FILES) === 'secret') {
      throw new WalkError(`Refusing to open ${path}: env files are never read by the scanner.`);
    }
    const text = reader.readText(path, DEFAULT_MAX_FILE_BYTES);
    if (text === null) throw new Error('Source metadata changed during scan; run it again.');
    metadataHashes[path] = digest(text);
    if (tracked.get(path) !== createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex')) commitCurrent = false;
  }
  const sourceDigest = digest({ hashes, sites: outcome.sites, implementations: outcome.implementations,
    packages: [...outcome.packages.entries()].sort(([a], [b]) => a.localeCompare(b)),
    envVarNames: outcome.envVarNames, notAnalysed: outcome.notAnalysed, truncated: outcome.truncated,
    locks: context.locks, metadataHashes, packageRoots: context.packages, envExampleNames: context.envExampleNames, commitCurrent });
  return { outcome, hashes, sourceDigest, commitCurrent };
}

export function scanPolicyDigest(opts: ScanOptions = {}): string {
  const d = opts.detect ?? {};
  return digest({ revision: SCANNER_POLICY_REVISION, scanner: opts.scanner ?? 'cli', skipDirs: [...(d.skipDirs ?? DEFAULT_SKIP_DIRS)].sort(),
    skipGenerated: d.skipGenerated ?? true, maxFiles: d.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: d.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, envFiles: d.envFiles ?? DEFAULT_ENV_FILES,
    customDetectors: d.detectors?.map(v => v.id) ?? null, customPreprocess: Boolean(d.preprocess) });
}

export async function currentBoundScan(root: string, cfg: UploadConfig, workspace: WorkspaceKey, consent: RepositoryOptIn): Promise<{
  manifest: Manifest; binding: LocalBinding; sourceDigest: string;
}> {
  const identity = repositoryIdentity(root);
  if (identity.dirty) throw bindingError('DIRTY_REPORT_SOURCE');
  const manifest = checkManifest(localJson(root, CACHE));
  const binding = readBinding(root, CACHE_BINDING, manifest);
  verifyBinding(binding, manifest, cfg, workspace, consent);
  const inputs = await sourceHashes(root);
  const after = repositoryIdentity(root);
  if (stableJson(manifest.repo) !== stableJson(identity.repo) || manifest.commitSha !== identity.commitSha || manifest.ref.kind !== 'default'
    || stableJson(after.repo) !== stableJson(identity.repo) || after.commitSha !== identity.commitSha || after.dirty
    || manifest.truncated || inputs.outcome.truncated || !inputs.commitCurrent || Object.values(manifest.notAnalysed).some(n => n > 0)
    || binding.sourceDigest !== inputs.sourceDigest || binding.policyDigest !== scanPolicyDigest({ scanner: manifest.scanner })) {
    throw bindingError('STALE_REPORT_SOURCE');
  }
  return { manifest, binding, sourceDigest: inputs.sourceDigest };
}

/** A cold offline scan cannot invent the HMAC key; a cached identical tree can be queued honestly. */
function offlineCached(root: string, identity: ReturnType<typeof repositoryIdentity>, inputs: Awaited<ReturnType<typeof sourceHashes>>, opts: ScanOptions, cfg: UploadConfig | null): ScanResult {
  const { repo, commitSha } = identity;
  const { hashes, sourceDigest } = inputs;
  if (identity.dirty || !inputs.commitCurrent || opts.optIn || opts.tag || opts.detect?.detectors || opts.detect?.preprocess) {
    throw new CodemapOfflineError('No matching private scan cache for changed source or unconfirmed scan settings.');
  }
  const settings = localJson(root, SETTINGS) as { repoId?: string; pathHashing?: boolean } | null;
  const previous = localJson(root, CACHE);
  const source = localJson(root, SOURCES);
  if (!settings || settings.repoId !== repo.id || !previous || JSON.stringify(source) !== JSON.stringify(hashes)) {
    throw new CodemapOfflineError('No matching private scan cache. Connect once to fetch the workspace key; no key is stored on disk.');
  }
  const manifest = checkManifest(previous);
  const binding = readBinding(root, CACHE_BINDING, manifest);
  if (manifest.commitSha !== commitSha || stableJson(manifest.repo) !== stableJson(repo) || manifest.pathHashing !== settings.pathHashing) {
    throw new CodemapOfflineError('Cached scan belongs to a different repository or tree.');
  }
  if (binding.scannerVersion !== SCANNER_BINDING_VERSION || binding.sourceDigest !== sourceDigest
    || binding.policyDigest !== scanPolicyDigest(opts) || (cfg && binding.target !== bindingTarget(cfg))
    || (opts.attribution !== undefined && opts.attribution !== binding.attribution)) {
    throw new CodemapOfflineError('Cached scan does not match the original workspace target, source or scan settings.');
  }
  if ((opts.hashPaths !== undefined && opts.hashPaths !== manifest.pathHashing)
    || (opts.pr !== undefined && opts.pr !== manifest.ref.pr) || (opts.pr === undefined && manifest.ref.kind === 'pr')) {
    throw new CodemapOfflineError('Cached scan does not match the requested privacy or branch settings.');
  }
  const after = repositoryIdentity(root);
  if (after.dirty || stableJson(after.repo) !== stableJson(repo) || after.commitSha !== commitSha) throw new CodemapOfflineError('Source changed while checking the cached scan.');
  const queuedAt = enqueue(root, manifest, binding);
  return { status: 'queued-offline', manifest, queuedAt, tagged: [], drained: 0 };
}

export async function scanRepository(root: string, cfg: UploadConfig | null, opts: ScanOptions = {}): Promise<ScanResult> {
  const identity = repositoryIdentity(root);
  if (opts.tag && opts.offline) throw new Error('Tagging requires the authenticated workspace key.');
  if (opts.pr !== undefined && (!Number.isSafeInteger(opts.pr) || opts.pr < 1 || opts.pr > 1e9)) throw new Error('Invalid pull request number.');
  const inputs = await sourceHashes(root, opts.detect);
  const { outcome, hashes } = inputs;
  if (opts.offline || !cfg) return offlineCached(root, identity, inputs, opts, cfg);
  let consent;
  try {
    consent = opts.optIn
      ? await optInRepository(cfg, identity.repo, Boolean(opts.hashPaths), Boolean(opts.attribution))
      : (await repositoryOptIns(cfg)).find(r => r.repoId === identity.repo.id);
  } catch (err) {
    if (err instanceof CodemapOfflineError) return offlineCached(root, identity, inputs, opts, cfg);
    throw err;
  }
  if (!consent) throw new CodemapApiError(404, 'REPO_NOT_OPTED_IN', 'Repository is private and has not opted in. Use swfte scan --opt-in explicitly.');
  if (opts.hashPaths !== undefined && opts.hashPaths !== consent.pathHashing) throw new Error('Path hashing disagrees with recorded repository consent.');
  if (opts.attribution !== undefined && opts.attribution !== consent.attribution) throw new Error('Attribution disagrees with recorded repository consent.');
  let workspace;
  try { workspace = await fetchWorkspaceKey(cfg); }
  catch (err) { if (err instanceof CodemapOfflineError) return offlineCached(root, identity, inputs, opts, cfg); throw err; }
  let renames: Record<string, string> = {};
  const previous = localJson(root, CACHE) as Manifest | null;
  if (previous?.commitSha && /^[0-9a-f]{40}$/.test(previous.commitSha)) {
    try {
      verifyBinding(readBinding(root, CACHE_BINDING, previous), previous, cfg, workspace, consent);
      const tokens = execFileSync('git', ['-C', root, 'diff', '-M', '--name-status', '-z', previous.commitSha, identity.commitSha],
        { encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0' } }).split('\0');
      for (let i = 0; i < tokens.length;) {
        const kind = tokens[i++]!;
        if (/^R\d+$/.test(kind)) { const old = tokens[i++]!; const next = tokens[i++]!; renames[old] = next; }
        else if (kind) i++;
      }
    } catch { renames = {}; }
  }
  const assigned = assignIds(outcome.sites, outcome.packages, workspace.key, identity.repo.id, renames);
  const rechecked = await sourceHashes(root, opts.detect);
  const checkedIdentity = repositoryIdentity(root);
  if (checkedIdentity.commitSha !== identity.commitSha || stableJson(checkedIdentity.repo) !== stableJson(identity.repo)
    || checkedIdentity.dirty !== identity.dirty || rechecked.sourceDigest !== inputs.sourceDigest) {
    throw new Error('Repository changed while checking consent; no scan was uploaded.');
  }
  const provenance = provenanceForSites(root, assigned);
  const manifest = buildManifest({ repo: identity.repo, commitSha: identity.commitSha,
    ref: opts.pr ? { kind: 'pr', pr: opts.pr } : { kind: 'default' }, scanner: opts.scanner ?? 'cli',
    pathHashing: consent.pathHashing, truncated: outcome.truncated || identity.dirty || !inputs.commitCurrent || Boolean(opts.tag),
    notAnalysed: outcome.notAnalysed, envVarNames: outcome.envVarNames, sites: assigned, key: workspace.key, provenance });
  const tagged = opts.tag ? tagCallSites(root, assigned) : [];
  // Tagging changes only metadata options but the cached tree must contain the exact new bytes.
  const finalInputs = tagged.length ? await sourceHashes(root, opts.detect) : inputs;
  const finalIdentity = repositoryIdentity(root);
  const binding = bindManifest(cfg, workspace, consent, manifest, finalInputs.sourceDigest, scanPolicyDigest(opts));
  cache(root, manifest, finalInputs.hashes, binding, false);
  cacheCallers(root, assigned);
  const acknowledged: Array<{ manifest: Manifest; binding: LocalBinding; result: Extract<UploadResult, { status: 'stored' | 'duplicate' }> }> = [];
  const drained = await drainQueue(root, cfg, { onAcknowledged: (m, b, r) => { acknowledged.push({ manifest: m, binding: b, result: r }); } });
  const latestInputs = await sourceHashes(root, opts.detect);
  const latestIdentity = repositoryIdentity(root);
  if (latestInputs.sourceDigest !== finalInputs.sourceDigest || stableJson(latestIdentity.repo) !== stableJson(finalIdentity.repo)
    || latestIdentity.commitSha !== finalIdentity.commitSha || latestIdentity.dirty !== finalIdentity.dirty) {
    throw bindingError('SOURCE_CHANGED_BEFORE_UPLOAD');
  }
  const same = acknowledged.find(a => a.binding.sourceDigest === binding.sourceDigest && a.binding.policyDigest === binding.policyDigest
    && a.binding.keyId === binding.keyId && a.binding.target === binding.target && a.binding.attribution === binding.attribution
    && stableJson({ ...a.manifest, scannedAt: null }) === stableJson({ ...manifest, scannedAt: null }));
  if (same) {
    // Keep the exact server-acknowledged manifest/timestamp; do not manufacture a newer receipt.
    cache(root, same.manifest, finalInputs.hashes, same.binding);
    return { status: same.result.status, manifest: same.manifest, tagged, drained: drained.uploaded.length };
  }
  const receipt = await uploadOrQueue(root, cfg, identity.repo.id, manifest, { binding, workspace, consent });
  if (receipt.status === 'offline') throw new Error('Upload queue was not provided.');
  if (receipt.status === 'stored') cache(root, manifest, finalInputs.hashes, binding);
  return { status: receipt.status, manifest, ...(receipt.status === 'queued-offline' ? { queuedAt: receipt.queuedAt } : {}),
    tagged, drained: drained.uploaded.length };
}
