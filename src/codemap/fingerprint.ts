/**
 * Keyed call-site fingerprints, path hashes and repo ids (docs/codemap/CONTRACT.md §2, §2.1, §2.2).
 *
 *   id       = "cs_" + hex(HMAC-SHA256(workspaceKey, "cs1\n" + repoId + "\n" + pkgId + "\n" + pkgRelPath
 *                                       + "\n" + symbol + "\n" + artifactKey + "\n" + ordinal))[0:24]
 *   pathHash = "ph_" + hex(HMAC-SHA256(workspaceKey, "path1\n" + repoId + "\n" + repoRelPath))[0:32]
 *   repo.id  = "r_"  + hex(SHA-256(normalised remote))[0:32]          (unkeyed on purpose)
 *
 * The line number is never an input: an id survives inserted lines, reformatting, comments and edits
 * in other symbols, and changes only when the call moves to another symbol or file, the enclosing
 * symbol is renamed, or a new same-artifact call appears before it in that symbol.
 *
 * The workspace key is the caller's (fetched by upload.ts, held in memory only). Nothing here touches
 * the disk or the network.
 */
import { createHash, createHmac } from 'node:crypto';
import { posix } from 'node:path';
import type { DetectedSite, Provider } from './types.js';

export const WORKSPACE_KEY_BYTES = 32;

export interface CallSiteIdParts {
  repoId: string;
  pkgId: string;
  pkgRelPath: string;
  symbol: string;
  artifactKey: string;
  ordinal: number;
}

export interface PackagePlace {
  pkgId: string;
  pkgRelPath: string;
}

export interface AssignedSite {
  site: DetectedSite;
  id: string;
  /** The id this site had under its previous path, when its file was renamed (git diff -M). */
  movedFrom?: string;
}

export class FingerprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FingerprintError';
  }
}

function keyBytes(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== WORKSPACE_KEY_BYTES) {
    throw new FingerprintError(`The workspace key must be ${WORKSPACE_KEY_BYTES} raw bytes (GET /v2/codemap/key).`);
  }
  return key;
}

/** A component that could carry a newline would let two different tuples hash the same input. */
function part(name: string, v: unknown): string {
  if (typeof v !== 'string') throw new FingerprintError(`Fingerprint input ${name} must be a string.`);
  // eslint-disable-next-line no-control-regex
  if (/[\n\r\x00]/.test(v)) throw new FingerprintError(`Fingerprint input ${name} contains a line break or NUL.`);
  return v;
}

function hmacHex(key: Uint8Array, input: string): string {
  return createHmac('sha256', keyBytes(key)).update(input, 'utf8').digest('hex');
}

/** CONTRACT §2.1. */
export function callSiteId(key: Uint8Array, p: CallSiteIdParts): string {
  if (!Number.isSafeInteger(p.ordinal) || p.ordinal < 0) throw new FingerprintError('Fingerprint ordinal must be a non-negative integer.');
  const input = [
    'cs1',
    part('repoId', p.repoId),
    part('pkgId', p.pkgId),
    part('pkgRelPath', p.pkgRelPath),
    part('symbol', p.symbol),
    part('artifactKey', p.artifactKey),
    String(p.ordinal),
  ].join('\n');
  return `cs_${hmacHex(key, input).slice(0, 24)}`;
}

/** CONTRACT §2.2. */
export function pathHash(key: Uint8Array, repoId: string, repoRelPath: string): string {
  return `ph_${hmacHex(key, `path1\n${part('repoId', repoId)}\n${part('repoRelPath', repoRelPath)}`).slice(0, 32)}`;
}

/** `kind:id`, or `kind:?` + envVarName (or bare `kind:?`) when unresolved. */
export function artifactKey(artifact: { kind: string; id: string | null; unresolved: boolean; envVarName?: string }): string {
  if (artifact.unresolved || artifact.id === null) return `${artifact.kind}:?${artifact.envVarName ?? ''}`;
  return `${artifact.kind}:${artifact.id}`;
}

/** The package roots implied by a relPath → place map: root directory ('' = scan root) → pkgId. */
function rootsOf(packages: Map<string, PackagePlace>): Map<string, string> {
  const roots = new Map<string, string>();
  for (const [relPath, place] of packages) {
    if (relPath === place.pkgRelPath) roots.set('', place.pkgId);
    else if (relPath.endsWith(`/${place.pkgRelPath}`)) roots.set(relPath.slice(0, -place.pkgRelPath.length - 1), place.pkgId);
  }
  return roots;
}

/** Nearest package root of a path given the known roots; the scan root with pkgId "." when none. */
export function placeOf(relPath: string, roots: Map<string, string>): PackagePlace {
  let best: string | null = null;
  for (const dir of roots.keys()) {
    if (dir === '' || relPath.startsWith(`${dir}/`)) {
      if (best === null || dir.length > best.length) best = dir;
    }
  }
  if (best === null) return { pkgId: '.', pkgRelPath: relPath };
  return { pkgId: roots.get(best)!, pkgRelPath: best === '' ? relPath : posix.relative(best, relPath) };
}

/**
 * Fingerprint every site. Ordinals count same-artifact calls per (file, symbol) in source order, which
 * is line order; sites on the same line keep the order the detectors reported them in (stable sort).
 * `renames` is git's {oldPath → newPath}; a site in a renamed file also gets the id it had under the
 * old path as `movedFrom`, so the server can carry its history across the move.
 */
export function assignIds(
  sites: DetectedSite[],
  packages: Map<string, PackagePlace>,
  key: Uint8Array,
  repoId: string,
  renames?: Record<string, string> | Map<string, string>
): AssignedSite[] {
  keyBytes(key);
  const oldPathOf = new Map<string, string>();
  const entries = renames instanceof Map ? [...renames.entries()] : Object.entries(renames ?? {});
  for (const [oldPath, newPath] of entries) oldPathOf.set(newPath, oldPath);
  const roots = oldPathOf.size ? rootsOf(packages) : new Map<string, string>();

  const ordered = sites
    .map((site, index) => ({ site, index }))
    .sort((a, b) => cmp(a.site.relPath, b.site.relPath) || a.site.line - b.site.line || a.index - b.index);

  const counters = new Map<string, number>();
  const out: AssignedSite[] = [];
  for (const { site } of ordered) {
    const place = packages.get(site.relPath);
    if (!place) throw new FingerprintError(`No package place for ${site.relPath}; every detected file must be in the packages map.`);
    const aKey = artifactKey(site.artifact);
    const counterKey = `${site.relPath}\n${site.symbol}\n${aKey}`;
    const ordinal = counters.get(counterKey) ?? 0;
    counters.set(counterKey, ordinal + 1);
    const id = callSiteId(key, { repoId, pkgId: place.pkgId, pkgRelPath: place.pkgRelPath, symbol: site.symbol, artifactKey: aKey, ordinal });
    const assigned: AssignedSite = { site, id };
    const oldPath = oldPathOf.get(site.relPath);
    if (oldPath !== undefined && oldPath !== site.relPath) {
      const old = placeOf(oldPath, roots);
      const previous = callSiteId(key, { repoId, pkgId: old.pkgId, pkgRelPath: old.pkgRelPath, symbol: site.symbol, artifactKey: aKey, ordinal });
      if (previous !== id) assigned.movedFrom = previous;
    }
    out.push(assigned);
  }
  return out;
}

/** Code-point order, independent of locale. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The normalised remote (CONTRACT §2): lowercase host, no scheme, no credentials, no port, no `.git`,
 * no trailing slash. `git@github.com:acme/web.git`, `ssh://git@github.com/acme/web` and
 * `https://user:token@GitHub.com/acme/web.git` all become `github.com/acme/web`.
 */
export function normaliseRemote(url: string): string {
  let s = String(url).trim();
  if (!s) throw new FingerprintError('The remote URL is empty.');
  let host: string;
  let path: string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
  if (scheme) {
    s = s.slice(scheme[0].length);
    const slash = s.indexOf('/');
    const authority = slash < 0 ? s : s.slice(0, slash);
    path = slash < 0 ? '' : s.slice(slash + 1);
    host = authority.slice(authority.lastIndexOf('@') + 1);
    host = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d*$/, '');
  } else {
    // scp-like: [user@]host:path
    const m = /^(?:[^@/]+@)?([^:/]+):(.*)$/.exec(s);
    if (!m) throw new FingerprintError('The remote URL is not a URL or an scp-style git remote.');
    host = m[1]!;
    path = m[2]!;
  }
  path = path.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '');
  host = host.toLowerCase();
  if (!host) throw new FingerprintError('The remote URL has no host.');
  return path ? `${host}/${path}` : host;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** `r_` + first 32 hex of SHA-256 of the normalised remote. */
export function repoIdFromRemote(url: string): string {
  return `r_${sha256Hex(normaliseRemote(url)).slice(0, 32)}`;
}

/** No remote: `r_` + SHA-256 of `local:` + the root's basename + the first commit SHA. */
export function repoIdLocal(absoluteRoot: string, firstCommitSha: string): string {
  const base = posix.basename(String(absoluteRoot).replace(/\\/g, '/').replace(/\/+$/, ''));
  return `r_${sha256Hex(`local:${base}${firstCommitSha}`).slice(0, 32)}`;
}

/** `provider` from the remote's host; `none` without a remote. */
export function providerOf(url: string | null | undefined): Provider {
  if (!url) return 'none';
  let host: string;
  try {
    host = normaliseRemote(url).split('/')[0]!;
  } catch {
    return 'other';
  }
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return 'gitlab';
  if (host === 'bitbucket.org' || host.startsWith('bitbucket.')) return 'bitbucket';
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com') || host === 'ssh.dev.azure.com') return 'azure';
  return 'other';
}
