/**
 * swfte_export_src (review r-mcp R2): the server's zip is untrusted bytes written into the
 * developer's tree. Named `G3:` after its ledger gate; all fail against origin/master.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';

import { loadConfig } from '../src/config.js';
import { codeTools, unzipCapped } from '../src/tools/code.js';

const enc = (s: string) => new TextEncoder().encode(s);
let root = '';
let prev = '';
beforeEach(() => {
  prev = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-exp-')));
  writeFileSync(join(root, 'package.json'), 'ORIGINAL');
  process.chdir(root);
});
afterEach(() => {
  process.chdir(prev);
  rmSync(root, { recursive: true, force: true });
});

const exp = codeTools.find((t) => t.name === 'swfte_export_src')!;
const config = loadConfig({ SWFTE_PAT: 'pat_TESTPAT123456', SWFTE_TELEMETRY: '0' } as never);
const exportWith = (files: Record<string, string>, input: Record<string, unknown> = { destDir: 'existing' }) => {
  const zip = zipSync({ 'swfte-blueprint.json': enc('{}'), ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, enc(v)])) });
  const client: any = { getBinary: async () => ({ bytes: zip, headers: {} }) };
  return exp.execute({ workflowId: 'wf_1', ...input } as never, { client, config, localFilesystem: true }) as Promise<any>;
};

describe('export_src never clobbers or escapes (R2)', () => {
  test('G3: export_src does not clobber an existing file without overwrite', async () => {
    mkdirSync(join(root, 'existing'));
    writeFileSync(join(root, 'existing', 'Cargo.toml'), 'USER EDITS\n');
    await assert.rejects(exportWith({ 'Cargo.toml': 'SERVER\n', 'src/new.rs': 'x' }), /Refusing to overwrite/);
    assert.equal(readFileSync(join(root, 'existing', 'Cargo.toml'), 'utf8'), 'USER EDITS\n');
    assert.equal(existsSync(join(root, 'existing', 'src', 'new.rs')), false, 'nothing else is written when one file conflicts');
  });

  test('G3: export_src force:true replaces only the conflicting files', async () => {
    mkdirSync(join(root, 'existing'));
    writeFileSync(join(root, 'existing', 'Cargo.toml'), 'USER EDITS\n');
    await exportWith({ 'Cargo.toml': 'SERVER\n' }, { destDir: 'existing', force: true });
    assert.equal(readFileSync(join(root, 'existing', 'Cargo.toml'), 'utf8'), 'SERVER\n');
  });

  test('G3: export_src does not write through an in-tree symlink', async () => {
    mkdirSync(join(root, 'existing'));
    symlinkSync(join(root, 'package.json'), join(root, 'existing', 'link.rs'));
    await assert.rejects(exportWith({ 'link.rs': 'pwned\n' }));
    await assert.rejects(exportWith({ 'link.rs': 'pwned\n' }, { destDir: 'existing', force: true }), undefined, 'force does not lift the symlink rule');
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), 'ORIGINAL');
  });

  test('G3: export_src does not write through a symlinked directory inside the tree', async () => {
    mkdirSync(join(root, 'existing'));
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'existing', 'sub'));
    await assert.rejects(exportWith({ 'sub/x.rs': 'pwned\n' }));
    assert.deepEqual(readdirSync(join(root, 'elsewhere')), []);
  });

  test('G3: export_src rejects zip entries with .. or an absolute path and writes nothing', async () => {
    for (const name of ['../escape.rs', 'a/../../escape.rs', '/tmp/abs-escape.rs']) {
      await assert.rejects(exportWith({ [name]: 'pwned\n', 'ok.rs': 'fine' }, { destDir: 'fresh' }), undefined, name);
      assert.equal(existsSync(join(root, 'escape.rs')), false);
      assert.equal(existsSync(join(root, 'fresh', 'ok.rs')), false, `nothing written for ${name}`);
    }
  });

  test('G3: export_src refuses to write into package.json / .git / .github even inside destDir', async () => {
    await assert.rejects(exportWith({ '.github/workflows/x.yml': 'x' }, { destDir: 'fresh2' }), /Refusing to write/);
    assert.equal(existsSync(join(root, 'fresh2', '.github')), false);
  });

  test('G3: export_src still works for a fresh directory and is idempotent for identical content', async () => {
    const r = await exportWith({ 'Cargo.toml': '[package]\n', 'src/steps/a.rs': '// blueprint-step-id: a\n' }, { destDir: 'fresh3' });
    assert.ok(r.files.includes('Cargo.toml'));
    assert.equal(readFileSync(join(root, 'fresh3', 'Cargo.toml'), 'utf8'), '[package]\n');
    await exportWith({ 'Cargo.toml': '[package]\n', 'src/steps/a.rs': '// blueprint-step-id: a\n' }, { destDir: 'fresh3' });
  });

  test('G3: unzip size cap refuses a zip bomb by declared and by entry count', () => {
    const big = zipSync({ 'a.bin': new Uint8Array(200_000) });
    assert.throws(() => unzipCapped(big, { maxEntries: 10, maxFileBytes: 1000, maxTotalBytes: 1e9 }), /safety limit/);
    const many = zipSync(Object.fromEntries([...Array(5)].map((_, i) => [`f${i}`, enc('x')])));
    assert.throws(() => unzipCapped(many, { maxEntries: 3, maxFileBytes: 1e9, maxTotalBytes: 1e9 }), /safety limit/);
    assert.ok(unzipCapped(many));
  });
});
