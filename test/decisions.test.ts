import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwfteApiError, type RequestOptions } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { runDecisionsCli } from '../src/cli-decisions.js';
import { classifyComposition, CompositionSignals } from '../src/guidance/composition.js';
import { importBatches,
  type DecisionImportItem, type MappedDecision, type NexusReadResult } from '../src/nexus-ingest.js';
import { applyNexus, decisionTools, getDecisions, ingestDecisions } from '../src/tools/decisions.js';

const config = loadConfig({ SWFTE_PAT: 'pat_TEST_DECISION_CLIENT', SWFTE_TELEMETRY: '0' });
const getTool = decisionTools.find(tool => tool.name === 'swfte_get_decisions')!;
const ingestTool = decisionTools.find(tool => tool.name === 'swfte_ingest_decisions')!;
function fixture(t: { after: (fn: () => void) => void }, count = 1) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-decisions-'))), from = join(cwd, '.nexus');
  mkdirSync(join(from, 'ledger'), { recursive: true });
  const events = Array.from({ length: count }, (_, i) => ({ schema: '1', type: 'rationale', event_id: `event-${i}`,
    session_id: 'session-1', ts: '2026-10-01T10:00:00Z', rationale: `Private source prose ${i}.`, repo: 'repo-a',
    source: 'human_confirmed', files: ['src/flow.ts'], status: 'CONFIRMED', workspaceId: 'foreign' }));
  writeFileSync(join(from, 'ledger', '2026-10-01.ndjson'), `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, from, options: { cwd, from, ref: 'workflow:wf/1', localFilesystem: true }, events };
}
function client(response?: (options: RequestOptions, index: number) => unknown) {
  const calls: RequestOptions[] = [];
  return { calls, value: { request: async (options: RequestOptions) => {
    calls.push(options);
    return response ? response(options, calls.length) : { dryRun: false, created: (options.body as { items: unknown[] }).items.length,
      duplicates: 0, rejected: [] };
  } } as never };
}
function optionsRead(decisions: MappedDecision[]): NexusReadResult {
  return { decisions, inspected: decisions.length, bytesRead: 0, skipped: {}, skippedItems: [], truncated: false };
}
function item(i: number, extra: Partial<DecisionImportItem> = {}): MappedDecision {
  return { catalogRef: 'workflow:wf/1', item: { sourceType: 'why', externalId: i.toString(16).padStart(64, '0'),
    title: 'A queue.', statement: 'Persist before acknowledging.', appliesTo: [{ scope: 'artifact', kind: 'workflow', ref: 'workflow:wf/1' }],
    upstream: { source: 'llm', repo: 'repo-a', ref: `event-${i}`, epistemicClass: 'rationalisation' }, ...extra } };
}
function apiError(code = 'DECISIONS_IMPORT_DISABLED', status = 403, message = 'Private error source content') {
  return new SwfteApiError({ code, status, message, method: 'POST', path: '/ignored', envelope: { private: message } });
}

test('decisions preview defaults and explicit false never call HTTP, and direct nonboolean truthiness cannot apply', async t => {
  const f = fixture(t), c = client();
  for (const apply of [undefined, false, 'true', 1, {}]) {
    const report = await ingestDecisions({ ...f.options, apply: apply as boolean }, c.value);
    assert.equal(report.dryRun, true); assert.equal(report.proposed, 1);
    assert.equal(JSON.stringify(report).includes('Private source prose'), false);
  }
  assert.equal(c.calls.length, 0);
  assert.equal(ingestTool.inputSchema.parse({ from: f.from, ref: 'workflow:wf/1' }).apply, false);
  assert.throws(() => ingestTool.inputSchema.parse({ apply: 'true' }));
  assert.throws(() => ingestTool.inputSchema.parse({ apply: true, workspaceId: 'foreign' }));
});

test('decisions preview hosted ingest refuses before any HTTP or local source read with a positive stdio control', async t => {
  const f = fixture(t), c = client();
  assert.equal((await ingestDecisions(f.options, c.value)).proposed, 1);
  const previous = process.cwd();
  try {
    process.chdir(f.cwd);
    const report: any = await ingestTool.execute(ingestTool.inputSchema.parse({ from: '.nexus', ref: 'workflow:wf/1' }),
      { client: c.value, config, localFilesystem: true });
    assert.equal(report.dryRun, true); assert.equal(report.proposed, 1);
  } finally { process.chdir(previous); }
  await assert.rejects(ingestTool.execute(ingestTool.inputSchema.parse({ from: '/missing', ref: 'workflow:wf/1', apply: true }),
    { client: c.value, config, localFilesystem: false }), error => error instanceof Error && error.message.includes('hosted'));
  assert.equal(c.calls.length, 0);
});

test('decisions preview unmatched and ambiguous artifact mapping never post, including explicit apply', async t => {
  const f = fixture(t), c = client();
  let report = await ingestDecisions({ ...f.options, ref: undefined, apply: true }, c.value);
  assert.equal(report.proposed, 0); assert.equal(report.skipped.no_artifact_match, 1);
  writeFileSync(join(f.cwd, 'swfte.json'), JSON.stringify({ version: 1, artifacts: ['workflow:wf-1', 'agent:agent-2'].map((catalogRef, i) => ({
    catalogRef, alias: `a-${i}`, language: 'typescript', framework: 'plain-ts', outDir: 'src', files: ['src/flow.ts'] })) }));
  report = await ingestDecisions({ ...f.options, ref: undefined, apply: true }, c.value);
  assert.equal(report.proposed, 0); assert.equal(report.skipped.ambiguous_artifact_match, 1); assert.equal(c.calls.length, 0);
});

test('decisions apply explicit true sends the actual endpoint/body with no workspace override or trusted confirmation', async t => {
  const f = fixture(t), c = client();
  const report = await ingestDecisions({ ...f.options, apply: true }, c.value);
  assert.equal(report.dryRun, false); assert.ok('created' in report && report.created === 1); assert.equal(c.calls.length, 1);
  const request = c.calls[0]!, body = request.body as { apply: boolean; items: DecisionImportItem[] };
  assert.equal(request.path, '/v2/catalog/workflow/wf%2F1/decisions/import'); assert.equal(request.method, 'POST');
  assert.equal(request.retries, 0); assert.equal(request.workspaceId, undefined); assert.equal(request.headers, undefined);
  assert.deepEqual(Object.keys(body).sort(), ['apply', 'items']); assert.equal(body.apply, true);
  assert.equal(body.items[0]!.sourceType, 'why'); assert.equal(body.items[0]!.upstream.source, 'human_confirmed');
  assert.equal(body.items[0]!.upstream.epistemicClass, 'rationalisation');
  for (const forbidden of ['status', 'source', 'workspaceId', 'visibility', 'author', 'provenance']) assert.equal(forbidden in body.items[0]!, false);
});

test('decisions apply splits 51 items by 50 and by exact serialized UTF-8 bytes with Unicode and escaping', async () => {
  const list = Array.from({ length: 51 }, (_, i) => item(i));
  const batches = importBatches(list); assert.deepEqual(batches.map(batch => batch.body.items.length), [50, 1]);
  const large = Array.from({ length: 12 }, (_, i) => item(i, { statement: '界'.repeat(680),
    notes: { how: '\\"'.repeat(1_000) }, constraints: Array.from({ length: 5 }, () => ({ text: '界'.repeat(1_300), grounded: true, confirmed: false })) }));
  const bytes = importBatches(large); assert.ok(bytes.length > 1);
  for (const batch of bytes) {
    assert.ok(batch.body.items.length <= 50); assert.ok(Buffer.byteLength(JSON.stringify(batch.body), 'utf8') <= 262_144);
  }
  const c = client(), result = await applyNexus(optionsRead(large), c.value);
  assert.equal(result.created, 12); assert.equal(c.calls.length, bytes.length);
  const collected = c.calls.flatMap(request => (request.body as { items: DecisionImportItem[] }).items.map(row => row.externalId));
  assert.deepEqual(collected, large.map(row => row.item.externalId));
});

test('decisions apply groups only declared artifact targets and rejects one oversized item before making a request', async () => {
  const c = client(), decisions = [item(1), { ...item(2), catalogRef: 'agent:a-1' }, item(3)];
  await applyNexus(optionsRead(decisions), c.value);
  assert.deepEqual(c.calls.map(call => call.path), ['/v2/catalog/workflow/wf%2F1/decisions/import', '/v2/catalog/agent/a-1/decisions/import']);
  const before = c.calls.length;
  await assert.rejects(applyNexus(optionsRead([item(4, { statement: '界'.repeat(100_000) })]), c.value),
    error => error instanceof Error && error.message.includes('body limit'));
  assert.equal(c.calls.length, before);
});

test('decisions apply preserves created duplicate and per-item rejection counts and validates server receipt identities', async () => {
  const rows = [item(1), item(2), item(3)];
  const c = client(() => ({ dryRun: false, created: 1, duplicates: 1,
    rejected: [{ externalId: rows[2]!.item.externalId, code: 'SECRET_DETECTED', private: 'DO_NOT_RETURN' }] }));
  const report = await applyNexus(optionsRead(rows), c.value);
  assert.equal(report.created, 1); assert.equal(report.duplicates, 1);
  assert.deepEqual(report.rejected, [{ externalId: rows[2]!.item.externalId, code: 'SECRET_DETECTED' }]);
  assert.equal(JSON.stringify(report).includes('DO_NOT_RETURN'), false);
  const invalid = client(() => ({ dryRun: false, created: 0, duplicates: 0, rejected: [{ externalId: 'f'.repeat(64), code: 'SECRET_DETECTED' }] }));
  const refusal = await applyNexus(optionsRead([item(1)]), invalid.value);
  assert.ok('error' in refusal); assert.equal(refusal.error!.code, 'INVALID_IMPORT_RESPONSE'); assert.equal(refusal.remaining, 1);
});

test('decisions apply rate/auth/transient failure stops after one attempt and preserves earlier committed receipts', async () => {
  for (const status of [403, 429, 503]) {
    const c = client((_, index) => { if (index === 2) throw apiError(status === 429 ? 'RATE_LIMITED' : 'HTTP_403', status);
      return { dryRun: false, created: 50, duplicates: 0, rejected: [] }; });
    const result = await applyNexus(optionsRead(Array.from({ length: 101 }, (_, i) => item(i))), c.value);
    assert.equal(result.created, 50); assert.equal(result.submitted, 50); assert.equal(result.remaining, 51);
    assert.equal(result.requests, 2); assert.equal(c.calls.length, 2); assert.ok('error' in result);
    assert.equal(result.error!.status, status); assert.equal(JSON.stringify(result).includes('Private error source content'), false);
    assert.ok(c.calls.every(call => call.retries === 0));
  }
});

test('decisions apply refuses malformed or dry-run server receipts without pretending the request was committed or absent', async () => {
  for (const response of [{ dryRun: true, created: 1, duplicates: 0, rejected: [] },
    { dryRun: false, created: -1, duplicates: 2, rejected: [] }, { dryRun: false, created: 99, duplicates: 0, rejected: [] }]) {
    const c = client(() => response), report = await applyNexus(optionsRead([item(1)]), c.value);
    assert.ok('error' in report); assert.equal(report.error!.code, 'INVALID_IMPORT_RESPONSE');
    assert.equal(report.created, 0); assert.equal(report.remaining, 1); assert.match(report.note, /may have committed/);
  }
});

test('decisions disclosure never returns source prose, credential matches or error envelopes in preview/apply', async t => {
  const f = fixture(t), c = client(() => { throw apiError(`AKIA${'A'.repeat(16)}`, 403, 'DO_NOT_RETURN_PRIVATE'); });
  const report = await ingestDecisions({ ...f.options, apply: true }, c.value);
  const json = JSON.stringify(report);
  assert.equal(json.includes('Private source prose'), false); assert.equal(json.includes('AKIA'), false);
  assert.equal(json.includes('DO_NOT_RETURN_PRIVATE'), false); assert.ok('error' in report && report.error.code === 'IMPORT_FAILED');
  writeFileSync(join(f.from, 'ledger', '2026-10-01.ndjson'), JSON.stringify({ ...f.events[0], ignored: config.credential }));
  const previous = c.calls.length;
  const safe = await ingestDecisions({ ...f.options, apply: true, credential: config.credential }, c.value);
  assert.equal(safe.proposed, 0); assert.equal(safe.skipped.secret_detected, 1); assert.equal(c.calls.length, previous);
  assert.equal(JSON.stringify(safe).includes(config.credential), false);
});

test('decisions GET encodes opaque ids and preserves writable/degraded/derived decisions for hosted callers', async () => {
  const body = { items: [{ id: 'derived_1', title: 'Untrusted rationale', derived: true, status: 'PROPOSED' }],
    degraded: ['store_unavailable'], writable: false };
  const c = client(() => body);
  const report: any = await getTool.execute(getTool.inputSchema.parse({ catalogRef: 'workflow:wf/1' }),
    { client: c.value, config, localFilesystem: false });
  assert.deepEqual(c.calls, [{ method: 'GET', path: '/v2/catalog/workflow/wf%2F1/decisions', retries: 0 }]);
  assert.deepEqual(report.items, body.items); assert.deepEqual(report.degraded, body.degraded); assert.equal(report.writable, false);
  assert.match(report.advisory, /UNTRUSTED CONTENT/); assert.match(report.note, /awaiting workspace confirmation/);
  assert.equal(getTool.readOnly, true);
});

test('decisions GET writable defaults false and backend errors/credential-bearing responses reveal no private payload', async () => {
  let c = client(() => ({ items: [], degraded: [] }));
  assert.equal((await getDecisions(c.value, 'workflow:wf-1') as any).writable, false);
  c = client(() => ({ items: [], degraded: [], writable: true }));
  assert.equal((await getDecisions(c.value, 'workflow:wf-1') as any).writable, true);
  c = client(() => { throw apiError('NOT_FOUND', 404, 'private-do-not-return'); });
  const error = await getDecisions(c.value, 'workflow:wf-1');
  assert.equal(error.code, 'NOT_FOUND'); assert.equal(JSON.stringify(error).includes('private-do-not-return'), false);
  c = client(() => ({ items: [{ title: config.credential }], degraded: [], writable: true }));
  assert.equal((await getDecisions(c.value, 'workflow:wf-1', config.credential)).code, 'INVALID_DECISIONS_RESPONSE');
  assert.throws(() => getTool.inputSchema.parse({ catalogRef: 'workflow:wf-1', workspaceId: 'foreign' }));
});

test('decisions CLI preview loads no credential config and invokes no client factory, while apply is explicit', async t => {
  const f = fixture(t), out: string[] = [], err: string[] = [], c = client(); let factories = 0;
  const io = { cwd: f.cwd, env: {}, out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  const factory = () => { factories++; return c.value; };
  assert.equal(await runDecisionsCli(['ingest', '--from', '.nexus', '--ref', 'workflow:wf/1', '--json'], io, factory), 0);
  assert.equal(factories, 0); assert.equal(c.calls.length, 0); assert.equal(err.length, 0);
  assert.equal(JSON.parse(out.pop()!).dryRun, true);
  assert.equal(await runDecisionsCli(['decisions', 'ingest', '--from', '.nexus', '--ref', 'workflow:wf/1', '--apply', '--json'], io, factory), 0);
  assert.equal(factories, 1); assert.equal(c.calls.length, 1); assert.equal(JSON.parse(out.pop()!).dryRun, false);
});

test('decisions CLI preview without a factory works with missing and invalid credential environment', async t => {
  const f = fixture(t), out: string[] = [];
  for (const env of [{}, { SWFTE_PAT: 'invalid-credential-do-not-return' }]) {
    const code = await runDecisionsCli(['ingest', '--from', f.from, '--ref', 'workflow:wf-1', '--json'],
      { cwd: f.cwd, env, out: line => out.push(line), err: () => assert.fail('preview loaded credential config') });
    assert.equal(code, 0); assert.equal(JSON.parse(out.pop()!).dryRun, true);
  }
});

test('decisions CLI help/invalid apply strings/hosted denial and empty apply never invoke credential setup', async t => {
  const f = fixture(t), out: string[] = [], err: string[] = []; let factories = 0;
  const io = { cwd: f.cwd, env: {}, out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  const factory = () => { factories++; throw new Error('credential-do-not-print'); };
  assert.equal(await runDecisionsCli(['--help'], io, factory), 0); assert.match(out.pop()!, /zero HTTP/);
  for (const argv of [['ingest', '--apply=true'], ['ingest', '--apply', 'true'], ['ingest', '--workspace', 'foreign']]) {
    assert.equal(await runDecisionsCli(argv, io, factory), 1);
  }
  assert.equal(await runDecisionsCli(['ingest', '--from', '.nexus', '--apply', '--json'], io, factory), 0);
  assert.equal(JSON.parse(out.pop()!).proposed, 0);
  assert.equal(await runDecisionsCli(['ingest', '--from', '/missing', '--apply'], { ...io, localFilesystem: false }, factory), 1);
  assert.equal(factories, 0); assert.ok(!err.join('').includes('credential-do-not-print'));
});

test('decisions CLI disclosure keeps all sensitive source/error text out of both output streams and uses nonzero failure status', async t => {
  const f = fixture(t), out: string[] = [], err: string[] = [];
  const io = { cwd: f.cwd, env: {}, out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  const c = client(() => { throw apiError('DECISIONS_READONLY', 403, 'do-not-print-this-error'); });
  assert.equal(await runDecisionsCli(['ingest', '--from', '.nexus', '--ref', 'workflow:wf-1', '--apply', '--json'], io, () => c.value), 1);
  assert.equal(JSON.parse(out.pop()!).error.code, 'DECISIONS_READONLY');
  assert.equal(await runDecisionsCli(['ingest', '--from', '.nexus', '--ref', 'workflow:wf-1'], io), 0);
  assert.ok(![...out, ...err].join('').includes('Private source prose')); assert.ok(![...out, ...err].join('').includes('do-not-print-this-error'));
  assert.equal(await runDecisionsCli(['ingest', '--from', '.nexus', '--ref', 'workflow:wf-1', '--apply'], io,
    () => { throw new Error('credential-value-do-not-print'); }), 1);
  assert.equal(err.join('').includes('credential-value-do-not-print'), false);
});

test('classifier parity optional decision type adds no decision key and preserves the existing corpus output byte for byte', () => {
  for (const row of CLASSIFIER_BASELINE) {
    const actual = classifyComposition(CompositionSignals.parse(row.signals));
    assert.equal('decision' in actual, false);
    assert.equal(createHash('sha256').update(JSON.stringify(actual)).digest('hex'), row.sha256, row.id);
  }
});

// All 23 rows of the existing Java/MCP parity corpus, copied as inputs plus fixed wire-byte
// fingerprints from agents-service/src/test/resources/composition/mcp-corpus.json before this leaf.
// The baseline is static: tests neither regenerate expected output nor depend on another checkout.
const CLASSIFIER_BASELINE = [
  {
    "id": "empty-both-undetermined",
    "signals": {},
    "sha256": "1e8d2c5be0dcd126aa41649316ab3c30f38208e7959a0cca70c33c4f2fa363f2"
  },
  {
    "id": "deterministic-only-provisional",
    "signals": {
      "deterministicSteps": [
        "fetch the changelog",
        "render the release note"
      ]
    },
    "sha256": "d303fdb0118d62522b83de87a2362028ef48590a47a8a4f09535ef16546355e8"
  },
  {
    "id": "deterministic-both-answered-recommended",
    "signals": {
      "deterministicSteps": [
        "fetch the changelog"
      ],
      "uncertainSteps": []
    },
    "sha256": "e708f0807e22bb0bd723cd3f0e465ffb26fd13675f97fbe7d25fa54454eafca4"
  },
  {
    "id": "uncertain-only-provisional",
    "signals": {
      "uncertainSteps": [
        "decide which probe to run next"
      ]
    },
    "sha256": "866a6b6c0718804c9dbd9ef8bc33addb209d9b751b1a37a64e27e37c11f0ad4e"
  },
  {
    "id": "uncertain-both-answered-recommended",
    "signals": {
      "deterministicSteps": [],
      "uncertainSteps": [
        "decide which probe to run next"
      ]
    },
    "sha256": "dc362b563f75cc2953c35d171dbbe114eef4648bbc867db90a160a7ce47c05df"
  },
  {
    "id": "hybrid",
    "signals": {
      "deterministicSteps": [
        "open the incident",
        "post the summary"
      ],
      "uncertainSteps": [
        "choose the next probe"
      ]
    },
    "sha256": "19596561bc09d21d4667108cae7170a39a93ca68b9a6da436166553c75685a65"
  },
  {
    "id": "surface-audience-only-internal-automation",
    "signals": {
      "expectedAudience": "single-operator"
    },
    "sha256": "a41ae4720622ee9316ba138065f736a1064bb3a8db335689680ffcf954b3bcf9"
  },
  {
    "id": "surface-conversational",
    "signals": {
      "expectedAudience": "team",
      "conversationalIntake": true
    },
    "sha256": "857e271c9ac498fc25b7043503013c5082601a38ee3c72da0b540341ed523e90"
  },
  {
    "id": "surface-widget",
    "signals": {
      "expectedAudience": "team",
      "sharedReviewInterface": true
    },
    "sha256": "9753d36632b8b5b92106611bc18fb7dd552aba25742520704022dba822b650cd"
  },
  {
    "id": "surface-application",
    "signals": {
      "expectedAudience": "team",
      "sharedDurableRecords": true,
      "sharedReviewInterface": true,
      "dedicatedInterfaceRequired": true
    },
    "sha256": "af9325caaf18966a905f2e2d3d8366d5137e5ee2d23fa92bdcab0fdcf8bcd2ed"
  },
  {
    "id": "surface-dedicated-without-shared-stays-put",
    "signals": {
      "expectedAudience": "team",
      "sharedReviewInterface": true,
      "dedicatedInterfaceRequired": true
    },
    "sha256": "9753d36632b8b5b92106611bc18fb7dd552aba25742520704022dba822b650cd"
  },
  {
    "id": "surface-solution",
    "signals": {
      "expectedAudience": "team",
      "sharedDurableRecords": true,
      "sharedReviewInterface": true,
      "independentlyUsefulArtifacts": 3
    },
    "sha256": "982de68cba85aff6d1a99993b1449cecbb3912859ffe0d52b86f7270e7f665bb"
  },
  {
    "id": "surface-system-of-record-caps-widget",
    "signals": {
      "expectedAudience": "team",
      "sharedReviewInterface": true,
      "sharedDurableRecords": true,
      "existingSystemOfRecord": true
    },
    "sha256": "70580044e8ece0d36db265800662105f7ecc3e56c6634f8b8f81ccea34ee93d6"
  },
  {
    "id": "surface-system-of-record-caps-with-chat",
    "signals": {
      "expectedAudience": "team",
      "sharedReviewInterface": true,
      "sharedDurableRecords": true,
      "conversationalIntake": true,
      "existingSystemOfRecord": true
    },
    "sha256": "06f1a37cf10aad6d7b0b801154765a7e105b8a3e4b096fde3eb9e223409e850b"
  },
  {
    "id": "surface-system-of-record-blocks-solution",
    "signals": {
      "expectedAudience": "team",
      "sharedReviewInterface": true,
      "sharedDurableRecords": true,
      "existingSystemOfRecord": true,
      "independentlyUsefulArtifacts": 4
    },
    "sha256": "70580044e8ece0d36db265800662105f7ecc3e56c6634f8b8f81ccea34ee93d6"
  },
  {
    "id": "surface-all-answered-recommended",
    "signals": {
      "expectedAudience": "external-customers",
      "sharedReviewInterface": true,
      "sharedDurableRecords": false,
      "conversationalIntake": false
    },
    "sha256": "86b1d952f83498cc84eefb6d7db3e970074c6d128415b06279b17cdb08449be7"
  },
  {
    "id": "full-signal-set",
    "signals": {
      "expectedAudience": "team",
      "recurringInteraction": true,
      "deterministicSteps": [
        "normalise the intake",
        "score it"
      ],
      "uncertainSteps": [
        "cluster the duplicates"
      ],
      "sharedDurableRecords": true,
      "sharedReviewInterface": true,
      "dedicatedInterfaceRequired": false,
      "conversationalIntake": false,
      "existingSystemOfRecord": false,
      "independentlyUsefulArtifacts": 2,
      "sources": [
        "support inbox",
        "issue tracker"
      ],
      "permissions": [
        "read the inbox",
        "write the ranking"
      ],
      "humanDecisions": [
        "accept or reject the merge"
      ],
      "outputTypes": [
        "ranked list"
      ],
      "budgetBoundary": "$2 per run",
      "timeBoundary": "10 minutes",
      "sideEffects": [
        "writes the ranking back to the tracker"
      ],
      "deploymentNeeds": [
        "internal network only"
      ]
    },
    "sha256": "d3b2e0f5d8f9ebb45168c8c5dcb2fbadf241c2acace0c42fb730b2a5832a9ba1"
  },
  {
    "id": "explicit-case-ids",
    "signals": {
      "deterministicSteps": [
        "publish"
      ],
      "expectedAudience": "team",
      "sharedReviewInterface": true,
      "caseStudyIds": [
        "S01",
        "S12"
      ]
    },
    "sha256": "8952e6e4f35363a60dc0f50f2a3c35e4270a7f7d370d4f7d68595772a4d9ba0a"
  },
  {
    "id": "unknown-case-id",
    "signals": {
      "deterministicSteps": [
        "publish"
      ],
      "expectedAudience": "team",
      "caseStudyIds": [
        "S99"
      ]
    },
    "sha256": "5449982bff81dc25f30cdd0cfe1a7fd173a1eaf8a4c62ebfefa66c9c0e4c1d50"
  },
  {
    "id": "execution-known-surface-undetermined",
    "signals": {
      "deterministicSteps": [
        "run the job"
      ],
      "uncertainSteps": []
    },
    "sha256": "cde700684a0ac1713ef7a9d781bcfca094b0ab2b5c539a487b0e76cae447dd49"
  },
  {
    "id": "surface-known-execution-undetermined",
    "signals": {
      "expectedAudience": "team",
      "conversationalIntake": true,
      "sharedReviewInterface": false,
      "sharedDurableRecords": false
    },
    "sha256": "334e1ec64833fcb4187bb4c4dd767bf9925223e2ebd0f24539ddf62901b8c8a4"
  },
  {
    "id": "recurring-only",
    "signals": {
      "recurringInteraction": false
    },
    "sha256": "73606f8cf9c70b08289bb414fb0c241321bd4496365e00a73d896322708dd9ca"
  },
  {
    "id": "artifacts-without-durable-records",
    "signals": {
      "expectedAudience": "team",
      "sharedReviewInterface": true,
      "independentlyUsefulArtifacts": 5
    },
    "sha256": "9753d36632b8b5b92106611bc18fb7dd552aba25742520704022dba822b650cd"
  }
];
