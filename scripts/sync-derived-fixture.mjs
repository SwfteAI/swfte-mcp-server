#!/usr/bin/env node
/**
 * Sync (or verify) the derived G3 golden from an agents-service checkout.
 *
 *   node scripts/sync-derived-fixture.mjs <agents-service-root> [--check] [--expect-sha <hex>] [--fixtures <dir>]
 *
 * The backend owns the golden (src/test/resources/catalog/g3/two-input-workflow.contract.json).
 * The MCP copy is test/fixtures/phase5-contracts/two-input-workflow.golden.json and must stay
 * byte-for-byte equal to it, together with the records that mirror it:
 *   - two-input-workflow.golden.json.sha256
 *   - workflow_wf_1.contract.json(.sha256)  (the captured unpinned workflow IS the golden)
 *   - provenance.json: derivedGoldenSha256 and the workflow:wf_1 provider-everyKind case sha256
 *
 * Default mode copies and re-verifies; --check changes nothing and exits 1 on any drift.
 * --expect-sha refuses a backend golden whose sha256 is not the one the caller expects.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOLDEN_RELATIVE = 'src/test/resources/catalog/g3/two-input-workflow.contract.json';
const GOLDEN = 'two-input-workflow.golden.json';
const CAPTURED = 'workflow_wf_1.contract.json';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { process.stderr.write(`sync-derived-fixture: ${message}\n`); process.exit(1); };

const args = process.argv.slice(2);
let root = null; let check = false; let expectSha = null;
let fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'phase5-contracts');
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--check') check = true;
  else if (arg === '--expect-sha') expectSha = args[++i] ?? fail('--expect-sha needs a value');
  else if (arg === '--fixtures') fixtures = resolve(args[++i] ?? fail('--fixtures needs a value'));
  else if (arg.startsWith('--')) fail(`unknown option ${arg}`);
  else if (root === null) root = resolve(arg);
  else fail('only one agents-service path may be given');
}
if (root === null) fail('usage: sync-derived-fixture.mjs <agents-service-root> [--check] [--expect-sha <hex>] [--fixtures <dir>]');
if (expectSha !== null && !/^[a-f0-9]{64}$/.test(expectSha)) fail('--expect-sha must be a lowercase sha256 hex digest');

const sourceFile = join(root, GOLDEN_RELATIVE);
if (!existsSync(sourceFile)) fail(`backend golden not found: ${sourceFile}`);
const source = readFileSync(sourceFile);
const sourceSha = sha256(source);
if (expectSha !== null && sourceSha !== expectSha) fail(`backend golden sha256 is ${sourceSha}, expected ${expectSha}; nothing changed`);
try { JSON.parse(source.toString('utf8')); } catch { fail('backend golden is not valid JSON; nothing changed'); }

const read = (name) => readFileSync(join(fixtures, name));
const readText = (name) => readFileSync(join(fixtures, name), 'utf8');
const shaLine = (name) => `${sourceSha}  ${name}\n`;

const provenancePath = join(fixtures, 'provenance.json');
const provenanceText = readText('provenance.json');
const recordedGoldenSha = JSON.parse(provenanceText).derivedGoldenSha256;
const nextProvenance = provenanceText.split(recordedGoldenSha).join(sourceSha);

// Each mirror: [file, expected bytes/text]. The wf_1 case sha lives in provenance.json and shares the golden's old digest.
const mirrors = [
  [GOLDEN, source],
  [`${GOLDEN}.sha256`, Buffer.from(shaLine(GOLDEN))],
  [CAPTURED, source],
  [`${CAPTURED}.sha256`, Buffer.from(shaLine(CAPTURED))],
  ['provenance.json', Buffer.from(nextProvenance)],
];

const drift = mirrors.filter(([name, expected]) => !existsSync(join(fixtures, name)) || !read(name).equals(expected)).map(([name]) => name);

if (check) {
  if (drift.length > 0) fail(`DERIVED_FIXTURE_DRIFT sha=${sourceSha} out of date: ${drift.join(', ')}`);
  process.stdout.write(`DERIVED_FIXTURE_IN_SYNC sha=${sourceSha}\n`);
  process.exit(0);
}

for (const [name, expected] of mirrors) writeFileSync(join(fixtures, name), expected);
const after = mirrors.filter(([name, expected]) => !read(name).equals(expected)).map(([name]) => name);
if (after.length > 0) fail(`verification after copy failed: ${after.join(', ')}`);
if (sha256(read(GOLDEN)) !== sourceSha) fail('golden sha256 differs from the backend after copy');
process.stdout.write(`DERIVED_FIXTURE_SYNCED sha=${sourceSha} (${drift.length} file(s) changed)\n`);
