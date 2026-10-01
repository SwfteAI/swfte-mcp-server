import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import type { ProofFile, TreeSnapshot } from './types.js';

const exec = promisify(execFile);
const MAX_FILE_BYTES = 2_000_000;
const MAX_TREE_BYTES = 30_000_000;
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum']);
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function validRelativePath(path: string): boolean {
  return Boolean(path && path.length <= 500 && !path.startsWith('/') && !/[\\:\x00-\x1f\x7f]/u.test(path)
    && path.normalize('NFC') === path && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
}
export function excludedSourcePath(path: string): boolean {
  return path.split('/').some(part => ['.git', '.nexus', 'node_modules', 'target'].includes(part)
    || part.startsWith('.env') || /\.(?:pem|key)$/iu.test(part));
}
export function canonicalTreeKey(files: Pick<ProofFile, 'path' | 'sha256'>[]): string {
  const seen = new Set<string>();
  for (const file of files) {
    if (!validRelativePath(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256) || seen.has(file.path)) {
      throw new Error('Noncanonical proof manifest');
    }
    seen.add(file.path);
  }
  const pairs = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => [file.path, file.sha256]);
  return sha256(JSON.stringify(pairs));
}

async function git(root: string, args: string[]): Promise<string> {
  const output = await exec('git', ['-C', root, ...args], { maxBuffer: 8_000_000, timeout: 10_000 });
  return output.stdout;
}

/** O_NOFOLLOW plus parent resolution prevent an outbound file from entering the proof payload. */
export async function readSourceFile(root: string, path: string): Promise<Uint8Array> {
  if (!validRelativePath(path) || excludedSourcePath(path)) throw new Error('Source path refused');
  root = await realpath(root);
  const absolute = resolve(root, ...path.split('/'));
  const actualParent = await realpath(resolve(absolute, '..'));
  const relativeParent = relative(root, actualParent);
  if (relativeParent === '..' || relativeParent.startsWith(`..${sep}`) || resolve(root, relativeParent) !== actualParent) {
    throw new Error('Source path escapes the repository');
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Source file is not regular or exceeds the byte cap');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Source file exceeds the byte cap');
    return bytes;
  } finally { await handle.close(); }
}

/** Reads git's tracked and nonignored untracked files; no code or local path leaves this module. */
export async function treeKey(path: string): Promise<TreeSnapshot> {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)) throw new Error('A local repository path is required');
  const root = await realpath(resolve(path));
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  if (await realpath(top) !== root) throw new Error('The repository root is required');
  const names = [...new Set((await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
    .split('\0').filter(Boolean))].filter(name => !excludedSourcePath(name));
  if (names.length > 20_000) throw new Error('Proof manifest file cap exceeded');
  const files: ProofFile[] = []; let total = 0;
  for (const name of names.sort()) {
    if (!validRelativePath(name)) throw new Error('Noncanonical source path');
    let stat;
    try { stat = await lstat(resolve(root, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Symlinks and nonregular source files are refused');
    const bytes = await readSourceFile(root, name); total += bytes.length;
    if (total > MAX_TREE_BYTES) throw new Error('Proof tree byte cap exceeded');
    files.push({ path: name, sha256: sha256(bytes), status: 'M' });
  }
  let commit: string | null = null;
  try { commit = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim(); } catch { /* New repository. */ }
  const dirty = (await git(root, ['status', '--porcelain', '--untracked-files=all'])).trim().length > 0;
  return { root, run_key: canonicalTreeKey(files), repo_fingerprint: sha256(root), commit, dirty,
    manifest: { files, lockfiles: files.map(file => file.path).filter(name => LOCKFILES.has(name.split('/').at(-1)!)) } };
}

export async function assertTreeUnchanged(snapshot: TreeSnapshot): Promise<void> {
  if ((await treeKey(snapshot.root)).run_key !== snapshot.run_key) throw new Error('STALE_CONTENT: tree changed during proof preparation');
}
