import test from 'node:test';
import { isMainThread } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fstatSync, linkSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NativeFilesystem, nativeArtifactPaths, nativePlatformTuple, NATIVE_FILE_LIMIT } from '../src/native-filesystem.js';

const bytes = (s: string) => Buffer.from(s);
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function fixture(run: (root: string, outside: string) => void) {
  const base = mkdtempSync(join(tmpdir(), 'native-fs-control-'));
  const root = join(base, 'project'); const outside = join(base, 'outside');
  mkdirSync(root); mkdirSync(outside);
  try { run(root, outside); } finally { rmSync(base, { recursive: true, force: true }); }
}

test('native platform selection refuses unproduced OS CPU and libc tuples', () => {
  assert.equal(nativePlatformTuple('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(nativePlatformTuple('darwin', 'x64'), 'darwin-x64');
  assert.equal(nativePlatformTuple('linux', 'x64', '2.31'), 'linux-x64-glibc');
  for (const args of [['win32', 'x64'], ['linux', 'arm64', '2.31'], ['linux', 'x64', ''], ['darwin', 'ia32']])
    assert.throws(() => nativePlatformTuple(args[0]!, args[1]!, args[2]), /UNSUPPORTED_PLATFORM/);
});

test('actual native producer creates reads merges replaces and returns descriptor readback', () => fixture(root => {
  const fs = NativeFilesystem.openRoot(root);
  try {
    const dir = fs.mkdir('src/nested'); assert(dir.ino.length > 0);
    assert.equal(fs.read('src/nested/client.ts'), null);
    const made = fs.replace({ rel: 'src/nested/client.ts', expected: null, bytes: bytes('export const one = 1;\n'), policy: 'create-only' });
    assert.equal(made.action, 'create'); assert.equal(digest(made.bytesReadBack), digest(readFileSync(join(root, 'src/nested/client.ts'))));
    const first = fs.read('src/nested/client.ts')!;
    assert.equal(first.nlink, '1'); assert.equal(first.bytes.toString(), 'export const one = 1;\n');
    const merged = fs.replace({ rel: 'src/nested/client.ts', expected: first, bytes: bytes(first.bytes.toString() + 'export const two = 2;\n'), policy: 'merge' });
    assert.equal(merged.action, 'merge'); assert.equal(merged.bytesReadBack.toString(), readFileSync(join(root, 'src/nested/client.ts'), 'utf8'));
    const second = fs.read('src/nested/client.ts')!;
    const unchanged = fs.replace({ rel: 'src/nested/client.ts', expected: second, bytes: second.bytes, policy: 'authorized-replace' });
    assert.equal(unchanged.action, 'unchanged'); assert.equal(unchanged.ino, second.ino);
    const replaced = fs.replace({ rel: 'src/nested/client.ts', expected: second, bytes: bytes('new content\n'), policy: 'authorized-replace' });
    assert.equal(replaced.action, 'overwrite'); assert.notEqual(replaced.ino, second.ino);
    assert.equal(digest(replaced.bytesReadBack), digest(readFileSync(join(root, 'src/nested/client.ts'))));
    assert.equal(Number(replaced.mode) & 0o7777, 0o644);
  } finally { fs.close(); fs.close(); }
  assert.throws(() => fs.read('src/nested/client.ts'), /ROOT_CLOSED/);
}));

test('atomic replacement preserves old open inode bytes instead of truncating it', () => fixture(root => {
  writeFileSync(join(root, 'client.ts'), 'old complete content');
  const old = openSync(join(root, 'client.ts'), constants.O_RDONLY);
  const fs = NativeFilesystem.openRoot(root);
  try {
    const before = fs.read('client.ts')!;
    const next = fs.replace({ rel: 'client.ts', expected: before, bytes: bytes('new complete content'), policy: 'authorized-replace' });
    assert.equal(readFileSync(old, 'utf8'), 'old complete content');
    assert.equal(readFileSync(join(root, 'client.ts'), 'utf8'), 'new complete content');
    assert.notEqual(next.ino, String(fstatSync(old).ino));
  } finally { closeSync(old); fs.close(); }
}));

test('stale snapshots and create conflicts preserve actual changed file', () => fixture(root => {
  writeFileSync(join(root, 'client.ts'), 'initial');
  const fs = NativeFilesystem.openRoot(root);
  try {
    const initial = fs.read('client.ts')!; writeFileSync(join(root, 'client.ts'), 'human edit');
    assert.throws(() => fs.replace({ rel: 'client.ts', expected: initial, bytes: bytes('generated'), policy: 'merge' }), /STALE_CONTENT/);
    assert.throws(() => fs.replace({ rel: 'client.ts', expected: null, bytes: bytes('generated'), policy: 'create-only' }), /CONFLICT/);
    assert.equal(readFileSync(join(root, 'client.ts'), 'utf8'), 'human edit');
  } finally { fs.close(); }
}));

test('existing hardlinks refuse reads merges and replacements without external truncation', () => fixture((root, outside) => {
  const victim = join(outside, 'victim'); writeFileSync(victim, 'external immutable control'); linkSync(victim, join(root, 'client.ts'));
  const fs = NativeFilesystem.openRoot(root);
  try {
    assert.throws(() => fs.read('client.ts'), /HARDLINK_REFUSED/);
    assert.throws(() => fs.replace({ rel: 'client.ts', expected: null, bytes: bytes('overwrite'), policy: 'authorized-replace' }), /HARDLINK_REFUSED/);
    assert.equal(readFileSync(victim, 'utf8'), 'external immutable control');
  } finally { fs.close(); }
}));

test('final and ancestor symlinks are refused and never read or write the victim', () => fixture((root, outside) => {
  writeFileSync(join(outside, 'victim'), 'outside');
  symlinkSync(outside, join(root, 'linked')); symlinkSync(join(outside, 'victim'), join(root, 'leaf'));
  const fs = NativeFilesystem.openRoot(root);
  try {
    for (const rel of ['linked/victim', 'leaf']) {
      assert.throws(() => fs.read(rel), /SYMLINK_REFUSED/);
      assert.throws(() => fs.replace({ rel, expected: null, bytes: bytes('bad'), policy: 'create-only' }), /SYMLINK_REFUSED/);
    }
    assert.equal(readFileSync(join(outside, 'victim'), 'utf8'), 'outside');
  } finally { fs.close(); }
}));

test('descriptor capability cannot be redirected by replacing original root name; moved-root residual is explicit', () => fixture((root, outside) => {
  const fs = NativeFilesystem.openRoot(root); const moved = join(outside, 'moved-project');
  renameSync(root, moved); symlinkSync(outside, root);
  try {
    fs.replace({ rel: 'capability.ts', expected: null, bytes: bytes('anchored inode'), policy: 'create-only' });
    assert.equal(existsSync(join(outside, 'capability.ts')), false, 'Original-root symlink never redirects the descriptor');
    assert.equal(readFileSync(join(moved, 'capability.ts'), 'utf8'), 'anchored inode', 'Held capability moves: this is not current-path ancestry confinement');
  } finally { fs.close(); }
}));

test('relative path and file bounds refuse before writes and valid exact cap still works', () => fixture(root => {
  const fs = NativeFilesystem.openRoot(root);
  try {
    for (const rel of ['', '/', '../outside', 'src/../outside', './client', 'src//client', 'src\\client', 'nul\0name'])
      assert.throws(() => fs.replace({ rel, expected: null, bytes: bytes('bad'), policy: 'create-only' }), /PATH_REFUSED/);
    assert.throws(() => fs.replace({ rel: 'oversize', expected: null, bytes: Buffer.alloc(NATIVE_FILE_LIMIT + 1), policy: 'create-only' }), /SIZE_LIMIT/);
    assert.equal(existsSync(join(root, 'oversize')), false);
    const data = Buffer.alloc(NATIVE_FILE_LIMIT, 97);
    const made = fs.replace({ rel: 'at-cap', expected: null, bytes: data, policy: 'create-only' });
    assert.equal(digest(made.bytesReadBack), digest(data));
    assert.throws(() => fs.read('at-cap', NATIVE_FILE_LIMIT - 1), /SIZE_LIMIT/);
  } finally { fs.close(); }
}));

test('native helper itself rejects bad or trailing protocol data without filesystem mutation', () => fixture(root => {
  const artifact = nativeArtifactPaths(); const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd, { bigint: true });
    const header = Buffer.alloc(34); header.write('SWFTECF1', 0, 'ascii'); header.writeUInt32BE(1, 8);
    header.writeBigUInt64BE(st.dev, 16); header.writeBigUInt64BE(st.ino, 24);
    const unknown = Buffer.from(header); unknown[12] = 99;
    const invalidUtf8 = Buffer.from(header); invalidUtf8[12] = 3; invalidUtf8.writeUInt16BE(1, 32);
    const wrongRoot = Buffer.from(header); wrongRoot.writeBigUInt64BE(0n, 24);
    const controls: Array<[Buffer, RegExp]> = [
      [bytes('not a protocol'), /PROTOCOL_INVALID/], [Buffer.concat([header, bytes('trailing')]), /PROTOCOL_INVALID/],
      [Buffer.alloc(9 * 1024 * 1024), /PROTOCOL_INVALID/], [unknown, /PROTOCOL_INVALID/],
      [Buffer.concat([invalidUtf8, Buffer.from([0, 2, 0xc0, 0xaf])]), /PATH_REFUSED/], [wrongRoot, /PATH_REFUSED/],
    ];
    for (const [input, expected] of controls) {
      const result = spawnSync(artifact.executable, [], { input, stdio: ['pipe', 'pipe', 'pipe', fd], maxBuffer: 1024 * 1024, timeout: 10_000 });
      assert.equal(result.error, undefined); assert.equal(result.status, 0);
      assert.match(result.stdout.subarray(16).toString(), expected);
      assert.deepEqual(readdirSync(root), [], 'Malformed requests cause no directory or file effects');
    }
  } finally { closeSync(fd); }
}));

test('isolated source-layout wrapper refuses absent or invalid helper without creating project files', async () => {
  const base = mkdtempSync(join(tmpdir(), 'native-artifact-control-'));
  const packageRoot = join(base, 'package'); const root = join(base, 'project');
  mkdirSync(join(packageRoot, 'src'), { recursive: true }); mkdirSync(root);
  const modulePath = join(packageRoot, 'src/native-filesystem.ts');
  copyFileSync(fileURLToPath(new URL('../src/native-filesystem.ts', import.meta.url)), modulePath);
  writeFileSync(join(packageRoot, 'package.json'), '{"type":"module"}');
  try {
    const isolated = await import(pathToFileURL(modulePath).href) as typeof import('../src/native-filesystem.js');
    assert.throws(() => isolated.NativeFilesystem.openRoot(root), /NATIVE_ARTIFACT_MISSING_OR_INVALID/);
    const artifact = isolated.nativeArtifactPaths(); mkdirSync(dirname(artifact.executable), { recursive: true });
    writeFileSync(artifact.executable, 'invalid executable');
    writeFileSync(artifact.manifest, JSON.stringify({ protocol: 'wrong', tuple: nativePlatformTuple(), sha256: 'a'.repeat(64) }));
    assert.throws(() => isolated.NativeFilesystem.openRoot(root), /NATIVE_ARTIFACT_MISSING_OR_INVALID/);
    assert.equal(existsSync(join(root, 'client.ts')), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('isolated wrapper rejects a corrupt binary hash and wrong artifact tuple before opening project', async () => {
  const base = mkdtempSync(join(tmpdir(), 'native-integrity-control-'));
  const packageRoot = join(base, 'package'); const root = join(base, 'project');
  mkdirSync(join(packageRoot, 'src'), { recursive: true }); mkdirSync(root);
  const modulePath = join(packageRoot, 'src/native-filesystem.ts');
  copyFileSync(fileURLToPath(new URL('../src/native-filesystem.ts', import.meta.url)), modulePath);
  writeFileSync(join(packageRoot, 'package.json'), '{"type":"module"}');
  try {
    const isolated = await import(pathToFileURL(modulePath).href) as typeof import('../src/native-filesystem.js');
    const original = nativeArtifactPaths(), artifact = isolated.nativeArtifactPaths();
    mkdirSync(dirname(artifact.executable), { recursive: true });
    copyFileSync(original.executable, artifact.executable); copyFileSync(original.manifest, artifact.manifest);
    const good = isolated.NativeFilesystem.openRoot(root);
    try { good.replace({ rel: 'positive.ts', expected: null, bytes: bytes('packaged artifact positive'), policy: 'create-only' }); }
    finally { good.close(); }
    const metadata = JSON.parse(readFileSync(artifact.manifest, 'utf8'));
    writeFileSync(artifact.manifest, JSON.stringify({ ...metadata, tuple: 'unproduced-ABI' }));
    assert.throws(() => isolated.NativeFilesystem.openRoot('/must-not-read-project'), /NATIVE_ARTIFACT_MISSING_OR_INVALID/);
    writeFileSync(artifact.manifest, JSON.stringify(metadata));
    const corrupt = readFileSync(artifact.executable); corrupt[0] = corrupt[0]! ^ 255; writeFileSync(artifact.executable, corrupt);
    assert.throws(() => isolated.NativeFilesystem.openRoot('/must-not-read-project'), /NATIVE_ARTIFACT_MISSING_OR_INVALID/);
    assert.equal(readFileSync(join(root, 'positive.ts'), 'utf8'), 'packaged artifact positive');
  } finally { rmSync(base, { recursive: true, force: true }); }
});


test('actual native create respects inherited umask and replacement preserves restrictive permissions', { concurrency: false }, () => fixture(root => {
  assert(isMainThread, 'permission control must run on the Node main thread');
  for (const [mask, expectedMode] of [[0o077, 0o600], [0o022, 0o644]]) {
    // Setter overload returns the prior mask; no deprecated zero-argument getter or worker call.
    const priorMask = process.umask(mask!);
    let native: NativeFilesystem | undefined;
    try {
      native = NativeFilesystem.openRoot(root);
      const rel = `created-${mask}.ts`;
      const made = native.replace({ rel, expected: null, bytes: bytes('private generated source'), policy: 'create-only' });
      assert.equal(made.action, 'create'); assert.equal(made.mode & 0o7777, expectedMode);
      const file = openSync(join(root, rel), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { assert.equal(fstatSync(file).mode & 0o7777, expectedMode, 'actual published inode must respect creation mask'); }
      finally { closeSync(file); }
      assert.equal(native.read(rel)!.mode & 0o7777, expectedMode);
      const existing = `existing-${mask}.ts`;
      writeFileSync(join(root, existing), 'human private source', { mode: 0o600, flag: 'wx' });
      const snapshot = native.read(existing)!; assert.equal(snapshot.mode & 0o7777, 0o600);
      const replaced = native.replace({ rel: existing, expected: snapshot, bytes: bytes('authorized replacement'), policy: 'authorized-replace' });
      assert.equal(replaced.action, 'overwrite'); assert.equal(replaced.mode & 0o7777, 0o600);
      const replacedFile = openSync(join(root, existing), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { assert.equal(fstatSync(replacedFile).mode & 0o7777, 0o600, 'replacement must not widen prior restrictive mode'); }
      finally { closeSync(replacedFile); }
    } finally {
      try { native?.close(); } finally { process.umask(priorMask); }
    }
  }
}));
