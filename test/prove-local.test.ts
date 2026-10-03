import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runLocal, secretFindings } from '../src/prove/local.js';
const exec = promisify(execFile);

test('AWS-shaped secret is found without returning secret bytes; clean twin has no finding', () => {
  const planted = ['AK', 'IA', 'A1B2C3D4E5F6G7H8'].join('');
  const findings = secretFindings('source.ts', `const credential = '${planted}';`);
  assert(findings.some(finding => finding.rule_id === 'aws-key'));
  assert(!JSON.stringify(findings).includes(planted));
  assert.equal(secretFindings('source.ts', 'const total = 2;').length, 0);
});
test('private key, URI credential, provider token, bearer and entropy classes refuse', () => {
  const samples = [
    ['private-key', ['-----BEGIN ', 'PRIVATE KEY-----'].join('')],
    ['uri-credentials', ['postgres://person:', 'hidden-value@db.invalid'].join('')],
    ['provider-token', ['sk_', 'live_', 'abcdefghijklmnopqrstuv'].join('')],
    ['bearer', ['Bearer ', 'abcdefghijklmnopqrstuv'].join('')],
    ['entropy', ['aB1cD2eF3gH4', 'iJ5kL6mN7oP8'].join('')],
  ];
  for (const [kind, sample] of samples) assert(secretFindings('x.ts', sample!).some(finding => finding.rule_id === kind));
});
test('local executes fixed check, reports absent build/test unknown and refuses prohibited source license', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prove-local-'));
  try {
    await exec('git', ['init', '-q', root]);
    await writeFile(join(root, 'source.ts'), 'const total = 2;');
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', license: 'MIT', scripts: { test: 'touch must-never-run' } }));
    const clean = await runLocal(root, ['scan', 'deps', 'build', 'test']);
    assert.equal(clean.verdict, 'PARTIAL');
    assert.equal(clean.checks.find(check => check.name === 'test')?.ok, null);
    assert.equal(clean.checks.find(check => check.name === 'local-diff')?.ok, true);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', license: 'BUSL-1.1' }));
    const prohibited = await runLocal(root, ['scan']);
    assert.equal(prohibited.verdict, 'FAIL'); assert(prohibited.findings.some(finding => finding.rule_id === 'license-refused'));
    assert.equal(prohibited.checks.some(check => check.name === 'deps'), false);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', license: 'MIT' }));
    const scanOnly = await runLocal(root, ['scan']);
    assert.equal(scanOnly.findings.length, 0); assert.equal(scanOnly.verdict, 'PARTIAL');
    await assert.rejects(runLocal(root, ['arbitrary-command']));
  } finally { await rm(root, { recursive: true, force: true }); }
});
