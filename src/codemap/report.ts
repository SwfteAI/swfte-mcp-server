/** CI reports bind actual verification to current source; only closed metadata is sent. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isPinnable, isSafeVersionPin, lookupPinnedVersion, verifyProject, versionedInvokePath, type VerifyReport } from '../bake.js';
import { ConfinedWriter } from '../fsguard.js';
import { loadLock, LOCK_FILE, normalizeRel, type LockArtifact } from '../lock.js';
import { effectiveContractHash, getContract, parseCatalogRef, sameHash, type CatalogContract } from '../catalog.js';
import { snake } from '../codegen.js';
import { SwfteApiError, SwfteClient } from '../client.js';
import type { ServerConfig } from '../config.js';
import { committedBlobs, currentBoundScan, repositoryIdentity } from './scan.js';
import { fetchWorkspaceKey, postVerifyResult, repositoryOptIns, type UploadConfig } from './upload.js';
import { bindingError, bindingTarget, digest, stableJson } from './binding.js';
import { readConfined } from './walk.js';

export interface VerificationSnapshot {
  readonly version: 1;
  readonly target: string;
  readonly keyId: string;
  readonly repoId: string;
  readonly commitSha: string;
  readonly manifestDigest: string;
  readonly sourceDigest: string;
  readonly lockDigest: string;
  readonly generatedFilesDigest: string;
  readonly pathHashing: boolean;
  readonly attribution: boolean;
  readonly artifacts: ReadonlyArray<{
    alias: string; catalogRef: string; contractHash: string; pinnedVersion: string | null;
  }>;
}

interface MeasuredReport {
  root: string;
  snapshot: VerificationSnapshot;
  reportDigest: string;
  report: VerifyReport;
  client: SwfteClient;
  cfg: UploadConfig;
  contextDigest: string;
  assertInputContext: () => void;
}
const measured = new WeakMap<VerifyReport, MeasuredReport>();
// The existing lookup helper preserves fallback schema references for null schema fields.
// Use a private sentinel so its compatibility fallback can never stand in for a version schema.
const MISSING_PIN_SCHEMA = Object.freeze({});

function transportBinding(cfg: UploadConfig): string {
  return digest([bindingTarget(cfg), cfg.workspaceId ?? null, cfg.credentialKind, digest(cfg.credential)]);
}

/** Own every transport field before the first await; caller objects never become request inputs. */
function privateConfig(cfg: UploadConfig): UploadConfig {
  return Object.freeze({ ...cfg, env: Object.freeze({ ...(cfg.env ?? process.env) }) });
}

function assertMeasured(state: MeasuredReport, cfg: UploadConfig, report: VerifyReport): void {
  state.assertInputContext();
  if (state.contextDigest !== transportBinding(cfg) || state.reportDigest !== digest(report)) {
    throw bindingError('UNMEASURED_REPORT_CONTEXT');
  }
}

function lockSnapshot(writer: ConfinedWriter, cfg: UploadConfig): {
  artifacts: LockArtifact[]; lockDigest: string; generatedFilesDigest: string;
} {
  const bytes = readConfined(writer, LOCK_FILE, 2 * 1024 * 1024);
  if (bytes === null) throw bindingError('MISSING_REPORT_LOCK');
  const loaded = loadLock(writer, { baseUrl: cfg.baseUrl, workspaceId: cfg.workspaceId ?? null });
  if (!loaded.exists || loaded.migrated || !loaded.lock.artifacts.length
    || bindingTarget({ ...cfg, baseUrl: loaded.lock.baseUrl }) !== bindingTarget(cfg)
    || (cfg.workspaceId && loaded.lock.workspaceId && cfg.workspaceId !== loaded.lock.workspaceId)) {
    throw bindingError('REPORT_LOCK_CONTEXT_MISMATCH');
  }
  const paths = new Set<string>();
  for (const artifact of loaded.lock.artifacts) {
    for (const path of artifact.files) paths.add(normalizeRel(path));
    const name = artifact.language === 'typescript' ? artifact.alias + '.ts' : snake(artifact.alias, 'artifact') + '.py';
    paths.add(normalizeRel(artifact.outDir + '/' + name));
  }
  if (paths.size > 5000) throw bindingError('UNBOUNDED_REPORT_INPUT');
  const files: Record<string, string | null> = {};
  const tracked = committedBlobs(writer.root);
  let total = 0;
  for (const path of [...paths].sort()) {
    const absolute = writer.resolve(path);
    if (!fs.existsSync(absolute)) {
      if (tracked.has(path)) throw bindingError('DIRTY_REPORT_SOURCE');
      files[path] = null; continue;
    }
    const stat = fs.lstatSync(absolute);
    total += stat.size;
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || total > 32 * 1024 * 1024) throw bindingError('UNBOUNDED_REPORT_INPUT');
    const text = readConfined(writer, path, 2 * 1024 * 1024);
    if (text === null) throw bindingError('UNREADABLE_REPORT_INPUT');
    if (tracked.get(path) !== createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex')) throw bindingError('DIRTY_REPORT_SOURCE');
    files[path] = digest(text);
  }
  return { artifacts: loaded.lock.artifacts, lockDigest: digest(bytes), generatedFilesDigest: digest(files) };
}

async function capture(root: string, cfg: UploadConfig): Promise<VerificationSnapshot> {
  const identity = repositoryIdentity(root);
  if (identity.dirty) throw bindingError('DIRTY_REPORT_SOURCE');
  const consent = (await repositoryOptIns(cfg)).find(r => r.repoId === identity.repo.id);
  if (!consent) throw bindingError('REPORT_REPO_NOT_OPTED_IN');
  const workspace = await fetchWorkspaceKey(cfg);
  const scan = await currentBoundScan(root, cfg, workspace, consent);
  const local = lockSnapshot(new ConfinedWriter({ root }), cfg);
  const after = repositoryIdentity(root);
  if (after.dirty || after.repo.id !== identity.repo.id || after.commitSha !== identity.commitSha) throw bindingError('STALE_REPORT_SOURCE');
  return Object.freeze({ version: 1 as const, target: bindingTarget(cfg), keyId: workspace.keyId,
    repoId: identity.repo.id, commitSha: identity.commitSha, manifestDigest: scan.binding.manifestDigest,
    sourceDigest: scan.sourceDigest, lockDigest: local.lockDigest, generatedFilesDigest: local.generatedFilesDigest,
    pathHashing: consent.pathHashing, attribution: consent.attribution,
    artifacts: Object.freeze(local.artifacts.map(a => Object.freeze({ alias: a.alias, catalogRef: a.catalogRef,
      contractHash: a.contractHash, pinnedVersion: a.pinnedVersion }))) });
}

function matches(snapshot: VerificationSnapshot, current: VerificationSnapshot): void {
  if (stableJson(snapshot) !== stableJson(current)) throw bindingError('STALE_REPORT_CONTEXT');
}

function applies(problem: VerifyReport['problems'][number], alias: string, ref: string): boolean {
  return (problem.catalogRef === null || problem.catalogRef === ref)
    && (problem.alias === null || problem.alias.split(',').includes(alias));
}

function exactPinPath(artifact: VerificationSnapshot['artifacts'][number]): string | null {
  if (artifact.pinnedVersion === null) return null;
  // isPinnable/versionedInvokePath throw a LockError on a malformed recorded pin; a report must refuse it as
  // an unconfirmed context (no request, no report), not surface the lock diagnostic.
  let path: string;
  try {
    if (!isPinnable(artifact.catalogRef, artifact.pinnedVersion)
      || !isSafeVersionPin(artifact.pinnedVersion)) throw bindingError('UNCONFIRMED_REPORT_PIN');
    path = versionedInvokePath(parseCatalogRef(artifact.catalogRef).id, artifact.pinnedVersion);
  } catch { throw bindingError('UNCONFIRMED_REPORT_PIN'); }
  if (new URL(path, 'https://codemap.invalid').pathname !== path) throw bindingError('UNCONFIRMED_REPORT_PIN');
  return path;
}

/** Exact published-version check. No live contract is substituted for a missing pin. */
async function confirmPins(client: SwfteClient, snapshot: VerificationSnapshot, report: VerifyReport): Promise<void> {
  const checked = new Set<string>();
  for (const artifact of snapshot.artifacts) {
    if (artifact.pinnedVersion === null) continue;
    const invokePath = exactPinPath(artifact);
    const key = stableJson([artifact.catalogRef, artifact.pinnedVersion, artifact.contractHash]);
    if (checked.has(key)) continue;
    checked.add(key);
    const failedPin = report.exitCode === 1 && report.problems.some(p => p.kind === 'vanished'
      && applies(p, artifact.alias, artifact.catalogRef));
    let fallback: CatalogContract;
    try { fallback = await getContract(client, parseCatalogRef(artifact.catalogRef)); }
    catch (err) {
      if (!failedPin || !(err instanceof SwfteApiError) || err.status !== 404) throw bindingError('UNCONFIRMED_REPORT_PIN');
      // Only a known missing-pin failure can use this placeholder, never a published hash.
      fallback = { catalogRef: artifact.catalogRef, invoke: { method: 'POST', path: '', auth: 'api_key', async: true, statusPath: null },
        inputSchema: {}, outputSchema: {} };
    }
    let found: Awaited<ReturnType<typeof lookupPinnedVersion>>;
    try { found = await lookupPinnedVersion(client, artifact.catalogRef, artifact.pinnedVersion,
      { ...fallback, inputSchema: MISSING_PIN_SCHEMA, outputSchema: MISSING_PIN_SCHEMA }); }
    catch { throw bindingError('UNCONFIRMED_REPORT_PIN'); }
    if (found.state === 'unsupported') throw bindingError('UNCONFIRMED_REPORT_PIN');
    if (found.state !== 'published') {
      if (!failedPin) throw bindingError('REPORT_PIN_CHANGED');
      continue;
    }
    if (found.contract.invoke.path !== invokePath) {
      throw bindingError('REPORT_PIN_ROUTE_MISMATCH');
    }
    const isSchema = (value: unknown) => typeof value === 'boolean'
      || (value !== null && typeof value === 'object' && !Array.isArray(value));
    if (found.contract.inputSchema === MISSING_PIN_SCHEMA || found.contract.outputSchema === MISSING_PIN_SCHEMA
      || !isSchema(found.contract.inputSchema) || !isSchema(found.contract.outputSchema)) throw bindingError('UNCONFIRMED_REPORT_PIN');
    // bakeArtifact records the catalog/live-route hash, even when its generated client is pinned.
    // Normalize only that route for the hash adapter; schemas and other published invoke metadata
    // still come from the exact requested version. No live schema or invoke call is substituted.
    const hashContract = { ...found.contract, contractHash: null,
      invoke: { ...found.contract.invoke, path: fallback.invoke.path } };
    if (!sameHash(artifact.contractHash, effectiveContractHash(hashContract).hash)) throw bindingError('REPORT_PIN_HASH_MISMATCH');
  }
}

/** Root CLI supplies its existing client and that client's exact trusted config. */
export async function verifyProjectWithSnapshot(ctx: Omit<Parameters<typeof verifyProject>[0], 'config'> & { config?: ServerConfig }, cfg: UploadConfig,
  opts: Parameters<typeof verifyProject>[1] = {}): Promise<VerifyReport> {
  if (opts?.offline || !ctx.client || ctx.writer.inline) throw bindingError('UNMEASURED_REPORT_CONTEXT');
  if (!ctx.config) throw bindingError('REPORT_CLIENT_CONTEXT_MISMATCH');
  const inputConfig = ctx.config;
  const inputClient = ctx.client;
  const contextDigest = transportBinding(cfg);
  const assertInputContext = () => {
    if (transportBinding(cfg) !== contextDigest || transportBinding(inputConfig) !== contextDigest
      || bindingTarget({ ...cfg, baseUrl: inputClient.baseUrl }) !== bindingTarget(cfg)
      || inputClient.configuredWorkspaceId !== cfg.workspaceId
      || inputClient.credentialKind !== cfg.credentialKind) throw bindingError('REPORT_CLIENT_CONTEXT_MISMATCH');
  };
  assertInputContext();
  const ownedConfig = privateConfig(cfg);
  // A supplied client does not expose its private credential. Build the actual verification
  // transport from the matched config instead of granting authority to a caller's client.
  const client = new SwfteClient(Object.freeze({ ...inputConfig, baseUrl: ownedConfig.baseUrl,
    credential: ownedConfig.credential, credentialKind: ownedConfig.credentialKind,
    workspaceId: ownedConfig.workspaceId }));
  const root = ctx.writer.root;
  const before = await capture(root, ownedConfig);
  assertInputContext();
  for (const artifact of before.artifacts) exactPinPath(artifact);
  const report = await verifyProject({ ...ctx, config: Object.freeze({ ...inputConfig }), client }, opts);
  const sealedReport = structuredClone(report);
  const reportDigest = digest(sealedReport);
  matches(before, await capture(root, ownedConfig));
  assertInputContext();
  await confirmPins(client, before, sealedReport);
  assertInputContext();
  matches(before, await capture(root, ownedConfig));
  assertInputContext();
  if (reportDigest !== digest(report)) throw bindingError('UNMEASURED_REPORT_CONTEXT');
  measured.set(report, { root, snapshot: before, reportDigest, report: sealedReport,
    client, cfg: ownedConfig, contextDigest, assertInputContext });
  return report;
}

/** Persist actual failing and unchecked outcomes too; diagnostics and source never cross the wire. */
export async function reportVerification(root: string, cfg: UploadConfig, report: VerifyReport, overallExitCode: number = report.exitCode): Promise<number> {
  if (![0, 1, 2].includes(overallExitCode)) throw new Error('Invalid CI outcome.');
  const state = measured.get(report);
  if (!state || state.root !== new ConfinedWriter({ root }).root) throw bindingError('UNMEASURED_REPORT_CONTEXT');
  assertMeasured(state, cfg, report);
  const sealedReport = state.report;
  if ((sealedReport.exitCode === 1 && overallExitCode !== 1) || (sealedReport.exitCode === 2 && overallExitCode === 0)) throw bindingError('WEAKENED_REPORT_OUTCOME');
  matches(state.snapshot, await capture(root, state.cfg));
  assertMeasured(state, cfg, report);
  await confirmPins(state.client, state.snapshot, sealedReport);
  assertMeasured(state, cfg, report);
  matches(state.snapshot, await capture(root, state.cfg));
  assertMeasured(state, cfg, report);
  let stored = 0;
  for (const artifact of state.snapshot.artifacts) {
    matches(state.snapshot, await capture(root, state.cfg));
    assertMeasured(state, cfg, report);
    const problems = sealedReport.problems.filter(p => applies(p, artifact.alias, artifact.catalogRef));
    const failed = problems.some(p => !['lock', 'unreachable'].includes(p.kind));
    const unchecked = !sealedReport.remoteChecked || problems.some(p => ['lock', 'unreachable'].includes(p.kind));
    const status = overallExitCode === 1 || failed ? 'fail' : overallExitCode === 2 || unchecked ? 'unchecked' : 'pass';
    const drift = [...new Set(problems.map(p => p.kind))].sort();
    await postVerifyResult(state.cfg, { repoId: state.snapshot.repoId, commitSha: state.snapshot.commitSha,
      artifactRef: artifact.catalogRef, alias: artifact.alias, status, drift });
    stored++;
  }
  return stored;
}
