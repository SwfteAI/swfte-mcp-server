/** Exercise the actual npm tarball, not a workspace build with accidental source dependencies. */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'swfte-package-smoke-'));
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const receipt = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root, encoding: 'utf8', timeout: 60_000 }))[0];
  const files = new Set(receipt.files.map(file => file.path));
  for (const required of ['package.json', 'dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE', 'src/preflight/cli.mjs',
    'dist/codemap/grammars/tree-sitter-python.wasm', 'dist/codemap/grammars/tree-sitter-java.wasm',
    'dist/codemap/grammars/LICENSE.tree-sitter-python', 'dist/codemap/grammars/LICENSE.tree-sitter-java'])
    assert(files.has(required), `Published package is missing ${required}`);
  for (const path of files) assert(!/(^|\/)\.env($|\.)|(^|\/)(node_modules|test|\.git)\//.test(path), `Private or development file in package: ${path}`);
  // Install the tarball as a real consumer. No dependency may resolve from the source worktree.
  const consumer = join(temporary, 'consumer');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(consumer);
  const packedMetadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const tarballRef = 'file:' + join(temporary, receipt.filename);
  const consumerMetadata = { name: 'swfte-isolated-smoke', version: '1.0.0', private: true, type: 'module',
    dependencies: { [packedMetadata.name]: tarballRef } };
  writeFileSync(join(consumer, 'package.json'), JSON.stringify(consumerMetadata));
  // Reuse immutable resolutions and integrity from the actual lockfile, never installed modules.
  // npm ci independently verifies and extracts every artifact into this consumer.
  const consumerLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  consumerLock.name = consumerMetadata.name;
  consumerLock.version = consumerMetadata.version;
  consumerLock.packages[''] = { name: consumerMetadata.name, version: consumerMetadata.version,
    dependencies: consumerMetadata.dependencies };
  consumerLock.packages['node_modules/' + packedMetadata.name] = { version: packedMetadata.version,
    resolved: tarballRef, integrity: receipt.integrity, dependencies: packedMetadata.dependencies,
    bin: packedMetadata.bin, engines: packedMetadata.engines, license: packedMetadata.license };
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(consumerLock));
  execFileSync(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--offline'], {
    cwd: consumer, stdio: 'inherit', timeout: 180_000,
  });
  const packed = join(consumer, 'node_modules', '@swfte', 'mcp-server');
  const metadata = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
  assert(existsSync(join(packed, metadata.main)), 'Package main is missing');
  assert(!lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), 'Consumer dependencies must be installed, never linked');
  assert(!lstatSync(packed).isSymbolicLink(), 'The packed module must be installed, never linked');
  // Transpile the test harness into the consumer so its SDK imports also use that installation.
  const harness = ts.transpileModule(readFileSync(join(root, 'scripts/protocol-smoke.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const harnessPath = join(consumer, 'protocol-smoke.mjs');
  writeFileSync(harnessPath, harness);
  const isolatedEnv = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', SWFTE_SMOKE_ENTRY: join(packed, metadata.main) };
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
  console.log(`PACKAGE_SMOKE_PASSED ${metadata.name}@${metadata.version} files=${files.size} integrity=${receipt.integrity}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
