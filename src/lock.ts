/**
 * `swfte.json` — the committed lock that binds a codebase to the catalog
 * entries it calls (CONTRACT rev 4, schema version 1):
 *
 *   { "version": 1, "baseUrl": "...", "workspaceId": "...",
 *     "artifacts": [ { "catalogRef", "alias", "language", "framework", "outDir",
 *                      "contractHash", "pinnedVersion", "files" } ] }
 *
 * It lives at the repository root. Written deterministically (fixed key order,
 * artifacts sorted, no timestamps) so two branches that each add an artifact
 * conflict only where they genuinely disagree. The leaf-1.2.2 shape
 * (`source: "swfte-studio"`, per-artifact `languages[]`, `scaffoldedAt`, lock
 * next to the generated code) is read and migrated forward on the next write.
 */
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { kebab } from './codegen.js';
import type { ConfinedWriter } from './fsguard.js';
import { FRAMEWORKS, type Framework, type Language } from './stack.js';

export const LOCK_FILE = 'swfte.json';
export const LOCK_VERSION = 1;

export interface LockArtifact {
  catalogRef: string;
  alias: string;
  language: Language;
  framework: Framework;
  outDir: string;
  contractHash: string;
  pinnedVersion: string | null;
  files: string[];
}

export interface Lock {
  version: 1;
  baseUrl: string;
  workspaceId: string | null;
  artifacts: LockArtifact[];
}

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function assertAlias(alias: string): string {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new LockError(`Invalid alias "${alias}": use lowercase letters, digits and dashes (max 63), starting with a letter or digit.`);
  }
  return alias;
}

/** Forward slashes, no leading "./", no trailing slash — the form every path in the lock takes. */
export function normalizeRel(p: string): string {
  const s = posix.normalize(String(p).replace(/\\/g, '/')).replace(/^\.\/+/, '').replace(/\/+$/, '');
  return s === '' ? '.' : s;
}

/** Credentials never belong in a committed file, and a baseUrl is the one field where a URL could carry them. */
export function cleanBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return String(url).replace(/\/+$/, '');
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const LANG_EXT: Record<Language, RegExp> = { typescript: /\.(ts|tsx|mts|cts)$/, python: /\.py$/ };

function isV1Artifact(a: unknown): boolean {
  return isObj(a) && typeof a.alias === 'string' && typeof a.framework === 'string' && typeof a.language === 'string';
}

function toV1Artifact(a: Record<string, unknown>): LockArtifact {
  const language: Language = a.language === 'python' ? 'python' : 'typescript';
  const framework = (FRAMEWORKS as readonly string[]).includes(String(a.framework))
    ? (a.framework as Framework)
    : language === 'python'
      ? 'plain-python'
      : 'plain-ts';
  const files = Array.isArray(a.files) ? a.files.map((f) => normalizeRel(String(f))) : [];
  return {
    catalogRef: String(a.catalogRef ?? ''),
    alias: String(a.alias),
    language,
    framework,
    outDir: normalizeRel(String(a.outDir ?? (files[0] ? posix.dirname(files[0]) : '.'))),
    contractHash: String(a.contractHash ?? ''),
    pinnedVersion: a.pinnedVersion == null ? null : String(a.pinnedVersion),
    files: [...new Set(files)].sort(),
  };
}

/** One leaf-1.2.2 entry → one v1 entry per language it was generated in. */
function migrateLegacyArtifact(a: Record<string, unknown>): LockArtifact[] {
  const files = Array.isArray(a.files) ? a.files.map((f) => normalizeRel(String(f))) : [];
  const langs = (Array.isArray(a.languages) ? a.languages.map(String) : []).filter((l): l is Language => l === 'typescript' || l === 'python');
  const inferred: Language[] = langs.length
    ? langs
    : (['typescript', 'python'] as Language[]).filter((l) => files.some((f) => LANG_EXT[l].test(f)));
  const ref = String(a.catalogRef ?? `${a.kind ?? ''}:${a.id ?? ''}`);
  const alias = kebab(String(a.name ?? a.id ?? ref.split(':')[1] ?? 'artifact'));
  return (inferred.length ? inferred : (['typescript'] as Language[])).map((language) => {
    const own = files.filter((f) => LANG_EXT[language].test(f));
    return {
      catalogRef: ref,
      alias,
      language,
      framework: language === 'python' ? 'plain-python' : 'plain-ts',
      outDir: normalizeRel(own[0] ? posix.dirname(own[0]) : files[0] ? posix.dirname(files[0]) : '.'),
      contractHash: String(a.contractHash ?? ''),
      pinnedVersion: a.updatedAt == null ? null : String(a.updatedAt),
      files: own.sort(),
    };
  });
}

/**
 * Parse any lock this package has ever written into the v1 shape. `migrated`
 * says the input was not already v1, so the caller knows the next write will
 * change the file's shape.
 */
export function migrateLock(raw: unknown, defaults: { baseUrl: string; workspaceId?: string | null }): { lock: Lock; migrated: boolean } {
  if (!isObj(raw)) throw new LockError('swfte.json must contain a JSON object.');
  if (typeof raw.version === 'number' && raw.version > LOCK_VERSION) {
    throw new LockError(`swfte.json is schema version ${raw.version}; this @swfte/mcp-server understands up to ${LOCK_VERSION}. Upgrade the package.`);
  }
  const entries = Array.isArray(raw.artifacts) ? raw.artifacts : [];
  let migrated = raw.version !== LOCK_VERSION || 'source' in raw || !Array.isArray(raw.artifacts);
  const artifacts: LockArtifact[] = [];
  for (const e of entries) {
    if (!isObj(e)) continue;
    if (isV1Artifact(e)) artifacts.push(toV1Artifact(e));
    else {
      migrated = true;
      artifacts.push(...migrateLegacyArtifact(e));
    }
  }
  return {
    lock: {
      version: 1,
      baseUrl: cleanBaseUrl(typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : defaults.baseUrl),
      workspaceId: typeof raw.workspaceId === 'string' && raw.workspaceId ? raw.workspaceId : (defaults.workspaceId ?? null),
      artifacts: dedupe(artifacts),
    },
    migrated,
  };
}

/** Later entries win on (alias, language); order is fixed by sortArtifacts. */
function dedupe(artifacts: LockArtifact[]): LockArtifact[] {
  const map = new Map<string, LockArtifact>();
  for (const a of artifacts) map.set(`${a.alias}\u0000${a.language}`, a);
  return sortArtifacts([...map.values()]);
}

function sortArtifacts(a: LockArtifact[]): LockArtifact[] {
  return a.sort((x, y) => x.alias.localeCompare(y.alias) || x.language.localeCompare(y.language));
}

/** Deterministic serialisation: fixed key order, two-space indent, trailing newline, LF. */
export function serializeLock(lock: Lock): string {
  const ordered = {
    version: 1,
    baseUrl: lock.baseUrl,
    workspaceId: lock.workspaceId,
    artifacts: sortArtifacts([...lock.artifacts]).map((a) => ({
      catalogRef: a.catalogRef,
      alias: a.alias,
      language: a.language,
      framework: a.framework,
      outDir: a.outDir,
      contractHash: a.contractHash,
      pinnedVersion: a.pinnedVersion,
      files: [...new Set(a.files)].sort(),
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export interface LoadedLock {
  lock: Lock;
  /** The file existed. */
  exists: boolean;
  /** Its shape was older than v1 (or it came from a legacy lock beside generated code). */
  migrated: boolean;
  /** Legacy lock files folded into this one; the caller should tell the developer to delete them. */
  legacySources: string[];
}

/**
 * Read the root lock through the writer (so the path is confined), migrating
 * the legacy shape. A lock that does not parse is an error even with force: a
 * merge-conflicted swfte.json is exactly the file whose contents must not be
 * guessed at, and rewriting it would drop the other branch's artifacts.
 */
export function loadLock(
  writer: ConfinedWriter,
  defaults: { baseUrl: string; workspaceId?: string | null },
  opts: { legacyDirs?: string[] } = {}
): LoadedLock {
  const read = (rel: string): unknown | undefined => {
    if (writer.inline) return undefined;
    const abs = writer.resolve(rel);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    if (/^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(text)) {
      throw new LockError(`${rel} contains merge-conflict markers. Resolve the conflict (keep both sides' artifacts), then run \`swfte sync\`.`);
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new LockError(`${rel} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix or remove it; it is never rewritten blind.`);
    }
  };

  const rootRaw = read(LOCK_FILE);
  let loaded: LoadedLock;
  if (rootRaw === undefined) {
    loaded = {
      lock: { version: 1, baseUrl: cleanBaseUrl(defaults.baseUrl), workspaceId: defaults.workspaceId ?? null, artifacts: [] },
      exists: false,
      migrated: false,
      legacySources: [],
    };
  } else {
    const m = migrateLock(rootRaw, defaults);
    loaded = { lock: m.lock, exists: true, migrated: m.migrated, legacySources: [] };
  }

  for (const dir of opts.legacyDirs ?? []) {
    const rel = normalizeRel(`${dir}/${LOCK_FILE}`);
    if (rel === LOCK_FILE) continue;
    let raw: unknown;
    try {
      raw = read(rel);
    } catch {
      continue; // a broken legacy file is left alone, not fatal
    }
    if (raw === undefined) continue;
    try {
      const m = migrateLock(raw, defaults);
      const known = new Set(loaded.lock.artifacts.map((a) => `${a.alias}\u0000${a.language}`));
      loaded.lock.artifacts = dedupe([...loaded.lock.artifacts, ...m.lock.artifacts.filter((a) => !known.has(`${a.alias}\u0000${a.language}`))]);
      loaded.migrated = true;
      loaded.legacySources.push(rel);
    } catch {
      // Not a lock we understand; leave it.
    }
  }
  return loaded;
}

/** Insert or replace one artifact, keyed by (alias, language). */
export function upsertArtifact(lock: Lock, entry: LockArtifact): { lock: Lock; previous: LockArtifact | null } {
  const previous = lock.artifacts.find((a) => a.alias === entry.alias && a.language === entry.language) ?? null;
  const rest = lock.artifacts.filter((a) => !(a.alias === entry.alias && a.language === entry.language));
  return { lock: { ...lock, artifacts: sortArtifacts([...rest, { ...entry, files: [...new Set(entry.files.map(normalizeRel))].sort() }]) }, previous };
}

/** Plan the lock write. `create(…, force=true)` is safe here: the current file was parsed and merged above. */
export function planLockWrite(writer: ConfinedWriter, lock: Lock): void {
  writer.create(writer.resolve(LOCK_FILE), serializeLock(lock), true);
}
