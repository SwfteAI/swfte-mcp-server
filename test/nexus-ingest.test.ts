import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEXUS_LIMITS, NexusIngestError, previewNexus, readNexus, safeRepoPath, sourceHasSecret } from '../src/nexus-ingest.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-nexus-')));
  const cwd = join(base, 'project'), home = join(base, 'home'), from = join(cwd, '.nexus');
  mkdirSync(cwd); mkdirSync(home); mkdirSync(from); mkdirSync(join(from, 'ledger'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, cwd, home, from, options: { cwd, home, from, ref: 'workflow:wf-1', localFilesystem: true } };
}
function why(id = 'event-1', extra: Record<string, unknown> = {}) {
  return { schema: '1', type: 'rationale', event_id: id, session_id: 'session-1', ts: '2026-10-01T10:00:00Z',
    rationale: 'Keep the retry outside the lock. This avoids waiting with a held lock.', source: 'llm_mined',
    repo: 'repo-a', files: ['src/flow/main.ts'], ...extra };
}
function ledger(from: string, events: unknown[], name = '2026-10-01.ndjson') {
  writeFileSync(join(from, 'ledger', name), `${events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n')}\n`);
}
function card(from: string, name = 'flow', extra: Record<string, unknown> = {}) {
  mkdirSync(join(from, 'model', 'repo-a'), { recursive: true });
  const value = { module: `src/flow/${name}.ts`, repo: 'repo-a', grounded_commit: 'a'.repeat(40), updated: '2026-10-01T10:00:00Z',
    summary: 'A bounded durable queue.', why: 'Persist before acknowledging.', how_it_works: 'Use the transactional store.',
    security: { sensitive: true, invariants: [{ text: 'A tenant owns each partition.', grounded: true, confirmed: true }] }, ...extra };
  writeFileSync(join(from, 'model', 'repo-a', `${name}.json`), JSON.stringify(value));
  return value;
}
function lock(cwd: string, artifacts = [{ catalogRef: 'workflow:wf-1', outDir: 'src/flow', files: ['src/flow/main.ts'] }]) {
  writeFileSync(join(cwd, 'swfte.json'), JSON.stringify({ version: 1, baseUrl: 'https://evil.invalid', workspaceId: 'foreign',
    artifacts: artifacts.map((artifact, i) => ({ ...artifact, alias: `a-${i}`, language: 'typescript', framework: 'plain-ts',
      contractHash: '', pinnedVersion: null })) }));
}
const refusal = (code: string) => (error: unknown) => error instanceof NexusIngestError && error.code === code;

test('reader schema accepts schema-1 and legacy absent-1 while skipping future, malformed, poisoned and unrelated lines', t => {
  const f = fixture(t);
  ledger(f.from, [why(), why('future', { schema: '2' }), why('numeric', { schema: 1 }), '{"rationale":"SECRET_UNSAFE_TRUNCATED"',
    '{"schema":"1","type":"rationale","__proto__":{"polluted":true}}', [], why('other', { type: 'model_response' }),
    why('legacy', { schema: undefined }), why('bad-file', { files: [123] }), why('shape', { event_id: { malicious: true } })]);
  const read = readNexus(f.options);
  assert.equal(read.decisions.length, 2);
  assert.equal(read.skipped.unsupported_schema, 2); assert.equal(read.skipped.malformed, 2);
  assert.equal(read.skipped.invalid_shape, 3); assert.equal(read.skipped.unsupported_type, 1);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.ok(!JSON.stringify(previewNexus(read)).includes('SECRET_UNSAFE_TRUNCATED'));
});

test('reader normalization missing upstream source remains unknown instead of inventing a model or confirmation claim', t => {
  const f = fixture(t); ledger(f.from, [why('unknown-source', { source: undefined })]);
  const read = readNexus(f.options);
  assert.equal(read.decisions.length, 1); assert.equal('source' in read.decisions[0]!.item.upstream, false);
  assert.equal(read.decisions[0]!.item.upstream.epistemicClass, 'rationalisation');
});

test('reader schema ignores claimed status, provenance, workspace and confirmation when mapping valid source data', t => {
  const f = fixture(t);
  card(f.from, 'flow', { status: 'CONFIRMED', source: 'human', workspaceId: 'foreign', provenance: { source: 'human' } });
  ledger(f.from, [why('1', { status: 'CONFIRMED', visibility: 'public', author: 'attacker', workspace: 'foreign' })]);
  const read = readNexus(f.options);
  assert.equal(read.decisions.length, 2);
  const model = read.decisions[0]!.item;
  assert.equal(model.upstream.source, 'llm_synth'); assert.equal(model.upstream.epistemicClass, 'rationalisation');
  assert.equal(model.constraints![0]!.confirmed, false);
  for (const decision of read.decisions) {
    assert.equal(decision.catalogRef, 'workflow:wf-1');
    for (const key of ['status', 'visibility', 'author', 'workspace', 'workspaceId', 'provenance', 'rejectedAlternatives']) {
      assert.equal(key in decision.item, false);
    }
  }
});

test('reader confinement explicit project directory and exact default Nexus root both have positive controls', t => {
  const f = fixture(t); ledger(f.from, [why()]);
  assert.equal(readNexus(f.options).decisions.length, 1);
  const defaultRoot = join(f.home, '.nexus'); mkdirSync(defaultRoot); mkdirSync(join(defaultRoot, 'ledger'));
  ledger(defaultRoot, [why('default')]);
  const options = { ...f.options, from: undefined };
  assert.equal(readNexus(options).decisions.length, 1);
  assert.equal(readNexus({ ...options, from: '~/.nexus' }).decisions.length, 1);
  assert.equal(readNexus({ ...f.options, from: '.nexus' }).decisions.length, 1);
});

test('reader confinement root/home/outside-project roots and root symlinks are refused without path disclosure', t => {
  const f = fixture(t); ledger(f.from, [why()]);
  const outside = join(f.base, 'outside'); mkdirSync(outside); mkdirSync(join(outside, 'ledger')); ledger(outside, [why('outside')]);
  const link = join(f.cwd, 'link'); symlinkSync(outside, link, 'dir');
  for (const from of ['/', f.home, outside, link, '../outside']) {
    assert.throws(() => readNexus({ ...f.options, from }), refusal('PATH_REFUSED'));
    try { readNexus({ ...f.options, from }); } catch (error) {
      assert.ok(!(error as Error).message.includes(from) || from === '/');
      assert.ok(!(error as Error).message.includes('outside'));
    }
  }
  symlinkSync(outside, join(f.home, '.nexus'), 'dir');
  assert.throws(() => readNexus({ ...f.options, from: undefined }), refusal('PATH_REFUSED'));
});

test('reader confinement ledger/card child symlink escapes and nonregular files are refused before reading', t => {
  const f = fixture(t), outside = join(f.base, 'outside'); mkdirSync(outside);
  const file = join(outside, 'sentinel.ndjson'); writeFileSync(file, JSON.stringify(why('escaped')));
  symlinkSync(file, join(f.from, 'ledger', 'escape.ndjson'));
  assert.throws(() => readNexus(f.options), refusal('PATH_REFUSED'));
  rmSync(join(f.from, 'ledger', 'escape.ndjson'));
  mkdirSync(join(f.from, 'model')); symlinkSync(outside, join(f.from, 'model', 'repo-a'), 'dir');
  assert.throws(() => readNexus(f.options), refusal('PATH_REFUSED'));
  unlinkSync(join(f.from, 'model', 'repo-a')); mkdirSync(join(f.from, 'model', 'repo-a'));
  symlinkSync(file, join(f.from, 'model', 'repo-a', 'escape.json'));
  assert.throws(() => readNexus(f.options), refusal('PATH_REFUSED'));
  rmSync(join(f.from, 'model', 'repo-a', 'escape.json')); mkdirSync(join(f.from, 'ledger', 'directory.ndjson'));
  assert.throws(() => readNexus(f.options), refusal('PATH_REFUSED'));
});

test('reader hosted denial comes before missing source/ref/lock filesystem resolution', t => {
  const f = fixture(t);
  assert.throws(() => readNexus({ ...f.options, from: '/missing', cwd: '/missing', ref: 'poison', localFilesystem: false }),
    error => error instanceof Error && error.message.includes('hosted MCP server'));
});

test('reader bounds inspect at most 5000 physical event records across multiple ledger files', t => {
  const f = fixture(t);
  ledger(f.from, Array.from({ length: 3_000 }, (_, i) => why(`new-${i}`)));
  ledger(f.from, Array.from({ length: 3_000 }, (_, i) => why(`old-${i}`)), '2026-09-30.ndjson');
  const read = readNexus(f.options);
  assert.equal(read.inspected, 5_000); assert.equal(read.decisions.length, 5_000);
  assert.equal(read.truncated, true); assert.ok(read.bytesRead <= 5 * 1024 * 1024);
});

test('reader bounds aggregate byte budget includes model cards and ledgers and never parses truncated tails', t => {
  const f = fixture(t); card(f.from);
  const prefix = `${JSON.stringify(why('valid'))}\n`;
  writeFileSync(join(f.from, 'ledger', '2026-10-01.ndjson'), prefix + ' '.repeat(5 * 1024 * 1024 + 100));
  const read = readNexus(f.options);
  assert.equal(read.bytesRead, 5 * 1024 * 1024); assert.equal(read.truncated, true);
  assert.equal(read.decisions.length, 2); assert.equal(read.skipped.malformed, undefined);
});

test('reader bounds oversized lines/cards skip safely and directory enumeration is capped', t => {
  const f = fixture(t);
  ledger(f.from, [why('too-large', { rationale: 'safe '.repeat(NEXUS_LIMITS.lineBytes) }), why('valid')]);
  card(f.from, 'huge', { summary: 'safe '.repeat(NEXUS_LIMITS.cardBytes) });
  let read = readNexus(f.options); assert.equal(read.decisions.length, 1); assert.equal(read.skipped.oversized_record, 2);
  rmSync(join(f.from, 'ledger'), { recursive: true }); mkdirSync(join(f.from, 'ledger'));
  // Entries need not be readable ledger events; bounds apply to directory work itself.
  for (let i = 0; i <= 10_000; i++) writeFileSync(join(f.from, 'ledger', `${i}.ignored`), '');
  read = readNexus(f.options); assert.equal(read.truncated, true); assert.equal(read.inspected, 0);
});

test('reader bounds blank-line storm is capped at 5000 inspections without materializing every line', t => {
  const f = fixture(t);
  writeFileSync(join(f.from, 'ledger', '2026-10-01.ndjson'), '\n'.repeat(100_000) + JSON.stringify(why('beyond-cap')));
  const read = readNexus(f.options);
  assert.equal(read.inspected, 5_000); assert.equal(read.truncated, true); assert.equal(read.decisions.length, 0);
});

test('reader mapping explicit catalog reference requires no lock and never guesses a target for unmatched files', t => {
  const f = fixture(t); ledger(f.from, [why()]);
  assert.equal(readNexus(f.options).decisions[0]!.catalogRef, 'workflow:wf-1');
  const read = readNexus({ ...f.options, ref: undefined });
  assert.equal(read.decisions.length, 0); assert.equal(read.skipped.no_artifact_match, 1);
  assert.equal(previewNexus(read).skippedItems[0]!.code, 'no_artifact_match');
  assert.match(previewNexus(read).skippedItems[0]!.externalId, /^[0-9a-f]{64}$/);
  assert.throws(() => readNexus({ ...f.options, ref: 'unknown:thing' }), refusal('INVALID_REF'));
});

test('reader mapping uses declared lock file/outDir segment boundaries and reports overlapping targets as ambiguous', t => {
  const f = fixture(t); lock(f.cwd);
  ledger(f.from, [why('within'), why('sibling', { files: ['src/flow-other/main.ts'] }),
    why('exact', { files: ['tools/one.ts'] }), why('unsafe', { files: ['../src/flow/main.ts', '/src/flow/main.ts', 'C:\\src\\flow'] })]);
  let read = readNexus({ ...f.options, ref: undefined });
  assert.equal(read.decisions.length, 1); assert.equal(read.skipped.no_artifact_match, 3);
  lock(f.cwd, [{ catalogRef: 'workflow:wf-1', outDir: 'src/flow', files: ['tools/one.ts'] },
    { catalogRef: 'agent:agent-2', outDir: 'src', files: [] }]);
  read = readNexus({ ...f.options, ref: undefined });
  assert.equal(read.decisions.length, 2); assert.equal(read.skipped.ambiguous_artifact_match, 1);
  assert.ok(read.decisions.some(row => row.catalogRef === 'workflow:wf-1' && row.item.upstream.files?.[0] === 'tools/one.ts'));
});

test('reader mapping invalid lock traversal/schema/symlink cannot authorize artifact guesses or a different workspace', t => {
  const f = fixture(t); ledger(f.from, [why()]);
  lock(f.cwd, [{ catalogRef: 'workflow:wf-1', outDir: 'x/../src/flow', files: ['x/../src/flow/main.ts'] }]);
  assert.equal(readNexus({ ...f.options, ref: undefined }).skipped.no_artifact_match, 1);
  writeFileSync(join(f.cwd, 'swfte.json'), '{"version":2,"artifacts":[]}');
  assert.throws(() => readNexus({ ...f.options, ref: undefined }), refusal('LOCK_REFUSED'));
  writeFileSync(join(f.cwd, 'swfte.json'), '{"version":1,"artifacts":[],"__proto__":{}}');
  assert.throws(() => readNexus({ ...f.options, ref: undefined }), refusal('LOCK_REFUSED'));
  rmSync(join(f.cwd, 'swfte.json')); const outside = join(f.base, 'lock.json'); writeFileSync(outside, '{}');
  symlinkSync(outside, join(f.cwd, 'swfte.json'));
  assert.throws(() => readNexus({ ...f.options, ref: undefined }), refusal('LOCK_REFUSED'));
});

test('reader mapping repo filter matches exact declared slug and safely skips foreign or unknown repos', t => {
  const f = fixture(t); ledger(f.from, [why('mine'), why('foreign', { repo: 'repo-b' }), why('absent', { repo: undefined })]);
  const read = readNexus({ ...f.options, repo: 'repo-a' });
  assert.equal(read.decisions.length, 1); assert.equal(read.skipped.repo_mismatch, 2);
  assert.throws(() => readNexus({ ...f.options, repo: '../repo-a' }), refusal('INVALID_REPO'));
});

test('reader normalization maps rationale prose/notes/relative files to bounded actual backend import contract', t => {
  const f = fixture(t);
  ledger(f.from, [why('id-1', { rationale: '<b>Use the queue.</b> Another sentence.\u0000' + '界'.repeat(1_000),
    how_note: 'Use a journal.', security_note: 'Own partition only.', risk_note: 'Recover interrupted writes.', change_class: 'correctness',
    grounded_commit: 'a'.repeat(40), model: 'model-v1', files: ['../bad', '/bad', 'C:\\bad', './src\\flow\\main.ts', 'src/./flow/main.ts'] })]);
  const item = readNexus(f.options).decisions[0]!.item;
  assert.equal(item.title, 'Use the queue.'); assert.ok(Buffer.byteLength(item.statement!) <= 2048);
  assert.equal(item.statement!.includes('<'), false); assert.equal(item.statement!.includes('\u0000'), false);
  assert.deepEqual(item.notes, { how: 'Use a journal.', security: 'Own partition only.', change_class: 'correctness' });
  assert.equal(item.consequences, 'Recover interrupted writes.'); assert.deepEqual(item.upstream.files, ['src/flow/main.ts']);
  assert.deepEqual(item.appliesTo, [{ scope: 'artifact', kind: 'workflow', ref: 'workflow:wf-1' }]);
  assert.equal(item.externalId, createHash('sha256').update(JSON.stringify(['repo-a', 'why', 'id-1'])).digest('hex'));
  assert.deepEqual(readNexus(f.options).decisions[0]!.item, item);
});

test('reader normalization full model cards win over digest and preserve grounded claims as unconfirmed with stable commit identity', t => {
  const f = fixture(t), value = card(f.from);
  writeFileSync(join(f.from, 'model', '.DS_Store'), 'unrelated filesystem metadata');
  ledger(f.from, [why('digest', { type: 'module_model', module_path: value.module, grounded_commit: value.grounded_commit,
    summary: 'Digest only.', why_note: 'Shorter why.', invariants: ['Less complete.'], source: 'llm_synth' })]);
  const read = readNexus(f.options), item = read.decisions[0]!.item;
  assert.equal(read.decisions.length, 1); assert.equal(read.skipped.duplicate_local, 1);
  assert.equal(item.statement, value.why); assert.equal(item.notes!.how, value.how_it_works);
  assert.deepEqual(item.constraints, [{ text: 'A tenant owns each partition.', grounded: true, confirmed: false }]);
  assert.equal(item.externalId, createHash('sha256').update(JSON.stringify(['repo-a', 'model_card',
    JSON.stringify([value.module, value.grounded_commit])])).digest('hex'));
});

test('reader normalization caps Unicode joined file metadata, notes and constraints without inventing alternatives', t => {
  const f = fixture(t);
  card(f.from, 'many', { summary: '界'.repeat(500), why: '界'.repeat(2_000), how_it_works: '界'.repeat(2_000),
    files: Array.from({ length: 30 }, (_, i) => `${'界'.repeat(150)}/${i}.ts`),
    security: { invariants: Array.from({ length: 30 }, () => ({ text: '界'.repeat(1_000), grounded: true, confirmed: true })) } });
  const item = readNexus(f.options).decisions[0]!.item;
  assert.equal(Array.from(item.title).length, 120); assert.ok(Buffer.byteLength(item.statement!) <= 2048);
  assert.ok(item.upstream.files!.length <= 20); assert.ok(Buffer.byteLength(item.upstream.files!.join(', ')) <= 4096);
  assert.equal(item.constraints!.length, 20); assert.ok(item.constraints!.every(c => !c.confirmed && Buffer.byteLength(c.text) <= 4096));
  assert.equal('rejectedAlternatives' in item, false);
});

test('reader secrets reject prefixed, markup/control split and entropy credentials before hashing or preview disclosure', t => {
  const f = fixture(t);
  const aws = `AKIA${'A'.repeat(16)}`, lower = 'abcdefghijklmnopqrstuvwx0123456789abcdabcd';
  const samples = [`_${aws}`, `pre${aws.slice(0, 8)}<b></b>${aws.slice(8)}`, `${aws.slice(0, 8)}\u0000${aws.slice(8)}`,
    '-----BEGIN PRIVATE KEY-----', `sk-${'x'.repeat(25)}`, `ghp_${'x'.repeat(25)}`, `xoxb-${'9'.repeat(20)}`,
    'eyJabcdefghijklmnop.abcdefghijklmnop.abcdefghijklmnop', 'https://user:password@example.test/', lower,
    'a'.repeat(5_000) + lower];
  ledger(f.from, samples.map((text, i) => why(`s-${i}`, { rationale: text })), '2026-10-01.ndjson');
  const read = readNexus(f.options);
  assert.equal(read.decisions.length, 0); assert.equal(read.skipped.secret_detected, samples.length);
  const preview = JSON.stringify(previewNexus(read));
  for (const secret of samples) assert.equal(preview.includes(secret), false);
  assert.equal(sourceHasSecret('a'.repeat(64)), false); assert.equal(sourceHasSecret('SHA ' + 'a1'.repeat(32)), false);
});

test('reader secrets scan unused fields, note keys, model claims and the configured credential without reflecting content', t => {
  const f = fixture(t), credential = 'fixture-credential-do-not-reflect';
  ledger(f.from, [why('secret', { ignored: { secret: credential } }), why('note', { security_note: `AKIA${'B'.repeat(16)}` })]);
  card(f.from, 'secret', { ignored: { [`sk-${'z'.repeat(30)}`]: 'unused' } });
  const read = readNexus({ ...f.options, credential });
  assert.equal(read.decisions.length, 0); assert.equal(read.skipped.secret_detected, 3);
  assert.equal(JSON.stringify(previewNexus(read)).includes(credential), false);
});

test('reader normalization relative-file guard has accepted controls and rejects traversal without resolving a source path', () => {
  assert.equal(safeRepoPath('./src\\flow/main.ts'), 'src/flow/main.ts');
  for (const path of ['../bad', 'a/../bad', '/etc/passwd', 'C:\\secrets', '\\\\host\\share', 'https://host/path', 'a\u0000b']) {
    assert.equal(safeRepoPath(path), undefined);
  }
});
