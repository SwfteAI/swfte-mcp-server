import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
assert.equal(path.basename(root), 'parallel-foundation-mcp');
const backend = path.resolve(root, '../parallel-foundation-agents');
const tracking = path.join(backend, '.unlazy/parallel/foundation-repairs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const mode = process.argv[2];
assert(['full', 'env-files'].includes(mode), 'Use full or env-files');
const receipt = JSON.parse(fs.readFileSync(path.join(tracking, 'reports/mcp-full-receipt.json'), 'utf8'));
const bytes = fs.readFileSync(path.join(backend, receipt.resultPath));
assert.equal(hash(bytes), receipt.resultSha256);
const result = JSON.parse(bytes);
assert(result.accepted && result.logs.types.exitCode === 0 && result.logs.build.exitCode === 0 && result.logs.tests.exitCode === 0);
assert.equal(result.changedDuringRun, false);
for (const field of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(result.counts[field], 0);
assert(result.counts.tests > 0 && result.counts.pass === result.counts.tests);
const source = JSON.parse(execFileSync(process.execPath, ['scripts/foundation-repairs/check.mjs', 'source'], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }));
for (const key of ['sha', 'tree', 'fingerprint']) assert.equal(source[key], result.source[key], `Stale current source: ${key}`);
for (const log of Object.values(result.logs)) assert.equal(hash(fs.readFileSync(path.join(backend, log.path))), log.sha256);
const planned = fs.readdirSync(path.join(root, 'test')).filter(file => /\.test\.(ts|mjs)$/.test(file)).sort().map(file => `test/${file}`);
assert.deepEqual(result.planned, planned, 'Every current and original test entrypoint required');
if (mode === 'env-files') {
  const tap = fs.readFileSync(path.join(backend, result.logs.tests.path), 'utf8');
  const names = [
    'production default paths are exact immutable strings; layout resolution performs no file I/O',
    'explicit neutral init creates real lock and empty named variables without writing credentials or .env files',
    'real neutral init merges existing values and unrelated content without replacement',
    'neutral writers retain credential refusal and atomic no-partial-write behavior',
    'configured neutral private files are excluded by real local scanning and example names remain code-eligible',
    'custom secret globs extend canonical private-file refusals and cannot make defaults uploadable',
    'configured example symlink is refused before any lock or example commit',
    'private and example paths cannot alias on a case-insensitive filesystem',
  ];
  for (const name of names) assert(tap.split('\n').some(line => /^\s*ok \d+ - /.test(line) && line.includes(name)), `Actual positive assertion case missing: ${name}`);
  console.log(`FOUNDATION_MCP_ENV_FILES_OK originalAllTests=${result.counts.tests} skipped=0 source=${source.fingerprint}`);
} else console.log(`FOUNDATION_MCP_FULL_RECEIPT_OK tests=${result.counts.tests} files=${planned.length} source=${source.fingerprint}`);
