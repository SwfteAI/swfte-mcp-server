import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, opendirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { confineDirectory, confinePath } from '../fsguard.js';

export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const MAX_BLOB_BYTES = 4 * 1024 * 1024;
const MAX_OBJECTS = 8192;
const permissive = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'CC0-1.0', 'Unlicense', '0BSD']);
const provider = new RegExp('(?:sk_' + 'live_[A-Za-z0-9]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,}'
  + '|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}'
  + '|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|https?://[^\\s/:]+:[^\\s/@]+@)');
const assignment = /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']?([A-Za-z0-9/+_.=-]{24,})/gi;
export class TwinIntakeRefusal extends Error {
  constructor(readonly code: string) { super(code); this.name = 'TwinIntakeRefusal'; }
}
export function requireNoProductionSecret(bytes: Uint8Array): void {
  const text = Buffer.from(bytes).toString('utf8');
  if (provider.test(text)) throw new TwinIntakeRefusal('PRODUCTION_CREDENTIAL');
  for (const match of text.matchAll(assignment)) {
    const value = match[1]!;
    if (value.startsWith('sk_test_')) continue;
    const counts = new Map<string, number>();
    for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1);
    const entropy = [...counts.values()].reduce((n, count) => { const p = count / value.length; return n - p * Math.log2(p); }, 0);
    if (entropy >= 4.2) throw new TwinIntakeRefusal('PRODUCTION_CREDENTIAL');
  }
}
function requireLicense(text: string, path: string): boolean {
  const spdx = [...text.matchAll(/SPDX-License-Identifier:[ \t]*([^\r\n]*)/g)];
  for (const match of spdx) {
    const license = match[1]!.replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
    if (!permissive.has(license)) throw new TwinIntakeRefusal('SOURCE_LICENSE_REFUSED');
  }
  if (/(?:^|\/)package\.json$/.test(path)) {
    let doc: { license?: unknown };
    try { doc = JSON.parse(text); } catch { throw new TwinIntakeRefusal('INVALID_PACKAGE_MANIFEST'); }
    if (doc.license === undefined) return spdx.length > 0;
    if (typeof doc.license !== 'string' || !permissive.has(doc.license)) throw new TwinIntakeRefusal('SOURCE_LICENSE_REFUSED');
    return true;
  }
  if (/(?:^|\/)licen[cs]e(?:\.(?:md|txt))?$/i.test(path)) {
    if (/Business Source License|Elastic License|GNU (?:AFFERO |LESSER )?GENERAL PUBLIC LICENSE/i.test(text)) throw new TwinIntakeRefusal('SOURCE_LICENSE_REFUSED');
    if (!spdx.length && !/MIT License|Apache License|BSD/.test(text)) throw new TwinIntakeRefusal('SOURCE_LICENSE_REFUSED');
    return true;
  }
  return spdx.length > 0;
}
function git(root: string, args: string[], maxBuffer = MAX_HISTORY_BYTES, deadline = Date.now() + 30_000, input?: string): Buffer {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new TwinIntakeRefusal('INTAKE_TIME_LIMIT');
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.ext.allow=never', '-C', root, ...args], {
      maxBuffer, timeout: remaining, input,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch { throw new TwinIntakeRefusal('GIT_INTAKE_REFUSED'); }
}
/** Packs committed history only. Every reachable blob is inspected, including deleted old secrets. */
export function packTwinBundle(repoPath: string, baseRef?: string): { bytes: Uint8Array; snapshotHash: string; commitShas: string[] } {
  const deadline = Date.now() + 30_000;
  const root = confineDirectory(repoPath);
  // Git may follow object/config links or execute repository-configured filters before a status is returned.
  // Refuse those source-controlled surfaces before invoking Git at all.
  const localGit = join(root, '.git');
  if (!existsSync(localGit) || !lstatSync(localGit).isDirectory() || lstatSync(localGit).isSymbolicLink()) throw new TwinIntakeRefusal('EXTERNAL_GIT_STORAGE_REFUSED');
  for (const metadata of ['shallow', 'info/grafts', 'objects/info/http-alternates', 'objects/info/alternates']) {
    if (existsSync(join(localGit, metadata))) throw new TwinIntakeRefusal('INCOMPLETE_GIT_HISTORY_REFUSED');
  }
  let entries = 0;
  const inspect = (directory: string, depth = 0) => {
    if (depth > 20) throw new TwinIntakeRefusal('HISTORY_LIMIT');
    const dir = opendirSync(directory);
    try { let entry;
      while ((entry = dir.readSync()) !== null) {
        if (++entries > MAX_OBJECTS || Date.now() > deadline) throw new TwinIntakeRefusal('HISTORY_LIMIT');
        const path = join(directory, entry.name); const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new TwinIntakeRefusal('EXTERNAL_GIT_STORAGE_REFUSED');
        if (entry.name.toLowerCase().endsWith('.promisor')) throw new TwinIntakeRefusal('INCOMPLETE_GIT_HISTORY_REFUSED');
        if (stat.isDirectory()) inspect(path, depth + 1);
      }
    } finally { dir.closeSync(); }
  };
  inspect(localGit);
  const configPath = join(localGit, 'config');
  if (lstatSync(configPath).size > 65536) throw new TwinIntakeRefusal('UNSAFE_GIT_CONFIG');
  const localConfig = readFileSync(configPath, 'utf8');
  if (/^\s*\[(?:include|includeif|filter|diff|merge)\b/im.test(localConfig) || /^\s*(?:worktree|attributesfile|worktreeconfig)\s*=/im.test(localConfig)) throw new TwinIntakeRefusal('UNSAFE_GIT_CONFIG');
  if (/^\s*(?:partialclone|promisor)\s*=/im.test(localConfig)) throw new TwinIntakeRefusal('INCOMPLETE_GIT_HISTORY_REFUSED');
  const run = (args: string[], maxBuffer = MAX_HISTORY_BYTES, input?: string) => git(root, args, maxBuffer, deadline, input);
  const top = run(['rev-parse', '--show-toplevel'], 4096).toString('utf8').trim();
  if (realpathSync(top) !== realpathSync(root)) throw new TwinIntakeRefusal('REPOSITORY_ROOT_REQUIRED');
  const gitDir = run(['rev-parse', '--absolute-git-dir'], 4096).toString('utf8').trim();
  const relGit = relative(root, realpathSync(gitDir));
  if (relGit === '..' || relGit.startsWith('..' + sep)) throw new TwinIntakeRefusal('EXTERNAL_GIT_STORAGE_REFUSED');
  if (existsSync(join(gitDir, 'objects/info/alternates'))) throw new TwinIntakeRefusal('EXTERNAL_GIT_STORAGE_REFUSED');
  for (const directory of ['objects', 'objects/info', 'objects/pack']) {
    const path = join(gitDir, directory);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new TwinIntakeRefusal('EXTERNAL_GIT_STORAGE_REFUSED');
  }
  if (run(['status', '--porcelain=v1', '-z'], MAX_BLOB_BYTES).length) throw new TwinIntakeRefusal('UNCOMMITTED_SOURCE_REFUSED');
  const tracked = run(['ls-files', '-z'], MAX_BLOB_BYTES).toString('utf8').split('\0').filter(Boolean);
  for (const path of tracked) {
    const target = confinePath(resolve(root, path));
    if (lstatSync(target).isSymbolicLink()) throw new TwinIntakeRefusal('SOURCE_LINK_REFUSED');
  }
  if (baseRef !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(baseRef) || baseRef.includes('..')) throw new TwinIntakeRefusal('INVALID_BASE_REF');
    run(['rev-parse', '--verify', baseRef + '^{commit}'], 4096);
  }
  const refBytes = run(['for-each-ref', '--format=%(objectname) %(refname)'], MAX_BLOB_BYTES);
  requireNoProductionSecret(refBytes);
  const refLines = refBytes.toString('utf8').trim().split('\n').filter(Boolean);
  const head = run(['rev-parse', '--verify', 'HEAD'], 128).toString('utf8').trim();
  const advertised = [...refLines, `${head} HEAD`].sort();
  const roots = [...new Set([...refLines.map(line => line.split(' ')[0]!), head])];
  const objects = run(['rev-list', '--objects', ...roots], MAX_BLOB_BYTES).toString('utf8').split('\n').filter(Boolean);
  if (!objects.length || objects.length > MAX_OBJECTS) throw new TwinIntakeRefusal('HISTORY_LIMIT');
  const commits = run(['rev-list', ...roots], MAX_BLOB_BYTES).toString('utf8').trim().split('\n');
  if (commits.length > 256) throw new TwinIntakeRefusal('HISTORY_LIMIT');
  const pathsByObject = new Map<string, Set<string>>();
  for (const commit of commits) {
    const entries = run(['ls-tree', '-r', '-z', commit], MAX_BLOB_BYTES).toString('utf8').split('\0').filter(Boolean);
    for (const entry of entries) {
      const match = /^(\d+) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(entry);
      if (!match || match[1] === '120000' || match[1] === '160000') throw new TwinIntakeRefusal('SOURCE_LINK_REFUSED');
      const paths = pathsByObject.get(match[3]!) ?? new Set<string>(); paths.add(match[4]!); pathsByObject.set(match[3]!, paths);
    }
  }
  const oids = objects.map(row => row.split(' ')[0]!);
  if (oids.some(oid => !/^[0-9a-f]{40,64}$/.test(oid))) throw new TwinIntakeRefusal('INVALID_GIT_OBJECT');
  const metadata = run(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], MAX_BLOB_BYTES, oids.join('\n') + '\n').toString('utf8').trim().split('\n');
  if (metadata.length !== objects.length) throw new TwinIntakeRefusal('INVALID_GIT_OBJECT');
  let scanned = 0;
  let declared = false;
  for (const row of metadata) {
    const [oid, kind, rawSize] = row.split(' ');
    if (!oid || !/^[0-9a-f]{40,64}$/.test(oid)) throw new TwinIntakeRefusal('INVALID_GIT_OBJECT');
    if (!kind || !['blob', 'commit', 'tree', 'tag'].includes(kind)) throw new TwinIntakeRefusal('INVALID_GIT_OBJECT');
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB_BYTES || scanned + size > MAX_HISTORY_BYTES) throw new TwinIntakeRefusal('HISTORY_LIMIT');
    const bytes = run(['cat-file', kind, oid], MAX_BLOB_BYTES);
    if (bytes.length !== size) throw new TwinIntakeRefusal('INVALID_GIT_OBJECT');
    scanned += bytes.length;
    requireNoProductionSecret(bytes);
    if (kind === 'blob') for (const path of pathsByObject.get(oid) ?? []) declared = requireLicense(bytes.toString('utf8'), path) || declared;
  }
  if (!declared) throw new TwinIntakeRefusal('SOURCE_LICENSE_UNDECLARED');
  const temp = mkdtempSync(join(tmpdir(), 'swfte-twin-'));
  try {
    const file = join(temp, 'source.bundle');
    run(['bundle', 'create', file, '--all'], 4096);
    const bundleHeads = run(['bundle', 'list-heads', file], MAX_BLOB_BYTES).toString('utf8').trim().split('\n').filter(Boolean).sort();
    if (JSON.stringify(bundleHeads) !== JSON.stringify(advertised)) throw new TwinIntakeRefusal('SOURCE_CHANGED_DURING_INTAKE');
    if (lstatSync(file).size > MAX_BUNDLE_BYTES) throw new TwinIntakeRefusal('BUNDLE_LIMIT');
    const bytes = new Uint8Array(readFileSync(file));
    // Ref names and capabilities are plaintext payload, separate from the inspected Git objects.
    const headerEnd = Buffer.from(bytes).indexOf(Buffer.from('\n\n'));
    if (headerEnd < 0 || headerEnd > MAX_BLOB_BYTES) throw new TwinIntakeRefusal('INVALID_GIT_BUNDLE');
    requireNoProductionSecret(bytes.subarray(0, headerEnd + 2));
    const snapshotHash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    return { bytes, snapshotHash, commitShas: commits };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
