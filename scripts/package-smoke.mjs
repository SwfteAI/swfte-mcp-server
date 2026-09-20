/** Exercise the actual npm tarball, not a workspace build with accidental source dependencies. */
import { mkdtempSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'swfte-package-smoke-'));
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const receipt = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root, encoding: 'utf8', timeout: 60_000 }))[0];
  const files = new Set(receipt.files.map(file => file.path));
  for (const required of ['package.json', 'dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE', 'src/preflight/cli.mjs'])
    assert(files.has(required), `Published package is missing ${required}`);
  for (const path of files) assert(!/(^|\/)\.env($|\.)|(^|\/)(node_modules|test|\.git)\//.test(path), `Private or development file in package: ${path}`);
  execFileSync('tar', ['-xzf', join(temporary, receipt.filename), '-C', temporary], { timeout: 30_000 });
  const packed = join(temporary, 'package');
  const metadata = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
  assert(existsSync(join(packed, metadata.main)), 'Package main is missing');
  // Dependency resolution is available, but no source tree exists beside this extracted artifact.
  symlinkSync(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
  execFileSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/protocol-smoke.ts')], {
    cwd: root, env: { ...process.env, SWFTE_SMOKE_ENTRY: join(packed, metadata.main) }, stdio: 'inherit', timeout: 45_000,
  });
  console.log(`PACKAGE_SMOKE_PASSED ${metadata.name}@${metadata.version} files=${files.size} integrity=${receipt.integrity}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
