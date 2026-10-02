/** Local queue/cache context. Only metadata and a domain-separated MAC reach disk. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ConfinedWriter } from '../fsguard.js';
import { PACKAGE_VERSION } from '../version.js';
import { checkManifest, serializeManifest } from './manifest.js';
import type { Manifest } from './types.js';
import { CodemapApiError, credentialTarget, type RepositoryOptIn, type UploadConfig, type WorkspaceKey } from './upload.js';
import { readConfined } from './walk.js';

export const CACHE_BINDING = '.swfte/codemap/cache-binding.json';
export const QUEUE_BINDINGS = '.swfte/codemap/queue-bindings';
/** Bump on every semantic detector/pin/cache-policy change, even before a package release. */
export const SCANNER_POLICY_REVISION = 'codemap-20261002-opaque-pins-stored-ack-4';
export const SCANNER_BINDING_VERSION = PACKAGE_VERSION + '+' + SCANNER_POLICY_REVISION;
const DOMAIN = 'swfte.codemap/local-binding/1\n';
const HEX = /^[0-9a-f]{64}$/;
const KEYS = ['version', 'target', 'keyId', 'repoId', 'commitSha', 'ref', 'pathHashing', 'attribution',
  'manifestDigest', 'sourceDigest', 'policyDigest', 'scannerVersion', 'mac'];

export interface LocalBinding {
  readonly version: 1;
  readonly target: string;
  readonly keyId: string;
  readonly repoId: string;
  readonly commitSha: string;
  readonly ref: Manifest['ref'];
  readonly pathHashing: boolean;
  readonly attribution: boolean;
  readonly manifestDigest: string;
  readonly sourceDigest: string;
  readonly policyDigest: string;
  readonly scannerVersion: string;
  readonly mac: string;
}

export function bindingError(code: string): CodemapApiError {
  return new CodemapApiError(0, code, 'Code-map context could not be confirmed; no manifest or CI result was sent.');
}

/** Fixed recursive key ordering; no source text is written by this helper. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().filter(k => row[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stableJson(row[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

export function bindingTarget(cfg: UploadConfig): string {
  const u = new URL(credentialTarget(cfg));
  if (u.username || u.password || u.search || u.hash) throw bindingError('INVALID_BINDING_TARGET');
  return u.toString().replace(/\/+$/, '');
}

export function manifestDigest(manifest: Manifest): string {
  return digest(serializeManifest(checkManifest(manifest)));
}

function payload(binding: Omit<LocalBinding, 'mac'> | LocalBinding): Omit<LocalBinding, 'mac'> {
  return { version: binding.version, target: binding.target, keyId: binding.keyId,
    repoId: binding.repoId, commitSha: binding.commitSha, ref: { ...binding.ref },
    pathHashing: binding.pathHashing, attribution: binding.attribution,
    manifestDigest: binding.manifestDigest, sourceDigest: binding.sourceDigest,
    policyDigest: binding.policyDigest, scannerVersion: binding.scannerVersion };
}

function mac(binding: Omit<LocalBinding, 'mac'>, workspace: WorkspaceKey): string {
  if (!(workspace.key instanceof Uint8Array) || workspace.key.length !== 32) throw bindingError('INVALID_WORKSPACE_KEY');
  return createHmac('sha256', workspace.key).update(DOMAIN).update(stableJson(payload(binding))).digest('hex');
}

export function bindManifest(cfg: UploadConfig, workspace: WorkspaceKey, consent: RepositoryOptIn,
  manifest: Manifest, sourceDigest: string, policyDigest: string): LocalBinding {
  const checked = checkManifest(manifest);
  if (consent.repoId !== checked.repo.id || consent.pathHashing !== checked.pathHashing
    || typeof consent.attribution !== 'boolean' || !HEX.test(sourceDigest) || !HEX.test(policyDigest)) {
    throw bindingError('BINDING_CONTEXT_MISMATCH');
  }
  const value: Omit<LocalBinding, 'mac'> = { version: 1, target: bindingTarget(cfg), keyId: workspace.keyId,
    repoId: checked.repo.id, commitSha: checked.commitSha, ref: { ...checked.ref },
    pathHashing: consent.pathHashing, attribution: consent.attribution,
    manifestDigest: manifestDigest(checked), sourceDigest, policyDigest, scannerVersion: SCANNER_BINDING_VERSION };
  return checkBinding({ ...value, mac: mac(value, workspace) }, checked);
}

export function checkBinding(raw: unknown, manifest: Manifest): LocalBinding {
  const fail = () => { throw bindingError('INVALID_LOCAL_BINDING'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).length !== KEYS.length || Object.keys(row).some(k => !KEYS.includes(k))
    || row.version !== 1 || typeof row.target !== 'string' || row.target.length > 512
    || typeof row.keyId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(row.keyId)
    || typeof row.pathHashing !== 'boolean' || typeof row.attribution !== 'boolean'
    || typeof row.scannerVersion !== 'string' || !/^[A-Za-z0-9_.+-]{1,64}$/.test(row.scannerVersion)
    || ['manifestDigest', 'sourceDigest', 'policyDigest', 'mac'].some(k => typeof row[k] !== 'string' || !HEX.test(row[k] as string))) return fail();
  let target: URL;
  try { target = new URL(row.target); } catch { return fail(); }
  if (target.username || target.password || target.search || target.hash
    || target.toString().replace(/\/+$/, '') !== row.target) return fail();
  const checked = checkManifest(manifest);
  if (row.repoId !== checked.repo.id || row.commitSha !== checked.commitSha
    || row.pathHashing !== checked.pathHashing || stableJson(row.ref) !== stableJson(checked.ref)
    || row.manifestDigest !== manifestDigest(checked)) return fail();
  // Reconstruct the closed record so prototypes, unknown ref fields and object aliases cannot escape.
  const out = payload(row as unknown as LocalBinding);
  return Object.freeze({ ...out, ref: Object.freeze({ ...checked.ref }), mac: row.mac as string });
}

export function verifyBinding(binding: LocalBinding, manifest: Manifest, cfg: UploadConfig,
  workspace: WorkspaceKey, consent: RepositoryOptIn): void {
  const checked = checkBinding(binding, manifest);
  if (checked.target !== bindingTarget(cfg) || checked.keyId !== workspace.keyId
    || checked.scannerVersion !== SCANNER_BINDING_VERSION || consent.repoId !== checked.repoId
    || consent.pathHashing !== checked.pathHashing || consent.attribution !== checked.attribution) {
    throw bindingError('BINDING_CONTEXT_MISMATCH');
  }
  const expected = Buffer.from(mac(payload(checked), workspace), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(checked.mac, 'hex'))) throw bindingError('BINDING_CONTEXT_MISMATCH');
}

export function compatibleBindings(a: LocalBinding, b: LocalBinding): boolean {
  return a.version === b.version && a.target === b.target && a.keyId === b.keyId
    && a.repoId === b.repoId && a.commitSha === b.commitSha && stableJson(a.ref) === stableJson(b.ref)
    && a.pathHashing === b.pathHashing && a.attribution === b.attribution
    && a.policyDigest === b.policyDigest && a.scannerVersion === b.scannerVersion;
}

export function readBinding(root: string, rel: string, manifest: Manifest): LocalBinding {
  const text = readConfined(new ConfinedWriter({ root }), rel, 16 * 1024);
  if (text === null) throw bindingError('MISSING_LOCAL_BINDING');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw bindingError('INVALID_LOCAL_BINDING'); }
  return checkBinding(parsed, manifest);
}

export function queueBindingPath(commitSha: string): string {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw bindingError('INVALID_QUEUE_COMMIT');
  return `${QUEUE_BINDINGS}/${commitSha}.json`;
}
