/**
 * The manifest allowlist serializer (docs/codemap/CONTRACT.md §3; mirrors the server's
 * `codemap/manifest.schema.json`, where every object is closed).
 *
 * This is the one gate between what the scanner saw and what leaves the machine, so it is written as
 * an allowlist, never as a filter:
 *   - every output object is built field by field, by name, from a checked primitive; no input object
 *     is ever spread, cloned or handed to JSON.stringify;
 *   - a key the contract does not name, anywhere, is refused (not dropped): an extra field means a
 *     caller is trying to ship something the contract does not allow;
 *   - every bound of §3 is checked here, before the server sees it, and a violation throws a
 *     ManifestViolationError that names the JSON pointer and never the offending value.
 */
import { pathHash } from './fingerprint.js';
import type { AssignedSite } from './fingerprint.js';
import {
  MANIFEST_SCHEMA,
  type AddedBy,
  type CallSite,
  type Manifest,
  type ManifestRepo,
  type Provenance,
  type Scanner,
} from './types.js';

export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MAX_CALL_SITES = 5000;
export const MAX_ENV_VAR_NAMES = 128;
export const MAX_NOT_ANALYSED_KEYS = 16;
export const MAX_KEYS = 64;

export type ViolationCode = 'ALLOWLIST_VIOLATION' | 'MANIFEST_TOO_LARGE';

export class ManifestViolationError extends Error {
  readonly code: ViolationCode;
  /** RFC 6901 pointer into the manifest ('' = the whole document). Never the value. */
  readonly pointer: string;
  constructor(code: ViolationCode, pointer: string, rule: string) {
    super(`${code} at ${pointer || '(document)'}: ${rule}`);
    this.name = 'ManifestViolationError';
    this.code = code;
    this.pointer = pointer;
  }
}

// Patterns copied from manifest.schema.json (the server enforces the same ones).
const RE = {
  repoId: /^r_[0-9a-f]{32}$/,
  generic: /^[A-Za-z0-9_.@:/+-]+$/,
  commitSha: /^[0-9a-f]{40}$/,
  isoUtc: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/,
  notAnalysedKey: /^[a-z][a-z0-9-]{0,31}$/,
  envVarName: /^[A-Z][A-Z0-9_]{0,63}$/,
  callSiteId: /^cs_[0-9a-f]{24}$/,
  path: /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/@+()[\]~-]+$/,
  pathHash: /^ph_[0-9a-f]{32}$/,
  symbol: /^[A-Za-z0-9_$.<>#:-]+$/,
  kind: /^[a-z][a-z0-9_-]{0,31}$/,
  artifactId: /^[A-Za-z0-9_.@:-]{1,128}$/,
  siteEnvVar: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  pinnedVersion: /^[A-Za-z0-9:_.+@-]+$/,
  alias: /^[a-z0-9][a-z0-9-]{0,62}$/,
  contractHash: /^[0-9a-f]{7,64}$/,
  keyName: /^(\*|[A-Za-z_$][A-Za-z0-9_$-]*(\.[A-Za-z_$][A-Za-z0-9_$-]*)*)$/,
};

const PROVIDERS = ['github', 'gitlab', 'bitbucket', 'azure', 'other', 'none'] as const;
const SCANNERS = ['cli', 'mcp', 'ci', 'agent'] as const;
const LANGUAGES = ['typescript', 'javascript', 'python', 'java', 'html'] as const;
const SDKS = ['node', 'python', 'java', 'http', 'widget-embed'] as const;
const OPS = ['run', 'chat', 'stream', 'embed', 'read-output', 'webhook-receive'] as const;
const MANAGED = ['typed-client', 'raw-http'] as const;
const ADDED_BY = ['claude-code', 'codex', 'human', 'studio'] as const;
const VIA = ['mcp', 'cli'] as const;
const REF_KINDS = ['default', 'pr'] as const;

const TOP_KEYS = ['schema', 'repo', 'commitSha', 'ref', 'scannedAt', 'scanner', 'pathHashing', 'truncated', 'notAnalysed', 'envVarNames', 'callSites'];
const REPO_KEYS = ['id', 'displayName', 'provider', 'defaultBranch'];
const REF_KEYS = ['kind', 'pr'];
const SITE_KEYS = ['id', 'movedFrom', 'path', 'pathHash', 'line', 'symbol', 'language', 'sdk', 'op', 'artifact', 'contractHash', 'inputKeys', 'outputKeys', 'managed', 'provenance'];
const ARTIFACT_KEYS = ['kind', 'id', 'unresolved', 'envVarName', 'pinnedVersion', 'alias', 'environment'];
const PROVENANCE_KEYS = ['addedBy', 'via', 'pr', 'at'];

const ptr = (base: string, key: string | number) => `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const fail = (pointer: string, rule: string): never => {
  throw new ManifestViolationError('ALLOWLIST_VIOLATION', pointer, rule);
};

/** A plain object whose own keys are all in `allowed` (null: any string key, e.g. a language map). */
function obj(v: unknown, at: string, allowed: readonly string[] | null): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(at, 'must be an object');
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) fail(at, 'must be a plain object');
  const o = v as Record<string, unknown>;
  // Own keys of every kind, symbols included: anything the contract does not name is refused.
  for (const k of Reflect.ownKeys(o)) {
    if (typeof k !== 'string' || (allowed !== null && !allowed.includes(k))) fail(ptr(at, typeof k === 'string' ? k : '(symbol)'), 'is not a contract field');
  }
  return o;
}

function has(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
}

function str(v: unknown, at: string, re: RegExp, max = 128): string {
  if (typeof v !== 'string') fail(at, 'must be a string');
  const s = v as string;
  if (s.length === 0 || s.length > max) fail(at, `must be 1..${max} characters`);
  if (!re.test(s)) fail(at, 'does not match its pattern');
  return s;
}

function nullableStr(v: unknown, at: string, re: RegExp, max = 128): string | null {
  return v === null ? null : str(v, at, re, max);
}

function oneOf<T extends string>(v: unknown, at: string, values: readonly T[]): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) fail(at, `must be one of ${values.join('|')}`);
  return v as T;
}

function bool(v: unknown, at: string): boolean {
  if (typeof v !== 'boolean') fail(at, 'must be a boolean');
  return v as boolean;
}

function int(v: unknown, at: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(at, `must be an integer ${min}..${max}`);
  return v as number;
}

function arr(v: unknown, at: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(at, 'must be an array');
  const a = v as unknown[];
  if (a.length > max) fail(at, `must hold at most ${max} items`);
  // Sparse arrays and extra own properties would be skipped by a copy and hide a field.
  if (Reflect.ownKeys(a).length !== a.length + 1) fail(at, 'must be a plain dense array');
  return a;
}

function keys(v: unknown, at: string): string[] {
  const a = arr(v, at, MAX_KEYS);
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) out.push(str(a[i], ptr(at, i), RE.keyName, 128));
  if (new Set(out).size !== out.length) fail(at, 'must not repeat a key');
  if (out.includes('*') && out.length !== 1) fail(at, 'the wildcard "*" must stand alone');
  return out;
}

function copyRepo(v: unknown, at: string): ManifestRepo {
  const o = obj(v, at, REPO_KEYS);
  const repo: ManifestRepo = {
    id: str(o.id, ptr(at, 'id'), RE.repoId),
    provider: oneOf(o.provider, ptr(at, 'provider'), PROVIDERS),
    defaultBranch: str(o.defaultBranch, ptr(at, 'defaultBranch'), RE.generic),
  };
  if (has(o, 'displayName')) {
    const displayName = str(o.displayName, ptr(at, 'displayName'), RE.generic);
    return { id: repo.id, displayName, provider: repo.provider, defaultBranch: repo.defaultBranch };
  }
  return repo;
}

function copyRef(v: unknown, at: string): Manifest['ref'] {
  const o = obj(v, at, REF_KEYS);
  const kind = oneOf(o.kind, ptr(at, 'kind'), REF_KINDS);
  if (!has(o, 'pr')) return { kind };
  if (kind !== 'pr') fail(ptr(at, 'pr'), 'is only allowed when kind is "pr"');
  return { kind, pr: int(o.pr, ptr(at, 'pr'), 1, 1_000_000_000) };
}

function copyProvenance(v: unknown, at: string): Provenance {
  const o = obj(v, at, PROVENANCE_KEYS);
  const addedBy: AddedBy = oneOf(o.addedBy, ptr(at, 'addedBy'), ADDED_BY);
  const via = oneOf(o.via, ptr(at, 'via'), VIA);
  const pr = has(o, 'pr') ? int(o.pr, ptr(at, 'pr'), 1, 1_000_000_000) : undefined;
  const at_ = str(o.at, ptr(at, 'at'), RE.isoUtc, 40);
  return pr === undefined ? { addedBy, via, at: at_ } : { addedBy, via, pr, at: at_ };
}

function copyArtifact(v: unknown, at: string): CallSite['artifact'] {
  const o = obj(v, at, ARTIFACT_KEYS);
  for (const k of ['kind', 'id', 'unresolved', 'pinnedVersion', 'alias', 'environment']) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) fail(ptr(at, k), 'is required');
  }
  const kind = str(o.kind, ptr(at, 'kind'), RE.kind, 32);
  const id = nullableStr(o.id, ptr(at, 'id'), RE.artifactId, 128);
  const unresolved = bool(o.unresolved, ptr(at, 'unresolved'));
  if ((id === null) !== unresolved) fail(ptr(at, 'id'), 'must be null exactly when unresolved is true');
  const envVarName = has(o, 'envVarName') ? str(o.envVarName, ptr(at, 'envVarName'), RE.siteEnvVar, 64) : undefined;
  const pinnedVersion = nullableStr(o.pinnedVersion, ptr(at, 'pinnedVersion'), RE.pinnedVersion, 80);
  const alias = nullableStr(o.alias, ptr(at, 'alias'), RE.alias, 63);
  if (o.environment !== null) fail(ptr(at, 'environment'), 'must be null (the backend fills it on read)');
  if (envVarName !== undefined) return { kind, id, unresolved, envVarName, pinnedVersion, alias, environment: null };
  return { kind, id, unresolved, pinnedVersion, alias, environment: null };
}

function copySite(v: unknown, at: string, hashed: boolean): CallSite {
  const o = obj(v, at, SITE_KEYS);
  const id = str(o.id, ptr(at, 'id'), RE.callSiteId);
  const movedFrom = has(o, 'movedFrom') ? str(o.movedFrom, ptr(at, 'movedFrom'), RE.callSiteId) : undefined;
  let place: { path: string } | { pathHash: string };
  if (hashed) {
    if (has(o, 'path')) fail(ptr(at, 'path'), 'must not be sent when pathHashing is true');
    place = { pathHash: str(o.pathHash, ptr(at, 'pathHash'), RE.pathHash) };
  } else {
    if (has(o, 'pathHash')) fail(ptr(at, 'pathHash'), 'must not be sent when pathHashing is false');
    place = { path: str(o.path, ptr(at, 'path'), RE.path, 400) };
  }
  const site: CallSite = {
    id,
    ...(movedFrom !== undefined ? { movedFrom } : {}),
    ...place,
    line: int(o.line, ptr(at, 'line'), 1, 10_000_000),
    symbol: str(o.symbol, ptr(at, 'symbol'), RE.symbol, 128),
    language: oneOf(o.language, ptr(at, 'language'), LANGUAGES),
    sdk: oneOf(o.sdk, ptr(at, 'sdk'), SDKS),
    op: oneOf(o.op, ptr(at, 'op'), OPS),
    artifact: copyArtifact(o.artifact, ptr(at, 'artifact')),
    contractHash: Object.prototype.hasOwnProperty.call(o, 'contractHash')
      ? nullableStr(o.contractHash, ptr(at, 'contractHash'), RE.contractHash, 64)
      : fail(ptr(at, 'contractHash'), 'is required'),
    inputKeys: keys(o.inputKeys, ptr(at, 'inputKeys')),
    outputKeys: keys(o.outputKeys, ptr(at, 'outputKeys')),
    managed: oneOf(o.managed, ptr(at, 'managed'), MANAGED),
  };
  if (has(o, 'provenance')) site.provenance = copyProvenance(o.provenance, ptr(at, 'provenance'));
  return site;
}

/**
 * Validate `m` against every bound of CONTRACT §3 and return a fresh copy built only from contract
 * fields. Throws ManifestViolationError (pointer, never value) on the first violation.
 */
export function checkManifest(m: unknown): Manifest {
  const o = obj(m, '', TOP_KEYS);
  for (const k of TOP_KEYS) if (!Object.prototype.hasOwnProperty.call(o, k)) fail(ptr('', k), 'is required');
  if (o.schema !== MANIFEST_SCHEMA) fail('/schema', `must be "${MANIFEST_SCHEMA}"`);
  const pathHashing = bool(o.pathHashing, '/pathHashing');

  const na = obj(o.notAnalysed, '/notAnalysed', null);
  const naKeys = Object.keys(na);
  if (naKeys.length > MAX_NOT_ANALYSED_KEYS) fail('/notAnalysed', `must hold at most ${MAX_NOT_ANALYSED_KEYS} languages`);
  const notAnalysed: Record<string, number> = {};
  for (const k of naKeys.sort()) {
    if (!RE.notAnalysedKey.test(k)) fail(ptr('/notAnalysed', k), 'language name does not match its pattern');
    notAnalysed[k] = int(na[k], ptr('/notAnalysed', k), 0, 10_000_000);
  }

  const envRaw = arr(o.envVarNames, '/envVarNames', MAX_ENV_VAR_NAMES);
  const envVarNames: string[] = [];
  for (let i = 0; i < envRaw.length; i++) envVarNames.push(str(envRaw[i], ptr('/envVarNames', i), RE.envVarName, 64));
  if (new Set(envVarNames).size !== envVarNames.length) fail('/envVarNames', 'must not repeat a name');

  const sitesRaw = arr(o.callSites, '/callSites', MAX_CALL_SITES);
  const callSites: CallSite[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < sitesRaw.length; i++) {
    const site = copySite(sitesRaw[i], ptr('/callSites', i), pathHashing);
    if (seen.has(site.id)) fail(ptr(ptr('/callSites', i), 'id'), 'repeats another call site id');
    seen.add(site.id);
    callSites.push(site);
  }

  return {
    schema: MANIFEST_SCHEMA,
    repo: copyRepo(o.repo, '/repo'),
    commitSha: str(o.commitSha, '/commitSha', RE.commitSha, 40),
    ref: copyRef(o.ref, '/ref'),
    scannedAt: str(o.scannedAt, '/scannedAt', RE.isoUtc, 40),
    scanner: oneOf<Scanner>(o.scanner, '/scanner', SCANNERS),
    pathHashing,
    truncated: bool(o.truncated, '/truncated'),
    notAnalysed,
    envVarNames,
    callSites,
  };
}

/** The wire body: the checked copy, in contract key order, within the 2 MiB bound. */
export function serializeManifest(m: unknown): string {
  const body = JSON.stringify(checkManifest(m));
  if (Buffer.byteLength(body, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ManifestViolationError('MANIFEST_TOO_LARGE', '', `the manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  return body;
}

export interface BuildManifestInput {
  repo: ManifestRepo;
  commitSha: string;
  ref?: Manifest['ref'];
  /** Defaults to now. */
  scannedAt?: string;
  scanner: Scanner;
  pathHashing: boolean;
  truncated: boolean;
  notAnalysed: Record<string, number>;
  envVarNames: string[];
  /** Fingerprinted sites (fingerprint.assignIds). */
  sites: AssignedSite[];
  /** Required in hashed mode: the workspace key the path hashes are keyed with. */
  key?: Uint8Array;
  /** Per-site provenance, keyed by call-site id. */
  provenance?: Map<string, Provenance>;
}

const sortedUnique = (xs: readonly string[]) => [...new Set(xs)].sort();

/**
 * Assemble a manifest from scanner output, naming every field. The result is checked by
 * checkManifest before it is returned, so a manifest that exists has passed the allowlist.
 */
export function buildManifest(input: BuildManifestInput): Manifest {
  if (input.pathHashing && !input.key) throw new Error('buildManifest: hashed mode needs the workspace key.');
  const repoId = input.repo.id;
  const callSites: CallSite[] = input.sites
    .map(({ site, id, movedFrom }) => {
      const a = site.artifact;
      const artifact: CallSite['artifact'] = {
        kind: a.kind,
        id: a.id,
        unresolved: a.unresolved,
        ...(a.envVarName !== undefined ? { envVarName: a.envVarName } : {}),
        pinnedVersion: a.pinnedVersion,
        alias: a.alias,
        environment: null,
      };
      const out: CallSite = {
        id,
        ...(movedFrom !== undefined ? { movedFrom } : {}),
        ...(input.pathHashing ? { pathHash: pathHash(input.key!, repoId, site.relPath) } : { path: site.relPath }),
        line: site.line,
        symbol: site.symbol,
        language: site.language,
        sdk: site.sdk,
        op: site.op,
        artifact,
        contractHash: site.contractHash,
        inputKeys: sortedUnique(site.inputKeys),
        outputKeys: sortedUnique(site.outputKeys),
        managed: site.managed,
      };
      const p = input.provenance?.get(id);
      if (p) out.provenance = { addedBy: p.addedBy, via: p.via, ...(p.pr !== undefined ? { pr: p.pr } : {}), at: p.at };
      return { out, relPath: site.relPath };
    })
    .sort((x, y) => (x.relPath < y.relPath ? -1 : x.relPath > y.relPath ? 1 : 0) || x.out.line - y.out.line || (x.out.id < y.out.id ? -1 : x.out.id > y.out.id ? 1 : 0))
    .map((x) => x.out);

  const notAnalysed: Record<string, number> = {};
  for (const k of Object.keys(input.notAnalysed).sort()) notAnalysed[k] = input.notAnalysed[k]!;

  return checkManifest({
    schema: MANIFEST_SCHEMA,
    repo: {
      id: input.repo.id,
      ...(input.repo.displayName !== undefined ? { displayName: input.repo.displayName } : {}),
      provider: input.repo.provider,
      defaultBranch: input.repo.defaultBranch,
    },
    commitSha: input.commitSha,
    ref: input.ref ? { kind: input.ref.kind, ...(input.ref.pr !== undefined ? { pr: input.ref.pr } : {}) } : { kind: 'default' },
    scannedAt: input.scannedAt ?? new Date().toISOString(),
    scanner: input.scanner,
    pathHashing: input.pathHashing,
    truncated: input.truncated,
    notAnalysed,
    envVarNames: sortedUnique(input.envVarNames),
    callSites,
  });
}
