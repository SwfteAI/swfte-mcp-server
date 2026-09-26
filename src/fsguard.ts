/**
 * Local-file confinement for every tool that touches the caller's disk: the
 * read side (confinePath / confineReadableFile / confineDirectory, used by
 * files_upload, knowledge_build, export_src, sync_src, preflight, compliance
 * scan) and the write side (ConfinedWriter, used by scaffold, wire and the CLI).
 *
 * A model decides which paths these tools receive, and text it reads (a catalog
 * entry, a web page, a document) can steer that choice. So every path is treated
 * as untrusted:
 *
 *   1. Hosted (HTTP) mode refuses local-file tools outright. The server's disk is
 *      not the caller's project; reading it would hand one tenant the process
 *      environment (`/proc/self/environ`) and the secrets in it.
 *   2. Locally (stdio) every path must resolve under the working directory the
 *      MCP client launched the server in. Absolute paths elsewhere, `..`
 *      traversal, NUL bytes, symlinks that lead out of the tree and
 *      `/proc` / `/dev` / `/sys` are refused before anything is read or written.
 *   3. A working directory of `/` or the home directory confines nothing, so it
 *      is refused too: launch the server from the project directory.
 *
 * Writes additionally follow two rules:
 *
 *   4. No silent overwrite. An existing file is only replaced with `force`.
 *      Env files and the lock file are merged (append-only / keyed update), never
 *      rewritten wholesale.
 *   5. No secrets. Content is checked for the configured credential and for
 *      secret-shaped tokens before it touches disk. Generated code reads
 *      credentials from the environment; it never carries one.
 *
 * Writes are planned first and committed only when the whole plan is clean, so
 * a refused file does not leave half a scaffold behind.
 *
 * Inline mode (a hosted server, whose disk is not the caller's project) plans
 * against an empty virtual tree and returns the files' contents from commit()
 * instead of writing them, with the same confinement and secret checks.
 */

import { closeSync, constants as FS, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/** Credential shapes that must never land in a written file. Publishable `swfte_pk_` keys are allowed. */
export const SECRET_PATTERN =
  /\b(pat_[A-Za-z0-9]{8,}|sk-swfte-[A-Za-z0-9_-]{8,}|swfte_sk_[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{20,}|gh[po]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/;

/** What a hosted (inline) run says instead of having written anything. */
export const INLINE_NOTE =
  'Hosted server: nothing was written to disk. Each entry in files carries path + content — write them into the project yourself (existing files were not checked for conflicts).';

export class PathConfinementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathConfinementError';
  }
}

/** What a hosted server says instead of touching its own disk. */
export function hostedRefusal(tool: string, alternative?: string): PathConfinementError {
  return new PathConfinementError(
    `${tool} refused: this is a hosted MCP server, so local file paths would name files on the server, ` +
      'not in your project. Local-file access is only available when the server runs locally (stdio) ' +
      `inside your repository.${alternative ? ` ${alternative}` : ''}`
  );
}

/** Throw the hosted refusal unless this process runs inside the caller's project. */
export function assertLocalFilesystem(localFilesystem: boolean | undefined, tool: string, alternative?: string): void {
  if (localFilesystem === false) throw hostedRefusal(tool, alternative);
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Real path of the nearest ancestor that exists, so a symlink escape is visible. */
export function nearestExistingReal(p: string): string {
  let cur = p;
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  const real = realpathSync(cur);
  return cur === p ? real : join(real, relative(cur, p));
}

const SPECIAL_ROOTS = ['/proc', '/dev', '/sys'];

function isSpecial(p: string): boolean {
  return SPECIAL_ROOTS.some((r) => p === r || p.startsWith(`${r}/`));
}

/** The confinement root: the working directory, refused when it confines nothing. */
export function confinementRoot(cwd: string = process.cwd()): string {
  const root = resolve(cwd);
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    real = root;
  }
  const home = (() => {
    try {
      return realpathSync(homedir());
    } catch {
      return homedir();
    }
  })();
  if (real === parse(real).root || real === home) {
    throw new PathConfinementError(
      `Refusing local file access: the server's working directory (${real}) is the filesystem root or ` +
        'your home directory, so it confines nothing. Launch the MCP server from your project directory.'
    );
  }
  return root;
}

/**
 * Resolve `p` under the working directory or throw. Relative paths resolve
 * against the root; an absolute path is accepted only when it already lies
 * inside it. The returned path is absolute and its real location is inside
 * the root too.
 */
export function confinePath(p: string, cwd?: string): string {
  if (typeof p !== 'string' || !p.trim()) throw new PathConfinementError('Path is empty.');
  if (p.includes('\0')) throw new PathConfinementError('Path contains a NUL byte.');
  const root = confinementRoot(cwd);
  const abs = resolve(root, p);
  if (isSpecial(abs) || !isInside(root, abs)) {
    throw new PathConfinementError(
      `Refusing path "${p}": it resolves outside the working directory (${root}). ` +
        'Pass a path inside the project; `..` traversal, absolute paths elsewhere and /proc, /dev, /sys are rejected.'
    );
  }
  const realRoot = nearestExistingReal(root);
  const real = nearestExistingReal(abs);
  if (isSpecial(real) || !isInside(realRoot, real)) {
    throw new PathConfinementError(`Refusing path "${p}": a symlink along it leads outside the working directory.`);
  }
  return abs;
}

/** Confine `p` and require it to be an existing regular file (not a device, FIFO or directory). */
export function confineReadableFile(p: string, cwd?: string): string {
  const abs = confinePath(p, cwd);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new PathConfinementError(`Refusing path "${p}": no such file.`);
  }
  if (!st.isFile()) throw new PathConfinementError(`Refusing path "${p}": not a regular file.`);
  return abs;
}

/** Confine `p` and require it to be an existing real directory (not a symlink to one). */
export function confineDirectory(p: string, cwd?: string): string {
  const abs = confinePath(p, cwd);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new PathConfinementError(`Refusing path "${p}": no such directory.`);
  }
  if (!st.isDirectory()) throw new PathConfinementError(`Refusing path "${p}": not a directory.`);
  return abs;
}

/**
 * A display name that must never become a filesystem path: no separators, no
 * traversal, no control characters.
 */
export function assertSafeName(name: string, what = 'Name'): string {
  if (typeof name !== 'string' || !name.trim()) throw new PathConfinementError(`${what} is empty.`);
  // eslint-disable-next-line no-control-regex
  if (/[\/\\\x00-\x1f]/.test(name) || name.split('.').every((s) => s === '') || name.includes('..')) {
    throw new PathConfinementError(
      `${what} "${name}" is not allowed: it must not contain path separators, "..", or control characters.`
    );
  }
  return name;
}

export interface PlannedWrite {
  /** Path relative to the root, forward slashes — what the tool reports. */
  path: string;
  action: 'create' | 'overwrite' | 'merge' | 'unchanged';
  bytes: number;
  /** Present only in inline mode: the file for the client to write. */
  content?: string;
}

type Op = { abs: string; content: string; action: PlannedWrite['action'] };

export class ConfinedWriter {
  readonly root: string;
  private readonly realRoot: string;
  private readonly ops = new Map<string, Op>();
  readonly conflicts: string[] = [];

  readonly inline: boolean;
  private readonly forbidden: string[];

  constructor(opts: { root?: string; forbidden?: string[]; inline?: boolean } = {}) {
    this.inline = Boolean(opts.inline);
    this.forbidden = opts.forbidden ?? [];
    // Same root rule as the read side: a cwd of / or $HOME confines nothing.
    this.root = this.inline ? resolve(sep, 'swfte-inline-project') : confinementRoot(opts.root ?? process.cwd());
    this.realRoot = this.inline ? this.root : realpathSync(this.root);
  }

  /**
   * Resolve a caller-supplied path under the root, or throw. Relative paths
   * resolve against the root; an absolute path is accepted only when it already
   * lies inside it.
   */
  resolve(p: string): string {
    if (typeof p !== 'string' || !p.trim()) throw new PathConfinementError('Path is empty.');
    if (p.includes('\0')) throw new PathConfinementError('Path contains a NUL byte.');
    if (this.inline && isAbsolute(p) && !isInside(this.root, p)) {
      throw new PathConfinementError(`Refusing path "${p}": pass a path relative to the project root.`);
    }
    const abs = resolve(this.root, p);
    if (isSpecial(abs) || !isInside(this.root, abs)) {
      throw new PathConfinementError(
        `Refusing path "${p}": it resolves outside the working directory (${this.root}). ` +
          'Pass a path inside the project; `..` traversal and absolute paths elsewhere are rejected.'
      );
    }
    if (!this.inline && !isInside(this.realRoot, nearestExistingReal(abs))) {
      throw new PathConfinementError(`Refusing path "${p}": a symlink along it leads outside the working directory.`);
    }
    if (!this.inline) this.assertNoSymlink(abs, p);
    return abs;
  }

  /**
   * lstat every component below the root, the final one included, and refuse
   * any symlink — dangling or not, pointing in or out (BT-N1). `existsSync`
   * follows links and reports a dangling one as absent, which is how a link
   * to a file outside the tree used to be written through. The root itself
   * may be a symlink (macOS /tmp); only what lies under it is checked.
   */
  private assertNoSymlink(abs: string, shown: string = abs): void {
    const rel = relative(this.root, abs);
    if (!rel) return;
    let cur = this.realRoot;
    for (const part of rel.split(sep)) {
      cur = join(cur, part);
      let st;
      try {
        st = lstatSync(cur);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // the rest does not exist yet
        throw err;
      }
      if (st.isSymbolicLink()) {
        throw new PathConfinementError(
          `Refusing path "${shown}": ${relative(this.realRoot, cur).split(sep).join('/')} is a symlink. ` +
            'Swfte never reads or writes through a symlink in the project (it could lead outside the tree); replace it with a real file or directory.'
        );
      }
    }
  }

  rel(abs: string): string {
    return relative(this.root, abs).split(sep).join('/') || '.';
  }

  private checkTarget(abs: string): 'missing' | 'file' {
    if (this.inline) return 'missing';
    this.assertNoSymlink(abs);
    let st;
    try {
      st = lstatSync(abs); // never existsSync: it follows links (BT-N1)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw err;
    }
    if (st.isSymbolicLink()) throw new PathConfinementError(`Refusing to write through symlink ${this.rel(abs)}.`);
    if (st.isDirectory()) throw new PathConfinementError(`${this.rel(abs)} is a directory, not a file.`);
    return 'file';
  }

  /** Plan a new file. An existing one is a conflict unless `force`. */
  create(abs: string, content: string, force = false): void {
    const state = this.checkTarget(abs);
    if (state === 'file') {
      const current = readFileSync(abs, 'utf8');
      if (current === content) return void this.ops.set(abs, { abs, content, action: 'unchanged' });
      if (!force) {
        this.conflicts.push(this.rel(abs));
        return;
      }
      this.ops.set(abs, { abs, content, action: 'overwrite' });
      return;
    }
    this.ops.set(abs, { abs, content, action: 'create' });
  }

  /**
   * Append `KEY=value` lines for keys the env file does not define yet. Keys
   * already present are left exactly as the developer set them, unless
   * `force` is set and a non-empty value differs.
   */
  mergeEnv(
    abs: string,
    entries: Array<{ key: string; value: string; comment?: string }>,
    opts: { force?: boolean; header?: string } = {}
  ): { added: string[]; kept: string[]; changed: string[] } {
    const state = this.checkTarget(abs);
    const planned = this.ops.get(abs)?.content;
    let text = planned ?? (state === 'file' ? readFileSync(abs, 'utf8') : '');
    const added: string[] = [];
    const kept: string[] = [];
    const changed: string[] = [];
    const lines = text.split(/\r?\n/);
    const indexOf = (key: string) => lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
    const toAppend: string[] = [];
    for (const e of entries) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(e.key)) throw new Error(`Invalid env key ${e.key}`);
      // Unquoted dotenv values: anything that could end, comment out or quote-shift the line is refused.
      if (/[\s"'`#\\$]/.test(e.value)) throw new Error(`Refusing env value for ${e.key}: it contains whitespace, a quote, #, $ or a backslash.`);
      const i = indexOf(e.key);
      if (i >= 0) {
        const currentValue = lines[i]!.replace(/^\s*(export\s+)?[A-Z0-9_]+\s*=\s*/, '');
        if (opts.force && e.value && currentValue !== e.value) {
          lines[i] = `${e.key}=${e.value}`;
          changed.push(e.key);
        } else kept.push(e.key);
        continue;
      }
      if (e.comment) toAppend.push(`# ${e.comment.replace(/[\r\n]+/g, ' ')}`);
      toAppend.push(`${e.key}=${e.value}`);
      added.push(e.key);
    }
    text = lines.join('\n');
    if (toAppend.length) {
      const needsGap = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
      const header = opts.header && !text.includes(opts.header) ? [`# ${opts.header}`] : [];
      text = `${text}${needsGap}${text.trim() ? '\n' : ''}${[...header, ...toAppend].join('\n')}\n`;
    }
    const prior = this.ops.get(abs)?.action;
    const action: PlannedWrite['action'] =
      prior === 'create'
        ? 'create'
        : added.length || changed.length
          ? state === 'file'
            ? 'merge'
            : 'create'
          : (prior ?? 'unchanged');
    this.ops.set(abs, { abs, content: text, action });
    return { added, kept, changed };
  }

  /**
   * Update a JSON document by a pure function of its current value. A file
   * that exists but does not parse is a conflict unless `force` — rewriting a
   * lock file the developer hand-edited would destroy exactly what it records.
   */
  mergeJson(abs: string, update: (current: Record<string, unknown>) => Record<string, unknown>, force = false): void {
    const state = this.checkTarget(abs);
    let current: Record<string, unknown> = {};
    if (state === 'file') {
      try {
        const parsed = JSON.parse(readFileSync(abs, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
        else throw new Error('not an object');
      } catch {
        if (!force) {
          this.conflicts.push(`${this.rel(abs)} (exists but is not a JSON object)`);
          return;
        }
      }
    }
    const content = `${JSON.stringify(update(current), null, 2)}\n`;
    this.ops.set(abs, { abs, content, action: state === 'file' ? 'merge' : 'create' });
  }

  /** Plain secret check, exposed so tools can vet content they return rather than write. */
  assertNoSecrets(label: string, content: string): void {
    for (const f of this.forbidden) {
      if (f && f.length >= 8 && content.includes(f)) {
        throw new Error(`Refusing to write ${label}: it contains the configured Swfte credential.`);
      }
    }
    const m = SECRET_PATTERN.exec(content);
    if (m) throw new Error(`Refusing to write ${label}: it contains a secret-shaped token (${m[0].slice(0, 6)}…).`);
  }

  /** Commit the plan. Throws, having written nothing, if any conflict or secret was found. */
  commit(): PlannedWrite[] {
    if (this.conflicts.length) {
      throw new OverwriteRefusedError(this.conflicts);
    }
    for (const op of this.ops.values()) this.assertNoSecrets(this.rel(op.abs), op.content);
    const out: PlannedWrite[] = [];
    for (const op of this.ops.values()) {
      if (this.inline) {
        out.push({ path: this.rel(op.abs), action: op.action, bytes: Buffer.byteLength(op.content), content: op.content });
        continue;
      }
      if (op.action !== 'unchanged') {
        // Re-check at commit: a link planted after planning must not be followed either.
        this.assertNoSymlink(op.abs);
        mkdirSync(dirname(op.abs), { recursive: true });
        this.assertNoSymlink(op.abs);
        // O_NOFOLLOW: the final component is opened only if it is not a symlink.
        const fd = openSync(op.abs, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | (FS.O_NOFOLLOW ?? 0), 0o644);
        try {
          writeSync(fd, op.content, null, 'utf8');
        } finally {
          closeSync(fd);
        }
      }
      out.push({ path: this.rel(op.abs), action: op.action, bytes: Buffer.byteLength(op.content) });
    }
    return out;
  }
}

export class OverwriteRefusedError extends Error {
  constructor(readonly files: string[]) {
    super(
      `Refusing to overwrite existing file(s): ${files.join(', ')}. Nothing was written. ` +
        'Pass force:true to replace them, or choose a different targetDir.'
    );
    this.name = 'OverwriteRefusedError';
  }
}

/** Whether `.gitignore` in the root appears to ignore a given env file. Best effort, for a warning only. */
export function gitignoreCovers(root: string, file: string): boolean {
  try {
    const text = readFileSync(join(root, '.gitignore'), 'utf8');
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .some((l) => l === file || l === `/${file}` || l === '.env*' || l === '.env.*' || (l === '.env' && file === '.env') || l === '*.local');
  } catch {
    return false;
  }
}

/**
 * Error text with every credential scrubbed (BT-N8): the given secrets, any
 * secret-shaped token, and URL userinfo (`https://user:secret@host`). Messages
 * from fetch/undici can quote the URL or a header verbatim, and CLI stderr
 * lands in CI logs.
 */
export function redactSecrets(message: string, secrets: Array<string | undefined> = []): string {
  let out = String(message);
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  out = out.replace(new RegExp(SECRET_PATTERN.source, 'g'), '[redacted]');
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@');
}
