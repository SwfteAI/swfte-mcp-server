// node scripts/check-pack.mjs — packs the project (no scripts) and asserts the tarball is clean:
// no internal narrative docs, no absolute maintainer paths, no sourcesContent in maps, every bin present,
// no main/types that would start a server on import. Prints PACK_OK only when all hold.
// Negative control: `node scripts/check-pack.mjs --selftest` feeds known-bad file sets through the same checks.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ABS_PATH = /\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/Projects|[A-Z]:\\Users\\/;

export function judge(files /* Map<path, Buffer> */, meta) {
  const problems = [];
  for (const [path, buf] of files) {
    if (/PUBLISH-GATE/.test(path)) problems.push(`internal doc shipped: ${path}`);
    if (/(^|\/)\.env($|\.)|(^|\/)(node_modules|test|\.git|\.e2e)\//.test(path)) problems.push(`private file shipped: ${path}`);
    const text = buf.toString('utf8');
    if (ABS_PATH.test(text)) problems.push(`absolute maintainer path in ${path}: ${(ABS_PATH.exec(text) ?? [''])[0]}`);
    if (path.endsWith('.map')) {
      try {
        if (JSON.parse(text).sourcesContent) problems.push(`sourcesContent in ${path}`);
      } catch {
        problems.push(`unparsable map ${path}`);
      }
    }
  }
  for (const [name, target] of Object.entries(meta.bin ?? {})) if (!files.has(target)) problems.push(`bin ${name} -> ${target} is not in the tarball`);
  for (const f of meta.files ?? []) if (f === 'bin') problems.push('files lists a bin/ directory that does not exist');
  if (meta.main || meta.types) problems.push('main/types set: importing dist/index.js starts a stdio server');
  return problems;
}

function pack() {
  const dir = mkdtempSync(join(tmpdir(), 'swfte-check-pack-'));
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const receipt = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { cwd: root, encoding: 'utf8' }))[0];
    execFileSync('tar', ['-xzf', join(dir, receipt.filename), '-C', dir]);
    const files = new Map();
    const walk = (d, rel) => {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        const r = rel ? `${rel}/${name}` : name;
        if (statSync(full).isDirectory()) walk(full, r);
        else files.set(r, readFileSync(full));
      }
    };
    walk(join(dir, 'package'), '');
    return { files, meta: JSON.parse(files.get('package.json').toString('utf8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv.includes('--selftest')) {
  const bad = new Map([
    ['docs/PUBLISH-GATE.md', Buffer.from('x')],
    ['dist/a.js', Buffer.from('const p = "/Users/someone/Projects/x"')],
    ['dist/a.js.map', Buffer.from('{"sourcesContent":["x"]}')],
  ]);
  const found = judge(bad, { bin: { a: 'dist/missing.js' }, files: ['bin'], main: 'dist/a.js' });
  if (found.length < 6) {
    console.error(`selftest: checks are toothless, found only ${found.length}: ${found.join(' | ')}`);
    process.exit(1);
  }
  console.log(`SELFTEST_OK ${found.length} known-bad findings`);
} else {
  const { files, meta } = pack();
  const problems = judge(files, meta);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`PACK_OK ${files.size} files`);
}
