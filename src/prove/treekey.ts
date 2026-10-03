import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NativeFilesystem } from '../native-filesystem.js';
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

/** Holds the admitted native directory descriptor; descendant reads never reopen a pathname. */
export class ProofSourceRoot {
  private readonly capability: NativeFilesystem;
  private readonly observed = new Map<string, string>();
  constructor(readonly root: string) { this.capability = NativeFilesystem.openRoot(root); }
  assertRoot(): void {
    const current = lstatSync(this.root, { bigint: true });
    if (!current.isDirectory() || current.dev.toString() !== this.capability.identity.dev
      || current.ino.toString() !== this.capability.identity.ino) throw new Error('STALE_CONTENT: repository root replaced');
  }
  read(path: string): Uint8Array {
    if (!validRelativePath(path) || excludedSourcePath(path)) throw new Error('Source path refused');
    this.assertRoot();
    const snapshot = this.capability.read(path, MAX_FILE_BYTES);
    if (!snapshot) throw new Error('STALE_CONTENT: source file disappeared');
    const { bytes, ...identity } = snapshot;
    const observation = JSON.stringify([identity, sha256(bytes)]);
    const prior = this.observed.get(path);
    if (prior !== undefined && prior !== observation) throw new Error('STALE_CONTENT: source identity or bytes changed');
    this.observed.set(path, observation);
    return snapshot.bytes;
  }
  close(): void { this.capability.close(); }
}

export async function readSourceFile(root: string | ProofSourceRoot, path: string): Promise<Uint8Array> {
  if (!validRelativePath(path) || excludedSourcePath(path)) throw new Error('Source path refused');
  if (root instanceof ProofSourceRoot) return root.read(path);
  const held = new ProofSourceRoot(await realpath(resolve(root)));
  try { return held.read(path); } finally { held.close(); }
}

/** Git chooses names through its pathname namespace; native authority alone supplies source bytes.
 * Bootstrap and Git metadata are not descriptor-relative or an atomic whole-tree observation.
 */
export async function treeKey(path: string, held?: ProofSourceRoot): Promise<TreeSnapshot> {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)) throw new Error('A local repository path is required');
  const root = await realpath(resolve(path));
  if (held && held.root !== root) throw new Error('STALE_CONTENT: repository root changed');
  const source = held ?? new ProofSourceRoot(root);
  try {
  source.assertRoot();
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  if (await realpath(top) !== root) throw new Error('The repository root is required');
  const names = [...new Set((await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
    .split('\0').filter(Boolean))].filter(name => !excludedSourcePath(name));
  if (names.length > 20_000) throw new Error('Proof manifest file cap exceeded');
  const files: ProofFile[] = []; let total = 0;
  for (const name of names.sort()) {
    if (!validRelativePath(name)) throw new Error('Noncanonical source path');
    const bytes = await readSourceFile(source, name); total += bytes.length;
    if (total > MAX_TREE_BYTES) throw new Error('Proof tree byte cap exceeded');
    files.push({ path: name, sha256: sha256(bytes), status: 'M' });
  }
  let commit: string | null = null;
  try { commit = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim(); } catch { /* New repository. */ }
  const dirty = (await git(root, ['status', '--porcelain', '--untracked-files=all'])).trim().length > 0;
  source.assertRoot();
  const lockfiles = files.map(file => file.path).filter(name => LOCKFILES.has(name.split('/').at(-1)!));
  files.forEach(file => Object.freeze(file)); Object.freeze(files); Object.freeze(lockfiles);
  return Object.freeze({ root, run_key: canonicalTreeKey(files), repo_fingerprint: sha256(root), commit, dirty,
    manifest: Object.freeze({ files, lockfiles }) });
  } finally { if (!held) source.close(); }
}

export async function assertTreeUnchanged(snapshot: TreeSnapshot, held?: ProofSourceRoot): Promise<void> {
  if ((await treeKey(snapshot.root, held)).run_key !== snapshot.run_key) throw new Error('STALE_CONTENT: tree changed during proof preparation');
}
