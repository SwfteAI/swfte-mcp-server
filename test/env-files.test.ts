import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_ENVIRONMENT_FILES, environmentSecretGlobs, isEnvironmentFile, resolveEnvironmentFiles } from '../src/env-files.js';
import { collectLocalFiles, isCredentialFile } from '../src/compliance.js';
import { ConfinedWriter } from '../src/fsguard.js';
import { initProject } from '../src/init.js';

const files = Object.freeze({ plain: 'dot-env', local: 'dot-env.local', example: 'dot-env.example' });
const scratch = path.join(process.cwd(), '.unlazy/foundation-repairs/env-fixtures');
let root: string;
beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(path.join(scratch, 'owned-'));
});
afterEach(() => {
  assert.equal(path.dirname(root), scratch, 'Delete only the current invocation fixture');
  rmSync(root, { recursive: true });
});

test('production default paths are exact immutable strings; layout resolution performs no file I/O', () => {
  assert.deepEqual(DEFAULT_ENVIRONMENT_FILES, { plain: '.env', local: '.env.local', example: '.env.example' });
  assert.deepEqual(resolveEnvironmentFiles(), DEFAULT_ENVIRONMENT_FILES);
  assert.equal(Object.isFrozen(DEFAULT_ENVIRONMENT_FILES), true);
  assert.deepEqual(readdirSync(root), []);
});

test('explicit neutral init creates real lock and empty named variables without writing credentials or .env files', () => {
  const credential = 'synthetic-unusable-fixture-credential';
  const result = initProject({ root, env: { SWFTE_API_KEY: credential }, environmentFiles: files });
  assert.deepEqual(result.files.map(file => file.path).sort(), ['dot-env.example', 'swfte.json']);
  const example = readFileSync(path.join(root, files.example), 'utf8');
  assert.match(example, /^SWFTE_API_KEY=$/m);
  assert.match(example, /^SWFTE_BASE_URL=$/m);
  assert.match(example, /^SWFTE_WORKSPACE_ID=$/m);
  assert.equal(example.includes(credential), false);
  assert.equal(readdirSync(root).some(file => file.startsWith('.env')), false);
});

test('real neutral init merges existing values and unrelated content without replacement', () => {
  writeFileSync(path.join(root, files.example), 'DATABASE_URL=kept\nSWFTE_API_KEY=existing-empty-key-name\n');
  initProject({ root, env: {}, environmentFiles: files });
  const before = readFileSync(path.join(root, files.example), 'utf8');
  assert.match(before, /^DATABASE_URL=kept$/m);
  assert.match(before, /^SWFTE_API_KEY=existing-empty-key-name$/m);
  const repeated = initProject({ root, env: {}, environmentFiles: files });
  assert.equal(repeated.lock.created, false);
  assert.equal(readFileSync(path.join(root, files.example), 'utf8'), before);
  assert.equal(readdirSync(root).some(file => file.startsWith('.env')), false);
});

test('neutral writers retain credential refusal and atomic no-partial-write behavior', () => {
  const writer = new ConfinedWriter({ root, forbidden: ['synthetic-forbidden-credential'] });
  writer.create(writer.resolve('generated.ts'), 'export {}\n');
  writer.mergeEnv(writer.resolve(files.plain), [{ key: 'SECRET', value: 'synthetic-forbidden-credential' }]);
  assert.throws(() => writer.commit(), /secret|credential/i);
  assert.deepEqual(readdirSync(root), []);
});

test('configured neutral private files are excluded by real local scanning and example names remain code-eligible', () => {
  mkdirSync(path.join(root, 'src'));
  for (const file of [files.local, 'DOT-ENV', files.example]) writeFileSync(path.join(root, 'src', file), 'neutral canary\n');
  writeFileSync(path.join(root, 'src/handler.ts'), 'export const answer = 42\n');
  const result = collectLocalFiles({ root, paths: ['src'], additionalSecretGlobs: environmentSecretGlobs(files) });
  assert.deepEqual(result.files.map(file => file.path).sort(), ['src/dot-env.example', 'src/handler.ts']);
  assert.equal(result.notScanned.length, 2);
  assert(result.notScanned.every(file => /credential file/.test(file.reason)));
});

test('custom secret globs extend canonical private-file refusals and cannot make defaults uploadable', () => {
  for (const file of ['.env', 'src/.env.local', 'src/.env.production', 'id_rsa', 'src/private.pem', 'dot-env', 'src/dot-env.local']) {
    assert.equal(isCredentialFile(file, environmentSecretGlobs(files)), true, file);
  }
  assert.equal(isCredentialFile('.env.example', environmentSecretGlobs(files)), false);
  assert.equal(isCredentialFile('src/handler.ts', environmentSecretGlobs(files)), false);
  assert.equal(isEnvironmentFile(files.example, files), true);
});

test('configured example symlink is refused before any lock or example commit', () => {
  const outside = path.join(root, 'outside-owned');
  mkdirSync(outside);
  const canary = path.join(outside, 'canary.txt');
  writeFileSync(canary, 'unchanged\n');
  symlinkSync(canary, path.join(root, files.example));
  assert.throws(() => initProject({ root, env: {}, environmentFiles: files }), /symlink/i);
  assert.equal(readFileSync(canary, 'utf8'), 'unchanged\n');
  assert.equal(existsSync(path.join(root, 'swfte.json')), false);
});

for (const bad of ['', '/tmp/escape', '../escape', 'a/../escape', 'a\\escape', 'C:/escape', 'a//escape', 'a/./escape', 'dot-env*', 'dot-env\u0000']) {
  test(`invalid explicit path is refused before init I/O: ${JSON.stringify(bad)}`, () => {
    assert.throws(() => initProject({ root, env: {}, environmentFiles: { ...files, example: bad } }), /environment file path/i);
    assert.deepEqual(readdirSync(root), []);
  });
}

test('private and example paths cannot alias on a case-insensitive filesystem', () => {
  assert.throws(() => resolveEnvironmentFiles({ ...files, example: 'DOT-ENV.LOCAL' }), /distinct/);
  assert.deepEqual(readdirSync(root), []);
});
