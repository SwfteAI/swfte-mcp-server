/**
 * Path deny-list (review r-mcp R7): a prompt-injected model chooses the paths, so the
 * places that run code or hold secrets are unreachable. Named `G8:`; every "refused" row
 * was writable/readable on origin/master.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfinedWriter, confineReadableFile, confinePath, denyReason } from '../src/fsguard.js';
import { loadConfig } from '../src/config.js';
import { fileTools } from '../src/tools/files.js';

let root = '';
let prev = '';
beforeEach(() => {
  prev = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-deny-')));
  process.chdir(root);
});
afterEach(() => {
  process.chdir(prev);
  rmSync(root, { recursive: true, force: true });
});

const WRITE_REFUSED = [
  '.git/hooks/pre-commit', '.git/config', '.github/workflows/ci.yml', 'sub/.github/workflows/x.yml', '.husky/pre-commit', '.vscode/tasks.json',
  '.claude/settings.json', '.cursor/rules/x.mdc', '.mcp.json', '.npmrc', '.env', '.env.local', '.env.production', 'apps/web/.env', 'package.json',
  '.GIT/hooks/post-checkout', '.Github/workflows/x.yml', './.git/HEAD',
];
const WRITE_ALLOWED = ['src/index.ts', 'public/support.html', '.env.example', '.env.sample', 'docs/.github-notes.md', 'lib/package.json.ts', 'src/gitignore.txt', '.gitignore'];
const READ_REFUSED = ['.env', '.env.local', 'pkg/.env.production', '.npmrc', '.netrc', '.git/config', '.ssh/id_rsa', '.aws/credentials', 'keys/server.pem', 'id_rsa', 'id_ed25519', 'id_rsa.pub', 'sub/ID_RSA'];
const READ_ALLOWED = ['src/index.ts', '.env.example', 'README.md', 'docs/identity.md', 'src/idle.ts', '.github/workflows/ci.yml'];

describe('deny-list (R7)', () => {
  test('G8: deny-list table - writes', () => {
    for (const p of WRITE_REFUSED) {
      assert.ok(denyReason(p, 'write'), `denyReason should refuse write ${p}`);
      const w = new ConfinedWriter({ root });
      assert.throws(() => w.resolve(p), /Refusing to write/, `ConfinedWriter.resolve ${p}`);
    }
    for (const p of WRITE_ALLOWED) {
      assert.equal(denyReason(p, 'write'), null, `write ${p}`);
      assert.doesNotThrow(() => new ConfinedWriter({ root }).resolve(p), p);
    }
  });

  test('G8: deny-list table - reads', () => {
    for (const p of READ_REFUSED) assert.ok(denyReason(p, 'read'), `denyReason should refuse read ${p}`);
    for (const p of READ_ALLOWED) assert.equal(denyReason(p, 'read'), null, `read ${p}`);
    for (const p of READ_REFUSED) assert.throws(() => confinePath(p, undefined, 'read'), /Refusing to read/, p);
  });

  test('G8: deny-list table - nothing is written by a refused plan, and an allowed write still lands', () => {
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    const w = new ConfinedWriter({ root });
    assert.throws(() => w.resolve('.git/hooks/pre-commit'));
    const ok = new ConfinedWriter({ root });
    ok.create(ok.resolve('src/a.ts'), 'export {}\n');
    ok.commit();
    assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), 'export {}\n');
    assert.equal(existsSync(join(root, '.git/hooks/pre-commit')), false);
  });

  test('G8: a symlink to a denied location is refused by its real path as well', () => {
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '[core]\n');
    symlinkSync(join(root, '.git'), join(root, 'innocent'));
    assert.throws(() => confinePath('innocent/config', undefined, 'read'), /Refusing to read/);
  });

  test('G8: .env writes are lifted only by the explicit allowEnvFile option (the analytics wiring)', () => {
    const w = new ConfinedWriter({ root });
    assert.throws(() => w.resolve('.env.local'));
    assert.doesNotThrow(() => w.resolve('.env.local', { allowEnvFile: true }));
    assert.throws(() => w.resolve('.git/config', { allowEnvFile: true }), 'allowEnvFile does not lift the directory rule');
  });

  test('G8: swfte_files_upload cannot be pointed at .env, .npmrc or .git and uploads nothing', async () => {
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(root, '.npmrc'), '//registry:_authToken=x');
    const calls: string[] = [];
    const client: any = { postMultipart: async (p: string) => (calls.push(p), { id: 'f' }) };
    const config = loadConfig({ SWFTE_PAT: 'pat_TESTPAT123456', SWFTE_TELEMETRY: '0' } as never);
    const tool = fileTools.find((t) => t.name === 'swfte_files_upload')!;
    for (const path of ['.env', '.npmrc', '.git/config']) {
      await assert.rejects(tool.execute({ path } as never, { client, config, localFilesystem: true }), /Refusing/, path);
    }
    assert.deepEqual(calls, []);
    writeFileSync(join(root, 'notes.txt'), 'hello');
    await tool.execute({ path: 'notes.txt' } as never, { client, config, localFilesystem: true });
    assert.equal(calls.length, 1);
  });

  test('G8: confineReadableFile refuses a private key even when it exists', () => {
    writeFileSync(join(root, 'server.pem'), '-----BEGIN PRIVATE KEY-----');
    assert.throws(() => confineReadableFile('server.pem'), /Refusing to read/);
  });
});
