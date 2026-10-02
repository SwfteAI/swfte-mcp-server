/** Exercise the actual npm tarball, not a workspace build with accidental source dependencies. */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, rmSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modes = new Set(['--emit-candidate', '--consume-candidate']);
const mode = process.argv[2];
assert(!mode || (modes.has(mode) && process.argv.length === 4), 'Expected --emit-candidate directory or --consume-candidate directory');
const candidate = mode ? resolve(process.argv[3]) : undefined;
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const tuples = ['darwin-arm64', 'darwin-x64', 'linux-x64-glibc'];
const temporary = mkdtempSync(join(tmpdir(), 'swfte-package-smoke-'));
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const envelope = mode === '--consume-candidate' ? JSON.parse(readFileSync(join(candidate, 'candidate.json'), 'utf8')) : undefined;
  const receipt = envelope?.pack ?? JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root, encoding: 'utf8', timeout: 60_000 }))[0];
  assert(typeof receipt.filename === 'string' && /^[A-Za-z0-9_.-]+\.tgz$/.test(receipt.filename), 'Invalid candidate filename');
  const tarball = join(mode === '--consume-candidate' ? candidate : temporary, receipt.filename);
  const tarballBytes = readFileSync(tarball);
  assert.equal('sha512-' + createHash('sha512').update(tarballBytes).digest('base64'), receipt.integrity, 'Candidate tarball integrity');
  const sourceSha256 = digest(readFileSync(join(root, 'native/confined-fs.c')));
  if (process.env.SWFTE_NATIVE_CANDIDATE) {
    const approved = JSON.parse(readFileSync(join(resolve(process.env.SWFTE_NATIVE_CANDIDATE),'candidate.json'),'utf8'));
    assert.equal(approved.schema,'swfte-native-candidate/1');
    assert.equal(approved.sourceSha256,sourceSha256);
    assert.equal(approved.tarballSha512,digest(tarballBytes,'sha512'),'Every clean/prepublish build must preserve the exact tested full tarball');
    assert.equal(approved.pack.integrity,receipt.integrity);
  }
  if (envelope) {
    assert.equal(envelope.schema, 'swfte-native-candidate/1');
    assert.equal(envelope.sourceSha256, sourceSha256, 'Candidate must bind current corrected C');
    assert.equal(envelope.tarballSha512, digest(tarballBytes, 'sha512'));
  }
  const files = new Set(receipt.files.map(file => file.path));
  for (const required of ['package.json', 'dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE', 'src/preflight/cli.mjs',
    'dist/codemap/grammars/tree-sitter-python.wasm', 'dist/codemap/grammars/tree-sitter-java.wasm',
    'dist/codemap/grammars/LICENSE.tree-sitter-python', 'dist/codemap/grammars/LICENSE.tree-sitter-java',
    'dist/native-filesystem.js', 'dist/native-filesystem.d.ts', 'native/confined-fs.c', 'docs/native-filesystem-boundary.md'])
    assert(files.has(required), `Published package is missing ${required}`);
  const requireAll = process.env.SWFTE_NATIVE_REQUIRE_ALL === '1' || !!mode;
  if (requireAll) for (const tuple of tuples) for (const file of ['confined-fs', 'manifest.json'])
    assert(files.has(`dist/native/${tuple}/${file}`), `Complete candidate lacks ${tuple}/${file}`);
  assert(files.has('dist/native/assembly.json'), 'Native build must supply an assembly identity');
  for (const path of files) assert(!/(^|\/)\.env($|\.)|(^|\/)(node_modules|test|\.git)\//.test(path), `Private or development file in package: ${path}`);
  // Install the tarball as a real consumer. No dependency may resolve from the source worktree.
  const consumer = join(temporary, 'consumer');
  mkdirSync(consumer);
  const packedMetadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const tarballRef = 'file:' + tarball;
  const consumerMetadata = { name: 'swfte-isolated-smoke', version: '1.0.0', private: true, type: 'module',
    dependencies: { [packedMetadata.name]: tarballRef },
    // Consumer-only declaration dependency: exact immutable existing lock resolution.
    devDependencies: { '@types/node': JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages['node_modules/@types/node'].version } };
  writeFileSync(join(consumer, 'package.json'), JSON.stringify(consumerMetadata));
  // Reuse immutable resolutions and integrity from the actual lockfile, never installed modules.
  // npm ci independently verifies and extracts every artifact into this consumer.
  const consumerLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  consumerLock.name = consumerMetadata.name;
  consumerLock.version = consumerMetadata.version;
  consumerLock.packages[''] = { name: consumerMetadata.name, version: consumerMetadata.version,
    dependencies: consumerMetadata.dependencies, devDependencies: consumerMetadata.devDependencies };
  consumerLock.packages['node_modules/' + packedMetadata.name] = { version: packedMetadata.version,
    resolved: tarballRef, integrity: receipt.integrity, dependencies: packedMetadata.dependencies,
    bin: packedMetadata.bin, engines: packedMetadata.engines, license: packedMetadata.license };
  for (const [name, entry] of Object.entries(consumerLock.packages)) {
    if (entry.dev && !['node_modules/@types/node', 'node_modules/undici-types'].includes(name))
      delete consumerLock.packages[name];
  }
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(consumerLock));
  execFileSync(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--include=dev', '--offline'], {
    cwd: consumer, stdio: 'inherit', timeout: 180_000,
  });
  const packed = join(consumer, 'node_modules', '@swfte', 'mcp-server');
  const metadata = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
  assert.equal(metadata.name,packedMetadata.name); assert.equal(metadata.version,packedMetadata.version);
  assert.equal(metadata.license,'MIT');
  assert.equal(digest(readFileSync(join(packed,'LICENSE'))),digest(readFileSync(join(root,'LICENSE'))));
  assert.match(readFileSync(join(packed,'native/confined-fs.c'),'utf8'),/^\/\* SPDX-License-Identifier: MIT/);
  assert(existsSync(join(packed, metadata.main)), 'Package main is missing');
  assert(!lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), 'Consumer dependencies must be installed, never linked');
  assert(!lstatSync(packed).isSymbolicLink(), 'The packed module must be installed, never linked');
  function assertNoLinks(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      // npm's bin shims are intentionally links; actual package/dependency contents must be extracted.
      if (directory === join(consumer, 'node_modules') && entry.name === '.bin') continue;
      assert(!lstatSync(path).isSymbolicLink(), `Installed dependency/source link: ${path}`);
      if (entry.isDirectory()) assertNoLinks(path);
    }
  }
  assertNoLinks(join(consumer, 'node_modules'));
  assert.equal(digest(readFileSync(join(packed, 'native/confined-fs.c'))), sourceSha256);
  const manifests = {};
  for (const tuple of tuples) {
    const folder = join(packed, 'dist/native', tuple);
    if (!existsSync(folder)) { assert(!requireAll, `Missing installed ${tuple}`); continue; }
    const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
    for (const [name,mode] of [['confined-fs',0o755],['manifest.json',0o644]]) {
      const stat=lstatSync(join(folder,name)); assert(stat.isFile()); assert.equal(stat.nlink,1); assert.equal(stat.mode&0o777,mode);
    }
    assert.equal(manifest.tuple, tuple); assert.equal(manifest.sourceSha256, sourceSha256);
    assert.equal(manifest.sha256, digest(readFileSync(join(folder, 'confined-fs'))));
    manifests[tuple] = manifest.sha256;
  }
  const assembly=JSON.parse(readFileSync(join(packed,'dist/native/assembly.json'),'utf8'));
  assert.equal(assembly.schema,'swfte-native-assembly/1'); assert.equal(assembly.protocol,'SWFTE_CF1');
  assert.equal(assembly.sourceSha256,sourceSha256); assert.deepEqual(assembly.artifacts,manifests);
  if (envelope) assert.deepEqual(manifests, envelope.artifacts, 'Same candidate artifacts on every real runner');
  // Transpile the test harness into the consumer so its SDK imports also use that installation.
  const harness = ts.transpileModule(readFileSync(join(root, 'scripts/protocol-smoke.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const harnessPath = join(consumer, 'protocol-smoke.mjs');
  writeFileSync(harnessPath, harness);
  const isolatedEnv = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', SWFTE_SMOKE_ENTRY: join(packed, metadata.main) };
  // Run the genuine consumer-installed compiler, with no workspace declarations or resolution paths.
  const installedCompiler = join(consumer, 'node_modules/typescript/bin/tsc');
  for (const name of ['typescript', '@types/node', 'undici-types']) {
    const installed = JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(installed.version, consumerLock.packages['node_modules/' + name].version);
  }
  assert(!lstatSync(installedCompiler).isSymbolicLink());
  const positiveTypes = join(consumer, 'public-native-positive.mts');
  writeFileSync(positiveTypes, `
import type {} from '@swfte/mcp-server';
import { NativeFilesystem, NativeFilesystemError, nativePlatformTuple, nativeArtifactPaths } from '@swfte/mcp-server/native-filesystem';
import type { NativeIdentity, NativeSnapshot, NativeCommit, NativeReplace } from '@swfte/mcp-server/native-filesystem';
import type { NativeReplace as DeepReplace } from '@swfte/mcp-server/dist/native-filesystem.js';
function publicContract(root: string, previous: NativeSnapshot | null): NativeCommit {
 const fs: NativeFilesystem = NativeFilesystem.openRoot(root);
 const request: NativeReplace = {rel:'owned/file', expected:previous, bytes:Buffer.from('value'), policy:'merge'};
 const deep: DeepReplace = request;
 const result: NativeCommit = fs.replace(deep);
 const identity: NativeIdentity = result;
 const readback: Buffer = result.bytesReadBack;
 const observed: NativeSnapshot | null = fs.read('owned/file');
 fs.mkdir('owned'); fs.close();
 const tuple: string = nativePlatformTuple();
 const executable: string = nativeArtifactPaths().executable;
 const refusal: NativeFilesystemError = new NativeFilesystemError('PATH_REFUSED');
 void identity; void readback; void observed; void tuple; void executable; void refusal;
 return result;
}
void publicContract;
`);
  const typeArgs = ['--noEmit', '--strict', '--skipLibCheck', 'false', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node',
    '--typeRoots', join(consumer, 'node_modules/@types')];
  execFileSync(process.execPath, [installedCompiler, ...typeArgs, positiveTypes], {
    cwd: consumer, env: isolatedEnv, stdio: 'pipe', timeout: 60_000,
  });
  // Positive resolution must succeed first; each independent misuse must produce its own diagnostic.
  for (const [name, code, text] of [
    ['wrong-policy', 'TS2322', "import type {NativeReplace} from '@swfte/mcp-server/native-filesystem'; const bad: NativeReplace = {rel:'file',expected:null,bytes:new Uint8Array(),policy:'unsafe-overwrite'};"],
    ['wrong-bytes', 'TS2322', "import type {NativeReplace} from '@swfte/mcp-server/native-filesystem'; const bad: NativeReplace = {rel:'file',expected:null,bytes:'not-bytes',policy:'merge'};"],
    ['missing-export', 'TS2305', "import {NativeMissingExport} from '@swfte/mcp-server/native-filesystem'; void NativeMissingExport;"],
  ]) {
    const file = join(consumer, 'public-native-' + name + '.mts'); writeFileSync(file, text);
    let refusal;
    try { execFileSync(process.execPath, [installedCompiler, ...typeArgs, file], {
      cwd: consumer, env: isolatedEnv, stdio: 'pipe', timeout: 60_000,
    }); } catch (error) { refusal = error; }
    assert(refusal && Number.isInteger(refusal.status) && refusal.status !== 0, 'Installed compiler must reject ' + name);
    const diagnostics = String(refusal.stdout) + String(refusal.stderr);
    assert(diagnostics.includes('public-native-' + name + '.mts') && diagnostics.includes(code), diagnostics);
    assert(!diagnostics.includes('TS2307'), 'Missing modules cannot masquerade as misuse refusal');
  }
  console.log('SWFTE_INSTALLED_PUBLIC_TYPES_OK');
  // Public installed entry only: no workspace wrapper, helper or native compilation is available here.
  const nativeHarness = join(consumer, 'native-consumer.mjs');
  writeFileSync(nativeHarness, `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, renameSync, chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { NativeFilesystem, nativePlatformTuple, nativeArtifactPaths } from '@swfte/mcp-server/native-filesystem';
const tuple = nativePlatformTuple();
const artifact = nativeArtifactPaths();
assert.equal(artifact.tuple, tuple);
assert(artifact.executable.startsWith(${JSON.stringify(packed)} + '/'), 'helper must be from extracted package');
assert.equal(lstatSync(artifact.executable).nlink, 1);
for (const args of [['win32','x64'],['linux','arm64','2.35'],['linux','x64','']])
  assert.throws(() => nativePlatformTuple(...args), e => e.code === 'UNSUPPORTED_PLATFORM');
const project = ${JSON.stringify(join(temporary, 'native-project'))}; mkdirSync(project);
const outside = ${JSON.stringify(join(temporary, 'native-outside'))}; mkdirSync(outside);
writeFileSync(join(outside,'victim'), 'unchanged-victim');
const fs = NativeFilesystem.openRoot(project);
try {
 fs.mkdir('owned');
 const made = fs.replace({rel:'owned/file',expected:null,bytes:Buffer.from('first'),policy:'create-only'});
 assert.equal(made.action,'create'); assert.equal(made.bytesReadBack.toString(),'first');
 let before=fs.read('owned/file'); assert.equal(before.bytes.toString(),'first');
 assert.equal(fs.replace({rel:'owned/file',expected:before,bytes:Buffer.from('merged'),policy:'merge'}).action,'merge');
 before=fs.read('owned/file');
 assert.equal(fs.replace({rel:'owned/file',expected:before,bytes:Buffer.from('final'),policy:'authorized-replace'}).action,'overwrite');
 before=fs.read('owned/file');
 assert.equal(fs.replace({rel:'owned/file',expected:before,bytes:Buffer.from('final'),policy:'merge'}).action,'unchanged');
 assert.equal(readFileSync(join(project,'owned/file'),'utf8'),'final');
 assert.throws(() => fs.replace({rel:'owned/file',expected:null,bytes:Buffer.from('bad'),policy:'create-only'}));
 symlinkSync(outside,join(project,'escape'));
 assert.throws(() => fs.replace({rel:'escape/victim',expected:null,bytes:Buffer.from('bad'),policy:'authorized-replace'}));
 linkSync(join(outside,'victim'),join(project,'linked'));
 assert.throws(() => fs.read('linked'),e=>e.code==='HARDLINK_REFUSED');
 assert.throws(() => fs.replace({rel:'linked',expected:null,bytes:Buffer.from('bad'),policy:'authorized-replace'}));
 assert.throws(() => fs.read('../victim'),e=>e.code==='PATH_REFUSED');
 assert.equal(readFileSync(join(outside,'victim'),'utf8'),'unchanged-victim');
} finally { fs.close(); }
// Missing, tampered, wrong-tuple and wrong-protocol artifacts refuse before creating/accessing project effects.
const originalManifest=readFileSync(artifact.manifest), originalBinary=readFileSync(artifact.executable);
const refusedRoot=join(project,'never-created');
const refused=()=>{assert.throws(()=>NativeFilesystem.openRoot(refusedRoot),e=>e.code==='NATIVE_ARTIFACT_MISSING_OR_INVALID');};
try {
 renameSync(artifact.executable,artifact.executable+'.saved'); refused(); renameSync(artifact.executable+'.saved',artifact.executable);
 writeFileSync(artifact.executable,Buffer.from('tampered')); chmodSync(artifact.executable,0o755); refused();
 writeFileSync(artifact.executable,originalBinary); chmodSync(artifact.executable,0o755);
 for(const patch of [{tuple:'other-tuple'},{protocol:'other-protocol'},{wireVersion:2}]) {
  writeFileSync(artifact.manifest,JSON.stringify({...JSON.parse(originalManifest),...patch})); refused();
 }
} finally {
 writeFileSync(artifact.executable,originalBinary); chmodSync(artifact.executable,0o755);
 writeFileSync(artifact.manifest,originalManifest); chmodSync(artifact.manifest,0o644);
}
assert.throws(()=>lstatSync(refusedRoot),e=>e.code==='ENOENT');
console.log('SWFTE_INSTALLED_NATIVE_OK '+tuple);
`);
  execFileSync(process.execPath, [nativeHarness], { cwd: consumer, env: isolatedEnv, stdio: 'inherit', timeout: 90_000 });
  execFileSync(process.execPath, [harnessPath], {
    cwd: consumer, env: isolatedEnv, stdio: 'inherit', timeout: 45_000,
  });
  // The `swfte` bin and the `npx @swfte/mcp-server swfte …` passthrough both run from the tarball.
  for (const [name, target] of Object.entries(metadata.bin)) assert(existsSync(join(packed, target)), `bin ${name} → ${target} is missing`);
  assert.equal(execFileSync(process.execPath, [join(packed, metadata.bin.swfte), '--version'], { cwd: consumer, env: isolatedEnv, encoding: 'utf8', timeout: 20_000 }).trim(), metadata.version);
  assert.equal(execFileSync(process.execPath, [join(packed, metadata.main), 'swfte', '--version'], { cwd: consumer, env: isolatedEnv, encoding: 'utf8', timeout: 20_000 }).trim(), metadata.version);
  const empty = mkdtempSync(join(temporary, 'empty-project-'));
  let exit = 0;
  try {
    execFileSync(process.execPath, [join(packed, metadata.bin.swfte), 'verify', '--offline'], { cwd: empty, env: isolatedEnv, stdio: 'pipe', timeout: 20_000 });
  } catch (err) {
    exit = err.status;
  }
  assert.equal(exit, 2, 'swfte verify without a swfte.json must exit 2 (could not check), never 0');
  if (requireAll && mode !== '--consume-candidate') {
    // Exercise the actual admission/assembly implementation with real built bytes, not fixture ELF positives.
    const { assembleNative } = await import('./build-confined-fs.mjs');
    const cache = join(root, '.native-artifacts');
    for (const defect of ['missing', 'source', 'hash', 'tuple', 'protocol', 'wire', 'size', 'abi', 'minimum', 'libc', 'symlink', 'hardlink', 'unknown']) {
      const input = join(temporary, 'matrix-' + defect), output = join(temporary, 'output-' + defect);
      cpSync(cache, input, { recursive: true }); mkdirSync(output); writeFileSync(join(output, 'sentinel'), 'preserved');
      const folder = join(input, 'darwin-arm64'), binaryPath = join(folder, 'confined-fs'), manifestPath = join(folder, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (defect === 'missing') rmSync(join(input, 'linux-x64-glibc'), { recursive: true });
      if (defect === 'source') manifest.sourceSha256 = '0'.repeat(64);
      if (defect === 'hash') manifest.sha256 = '0'.repeat(64);
      if (defect === 'tuple') manifest.tuple = 'darwin-x64';
      if (defect === 'protocol') manifest.protocol = 'SWFTE_CF2';
      if (defect === 'wire') manifest.wireVersion = 2;
      if (defect === 'size') manifest.bytes += 1;
      if (defect === 'abi') { const bytes = readFileSync(binaryPath); bytes.writeUInt32LE(0x01000007,4); writeFileSync(binaryPath,bytes); manifest.sha256=digest(bytes); }
      if (defect === 'minimum') manifest.macosMinimum = '12.0';
      if (defect === 'libc') {
        const linux = join(input,'linux-x64-glibc/manifest.json');
        const metadata = JSON.parse(readFileSync(linux,'utf8')); metadata.glibcMinimum='musl'; writeFileSync(linux,JSON.stringify(metadata));
      }
      writeFileSync(manifestPath,JSON.stringify(manifest));
      if (defect === 'symlink') { const { symlinkSync } = await import('node:fs'); rmSync(manifestPath); symlinkSync(join(cache,'darwin-arm64/manifest.json'),manifestPath); }
      if (defect === 'hardlink') { const { linkSync } = await import('node:fs'); linkSync(binaryPath,join(temporary,'linked-helper')); }
      if (defect === 'unknown') mkdirSync(join(input,'darwin-other'));
      assert.throws(() => assembleNative(input, output, { requireAll: true }), `Admission must refuse ${defect}`);
      assert.deepEqual(readdirSync(output), ['sentinel'], 'All matrix admission precedes every output write');
      assert.equal(readFileSync(join(output,'sentinel'),'utf8'),'preserved');
    }
  }
  if (mode === '--emit-candidate') {
    mkdirSync(candidate, { recursive: true }); cpSync(tarball, join(candidate,receipt.filename));
    writeFileSync(join(candidate,'candidate.json'), JSON.stringify({ schema:'swfte-native-candidate/1', pack:receipt,
      tarballSha512:digest(tarballBytes,'sha512'), sourceSha256, artifacts:manifests },null,2)+'\n');
  }
  console.log(`PACKAGE_SMOKE_PASSED ${metadata.name}@${metadata.version} files=${files.size} integrity=${receipt.integrity}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
