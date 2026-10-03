import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, mkdir, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalTreeKey, excludedSourcePath, readSourceFile, sha256, treeKey, assertTreeUnchanged, ProofSourceRoot } from '../src/prove/treekey.js';
const exec = promisify(execFile);

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prove-tree-'));
  await exec('git', ['init', '-q', root]);
  return root;
}
test('tree key sorts paths canonically and binds actual bytes', async () => {
  const root = await repo();
  try {
    await writeFile(join(root, 'b.ts'), 'const total = 2;'); await writeFile(join(root, 'a.ts'), 'export const value = 1;');
    const first = await treeKey(root);
    assert.equal(first.run_key, canonicalTreeKey([...first.manifest.files].reverse()));
    assert.equal(first.manifest.files.length, 2);
    await writeFile(join(root, 'a.ts'), 'export const value = 3;');
    assert.notEqual((await treeKey(root)).run_key, first.run_key);
    await assert.rejects(assertTreeUnchanged(first), /STALE_CONTENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('canonical keys reject aliases, duplicates and noncanonical hashes', () => {
  for (const path of ['../x', '/x', 'x//y', 'x/./y', 'x\\y', 'C:x', 'x\n']) {
    assert.throws(() => canonicalTreeKey([{ path, sha256: sha256('x') }]));
  }
  assert.throws(() => canonicalTreeKey([{ path: 'x', sha256: 'PASS' }]));
  assert.throws(() => canonicalTreeKey([{ path: 'x', sha256: sha256('x') }, { path: 'x', sha256: sha256('x') }]));
  assert.equal(canonicalTreeKey([]), sha256('[]'));
});
test('ignored files and secret-bearing excluded paths never enter manifest', async () => {
  const root = await repo();
  try {
    await writeFile(join(root, '.gitignore'), 'ignored.ts\n');
    await writeFile(join(root, 'ignored.ts'), 'excluded'); await writeFile(join(root, 'safe.ts'), 'const total = 2;');
    assert.equal((await treeKey(root)).manifest.files.some(file => file.path === 'ignored.ts'), false);
    for (const path of ['.env', 'nested/.env.local', 'nested/key.pem', 'target/test', 'node_modules/x', '.nexus/gates/test.md']) {
      assert.equal(excludedSourcePath(path), true);
    }
    assert.equal(excludedSourcePath('safe.ts'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('source symlink to outside is refused with a safe file positive control', async () => {
  const root = await repo(); const outside = await mkdtemp(join(tmpdir(), 'prove-outside-'));
  try {
    await writeFile(join(outside, 'outside.txt'), 'private'); await writeFile(join(root, 'safe.ts'), 'safe');
    assert.equal(Buffer.from(await readSourceFile(root, 'safe.ts')).toString(), 'safe');
    await symlink(join(outside, 'outside.txt'), join(root, 'linked.ts'));
    await assert.rejects(treeKey(root), /SYMLINK_REFUSED/);
    await assert.rejects(readSourceFile(root, '../outside.txt'), /refused/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test('actual held native reader refuses late parent replacement after a nested positive', async () => {
  const root = await repo(); const outside = await mkdtemp(join(tmpdir(), 'prove-late-parent-'));
  let held: ProofSourceRoot | undefined;
  try {
    await mkdir(join(root, 'nested')); await writeFile(join(root, 'nested/value.ts'), 'safe');
    await writeFile(join(outside, 'value.ts'), 'outside'); held = new ProofSourceRoot(await realpath(root)); // treeKey compares against the real path (macOS tmpdir is a symlink)
    assert.equal(Buffer.from(await readSourceFile(held, 'nested/value.ts')).toString(), 'safe');
    const snapshot = await treeKey(root, held);
    assert.equal(snapshot.run_key, canonicalTreeKey([{ path: 'nested/value.ts', sha256: sha256('safe') }]));
    await rename(join(root, 'nested'), join(root, 'retained'));
    await symlink(outside, join(root, 'nested'));
    await assert.rejects(readSourceFile(held, 'nested/value.ts'), /SYMLINK_REFUSED/);
    await assert.rejects(assertTreeUnchanged(snapshot, held), /SYMLINK_REFUSED|STALE_CONTENT/);
  } finally { held?.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
test('subdirectory and remote URL targets are not accepted as repository roots', async () => {
  await assert.rejects(treeKey('https://example.invalid/repo'), /local repository/);
});
