/**
 * The confined file walk of the code map scanner (docs/codemap/CONTRACT.md §7, §2.1).
 *
 * Scanner traversal and source/metadata reads use a held native root capability. Descriptor-relative
 * operations refuse intermediate links, so a link planted in the tree is never
 * followed, in or out. What the walk will not do:
 *   - descend into vendored or build output (node_modules, .venv, venv, target, build, dist, .next, .git,
 *     __pycache__), unless the caller passes its own skip list;
 *   - open an env file matched by the `secret` globs of DEFAULT_ENV_FILES (`.env`, `.env.local`,
 *     `.env.*`) or the caller's `envFiles` override (CONTRACT D10); a `names` file (`.env.example`) is
 *     read for SWFTE_* NAMES only, never a value;
 *   - read a file of an unsupported language (it is only counted into notAnalysed);
 *   - hand a detector a `.d.ts`, or a file another tool generated (the Swfte generated client is kept:
 *     it is exactly what the typed-client detectors look for);
 *   - read a swfte.json entry whose alias is malformed or whose file paths leave the scan root.
 * Caps (maxFiles, maxFileBytes) set `truncated`, which impact reads as "unknown", never "safe".
 */
import fs from 'node:fs';
import { posix } from 'node:path';
import { GENERATED_MARKER } from '../codegen.js';
import { ConfinedWriter } from '../fsguard.js';
import { NATIVE_FILE_LIMIT, NativeFilesystemError } from '../native-filesystem.js';
import { NativeScanReader, isNativeScanIncomplete } from './native-reader.js';
import { ALIAS_PATTERN, LOCK_FILE, migrateLock, normalizeRel } from '../lock.js';
import { cmp } from './fingerprint.js';
import type { DetectContext, LockBinding, SourceLanguage } from './types.js';

export const DEFAULT_SKIP_DIRS: readonly string[] = ['node_modules', '.venv', 'venv', 'target', 'build', 'dist', '.next', '.git', '__pycache__'];
export const DEFAULT_MAX_FILES = 20_000;
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
/** Package manifests and locks are small; anything bigger is not one we parse. */
const MAX_META_BYTES = 1024 * 1024;
/** How much of a file's head is searched for another tool's generated marker. */
const HEADER_BYTES = 4096;
const HEADER_LINES = 40;

const LANGUAGE_BY_EXT: Record<string, SourceLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.html': 'html',
  '.htm': 'html',
  '.jinja': 'html',
  '.j2': 'html',
};

/** Languages the scanner does not analyse: counted, never opened. */
export const NOT_ANALYSED_BY_EXT: Record<string, string> = {
  '.go': 'go',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.kt': 'kotlin',
  '.rs': 'rust',
  '.swift': 'swift',
};

const PACKAGE_MARKERS = ['package.json', 'pyproject.toml', 'setup.cfg', 'pom.xml', 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'];

/** Env files by basename glob (`*` any run of characters, `?` one character), CONTRACT D10. */
export interface EnvFileRules {
  /** Never opened (unless also matched by `names`). */
  secret: readonly string[];
  /** Read for SWFTE_* names only, never values. */
  names: readonly string[];
}

export const DEFAULT_ENV_FILES: EnvFileRules = Object.freeze({
  secret: Object.freeze(['.env', '.env.local', '.env.*']),
  names: Object.freeze(['.env.example']),
});

export interface WalkOptions {
  skipDirs?: readonly string[];
  skipGenerated?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  envFiles?: EnvFileRules;
}

export interface WalkEntry {
  /** POSIX path relative to the scan root. */
  relPath: string;
  language: SourceLanguage;
  size: number;
}

export interface PackageRoot {
  /** Directory relative to the scan root ('' = the root). */
  dir: string;
  pkgId: string;
}

export interface LockSite {
  /** Directory of the swfte.json relative to the scan root ('' = the root). */
  dir: string;
  bindings: LockBinding[];
}

export interface WalkResult {
  root: string;
  files: WalkEntry[];
  notAnalysed: Record<string, number>;
  truncated: boolean;
  /** SWFTE_* names declared in `names` env files such as .env.example (names only). */
  envExampleNames: string[];
  packages: PackageRoot[];
  locks: LockSite[];
  /** Why something was left out (never a file's contents). */
  warnings: string[];
  skipped: { generated: number; declaration: number; env: number; tooLarge: number; symlink: number };
}

export class WalkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalkError';
  }
}

const globCache = new Map<string, RegExp>();
function globRe(glob: string): RegExp {
  let re = globCache.get(glob);
  if (!re) {
    const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    re = new RegExp(`^${body}$`);
    globCache.set(glob, re);
  }
  return re;
}

function checkRules(rules: EnvFileRules): EnvFileRules {
  const ok = (xs: unknown) => Array.isArray(xs) && xs.every((g) => typeof g === 'string' && g.length > 0 && !g.includes('/') && !g.includes('\0'));
  if (!rules || !ok(rules.secret) || !ok(rules.names)) {
    throw new WalkError('envFiles must be {secret: string[], names: string[]} of non-empty basename globs (no "/").');
  }
  return rules;
}

/**
 * How the env-file rules treat a basename: `names` (read for SWFTE_* names), `secret` (never opened),
 * or null (not an env file). A `names` match wins over `secret`.
 */
export function envFileKind(name: string, rules: EnvFileRules = DEFAULT_ENV_FILES): 'names' | 'secret' | null {
  checkRules(rules);
  if (rules.names.some((g) => globRe(g).test(name))) return 'names';
  if (rules.secret.some((g) => globRe(g).test(name))) return 'secret';
  return null;
}

const isDeclaration = (name: string) => /\.d\.(ts|mts|cts)$/.test(name) || /\.d\.[^.]+\.ts$/.test(name);
const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
};

/** Language of a file by its name alone (null: not a source file the scanner analyses). */
export function languageOf(relPath: string, envFiles: EnvFileRules = DEFAULT_ENV_FILES): SourceLanguage | null {
  const name = posix.basename(relPath);
  if (envFileKind(name, envFiles) !== null || isDeclaration(name)) return null;
  return LANGUAGE_BY_EXT[extOf(name)] ?? null;
}

/**
 * The one way the scanner reads a file: confined, never a `secret` env file (a `names` one such as
 * .env.example is allowed), never through a symlink, regular files only, at most `maxBytes`. Returns
 * null for a file that is not a regular file or is larger than the cap.
 */
export function readConfined(writer: ConfinedWriter, relPath: string, maxBytes: number, envFiles: EnvFileRules = DEFAULT_ENV_FILES): string | null {
  const name = posix.basename(relPath);
  if (envFileKind(name, envFiles) === 'secret') {
    throw new WalkError(`Refusing to open ${relPath}: env files are never read by the scanner.`);
  }
  const abs = writer.resolve(relPath);
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR') return null;
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether another tool marked this file generated in its header. The Swfte generated client carries
 * its own marker and is never skipped.
 */
export function isGeneratedByOtherTool(text: string): boolean {
  const head = text.slice(0, HEADER_BYTES).split(/\r?\n/).slice(0, HEADER_LINES).join('\n');
  if (head.includes(GENERATED_MARKER)) return false;
  return (
    /@generated\b/.test(head) ||
    /Code generated\b.*\bDO NOT EDIT\b/.test(head) ||
    /@(?:javax\.annotation\.(?:processing\.)?|jakarta\.annotation\.)?Generated\b/.test(head)
  );
}

/** SWFTE_* names declared in a .env.example (the values are discarded as the line is parsed). */
export function envExampleNames(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(SWFTE_[A-Z0-9_]*)\s*=/.exec(line);
    if (m && /^[A-Z][A-Z0-9_]{0,63}$/.test(m[1]!)) names.add(m[1]!);
  }
  return [...names].sort(cmp);
}

const cleanName = (s: unknown): string | null => {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  // eslint-disable-next-line no-control-regex
  return t && t.length <= 214 && !/[\x00-\x1f\x7f]/.test(t) ? t : null;
};

function tomlSectionValue(text: string, section: string, key: string): string | null {
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      inSection = header[1]!.trim() === section;
      continue;
    }
    if (!inSection) continue;
    const m = new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(line);
    if (m) return m[1] ?? m[2] ?? null;
  }
  return null;
}

function iniSectionValue(text: string, section: string, key: string): string | null {
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      inSection = header[1]!.trim() === section;
      continue;
    }
    if (!inSection) continue;
    const m = new RegExp(`^${key}\\s*[=:]\\s*(.+)$`).exec(line);
    if (m) return m[1]!.trim();
  }
  return null;
}

function pomId(text: string): string | null {
  let t = text.replace(/<!--[\s\S]*?-->/g, '');
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(t)?.[1] ?? '';
  for (const block of ['parent', 'dependencies', 'dependencyManagement', 'build', 'profiles', 'modules', 'reporting', 'pluginRepositories', 'repositories', 'distributionManagement']) {
    t = t.replace(new RegExp(`<${block}>[\\s\\S]*?</${block}>`, 'g'), '');
  }
  const tag = (s: string, name: string) => new RegExp(`<${name}>\\s*([^<\\s]+)\\s*</${name}>`).exec(s)?.[1] ?? null;
  const artifactId = tag(t, 'artifactId');
  const groupId = tag(t, 'groupId') ?? tag(parent, 'groupId');
  return artifactId && groupId ? `${groupId}:${artifactId}` : null;
}

function gradleRootName(text: string): string | null {
  return /rootProject\.name\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(text)?.slice(1).find(Boolean) ?? null;
}

/** pkgId of a package root directory from its markers (CONTRACT §2.1), null when none names it. */
function packageName(read: (rel: string) => string | null, dir: string, markers: Set<string>): string | null {
  const at = (f: string) => (dir ? `${dir}/${f}` : f);
  if (markers.has('package.json')) {
    const text = read(at('package.json'));
    try {
      const name = cleanName(text ? JSON.parse(text)?.name : null);
      if (name) return name;
    } catch {
      /* unparseable package.json: fall through to the next marker */
    }
  }
  if (markers.has('pyproject.toml')) {
    const text = read(at('pyproject.toml'));
    const name = cleanName(text ? tomlSectionValue(text, 'project', 'name') : null);
    if (name) return name;
  }
  if (markers.has('setup.cfg')) {
    const text = read(at('setup.cfg'));
    const name = cleanName(text ? iniSectionValue(text, 'metadata', 'name') : null);
    if (name) return name;
  }
  if (markers.has('pom.xml')) {
    const text = read(at('pom.xml'));
    const name = cleanName(text ? pomId(text) : null);
    if (name) return name;
  }
  for (const f of ['settings.gradle', 'settings.gradle.kts']) {
    if (!markers.has(f)) continue;
    const name = cleanName(gradleRootName(read(at(f)) ?? ''));
    if (name) return name;
  }
  if ((markers.has('build.gradle') || markers.has('build.gradle.kts') || markers.has('settings.gradle') || markers.has('settings.gradle.kts')) && dir) {
    return posix.basename(dir);
  }
  return null;
}

/** A lock path joined onto its lock's directory; null when it would leave the scan root. */
function underRoot(lockDir: string, p: string): string | null {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return null;
  const joined = posix.normalize(lockDir ? `${lockDir}/${normalizeRel(p)}` : normalizeRel(p));
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/') || joined === '.') return null;
  return joined;
}

function parseLock(text: string, dir: string, rel: string, warnings: string[]): LockBinding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    warnings.push(`${rel}: not valid JSON; its bindings are ignored.`);
    return [];
  }
  let artifacts;
  try {
    artifacts = migrateLock(raw, { baseUrl: 'https://api.swfte.com/agents' }).lock.artifacts;
  } catch (err) {
    warnings.push(`${rel}: ${err instanceof Error ? err.name : 'unreadable'}; its bindings are ignored.`);
    return [];
  }
  const out: LockBinding[] = [];
  for (const a of artifacts) {
    if (!ALIAS_PATTERN.test(a.alias)) {
      warnings.push(`${rel}: an entry with a malformed alias was refused.`);
      continue;
    }
    const files: string[] = [];
    let escaped = false;
    for (const f of a.files) {
      const p = underRoot(dir, f);
      if (p === null) escaped = true;
      else files.push(p);
    }
    const outDir = underRoot(dir, a.outDir === '.' ? '' : a.outDir);
    if (escaped || (a.outDir !== '.' && outDir === null)) {
      warnings.push(`${rel}: alias ${a.alias} names a path outside the scan root; the entry was refused.`);
      continue;
    }
    out.push({
      alias: a.alias,
      catalogRef: a.catalogRef,
      language: a.language,
      pinnedVersion: a.pinnedVersion,
      contractHash: a.contractHash ? a.contractHash : null,
      files: [...new Set(files)].sort(cmp),
    });
  }
  return out.sort((x, y) => cmp(x.alias, y.alias) || cmp(x.language, y.language));
}

/**
 * Enumerate the scan root. Directory entries are visited in code-point order, so which files a cap
 * keeps is deterministic.
 */
export function walkProject(root: string, opts: WalkOptions = {}): WalkResult {
  const reader = new NativeScanReader(root);
  try { return walkProjectWithReader(reader, opts); } finally { reader.close(); }
}

/** Borrowed authority: the owner closes after all detection and hash rereads finish. */
export function walkProjectWithReader(reader: NativeScanReader, opts: WalkOptions = {}): WalkResult {
  const skipDirs = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS);
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > NATIVE_FILE_LIMIT) {
    throw new NativeFilesystemError('SIZE_LIMIT');
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) throw new WalkError('maxFiles must be a non-negative integer.');
  const result: WalkResult = {
    root: reader.root,
    files: [],
    notAnalysed: {},
    truncated: false,
    envExampleNames: [],
    packages: [],
    locks: [],
    warnings: [],
    skipped: { generated: 0, declaration: 0, env: 0, tooLarge: 0, symlink: 0 },
  };
  const envFiles = checkRules(opts.envFiles ?? DEFAULT_ENV_FILES);
  const envNames = new Set<string>();
  const readMeta = (rel: string) => {
    if (envFileKind(posix.basename(rel), envFiles) === 'secret') {
      throw new WalkError(`Refusing to open ${rel}: env files are never read by the scanner.`);
    }
    try {
      const text = reader.readText(rel, MAX_META_BYTES);
      if (text !== null) return text;
    } catch (error) {
      if (!isNativeScanIncomplete(error)) throw error;
    }
    result.truncated = true;
    result.warnings.push(`${rel}: enumerated metadata unreadable; scan incomplete.`);
    return null;
  };

  const stack: string[] = [''];
  walk: while (stack.length) {
    const dir = stack.pop()!;
    let listed: ReturnType<NativeScanReader['list']>;
    try {
      listed = reader.list(dir);
    } catch (err) {
      if (!isNativeScanIncomplete(err)) throw err;
      result.warnings.push(`${dir || '.'}: unreadable directory (${err.code}).`);
      result.truncated = true;
      continue;
    }
    if (listed === null) {
      result.warnings.push(`${dir || '.'}: enumerated directory disappeared; scan incomplete.`);
      result.truncated = true;
      continue;
    }
    const entries = [...listed.entries];
    entries.sort((a, b) => cmp(a.name, b.name));
    // This directory's package root and lock first, so every file listed from it (even when a cap
    // stops the walk part-way through the directory) is placed under the right pkgId and lock.
    const markers = new Set(entries.filter((e) => e.kind === 'file' && PACKAGE_MARKERS.includes(e.name)).map((e) => e.name));
    if (markers.size) result.packages.push({ dir, pkgId: packageName(readMeta, dir, markers) ?? (dir || '.') });
    if (entries.some((e) => e.kind === 'file' && e.name === LOCK_FILE)) {
      const rel = dir ? `${dir}/${LOCK_FILE}` : LOCK_FILE;
      const text = readMeta(rel);
      if (text !== null) result.locks.push({ dir, bindings: parseLock(text, dir, rel, result.warnings) });
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === 'symlink') {
        result.skipped.symlink++;
        continue;
      }
      if (e.kind === 'directory') {
        if (!skipDirs.has(e.name)) subdirs.push(rel);
        continue;
      }
      if (e.kind !== 'file') continue;
      const envKind = envFileKind(e.name, envFiles);
      if (envKind === 'names') {
        const text = readMeta(rel);
        if (text !== null) for (const n of envExampleNames(text)) envNames.add(n);
        continue;
      }
      if (envKind === 'secret') {
        result.skipped.env++;
        continue;
      }
      if (e.name === LOCK_FILE) continue;
      const ext = extOf(e.name);
      const other = NOT_ANALYSED_BY_EXT[ext];
      if (other) {
        result.notAnalysed[other] = (result.notAnalysed[other] ?? 0) + 1;
        continue;
      }
      if (isDeclaration(e.name)) {
        if (LANGUAGE_BY_EXT[ext]) result.skipped.declaration++;
        continue;
      }
      const language = LANGUAGE_BY_EXT[ext];
      if (!language) continue;
      if (BigInt(e.identity.nlink) !== 1n) {
        result.truncated = true;
        result.warnings.push(`${rel}: shared inode refused; scan incomplete.`);
        continue;
      }
      if (result.files.length >= maxFiles) {
        result.truncated = true;
        result.warnings.push(`File cap reached (${maxFiles}); the rest of the tree was not scanned.`);
        break walk;
      }
      const size = BigInt(e.identity.size);
      if (size > BigInt(maxFileBytes)) {
        result.skipped.tooLarge++;
        result.truncated = true;
        continue;
      }
      result.files.push({ relPath: rel, language, size: Number(size) });
    }
    // Reverse so the stack pops them in code-point order.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!);
  }

  // Two roots claiming one name would fingerprint two files identically: fall back to their directories.
  const byName = new Map<string, number>();
  for (const p of result.packages) byName.set(p.pkgId, (byName.get(p.pkgId) ?? 0) + 1);
  for (const p of result.packages) if (byName.get(p.pkgId)! > 1) p.pkgId = p.dir || '.';

  result.files.sort((a, b) => cmp(a.relPath, b.relPath));
  result.packages.sort((a, b) => cmp(a.dir, b.dir));
  result.locks.sort((a, b) => cmp(a.dir, b.dir));
  result.envExampleNames = [...envNames].sort(cmp);
  const na: Record<string, number> = {};
  for (const k of Object.keys(result.notAnalysed).sort(cmp)) na[k] = result.notAnalysed[k]!;
  result.notAnalysed = na;
  return result;
}

const inDir = (dir: string, relPath: string) => dir === '' || relPath.startsWith(`${dir}/`);

function nearest<T extends { dir: string }>(items: T[], relPath: string): T | null {
  let best: T | null = null;
  for (const it of items) if (inDir(it.dir, relPath) && (best === null || it.dir.length > best.dir.length)) best = it;
  return best;
}

/** pkgId and package-relative path of a file (CONTRACT §2.1); pkgId "." when no package root holds it. */
export function packageOf(relPath: string, packages: PackageRoot[]): { pkgId: string; pkgRelPath: string } {
  const p = nearest(packages, relPath);
  if (!p) return { pkgId: '.', pkgRelPath: relPath };
  return { pkgId: p.pkgId, pkgRelPath: p.dir ? relPath.slice(p.dir.length + 1) : relPath };
}

/** The detector context of a file: the bindings of the nearest swfte.json above it. */
export function contextOf(relPath: string, locks: LockSite[]): DetectContext {
  const l = nearest(locks, relPath);
  return l ? { locks: l.bindings, lockDir: l.dir } : { locks: [], lockDir: null };
}

/** The confinement every scanner read goes through (the scan root; refuses / and $HOME). */
export function scanReader(root: string): ConfinedWriter {
  return new ConfinedWriter({ root });
}

/**
 * Read one walked source file for the detectors. Skipped when another tool generated it (and
 * skipGenerated is on), or when it changed into something unreadable or too large since the walk.
 */
export function readSource(writer: ConfinedWriter, entry: WalkEntry, opts: WalkOptions = {}): { text: string } | { skipped: 'generated' | 'unreadable' } {
  const text = readConfined(writer, entry.relPath, opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, opts.envFiles ?? DEFAULT_ENV_FILES);
  if (text === null) return { skipped: 'unreadable' };
  if ((opts.skipGenerated ?? true) && isGeneratedByOtherTool(text)) return { skipped: 'generated' };
  return { text };
}

/** Native scanner path; legacy helpers above remain scoped to their existing callers. */
export function readNativeSource(reader: NativeScanReader, entry: WalkEntry, opts: WalkOptions = {}): { text: string } | { skipped: 'generated' | 'unreadable' } {
  if (envFileKind(posix.basename(entry.relPath), opts.envFiles ?? DEFAULT_ENV_FILES) !== null) {
    throw new WalkError('Env files are not detector source.');
  }
  let text: string | null;
  try { text = reader.readText(entry.relPath, opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES); }
  catch (error) { if (!isNativeScanIncomplete(error)) throw error; return { skipped: 'unreadable' }; }
  if (text === null) return { skipped: 'unreadable' };
  if ((opts.skipGenerated ?? true) && isGeneratedByOtherTool(text)) return { skipped: 'generated' };
  return { text };
}
