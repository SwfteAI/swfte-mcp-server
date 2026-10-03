import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SwfteClient, SwfteApiError } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { selectedConfidenceReportTools } from '../src/tools/selected-confidence-report.js';
import { allTools } from '../src/tools/index.js';
import { buildServer } from '../src/server.js';

// Authenticated transport/admission fixtures only. These are not native store,
// current artifact, calibration, canonical seal or signature execution evidence.
const runId = 'cr_owned/1';
const contentHash = 'a'.repeat(64);
const reportHash = 'b'.repeat(64);
const sectionIds = ['SUMMARY', 'WHAT_WAS_RUN', 'FINDINGS', 'COVERAGE_MAP', 'COMPLIANCE', 'PERFORMANCE_COST', 'BEHAVIOUR', 'CHANGES_SINCE', 'HOW_AND_WHY', 'CLAIMS_BOUNDARY'];
const dimensions = ['FUNCTION', 'COMPLETENESS', 'ROBUSTNESS', 'LOAD_COST', 'SECURITY', 'PRIVACY', 'COMPLIANCE', 'BEHAVIOUR'];
const excluded = new Set(['LOAD_COST', 'PRIVACY', 'BEHAVIOUR']);
function selected(): any {
  const result = {
    schemaVersion: '1',
    run: { runId, workspaceId: 'ws', artifactKind: 'WORKFLOW', artifactId: 'owned', contentHash, environment: 'SANDBOX', profile: 'QUICK', frameworks: [], seed: 1,
      budget: { persona: 1, systemUnderTest: 1, report: .1, maxSteps: 200 }, status: 'COMPLETE', engineVersion: 'actual-engine-v1', calibrationVersion: null,
      modelSnapshot: [], cassetteHead: null, startedAt: '2026-10-02T12:00:00.123456789Z', finishedAt: '2026-10-02T12:00:01Z' },
    claims: [], completeness: { covered: 0, applicable: 1, uncovered: [{ elementId: 'native-node', dimension: 'FUNCTION', reason: 'NOT_EXERCISED' }], inapplicable: [] }, findings: [],
    summary: { overall: 'UNKNOWN', headline: 'NOTHING_FAILED_SOME_UNTESTED',
      dimensions: dimensions.map(dimension => ({ dimension, verdict: 'UNKNOWN', passCount: 0, failCount: 0, unknownCount: excluded.has(dimension) ? 0 : 1, mandatory: !excluded.has(dimension) })),
      completenessCovered: 0, completenessApplicable: 1, unknownCount: 5, openCriticalFindings: 0, lastRunAt: '2026-10-02T12:00:01Z', evidenceLevel: 'NONE' },
    futureResult: { retained: true },
  };
  return { runId, selectedSeq: 0, storedRevision: 7, artifactKind: 'WORKFLOW', artifactId: 'owned', contentHash, availableVersion: null, result,
    rawReport: { runId, contentHash, generatedAt: '2026-10-02T12:00:02.123456789Z', baselineContentHash: null,
      sections: sectionIds.map(id => ({ id, title: id, markdown: '', data: { fixtureBoundary: 'TRANSPORT_ONLY' } })),
      unknowns: dimensions.filter(d => !excluded.has(d)).map(dimension => ({ elementId: dimension === 'FUNCTION' ? 'native-node' : '*', dimension, reason: 'NOT_EXERCISED', title: 'Unexercised', detail: 'No native execution asserted by this fixture.' })),
      droppedSentences: [], claimsBoundary: 'Supports your audit; not an audit opinion.', reportHash, futureSealExtension: { retained: true } },
    reportHash, reportIntegrity: 'CANONICAL_HASH_VERIFIED', signatureStatus: 'UNSIGNED', signatureValidation: 'UNAVAILABLE', futureSelected: { retained: true } };
}
function judged(): any {
  const body = selected();
  const result = body.result;
  result.claims = [{ dimension: 'FUNCTION', elementId: 'native-node', verdict: 'PASS', statedConfidence: .8, interval: null,
    evidenceRefs: [{ kind: 'EXEC_LOG', hash: 'c'.repeat(64) }], dependsOn: [], stale: false }];
  result.completeness = { covered: 1, applicable: 1, uncovered: [], inapplicable: [] };
  result.summary.dimensions[0] = { dimension: 'FUNCTION', verdict: 'PASS', passCount: 1, failCount: 0, unknownCount: 0, mandatory: true };
  result.summary.completenessCovered = 1;
  result.summary.unknownCount = 4;
  result.run.calibrationVersion = 'reviewed-calibration-v1';
  return body;
}
type Call = { method: string; path: string; body: string; headers: Record<string, unknown> };
type Reply = { body?: unknown; status?: number; raw?: string };
async function fixture(run: (client: SwfteClient, calls: Call[]) => Promise<void>, reply: (call: Call) => Reply) {
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    const call = { method: req.method!, path: req.url!, body, headers: { ...req.headers } };
    calls.push(call);
    const response = reply(call);
    res.writeHead(response.status ?? 200, { 'content-type': 'application/json' });
    res.end(response.raw ?? JSON.stringify(response.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = loadConfig({ SWFTE_PAT: 'pat_test', SWFTE_BASE_URL: `http://127.0.0.1:${address.port}`, SWFTE_WORKSPACE_ID: 'ws', SWFTE_TELEMETRY: '0' } as never);
  try { await run(new SwfteClient(config), calls); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
async function executeWire(client: SwfteClient, input: any = { runId, seq: 0 }) {
  const tool = selectedConfidenceReportTools.find(t => t.name === 'swfte_prove_selected_report'); assert.ok(tool);
  return tool.execute(tool.inputSchema.parse(input), { client, config: loadConfig({ SWFTE_PAT: 'pat_test' } as never) });
}
async function execute(client: SwfteClient, input: any = { runId, seq: 0 }) {
  const wire = await executeWire(client, input);
  assert.equal(typeof wire, 'string');
  return JSON.parse(wire as string);
}
const identity = { workspaceId: 'ws', actorId: 'person:7' };
const response = (body: unknown = selected()) => (call: Call): Reply => ({ body: call.path === '/v2/confidence/identity' ? identity : body });

test('selected report is mounted once as a read-only runtime tool', () => {
  const mounted = allTools.filter(t => t.name === 'swfte_prove_selected_report');
  assert.equal(mounted.length, 1); assert.equal(mounted[0]!.group, 'runtime'); assert.equal(mounted[0]!.readOnly, true);
});
test('one authenticated selected GET retains honest UNKNOWN, explicit null version and additive fields', () => {
  const body = selected();
  return fixture(async (client, calls) => {
    const actual: any = await execute(client);
    assert.deepEqual(actual, body); assert.equal(actual.availableVersion, null); assert.equal(actual.result.summary.overall, 'UNKNOWN');
    assert.deepEqual(actual.rawReport.futureSealExtension, { retained: true }); assert.equal(actual.signatureValidation, 'UNAVAILABLE');
    assert.deepEqual(calls.map(c => [c.method, c.path]), [['GET', '/v2/confidence/identity'], ['GET', `/v2/confidence/runs/${encodeURIComponent(runId)}/selected-report?seq=0`]]);
    for (const call of calls) { assert.equal(call.headers.authorization, 'Bearer pat_test'); assert.equal(call.headers['x-actor-id'], undefined); assert.equal(call.body, ''); }
  }, response(body));
});
test('exact current-content and native-version guards go to the coherent provider without legacy reads', () => {
  const body = selected(); body.availableVersion = 'draft:version-7';
  return fixture(async (client, calls) => {
    const actual: any = await execute(client, { runId, seq: 3, expectedContentHash: contentHash, expectedAvailableVersion: body.availableVersion });
    assert.equal(actual.selectedSeq, 3); assert.equal(calls.length, 2);
    const path = new URL(calls[1]!.path, 'http://fixture');
    assert.equal(path.searchParams.get('seq'), '3'); assert.equal(path.searchParams.get('expectedContentHash'), contentHash); assert.equal(path.searchParams.get('expectedAvailableVersion'), body.availableVersion);
    assert.equal(path.pathname, `/v2/confidence/runs/${encodeURIComponent(runId)}/selected-report`);
  }, call => response({ ...body, selectedSeq: 3 })(call));
});
test('unverified or foreign identity refuses BEFORE the selected provider call', async () => {
  for (const owner of [{ workspaceId: 'foreign', actorId: 'person:7' }, { workspaceId: 'ws', actorId: ' ' }, {}, null]) {
    await fixture(async (client, calls) => { await assert.rejects(execute(client)); assert.equal(calls.length, 1); assert.equal(calls[0]!.path, '/v2/confidence/identity'); }, () => ({ body: owner }));
  }
});
test('selected run sequence artifact workspace and raw report links are checked against their real pair', async () => {
  const changes: ((body: any) => void)[] = [body => body.runId = 'other', body => body.selectedSeq = 1,
    body => body.result.run.workspaceId = 'foreign', body => body.result.run.runId = 'other', body => body.artifactKind = 'AGENT', body => body.artifactId = 'other',
    body => body.contentHash = 'c'.repeat(64), body => body.rawReport.runId = 'other', body => body.rawReport.contentHash = 'c'.repeat(64), body => body.rawReport.reportHash = 'c'.repeat(64)];
  for (const change of changes) { const body = selected(); change(body);
    await fixture(async (client, calls) => { await assert.rejects(execute(client), /BINDING_MISMATCH/); assert.equal(calls.length, 2); assert.ok(calls.every(c => c.method === 'GET')); }, response(body));
  }
});
test('expected guards refuse wrong current hash, changed version and explicit null version', async () => {
  for (const input of [{ runId, seq: 0, expectedContentHash: 'c'.repeat(64) }, { runId, seq: 0, expectedAvailableVersion: 'version-7' }]) {
    await fixture(async (client, calls) => { await assert.rejects(execute(client, input), /SELECTED_CONFIDENCE_BINDING_MISMATCH/); assert.equal(calls.length, 2); }, response());
  }
  const body = selected(); body.availableVersion = 'version-8';
  await fixture(async (client) => { await assert.rejects(execute(client, { runId, seq: 0, expectedAvailableVersion: 'version-7' }), /SELECTED_CONFIDENCE_BINDING_MISMATCH/); }, response(body));
});
test('missing nullable version and invalid durable revision are not normalized into valid identity', async () => {
  const changes: ((body: any) => void)[] = [body => { delete body.availableVersion; }, body => body.availableVersion = ' ', body => body.storedRevision = -1,
    body => body.storedRevision = 1.5, body => body.storedRevision = Number.MAX_SAFE_INTEGER + 1, body => body.selectedSeq = -1];
  for (const change of changes) { const body = selected(); change(body);
    await fixture(async (client, calls) => { await assert.rejects(execute(client)); assert.equal(calls.length, 2); }, response(body));
  }
});
test('every report section is required once in exact canonical order', async () => {
  for (const change of [(b: any) => b.rawReport.sections.pop(), (b: any) => b.rawReport.sections.push(b.rawReport.sections[0]),
    (b: any) => b.rawReport.sections.reverse(), (b: any) => b.rawReport.sections[1] = b.rawReport.sections[0]]) {
    const body = selected(); change(body);
    await fixture(async (client, calls) => { await assert.rejects(execute(client), /SELECTED_CONFIDENCE_REPORT_NOT_READY/); assert.equal(calls.length, 2); }, response(body));
  }
});
test('native nanosecond report time and nullable dropped sentences retain their wire shape; malformed time refuses', async () => {
  for (const omit of [false, true]) {
    const body = selected(); if (omit) delete body.rawReport.droppedSentences; else body.rawReport.droppedSentences = null;
    body.rawReport.generatedAt = '2026-10-02T12:00:02.123456789Z';
    await fixture(async (client) => {
      const actual: any = await execute(client);
      assert.deepEqual(actual, body); assert.equal(actual.rawReport.generatedAt, '2026-10-02T12:00:02.123456789Z');
    }, response(body));
  }
  for (const time of ['not-an-instant', '2026-02-30T12:00:02Z', '2026-10-02', '2026-10-02T12:00:02.1234567890Z']) {
    const body = selected(); body.rawReport.generatedAt = time;
    await fixture(async (client, calls) => { await assert.rejects(execute(client)); assert.equal(calls.length, 2); }, response(body));
  }
});
test('a correctly projected running result cannot be served as a ready selected report', () => {
  const body = selected(); body.result.run.status = 'RUNNING'; body.result.run.finishedAt = null;
  body.result.summary.headline = 'IN_PROGRESS'; body.result.summary.lastRunAt = body.result.run.startedAt;
  return fixture(async (client) => { await assert.rejects(execute(client), /SELECTED_CONFIDENCE_REPORT_NOT_READY/); }, response(body));
});
test('real result projection rejects label-only PASS and uncalibrated judged point; paired calibrated projection remains UNKNOWN', async () => {
  const calibrated = judged();
  await fixture(async (client) => { const actual: any = await execute(client); assert.equal(actual.result.run.calibrationVersion, 'reviewed-calibration-v1'); assert.equal(actual.result.summary.overall, 'UNKNOWN'); }, response(calibrated));
  const label = selected(); label.result.summary.overall = 'PASS';
  const uncalibrated = judged(); uncalibrated.result.run.calibrationVersion = null;
  for (const body of [label, uncalibrated]) await fixture(async (client, calls) => { await assert.rejects(execute(client), /CONFIDENCE_RESULT_PROJECTION_INVALID/); assert.equal(calls.length, 2); }, response(body));
});
test('signature status stays honest and unsupported external validation never becomes accepted', async () => {
  const body = selected(); body.signatureStatus = 'UNVERIFIED'; body.rawReport.signature = { keyId: 'unvalidated-key', signature: 'not-checked' };
  await fixture(async (client) => { assert.deepEqual(await execute(client), body); }, response(body));
  for (const change of [(b: any) => b.signatureStatus = 'VERIFIED', (b: any) => b.signatureValidation = 'VALIDATED', (b: any) => b.reportIntegrity = 'CLIENT_LABEL']) {
    const invalid = selected(); change(invalid); await fixture(async (client) => { await assert.rejects(execute(client)); }, response(invalid));
  }
});
test('provider auth absence conflict and outage propagate once without retry or result/report fallback', async () => {
  for (const status of [401, 403, 404, 409, 429, 503]) await fixture(async (client, calls) => {
    await assert.rejects(execute(client), (error: unknown) => error instanceof SwfteApiError && error.status === status);
    assert.equal(calls.length, 2); assert.equal(calls[1]!.path, `/v2/confidence/runs/${encodeURIComponent(runId)}/selected-report?seq=0`);
  }, call => call.path === '/v2/confidence/identity' ? { body: identity } : { status, body: { code: 'UNAVAILABLE' } });
});
test('identity outage causes no provider read and malformed selected JSON causes no fallback', async () => {
  await fixture(async (client, calls) => { await assert.rejects(execute(client), SwfteApiError); assert.equal(calls.length, 1); }, () => ({ status: 503, body: { code: 'UNAVAILABLE' } }));
  await fixture(async (client, calls) => { await assert.rejects(execute(client)); assert.equal(calls.length, 2); }, call => call.path === '/v2/confidence/identity' ? { body: identity } : { raw: '{broken' });
});
test('opaque native run identity and exact nonnegative safe sequence are rejected before any HTTP', async () => {
  const badInputs = [{ runId, seq: -1 }, { runId, seq: .5 }, { runId, seq: Number.MAX_SAFE_INTEGER + 1 }, { runId },
    ...['', ' ', '..', 'x/../y', '/absolute', 'https://external', 'x?query', 'x#fragment', 'x%2Fpath', 'x'.repeat(201)].map(id => ({ runId: id, seq: 0 })),
    { runId, seq: 0, actorId: 'person:7' }];
  await fixture(async (client, calls) => { for (const input of badInputs) await assert.rejects(execute(client, input)); assert.equal(calls.length, 0); }, response());
});

test('selected report retains exact additive numeric values and lexemes through registered tools/call', async () => {
  const body = selected();
  body.rawReport.precisionProbe = { integer: '__INTEGER__', decimal: '__DECIMAL__', exponent: '__EXPONENT__', stringNumber: '9223372036854775807' };
  const raw = '\n  ' + JSON.stringify(body).replace('"__INTEGER__"', '9223372036854775807')
    .replace('"__DECIMAL__"', '0.123456789012345678901234567890')
    .replace('"__EXPONENT__"', '9.223372036854775807e18') + '\n';
  // The old parse/stringify path changes numeric VALUE; the expected text comes
  // from the HTTP bytes, never from a parsed fixture or a replacement seal.
  const rounded = JSON.parse(raw);
  assert.notEqual(String(rounded.rawReport.precisionProbe.integer), '9223372036854775807');
  assert.notEqual(JSON.stringify(rounded), raw.trim());
  await fixture(async (client, calls) => {
    const actual = await executeWire(client);
    assert.equal(actual, raw); assert.equal(calls.length, 2);
    assert.ok((actual as string).includes('"integer":9223372036854775807'));
    assert.ok((actual as string).includes('"decimal":0.123456789012345678901234567890'));
    assert.ok((actual as string).includes('"exponent":9.223372036854775807e18'));
    assert.ok((actual as string).includes('"stringNumber":"9223372036854775807"'));
    assert.ok((actual as string).includes('"reportHash":"' + reportHash + '"'));
  }, call => call.path === '/v2/confidence/identity' ? { body: identity } : { raw });
  await fixture(async (client, calls) => {
    const config = loadConfig({ SWFTE_PAT: 'pat_test', SWFTE_TELEMETRY: '0' } as never);
    const server = buildServer({ config, resolveClient: () => client });
    try {
      const handler = (server as any)._requestHandlers.get('tools/call'); assert.ok(handler);
      const actual = await handler({ method: 'tools/call', params: { name: 'swfte_prove_selected_report', arguments: { runId, seq: 0 } } }, {});
      assert.equal(actual.isError, undefined); assert.equal(actual.content[0].type, 'text'); assert.equal(actual.content[0].text, raw);
      assert.equal(calls.length, 2); assert.ok(calls.every(call => call.method === 'GET'));
    } finally { await server.close(); }
  }, call => call.path === '/v2/confidence/identity' ? { body: identity } : { raw });
});

test('endpoint raw transport refuses empty malformed and oversized response without retry or fallback', async () => {
  for (const raw of ['', '{broken', '\ufeff' + JSON.stringify(selected()), JSON.stringify({ ...selected(), padding: 'x'.repeat(1024 * 1024) })]) {
    await fixture(async (client, calls) => {
      await assert.rejects(executeWire(client), (error: unknown) => error instanceof SwfteApiError
        && ['SELECTED_REPORT_JSON_INVALID', 'RESPONSE_LIMIT_EXCEEDED'].includes(error.code));
      assert.equal(calls.length, 2); assert.ok(calls.every(call => call.method === 'GET'));
    }, call => call.path === '/v2/confidence/identity' ? { body: identity } : { raw });
  }
});

test('ordinary JSON request behavior and parsed selected admission remain distinct from raw output', async () => {
  await fixture(async (client, calls) => {
    assert.deepEqual(await client.request({ method: 'GET', path: '/ordinary-json', retries: 0 }), { retained: 7 });
    assert.equal(calls.length, 1);
  }, () => ({ body: { retained: 7 } }));
  const body = selected(); body.rawReport.precisionProbe = '__INTEGER__'; body.artifactId = 'other';
  const raw = JSON.stringify(body).replace('"__INTEGER__"', '9223372036854775807');
  await fixture(async (client, calls) => {
    await assert.rejects(executeWire(client), /SELECTED_CONFIDENCE_BINDING_MISMATCH/); assert.equal(calls.length, 2);
  }, call => call.path === '/v2/confidence/identity' ? { body: identity } : { raw });
});
