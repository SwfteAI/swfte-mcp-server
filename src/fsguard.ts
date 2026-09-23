/**
 * Local-file confinement for the tools that touch the caller's disk.
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
 * This is the read-side subset of the `ConfinedWriter` on feat/sot-catalog-bridge
 * (same `PathConfinementError`, `isInside`, `nearestExistingReal`), so the two
 * converge when that branch rebases.
 */

import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

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
