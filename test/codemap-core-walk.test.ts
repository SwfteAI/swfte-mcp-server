/**
 * The confined walk (docs/codemap/CONTRACT.md §7, §2.1).
 *
 * Reads are observed, not inferred: native read plus legacy fs reads are spied for tests that say a
 * file is never opened (.env, unsupported languages, symlink targets, a lock path that escapes the
 * root), so a walker that opened one and then discarded it would still fail.
 */
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PathConfinementError } from '../src/fsguard.js';
import { NativeFilesystem, NativeFilesystemError } from '../src/native-filesystem.js';
import {
  contextOf,
  DEFAULT_ENV_FILES,
  envFileKind,
  isGeneratedByOtherTool,
  languageOf,
  packageOf,
  readConfined,
  readSource,
  scanReader,
  walkProject,
  WalkError,
} from '../src/codemap/walk.js';

const DOTENV_NAME = 'SWFTE_FROM_DOTENV';
const DOTENV_VALUE = 'value-that-must-never-be-read';
/** The production rules plus neutral stand-ins, exactly as the eval and probes pass them (D10). */
const ENV_FILES = { secret: [...DEFAULT_ENV_FILES.secret, 'dot-env', 'dot-env.*'], names: [...DEFAULT_ENV_FILES.names, 'dot-env.example'] };

function write(root: string, rel: string, text: string) {
  const abs = join(root, rel);
  fs.mkdirSync(dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** Every selected native read and separately scoped legacy pathname read while `fn` runs. */
function opened<T>(fn: () => T): { result: T; paths: string[] } {
  const paths: string[] = [];
  const realOpen = fs.openSync as (...a: unknown[]) => number;
  const realRead = fs.readFileSync as (...a: unknown[]) => unknown;
  const realNativeRead = NativeFilesystem.prototype.read;
  const native = mock.method(NativeFilesystem.prototype, 'read', function(this: NativeFilesystem, rel: string, maxBytes?: number) {
    paths.push(join(root, rel));
    return realNativeRead.call(this, rel, maxBytes);
  });
  const o = mock.method(fs, 'openSync', (p: fs.PathLike, ...rest: unknown[]) => {
    paths.push(String(p));
    return realOpen.call(fs, p, ...rest);
  });
  const r = mock.method(fs, 'readFileSync', (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    paths.push(String(p));
    return realRead.call(fs, p, ...rest);
  });
  try {
    return { result: fn(), paths };
  } finally {
    o.mock.restore();
    r.mock.restore();
    native.mock.restore();
  }
}

let root: string;
let outside: string;

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cmap-walk-')));
  outside = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cmap-outside-')));
  write(outside, 'secret.ts', 'export const x = 1;\n');
  write(outside, 'dir/inner.ts', 'export const y = 1;\n');

  write(root, 'package.json', JSON.stringify({ name: 'acme-root' }));
  write(root, 'src/app.ts', 'export const a = 1;\n');
  write(root, 'src/util.js', 'module.exports = 1;\n');
  write(root, 'src/types.d.ts', 'export type T = 1;\n');
  write(root, 'src/mod.mts', '');
  write(root, 'src/mod.cts', '');
  write(root, 'src/view.tsx', '');
  write(root, 'src/view.jsx', '');
  write(root, 'src/es.mjs', '');
  write(root, 'src/cjs.cjs', '');
  write(root, 'svc/main.py', 'print(1)\n');
  write(root, 'svc/Main.java', 'class Main {}\n');
  write(root, 'templates/page.html', '<div></div>\n');
  write(root, 'templates/old.htm', '');
  write(root, 'templates/base.jinja', '');
  write(root, 'templates/mail.j2', '');
  for (const d of ['node_modules/lib', '.venv/lib', 'venv/lib', 'target/classes', 'build/out', 'dist/out', '.next/server', '.git/hooks', 'pkg/__pycache__']) {
    write(root, `${d}/vendored.js`, 'fetch("/v2/workflows/x/run")\n');
    write(root, `${d}/vendored.py`, '');
  }
  // Env plants under neutral names (CONTRACT D10, deviation 6): no file named .env* is ever created.
  write(root, 'dot-env', `${DOTENV_NAME}=${DOTENV_VALUE}\n`);
  write(root, 'dot-env.local', `SWFTE_LOCAL_ONLY=${DOTENV_VALUE}\n`);
  write(root, 'svc/dot-env.production', `SWFTE_PROD_ONLY=${DOTENV_VALUE}\n`);
  write(root, 'dot-env.example', 'SWFTE_WORKFLOW_ID=wf_example\nexport SWFTE_AGENT_ID=\nOTHER_NAME=1\n# SWFTE_COMMENTED=1\n');
  for (const f of ['main.go', 'lib.rb', 'index.php', 'Prog.cs', 'App.kt', 'lib.rs', 'View.swift', 'more.go']) write(root, `other/${f}`, 'never read\n');
  fs.symlinkSync(join(outside, 'secret.ts'), join(root, 'src/linked.ts'));
  fs.symlinkSync(join(outside, 'dir'), join(root, 'linkdir'));
});

after(() => {
  fs.rmSync(root, { recursive: true });
  fs.rmSync(outside, { recursive: true });
});

describe('enumeration', () => {
  test('languages by extension; .d.ts never listed', () => {
    const w = walkProject(root);
    const byLang = Object.fromEntries(w.files.map((f) => [f.relPath, f.language]));
    assert.deepEqual(byLang, {
      'src/app.ts': 'typescript',
      'src/cjs.cjs': 'javascript',
      'src/es.mjs': 'javascript',
      'src/mod.cts': 'typescript',
      'src/mod.mts': 'typescript',
      'src/util.js': 'javascript',
      'src/view.jsx': 'javascript',
      'src/view.tsx': 'typescript',
      'svc/Main.java': 'java',
      'svc/main.py': 'python',
      'templates/base.jinja': 'html',
      'templates/mail.j2': 'html',
      'templates/old.htm': 'html',
      'templates/page.html': 'html',
    });
    assert.equal(w.skipped.declaration, 1);
    assert.equal(languageOf('a/b.d.ts'), null);
    assert.equal(languageOf('.env.ts'), null);
  });

  test('vendored and build directories are never entered', () => {
    const w = walkProject(root);
    for (const f of w.files) assert.doesNotMatch(f.relPath, /(^|\/)(node_modules|\.venv|venv|target|build|dist|\.next|\.git|__pycache__)\//, f.relPath);
    const all = walkProject(root, { skipDirs: [] });
    assert.ok(all.files.some((f) => f.relPath === 'node_modules/lib/vendored.js'), 'an empty skip list includes them (the eval mutant)');
  });

  test('two walks are identical and in code-point order', () => {
    const a = walkProject(root);
    const b = walkProject(root);
    assert.deepEqual(a, b);
    const paths = a.files.map((f) => f.relPath);
    assert.deepEqual(paths, [...paths].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
  });
});

describe('never opened', () => {
  test('the production default pins .env and .env.local as secret and .env.example as names (strings only)', () => {
    assert.ok(DEFAULT_ENV_FILES.secret.includes('.env'));
    assert.ok(DEFAULT_ENV_FILES.secret.includes('.env.local'));
    assert.ok(DEFAULT_ENV_FILES.names.includes('.env.example'));
    assert.equal(envFileKind('.env'), 'secret');
    assert.equal(envFileKind('.env.local'), 'secret');
    assert.equal(envFileKind('.env.production'), 'secret');
    assert.equal(envFileKind('.env.example'), 'names');
    assert.equal(envFileKind('env.ts'), null);
    assert.equal(envFileKind('my.env'), null);
    assert.throws(() => (DEFAULT_ENV_FILES.secret as string[]).push('x'), TypeError, 'the default cannot be mutated at run time');
    assert.throws(() => walkProject(root, { envFiles: { secret: ['a/b'], names: [] } }), WalkError);
  });

  test('secret env files are never opened; the names file yields SWFTE_* names only, never a value', () => {
    const { result: w, paths } = opened(() => walkProject(root, { envFiles: ENV_FILES }));
    const envOpens = paths.filter((p) => /(^|\/)dot-env(\.|$)/.test(p) && !p.endsWith('dot-env.example'));
    assert.deepEqual(envOpens, [], 'no secret env file was opened');
    assert.ok(paths.some((p) => p.endsWith('/dot-env.example')), 'the names file is read (positive control)');
    assert.deepEqual(w.envExampleNames, ['SWFTE_AGENT_ID', 'SWFTE_WORKFLOW_ID']);
    assert.equal(w.skipped.env, 3);
    const json = JSON.stringify(w);
    for (const leaked of [DOTENV_NAME, DOTENV_VALUE, 'SWFTE_LOCAL_ONLY', 'SWFTE_PROD_ONLY', 'wf_example', 'OTHER_NAME']) {
      assert.ok(!json.includes(leaked), `${leaked} must not appear in the walk result`);
    }
    // Without the override the stand-ins are ordinary unknown files: not env files, and not read.
    const plain = opened(() => walkProject(root));
    assert.deepEqual(plain.result.envExampleNames, []);
    assert.deepEqual(plain.paths.filter((p) => p.includes('dot-env')), []);
  });

  test('the read primitive itself refuses secret env files, whoever asks', () => {
    const reader = scanReader(root);
    for (const rel of ['dot-env', 'dot-env.local', 'svc/dot-env.production']) {
      const { paths } = opened(() => assert.throws(() => readConfined(reader, rel, 1 << 20, ENV_FILES), WalkError));
      assert.deepEqual(paths, [], `${rel} was not opened`);
    }
    // A path that does not exist, named like a real env file, is refused by name before any fs call.
    const { paths } = opened(() => assert.throws(() => readConfined(reader, 'no-such-dir/.env', 1 << 20), WalkError));
    assert.deepEqual(paths, []);
  });

  test('unsupported languages are counted into notAnalysed without being opened', () => {
    const { result: w, paths } = opened(() => walkProject(root));
    assert.deepEqual(w.notAnalysed, { csharp: 1, go: 2, kotlin: 1, php: 1, ruby: 1, rust: 1, swift: 1 });
    assert.deepEqual(paths.filter((p) => p.includes('/other/')), []);
  });

  test('symlinks are never followed: a linked file or directory outside the root is not listed or opened', () => {
    const { result: w, paths } = opened(() => walkProject(root));
    assert.ok(!w.files.some((f) => f.relPath === 'src/linked.ts' || f.relPath.startsWith('linkdir/')));
    assert.equal(w.skipped.symlink, 2);
    assert.deepEqual(paths.filter((p) => p.startsWith(outside)), []);
    assert.throws(() => readConfined(scanReader(root), 'src/linked.ts', 1 << 20), PathConfinementError);
    assert.throws(() => readConfined(scanReader(root), '../x.ts', 1 << 20), PathConfinementError);
  });

  test('a home-directory or filesystem-root scan confines nothing and is refused', () => {
    const refused = (error: unknown) => error instanceof NativeFilesystemError && error.code === 'PATH_REFUSED';
    assert.throws(() => walkProject(homedir()), refused);
    assert.throws(() => walkProject('/'), refused);
  });
});

describe('generated files', () => {
  test('files another tool generated are skipped; the Swfte client and @GeneratedValue are kept', () => {
    assert.equal(isGeneratedByOtherTool('// @generated by protoc-gen-ts\nexport {}'), true);
    assert.equal(isGeneratedByOtherTool('// Code generated by sqlc. DO NOT EDIT.\npackage x'), true);
    assert.equal(isGeneratedByOtherTool('import x;\n@javax.annotation.Generated("jooq")\nclass A {}'), true);
    assert.equal(isGeneratedByOtherTool('@Generated(value = "x")\nclass B {}'), true);
    assert.equal(isGeneratedByOtherTool('@Entity class C { @Id @GeneratedValue Long id; }'), false);
    assert.equal(isGeneratedByOtherTool('// Generated by @swfte/mcp-server (swfte add). Do not edit by hand. @generated\nexport {}'), false);
    assert.equal(isGeneratedByOtherTool(`${'\n'.repeat(60)}// @generated`), false, 'only the header counts');
  });

  test('readSource honours skipGenerated', () => {
    const r = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cmap-gen-')));
    try {
      write(r, 'gen/api.ts', '// @generated\nexport {}\n');
      write(r, 'clients/order.ts', '// Generated by @swfte/mcp-server (swfte add / swfte_scaffold_client). Do not edit by hand — run `swfte sync`.\nexport {}\n');
      const w = walkProject(r);
      const reader = scanReader(r);
      const gen = w.files.find((f) => f.relPath === 'gen/api.ts')!;
      const swfte = w.files.find((f) => f.relPath === 'clients/order.ts')!;
      assert.deepEqual(readSource(reader, gen), { skipped: 'generated' });
      assert.ok('text' in readSource(reader, gen, { skipGenerated: false }));
      assert.ok('text' in readSource(reader, swfte));
    } finally {
      fs.rmSync(r, { recursive: true });
    }
  });
});

describe('caps', () => {
  test('maxFiles keeps the first files in code-point order and sets truncated', () => {
    const w = walkProject(root, { maxFiles: 3 });
    assert.equal(w.truncated, true);
    assert.deepEqual(w.files.map((f) => f.relPath), ['src/app.ts', 'src/cjs.cjs', 'src/es.mjs']);
    assert.equal(walkProject(root, { maxFiles: 14 }).truncated, false, 'exactly at the cap is not truncated');
  });

  test('a cap that stops mid-directory still places the listed files under that directory\'s package and lock', () => {
    const r = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cmap-capdir-')));
    try {
      write(r, 'app/a.ts', '');
      write(r, 'app/b.ts', '');
      write(r, 'app/package.json', JSON.stringify({ name: 'late-name' }));
      write(r, 'app/swfte.json', JSON.stringify({ version: 1, baseUrl: 'https://api.swfte.com/agents', workspaceId: null, artifacts: [{ catalogRef: 'agent:a', alias: 'helper', language: 'typescript', framework: 'plain-ts', outDir: 'gen', contractHash: '', pinnedVersion: null, files: ['gen/helper.ts'] }] }));
      const w = walkProject(r, { maxFiles: 1 });
      assert.equal(w.truncated, true);
      assert.deepEqual(w.files.map((f) => f.relPath), ['app/a.ts']);
      assert.deepEqual(packageOf('app/a.ts', w.packages), { pkgId: 'late-name', pkgRelPath: 'a.ts' });
      assert.deepEqual(contextOf('app/a.ts', w.locks).locks.map((l) => l.alias), ['helper']);
    } finally {
      fs.rmSync(r, { recursive: true });
    }
  });

  test('a file over maxFileBytes is left out, never read, and sets truncated', () => {
    const r = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cmap-big-')));
    try {
      write(r, 'big.ts', 'x'.repeat(2048));
      write(r, 'small.ts', 'x');
      const { result: w, paths } = opened(() => walkProject(r, { maxFileBytes: 1024 }));
      assert.deepEqual(w.files.map((f) => f.relPath), ['small.ts']);
      assert.equal(w.truncated, true);
      assert.deepEqual(paths.filter((p) => p.endsWith('big.ts')), []);
    } finally {
      fs.rmSync(r, { recursive: true });
    }
  });
});

describe('package roots (pkgId)', () => {
  test('names from package.json, pyproject, setup.cfg, Maven and Gradle; directory fallbacks; "." without a root', () => {
    const r = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cmap-pkg-')));
    try {
      write(r, 'js/package.json', JSON.stringify({ name: '@acme/web' }));
      write(r, 'js/src/a.ts', '');
      write(r, 'py/pyproject.toml', '[tool.black]\nname = "wrong"\n[project]\nname = "acme-svc"\n');
      write(r, 'py/app/b.py', '');
      write(r, 'cfg/setup.cfg', '[metadata]\nname = legacy-svc\n');
      write(r, 'cfg/c.py', '');
      write(r, 'mvn/pom.xml', '<project><parent><groupId>com.acme</groupId><artifactId>parent</artifactId></parent><artifactId>billing</artifactId><dependencies><dependency><groupId>x</groupId><artifactId>y</artifactId></dependency></dependencies></project>');
      write(r, 'mvn/src/main/java/D.java', '');
      write(r, 'gr/settings.gradle.kts', 'rootProject.name = "ledger"\n');
      write(r, 'gr/E.java', '');
      write(r, 'plain/build.gradle', '');
      write(r, 'plain/F.java', '');
      write(r, 'noname/package.json', '{}');
      write(r, 'noname/g.js', '');
      write(r, 'loose/h.ts', '');
      write(r, 'dup1/package.json', JSON.stringify({ name: 'same' }));
      write(r, 'dup1/i.ts', '');
      write(r, 'dup2/package.json', JSON.stringify({ name: 'same' }));
      write(r, 'dup2/i.ts', '');
      const w = walkProject(r);
      const of = (p: string) => packageOf(p, w.packages);
      assert.deepEqual(of('js/src/a.ts'), { pkgId: '@acme/web', pkgRelPath: 'src/a.ts' });
      assert.deepEqual(of('py/app/b.py'), { pkgId: 'acme-svc', pkgRelPath: 'app/b.py' });
      assert.deepEqual(of('cfg/c.py'), { pkgId: 'legacy-svc', pkgRelPath: 'c.py' });
      assert.deepEqual(of('mvn/src/main/java/D.java'), { pkgId: 'com.acme:billing', pkgRelPath: 'src/main/java/D.java' });
      assert.deepEqual(of('gr/E.java'), { pkgId: 'ledger', pkgRelPath: 'E.java' });
      assert.deepEqual(of('plain/F.java'), { pkgId: 'plain', pkgRelPath: 'F.java' });
      assert.deepEqual(of('noname/g.js'), { pkgId: 'noname', pkgRelPath: 'g.js' });
      assert.deepEqual(of('loose/h.ts'), { pkgId: '.', pkgRelPath: 'loose/h.ts' });
      assert.deepEqual(of('dup1/i.ts'), { pkgId: 'dup1', pkgRelPath: 'i.ts' }, 'two roots with one name fall back to their directories');
      assert.deepEqual(of('dup2/i.ts'), { pkgId: 'dup2', pkgRelPath: 'i.ts' });
    } finally {
      fs.rmSync(r, { recursive: true });
    }
  });
});

describe('nearest swfte.json', () => {
  const lock = (artifacts: unknown[]) => JSON.stringify({ version: 1, baseUrl: 'https://api.swfte.com/agents', workspaceId: null, artifacts });
  const entry = (alias: string, files: string[], extra: Record<string, unknown> = {}) => ({
    catalogRef: `workflow:${alias}`,
    alias,
    language: 'typescript',
    framework: 'plain-ts',
    outDir: 'swfte',
    contractHash: 'abc1234',
    pinnedVersion: null,
    files,
    ...extra,
  });

  test('each file gets the bindings of the nearest lock above it, with files relative to the scan root', () => {
    const r = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cmap-lock-')));
    try {
      write(r, 'swfte.json', lock([entry('root-flow', ['swfte/root-flow.ts'])]));
      write(r, 'apps/b/swfte.json', lock([entry('b-flow', ['swfte/b-flow.ts'], { pinnedVersion: '4', contractHash: '' })]));
      write(r, 'apps/a/x.ts', '');
      write(r, 'apps/b/src/y.ts', '');
      const w = walkProject(r);
      const a = contextOf('apps/a/x.ts', w.locks);
      const b = contextOf('apps/b/src/y.ts', w.locks);
      assert.equal(a.lockDir, '');
      assert.deepEqual(a.locks.map((l) => [l.alias, l.files]), [['root-flow', ['swfte/root-flow.ts']]]);
      assert.equal(b.lockDir, 'apps/b');
      assert.deepEqual(b.locks, [{ alias: 'b-flow', catalogRef: 'workflow:b-flow', language: 'typescript', pinnedVersion: '4', contractHash: null, files: ['apps/b/swfte/b-flow.ts'] }]);
      const none = walkProject(r, { skipDirs: ['apps'] });
      assert.deepEqual(contextOf('elsewhere/z.ts', []), { locks: [], lockDir: null });
      assert.equal(none.locks.length, 1);
    } finally {
      fs.rmSync(r, { recursive: true });
    }
  });

  test('an entry whose file path or alias escapes the root is refused and its paths are never read', () => {
    const r = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cmap-lock-esc-')));
    try {
      write(r, 'nested/swfte.json', lock([
        entry('escape', ['../../etc/hosts']),
        entry('absolute', ['/etc/hosts']),
        entry('good', ['swfte/good.ts']),
        entry('../../etc', ['swfte/x.ts']),
        entry('outdir', ['swfte/o.ts'], { outDir: '../../../tmp' }),
      ]));
      write(r, 'nested/src/a.ts', '');
      const { result: w, paths } = opened(() => walkProject(r));
      const ctx = contextOf('nested/src/a.ts', w.locks);
      assert.deepEqual(ctx.locks.map((l) => l.alias), ['good']);
      assert.ok(w.warnings.filter((m) => m.includes('refused')).length >= 3);
      assert.deepEqual(paths.filter((p) => p.includes('/etc/') || p.includes('hosts')), []);
    } finally {
      fs.rmSync(r, { recursive: true });
    }
  });

  test('a lock that is not JSON, or from a newer schema, contributes no bindings and says so', () => {
    const r = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'cmap-lock-bad-')));
    try {
      write(r, 'a/swfte.json', '<<<<<<< HEAD\n{}\n');
      write(r, 'b/swfte.json', JSON.stringify({ version: 99, artifacts: [] }));
      write(r, 'a/x.ts', '');
      const w = walkProject(r);
      assert.deepEqual(contextOf('a/x.ts', w.locks).locks, []);
      assert.equal(w.warnings.filter((m) => m.includes('swfte.json')).length, 2);
    } finally {
      fs.rmSync(r, { recursive: true });
    }
  });
});
