import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { zipSync } from 'fflate';
import { SwfteClient, SwfteApiError, OperationDeadlineError } from '../src/client.js';
import { reviewTools, REVIEW_KINDS } from '../src/tools/review.js';
import { releaseTools } from '../src/tools/releases.js';
import type { ToolContext } from '../src/tools/_types.js';
import type { ServerConfig } from '../src/config.js';

const contentHash = `sha256:${'a'.repeat(64)}`;
const planHash = `sha256:${'b'.repeat(64)}`;
const all = [...reviewTools, ...releaseTools];
function harness(name: string, reply: unknown, authority?: unknown) {
  const calls: any[] = [];
  const tool = all.find(t => t.name === name)!;
  assert.ok(tool);
  const ctx = { config: config(), client: { request: async (request: unknown) => { calls.push(request); if (name === 'swfte_release_propose_ramp' && (request as any).method === 'GET') { assert.ok(authority, 'Declared full native release authority required'); return authority; } return reply; } } } as unknown as ToolContext;
  return { calls, run: (input: unknown) => tool.execute(tool.inputSchema.parse(input), ctx) };
}

describe('exact-hash review and release MCP contracts', () => {
  test('room alias refuses incomplete historical evidence rather than trusting unsigned shape', async () => {
    const h = harness('swfte_review_room', { packet: null, reason: 'HISTORICAL_PACKET_UNAVAILABLE' });
    await assert.rejects(h.run({ actionId: 'act:a-1', contentHash }), code('REVIEW_ROOM_BINDING_INVALID'));
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].retries, 0);
  });
  test('hash prefixes and unknown workspace override cannot reach the client', () => {
    for (const bad of ['a'.repeat(12), 'sha256:'+ 'G'.repeat(64), 'latest', '']) {
      const h = harness('swfte_review_room', {});
      assert.throws(() => h.run({ actionId: 'a', contentHash: bad })); assert.equal(h.calls.length, 0);
    }
    const h = harness('swfte_release_pause', {});
    assert.throws(() => h.run({ releaseId: 'r', expectedContentHash: contentHash, expectedPlanHash: planHash, trigger: 'operator', workspaceId: 'foreign' }));
    assert.equal(h.calls.length, 0);
  });
  test('a final newline cannot extend an exact hash on any review or release input', () => {
    for (const name of ['swfte_open_review_room', 'swfte_review_room', 'swfte_assemble_proof_bundle', 'swfte_export_proof_bundle', 'swfte_proof_bundle']) {
      const h = harness(name, {});
      const input = name.includes('room') ? { actionId: 'action', contentHash: contentHash+'\n' }
        : { kind: 'workflow', artifactId: 'artifact', contentHash: contentHash+'\n', ...(name.includes('export') ? { platform: 'vanta', documentId: 'document' } : {}) };
      assert.throws(() => h.run(input)); assert.equal(h.calls.length, 0);
    }
    for (const name of ['swfte_release_pause', 'swfte_release_rollback', 'swfte_release_propose_ramp']) {
      for (const field of ['expectedContentHash', 'expectedPlanHash']) {
        const h = harness(name, {});
        const input = { releaseId: 'release-1', expectedContentHash: contentHash, expectedPlanHash: planHash,
          ...(name.endsWith('ramp') ? { desiredStage: 'AB', candidateWeight: 5000 } : { trigger: 'operator' }) };
        assert.throws(() => h.run({ ...input, [field]: input[field as 'expectedContentHash' | 'expectedPlanHash']+'\n' }));
        assert.equal(h.calls.length, 0);
      }
    }
  });
  test('ramp calls only propose-next-step and preserves both hashes in presented action', async () => {
    const action = { id: 'act_r', capability: 'release.ramp', target: { kind: 'model', id: 'm' }, params: { releaseId: 'r', stage: 'AB', candidateWeight: '5000', planHash }, environment: 'production', status: 'PROPOSED', requiresApproval: true, contentHash, planHash };
    const h = harness('swfte_release_propose_ramp', action, { ...statusWire('MODEL'), artifactId: 'm', candidate: { ...statusWire().candidate, contentHash } });
    const result = await h.run({ releaseId: 'r', expectedContentHash: contentHash, expectedPlanHash: planHash, desiredStage: 'AB', candidateWeight: 5000 }) as any;
    assert.equal(h.calls.length, 2); assert.equal(h.calls[0].path, '/v2/releases/r'); assert.equal(h.calls[0].method, 'GET');
    assert.equal(h.calls[1].path, '/v2/releases/r/propose-next-step'); assert.equal(h.calls[1].retries, 0); assert.equal(result.changesTraffic, false);
    assert.equal(result.contentHash, contentHash); assert.equal(result.planHash, planHash);
    assert.match(result.instructions, /Pending human approval/);
  });
  test('mismatched proposal response is refused', async () => {
    const h = harness('swfte_release_propose_ramp', { contentHash, planHash: `sha256:${'c'.repeat(64)}` }, { ...statusWire(), candidate: { ...statusWire().candidate, contentHash } });
    await assert.rejects(h.run({ releaseId: 'r', expectedContentHash: contentHash, expectedPlanHash: planHash, desiredStage: 'AB', candidateWeight: 5000 }), code('RELEASE_PROPOSAL_UNCONFIRMED'));
  });
  test('safe-direction controls are exact-hash calls with no action creation or retry', async () => {
    for (const name of ['pause', 'rollback']) {
      const h = harness(`swfte_release_${name}`, { releaseId: 'r', ledgerSeq: 3, stage: name === 'pause' ? 'PAUSED' : 'ROLLED_BACK', candidateWeight: 0 });
      await h.run({ releaseId: 'r', expectedContentHash: contentHash, expectedPlanHash: planHash, trigger: 'operator' });
      assert.equal(h.calls[0].path, `/v2/releases/r/${name}`); assert.equal(h.calls[0].retries, 0);
      assert.deepEqual(h.calls[0].body, { expectedContentHash: contentHash, expectedPlanHash: planHash, trigger: 'operator' });
    }
  });
  test('underpowered and mismatch source facts pass through without invented metrics', async () => {
    for (const reply of [{ withheld: 'ALLOCATION_MISMATCH', primary: null }, { underpowered: true, primary: { outcome: 'INCONCLUSIVE_UNDERPOWERED' } }]) {
      const full = { ...summaryWire(), ...reply, ...(reply.primary ? { primary: { ...summaryWire().primary, ...reply.primary } } : {}) };
      const h = harness('swfte_release_report', full);
      assert.deepEqual(await h.run({ releaseId: 'r' }), full);
    }
  });
  test('no new tool grants a decision or direct step-up', () => {
    assert.equal(all.some(t => /approve|execute|direct_ramp/.test(t.name)), false);
    for (const t of reviewTools) assert.equal(t.readOnly, false);
    for (const t of all.filter(t=>t.name==='swfte_review_room'||t.name==='swfte_proof_bundle')) assert.equal(t.group, 'extras');
    assert.equal(releaseTools.filter(t=>/propose/.test(t.name)).length, 1);
  });
});

// Local ephemeral fixture key: this tests the real client/crypto seam, never a vendor or backend runtime.
const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const keyId = `sha256:${sha(keyPair.publicKey.export({ type: 'spki', format: 'der' }))}`;
const order = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
function fixtureJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(fixtureJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${fixtureJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function integer(value: bigint): Buffer {
  let text = value.toString(16); if (text.length % 2) text = `0${text}`;
  let bytes = Buffer.from(text, 'hex'); if (bytes[0]! >= 128) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([2, bytes.length]), bytes]);
}
function lowSignature(signature: Buffer): Buffer {
  const rLength = signature[3]!;
  const r = BigInt(`0x${signature.subarray(4, 4 + rLength).toString('hex')}`);
  const s = BigInt(`0x${signature.subarray(6 + rLength).toString('hex')}`);
  const encoded = Buffer.concat([integer(r), integer(s > order / 2n ? order - s : s)]);
  return Buffer.concat([Buffer.from([0x30, encoded.length]), encoded]);
}
const definition = Buffer.from('{"kind":"local-test","value":"unchanged subject"}');
const fixtureHash = `sha256:${sha(definition)}`;
const verifyLine = 'cosign verify-blob-attestation --key public.pem --signature envelope.json --type https://swfte.dev/proof-bundle/v1 --offline --insecure-ignore-tlog subject.json\n';
function signedFixture(kind: string = 'workflow', change: (statement: any) => void = () => {}, throughSeq = 1) {
  const absent = { status: 'absent', reason: 'SOURCE_RUNTIME_UNAVAILABLE' };
  const statement: any = { _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://swfte.dev/proof-bundle/v1',
    subject: [{ name: `${kind}:artifact`, digest: { sha256: fixtureHash.slice(7) } }],
    predicate: { artifact: { kind, id: 'artifact', version: 'content-hash', contentHash: fixtureHash, workspace: 'ws_a' },
      assembledThroughLedgerSeq: throughSeq, confidence: absent, controlEvidence: absent, securityProbes: absent,
      approvals: absent, stakeholders: absent, promotions: absent, runs: absent, contributors: {} } };
  change(statement);
  const payload = Buffer.from(fixtureJson(statement));
  const type = 'application/vnd.in-toto+json';
  const pae = Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `), payload]);
  const signature = lowSignature(sign('sha256', pae, keyPair.privateKey));
  const root = { payloadType: type, payload: payload.toString('base64'), signatures: [{ keyid: keyId, sig: signature.toString('base64') }] };
  return { bytes: Buffer.from(fixtureJson(root)), root, statement };
}
function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { baseUrl: 'https://api.swfte.test/agents', credential: 'pat_local_fixture', credentialKind: 'pat', workspaceId: 'ws_a',
    userAgent: 'local-review-test', debug: false, enabledGroups: new Set(), allowDeploy: false, defaultWaitMs: 1000, telemetry: false, ...overrides };
}
function jsonReply(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function binaryReply(bytes: Uint8Array, current = true, contentType = 'application/json'): Response {
  return new Response(Buffer.from(bytes), { headers: { 'Content-Type': contentType, ...(current ? { 'X-Bundle-Version': '2' } : {}) } });
}
function roomReply(id: string) { return { contentHash: fixtureHash, action: { id, kind: 'workflow', artifactId: 'artifact', capability: 'workflow.deploy', contentHash: fixtureHash, planHash,
  currentContentStatus: 'available', currentContentHash: fixtureHash, currentPlanStatus: 'available', currentPlanHash: planHash,
  packetStatus: 'absent', decisionDependency: 'exact reviewed packet snapshot' }, stale: false, staleReason: null, packet: null,
  reports: ['confidence', 'security', 'privacy', 'compliance', 'performance-cost', 'behaviour', 'what-changed', 'release-plan', 'stakeholders']
    .map(key => ({ key, status: 'absent', contentHash: fixtureHash, facts: {}, reason: key === 'confidence' ? 'CONFIDENCE_RUNTIME_UNAVAILABLE' : 'SOURCE_REPORT_UNAVAILABLE' })),
  proofSuiteAvailable: false, reviewRequirements: { noteRequired: false, highRiskAcknowledgementRequired: false, unrunHighRiskScenarios: [], dealbreakerHit: false,
    stakeholderStatus: 'dependency_unavailable', proofSuiteStatus: 'dependency_unavailable' } }; }
async function localClient(name: string, responses: (Response | (() => Promise<Response>))[], input: unknown, inspect: (result: any, calls: { url: URL; init: RequestInit }[]) => void, cfg = config()) {
  const originalFetch = globalThis.fetch;
  const calls: { url: URL; init: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(String(url)), init: init ?? {} });
    const response = responses.shift(); assert.ok(response, 'Unexpected HTTP request');
    return typeof response === 'function' ? response() : response;
  };
  try {
    const tool = all.find(t => t.name === name)!; assert.ok(tool);
    const ctx = { client: new SwfteClient(cfg), config: cfg };
    const result = await tool.execute(tool.inputSchema.parse(input), ctx);
    inspect(result, calls); assert.equal(responses.length, 0);
  } finally { globalThis.fetch = originalFetch; }
}
const assembleInput = { kind: 'workflow', artifactId: 'artifact', contentHash: fixtureHash };
const versionsReply = () => jsonReply([{ bundleVersion: '1', keyId }, { bundleVersion: '2', keyId }]);
const keyReply = () => jsonReply({ keyId, publicKey: pem });
function receipt(bytes: Uint8Array, overrides = {}) { return { platform: 'vanta', documentId: 'document', uploadReference: 'local-item', envelopeDigest: sha(bytes), idempotencyKey: `${fixtureHash}:1`, status: 'submitted', ...overrides }; }
function packageBytes(bytes: Uint8Array, changes: Record<string, Uint8Array> = {}) { return zipSync({ 'envelope.json': bytes, 'subject.json': definition,
  'public.pem': Buffer.from(pem), 'VERIFY.txt': Buffer.from(verifyLine), ...changes }); }
function code(expected: string) { return (error: unknown) => error instanceof SwfteApiError && error.code === expected; }
function privatePemFixtures(): string[] {
  const pkcs8 = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const sec1 = keyPair.privateKey.export({ type: 'sec1', format: 'pem' }).toString();
  const encrypted = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'local-ephemeral-fixture-only' }).toString();
  return [pkcs8, sec1, encrypted, pkcs8.replaceAll('PRIVATE KEY', 'PUBLIC KEY'), sec1.replaceAll('EC PRIVATE KEY', 'PUBLIC KEY'), pem + pkcs8];
}

describe('original review MCP outcomes through actual SwfteClient', { concurrency: false }, () => {
  test('original names are core and aliases remain extras with truthful non-readOnly annotations', () => {
    for (const name of ['swfte_open_review_room', 'swfte_assemble_proof_bundle', 'swfte_export_proof_bundle']) {
      const tool = all.find(t => t.name === name)!; assert.ok(tool); assert.equal(tool.group, 'core'); assert.equal(tool.readOnly, false);
    }
    assert.deepEqual(reviewTools.filter(t => t.group === 'extras').map(t => t.name).sort(), ['swfte_proof_bundle', 'swfte_review_room']);
  });
  test('open uses the frozen existing exact-packet route without claiming a full room or human view', async () => {
    await localClient('swfte_open_review_room', [jsonReply(roomReply('action:a-1'))], { actionId: 'action:a-1', contentHash: fixtureHash }, (result, calls) => {
      const url = new URL(result.url); assert.equal(url.pathname, '/v2/studio/review/workflow/artifact');
      assert.equal(url.searchParams.get('action'), 'action:a-1'); assert.equal(url.searchParams.get('hash'), fixtureHash);
      assert.equal(result.linkKind, 'exact-packet'); assert.equal(result.fullReviewRoomAvailable, false);
      assert.equal(result.humanViewRecorded, false); assert.equal(result.room.packet, null); assert.equal(result.room.proofSuiteAvailable, false);
      assert.equal(result.room.reports[0].reason, 'CONFIDENCE_RUNTIME_UNAVAILABLE');
      assert.equal(calls.length, 1); assert.equal(calls[0]!.init.method, 'GET'); assert.equal(calls[0]!.url.pathname, '/agents/v2/review/action%3Aa-1');
      assert.equal(calls[0]!.url.searchParams.get('hash'), fixtureHash);
      assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer pat_local_fixture');
      assert.equal((calls[0]!.init.headers as Record<string, string>)['X-Workspace-ID'], undefined);
    });
  });
  test('open refuses changed room, action, packet and report bindings', async () => {
    for (const changed of [ { contentHash }, { action: { ...roomReply('action').action, id: 'different' } },
      { action: { ...roomReply('action').action, contentHash } }, { action: { ...roomReply('action').action, planHash: 'sha256:bad' } }, { reports: [{ contentHash }] },
      { packet: { kind: 'workflow', id: 'artifact', contentHash } } ]) {
      await assert.rejects(localClient('swfte_open_review_room', [jsonReply({ ...roomReply('action'), ...changed })], { actionId: 'action', contentHash: fixtureHash }, () => {}), code('REVIEW_ROOM_BINDING_INVALID'));
    }
  });
  test('invalid action segments are rejected by core and alias before any HTTP read', () => {
    for (const name of ['swfte_open_review_room', 'swfte_review_room']) {
      for (const actionId of ['', 'a/b', 'a?view=true', '.', '..', '_a', ' a', 'a ', 'a\n', 'a'.repeat(201)]) {
        const h = harness(name, {});
        assert.throws(() => h.run({ actionId, contentHash: fixtureHash }));
        assert.equal(h.calls.length, 0);
      }
    }
  });
  test('the actual 200 character action boundary remains supported', async () => {
    const actionId = 'a'.repeat(200);
    await localClient('swfte_open_review_room', [jsonReply(roomReply(actionId))], { actionId, contentHash: fixtureHash }, (result, calls) => {
      assert.equal(calls.length, 1); assert.equal(new URL(result.url).searchParams.get('action'), actionId);
    });
  });
  test('every mandatory currentness fact must be present before an exact packet link', async () => {
    for (const field of ['currentContentStatus', 'currentContentHash', 'currentPlanStatus', 'currentPlanHash', 'packetStatus', 'decisionDependency']) {
      const room: any = roomReply('action'); delete room.action[field];
      await assert.rejects(localClient('swfte_open_review_room', [jsonReply(room)], { actionId: 'action', contentHash: fixtureHash }, () => {}), code('REVIEW_ROOM_BINDING_INVALID'));
    }
  });
  test('contradictory current hashes, plan/packet states and unexplained drift refuse binding', async () => {
    for (const action of [ { currentContentStatus: 'absent' }, { currentContentHash: null },
      { currentContentStatus: 'dependency_unavailable', currentContentHash: fixtureHash },
      { currentPlanStatus: 'not_applicable' }, { currentPlanHash: null },
      { currentPlanStatus: 'dependency_unavailable', currentPlanHash: planHash },
      { packetStatus: 'available' }, { decisionDependency: '' }, { currentContentHash: contentHash },
      { currentPlanHash: contentHash }, { capability: undefined } ]) {
      const room = { ...roomReply('action'), action: { ...roomReply('action').action, ...action } };
      await assert.rejects(localClient('swfte_open_review_room', [jsonReply(room)], { actionId: 'action', contentHash: fixtureHash }, () => {}), code('REVIEW_ROOM_BINDING_INVALID'));
    }
    for (const changed of [{ stale: true }, { staleReason: 'unexplained' }]) {
      await assert.rejects(localClient('swfte_open_review_room', [jsonReply({ ...roomReply('action'), ...changed })], { actionId: 'action', contentHash: fixtureHash }, () => {}), code('REVIEW_ROOM_BINDING_INVALID'));
    }
  });
  test('explained unavailable current facts and nonapplicable plan remain explicit without human authority', async () => {
    for (const action of [ { currentContentStatus: 'dependency_unavailable', currentContentHash: null, decisionDependency: 'authoritative current content hash' },
      { currentPlanStatus: 'dependency_unavailable', currentPlanHash: null, decisionDependency: 'authoritative current release plan hash' },
      { planHash: null, currentPlanStatus: 'not_applicable', currentPlanHash: null },
      { capability: 'release.complete', planHash: null, currentPlanStatus: 'available', currentPlanHash: planHash, decisionDependency: 'reviewed release plan hash' } ]) {
      const room = { ...roomReply('action'), action: { ...roomReply('action').action, ...action } };
      await localClient('swfte_open_review_room', [jsonReply(room)], { actionId: 'action', contentHash: fixtureHash }, result => {
        assert.deepEqual(result.room.action, room.action); assert.equal(result.humanViewRecorded, false); assert.equal(result.fullReviewRoomAvailable, false);
      });
    }
  });
  test('an available current packet requires matching packet status and explicit nullable dependency', async () => {
    const room = { ...roomReply('action'), packet: { kind: 'workflow', id: 'artifact', contentHash: fixtureHash },
      action: { ...roomReply('action').action, packetStatus: 'available', decisionDependency: null } };
    await localClient('swfte_open_review_room', [jsonReply(room)], { actionId: 'action', contentHash: fixtureHash }, result => {
      assert.equal(result.room.action.decisionDependency, null); assert.equal(result.room.packet.contentHash, fixtureHash); assert.equal(result.humanViewRecorded, false);
    });
  });
  test('every original kind has separately encoded exact packet path/action/hash segments', async () => {
    for (const kind of REVIEW_KINDS) {
      const room = roomReply('action:a-1'); room.action = { ...room.action, kind, artifactId: 'artifact/a?x' };
      await localClient('swfte_open_review_room', [jsonReply(room)], { actionId: 'action:a-1', contentHash: fixtureHash }, result => {
        const url = new URL(result.url); assert.equal(url.pathname, `/v2/studio/review/${kind}/artifact%2Fa%3Fx`);
        assert.equal(url.searchParams.get('action'), 'action:a-1'); assert.equal(url.searchParams.get('hash'), fixtureHash); assert.equal(result.humanViewRecorded, false);
      });
    }
  });
  test('nine ordered report slots refuse empty, duplicate, swapped, malformed status/facts and unexplained absence', async () => {
    const source = roomReply('action').reports;
    for (const reports of [[], source.slice(1), [source[1], source[0], ...source.slice(2)], [source[0], source[0], ...source.slice(2)],
      [{ ...source[0], status: 'complete' }, ...source.slice(1)], [{ ...source[0], facts: [] }, ...source.slice(1)],
      [{ ...source[0], reason: '' }, ...source.slice(1)], [{ ...source[0], status: 'available', reason: 'unexplained' }, ...source.slice(1)]]) {
      await assert.rejects(localClient('swfte_open_review_room', [jsonReply({ ...roomReply('action'), reports })], { actionId: 'action', contentHash: fixtureHash }, () => {}), code('REVIEW_ROOM_BINDING_INVALID'));
    }
  });
  test('actual dependency_unavailable report slots remain explicit rather than becoming available', async () => {
    const room: any = roomReply('action'); room.reports[0] = { ...room.reports[0], status: 'dependency_unavailable', facts: { status: 'dependency_unavailable' } };
    await localClient('swfte_open_review_room', [jsonReply(room)], { actionId: 'action', contentHash: fixtureHash }, result => {
      assert.equal(result.room.reports.length, 9); assert.equal(result.room.reports[0].status, 'dependency_unavailable'); assert.equal(result.room.reports[0].reason, 'CONFIDENCE_RUNTIME_UNAVAILABLE');
    });
  });
  test('stale retained room remains visibly stale rather than substituting a current hash', async () => {
    const room = { ...roomReply('action'), stale: true, staleReason: 'Content changed', action: { ...roomReply('action').action, contentHash } };
    await localClient('swfte_open_review_room', [jsonReply(room)], { actionId: 'action', contentHash: fixtureHash }, result => {
      assert.equal(result.contentHash, fixtureHash); assert.equal(result.room.action.contentHash, contentHash); assert.equal(result.room.stale, true);
    });
  });
  test('all7 kinds assemble genuine local signatures, exact workspace and explicit section absences', async () => {
    for (const kind of REVIEW_KINDS) {
      const fixture = signedFixture(kind);
      await localClient('swfte_assemble_proof_bundle', [binaryReply(fixture.bytes), versionsReply(), keyReply()], { ...assembleInput, kind }, (result, calls) => {
        assert.equal(result.kind, kind); assert.equal(result.workspaceId, 'ws_a'); assert.equal(result.contentHash, fixtureHash); assert.equal(result.bundleVersion, '2');
        assert.equal(result.envelopeDigest, sha(fixture.bytes)); assert.equal(result.verification.signatureVerified, true); assert.equal(result.verification.independentCosignVerified, false);
        assert.deepEqual(result.sections.confidence, { status: 'absent', reason: 'SOURCE_RUNTIME_UNAVAILABLE' });
        assert.equal(result.sections.runs.status, 'absent'); assert.equal(result.payload, undefined); assert.equal(result.predicate, undefined);
        assert.equal(calls.length, 3); assert.equal(calls[0]!.url.pathname, `/agents/v2/proof-bundles/${kind}/artifact`);
        for (const call of calls) assert.equal(call.init.method, 'GET');
        assert.equal(calls[2]!.url.searchParams.get('keyId'), keyId);
      });
    }
  });
  test('an exact retained version uses its actual bytes without requiring the current-version header', async () => {
    const fixture = signedFixture('workflow', () => {}, 0);
    await localClient('swfte_assemble_proof_bundle', [binaryReply(fixture.bytes, false), versionsReply(), keyReply()], { ...assembleInput, bundleVersion: '1' }, (result, calls) => {
      assert.equal(result.bundleVersion, '1'); assert.equal(calls[0]!.url.pathname, '/agents/v2/proof-bundles/workflow/artifact/versions/1');
      assert.equal(result.material.packageQuery.version, '1'); assert.equal(result.envelopeDigest, sha(fixture.bytes));
    });
  });
  test('a valid old envelope relabelled as a later header or requested version is refused', async () => {
    const old = signedFixture('workflow', () => {}, 0);
    await assert.rejects(localClient('swfte_assemble_proof_bundle', [binaryReply(old.bytes)], assembleInput, () => {}), code('PROOF_VERSION_BINDING_INVALID'));
    await assert.rejects(localClient('swfte_assemble_proof_bundle', [binaryReply(old.bytes, false)], { ...assembleInput, bundleVersion: '2' }, () => {}), code('PROOF_VERSION_BINDING_INVALID'));
  });
  test('signed but foreign subject, hash, contributor, kind or workspace is refused', async () => {
    for (const change of [ (s: any) => { s.predicate.artifact.workspace = 'foreign'; }, (s: any) => { s.predicate.artifact.id = 'foreign'; },
      (s: any) => { s.predicate.artifact.kind = 'agent'; }, (s: any) => { s.subject[0].digest.sha256 = contentHash.slice(7); },
      (s: any) => { s.predicate.contributors = { release: { contentHash, assembledThroughLedgerSeq: 0, facts: {} } }; } ]) {
      const fixture = signedFixture('workflow', change);
      await assert.rejects(localClient('swfte_assemble_proof_bundle', [binaryReply(fixture.bytes)], assembleInput, () => {}), code('PROOF_BINDING_INVALID'));
    }
  });
  test('noncanonical or duplicate envelope JSON and changed signature/payload never verify', async () => {
    const fixture = signedFixture();
    const duplicate = Buffer.from(`{"payloadType":"wrong",${fixture.bytes.toString().slice(1)}`);
    for (const bytes of [Buffer.concat([fixture.bytes, Buffer.from('\n')]), duplicate]) {
      await assert.rejects(localClient('swfte_assemble_proof_bundle', [binaryReply(bytes)], assembleInput, () => {}), code('PROOF_BINDING_INVALID'));
    }
    const signature = Buffer.from(fixture.root.signatures[0]!.sig, 'base64'); signature[signature.length - 1] = signature[signature.length - 1]! ^ 1;
    const changedSignature = Buffer.from(fixtureJson({ ...fixture.root, signatures: [{ keyid: keyId, sig: signature.toString('base64') }] }));
    await assert.rejects(localClient('swfte_assemble_proof_bundle', [binaryReply(changedSignature), versionsReply(), keyReply()], assembleInput, () => {}), error => error instanceof SwfteApiError && /PROOF_(?:BINDING|SIGNATURE)_INVALID/.test(error.code));
    const changed = signedFixture(); changed.statement.predicate.confidence = { status: 'absent', reason: 'changed without signature' };
    const changedPayload = Buffer.from(fixtureJson({ ...changed.root, payload: Buffer.from(fixtureJson(changed.statement)).toString('base64') }));
    await assert.rejects(localClient('swfte_assemble_proof_bundle', [binaryReply(changedPayload), versionsReply(), keyReply()], assembleInput, () => {}), code('PROOF_SIGNATURE_INVALID'));
  });
  test('wrong retained key, missing version and missing current header do not become latest material', async () => {
    const fixture = signedFixture(); const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await assert.rejects(localClient('swfte_assemble_proof_bundle', [binaryReply(fixture.bytes), versionsReply(), jsonReply({ keyId, publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() })], assembleInput, () => {}), code('PROOF_SIGNATURE_INVALID'));
    await assert.rejects(localClient('swfte_assemble_proof_bundle', [binaryReply(fixture.bytes), jsonReply([{ bundleVersion: '1', keyId }])], assembleInput, () => {}), code('PROOF_MATERIAL_UNAVAILABLE'));
    await assert.rejects(localClient('swfte_assemble_proof_bundle', [binaryReply(fixture.bytes, false)], assembleInput, () => {}), code('PROOF_MATERIAL_UNAVAILABLE'));
  });
  test('a genuine SPKI key verifies and only parsed public material is returned', async () => {
    const fixture = signedFixture();
    await localClient('swfte_assemble_proof_bundle', [binaryReply(fixture.bytes), versionsReply(), jsonReply({ keyId, publicKey: pem, privateKey: privatePemFixtures()[0] })], assembleInput, result => {
      assert.equal(result.verification.signatureVerified, true);
      assert.equal(result.verification.publicKey === pem, true);
      assert.equal(JSON.stringify(result).includes('PRIVATE KEY'), false);
    });
  });
  test('authenticated key responses reject same-key PKCS8, SEC1, encrypted and forged public-label private PEM', async () => {
    const fixture = signedFixture();
    for (const privatePem of privatePemFixtures()) {
      await assert.rejects(localClient('swfte_assemble_proof_bundle', [binaryReply(fixture.bytes), versionsReply(), jsonReply({ keyId, publicKey: privatePem })], assembleInput, () => {}), error =>
        code('PROOF_SIGNATURE_INVALID')(error) && !String(error).includes('PRIVATE KEY') && !String(error).includes('local-ephemeral-fixture-only'));
    }
  });
  test('offline public.pem rejects private envelopes and forged public labels without returning ZIP bytes', async () => {
    const fixture = signedFixture();
    for (const privatePem of privatePemFixtures()) {
      const zip = packageBytes(fixture.bytes, { 'public.pem': Buffer.from(privatePem) });
      await assert.rejects(localClient('swfte_assemble_proof_bundle', [binaryReply(fixture.bytes), versionsReply(), keyReply(), binaryReply(zip, false, 'application/zip')], { ...assembleInput, offlinePackage: true }, () => {}), error =>
        code('PROOF_PACKAGE_BINDING_INVALID')(error) && !String(error).includes('PRIVATE KEY') && !String(error).includes('local-ephemeral-fixture-only'));
    }
  });
  test('offline package retains original envelope/ZIP bytes and verifies subject/key joins', async () => {
    const fixture = signedFixture(), zip = packageBytes(fixture.bytes);
    await localClient('swfte_assemble_proof_bundle', [binaryReply(fixture.bytes), versionsReply(), keyReply(), binaryReply(zip, false, 'application/zip')], { ...assembleInput, offlinePackage: true }, (result, calls) => {
      assert.deepEqual(Buffer.from(result.offlinePackage.bytes, 'base64'), Buffer.from(zip)); assert.equal(result.offlinePackage.sha256, sha(zip));
      assert.equal(calls[3]!.url.searchParams.get('version'), '2'); assert.equal(result.verification.command + '\n', verifyLine);
    });
  });
  test('changed envelope, subject, key or unexpected ZIP entry prevents package availability', async () => {
    const fixture = signedFixture();
    for (const changed of [{ 'envelope.json': Buffer.concat([fixture.bytes, Buffer.from('\n')]) }, { 'subject.json': Buffer.from('different subject') },
      { 'public.pem': Buffer.from('not a public key') }, { '../secret.txt': Buffer.from('private') }, { 'VERIFY.txt': Buffer.from('different command') }]) {
      await assert.rejects(localClient('swfte_assemble_proof_bundle', [binaryReply(fixture.bytes), versionsReply(), keyReply(), binaryReply(packageBytes(fixture.bytes, changed), false, 'application/zip')], { ...assembleInput, offlinePackage: true }, () => {}), code('PROOF_PACKAGE_BINDING_INVALID'));
    }
  });
  test('admin export receipt selects its actual retained version after POST, never guessed current', async () => {
    const fixture = signedFixture('workflow', () => {}, 0), expected = receipt(fixture.bytes);
    await localClient('swfte_export_proof_bundle', [jsonReply(expected), binaryReply(fixture.bytes, false), versionsReply(), keyReply()], { ...assembleInput, platform: 'vanta', documentId: 'document' }, (result, calls) => {
      assert.equal(result.bundleVersion, '1'); assert.equal(result.envelopeDigest, sha(fixture.bytes)); assert.deepEqual(result.receipt, expected);
      assert.equal(calls[0]!.init.method, 'POST'); assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { contentHash: fixtureHash, platform: 'vanta', documentId: 'document' });
      assert.equal(calls[1]!.url.pathname, '/agents/v2/proof-bundles/workflow/artifact/versions/1'); assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
    });
  });
  test('unknown or mismatched export receipt is explicit unconfirmed and never replayed', async () => {
    const fixture = signedFixture();
    for (const changed of [{ status: 'uncertain' }, { platform: 'drata' }, { documentId: 'other' }, { idempotencyKey: `${contentHash}:1` },
      { idempotencyKey: `${fixtureHash}:latest` }, { envelopeDigest: 'not-a-digest' }, { uploadReference: '' }]) {
      await assert.rejects(localClient('swfte_export_proof_bundle', [jsonReply(receipt(fixture.bytes, changed))], { ...assembleInput, platform: 'vanta', documentId: 'document' }, () => {}), code('PROOF_EXPORT_RECEIPT_MISMATCH'));
    }
  });
  test('receipt digest must equal unchanged retained envelope; confirmation failure says possible commit', async () => {
    const fixture = signedFixture('workflow', () => {}, 0);
    await assert.rejects(localClient('swfte_export_proof_bundle', [jsonReply(receipt(fixture.bytes, { envelopeDigest: 'c'.repeat(64) })), binaryReply(fixture.bytes, false), versionsReply(), keyReply()], { ...assembleInput, platform: 'vanta', documentId: 'document' }, () => {}), error => {
      assert.ok(error instanceof SwfteApiError); assert.equal(error.code, 'PROOF_EXPORT_CONFIRMATION_UNAVAILABLE'); assert.match(error.message, /may have committed/);
      assert.equal(error.envelope.bundleVersion, '1'); return true;
    });
  });
  test('403/409/410/422/503 preserve server error with one attempt on GET assembly and POST export', async () => {
    for (const status of [403, 409, 410, 422, 503]) {
      for (const [name, input] of [['swfte_assemble_proof_bundle', assembleInput], ['swfte_export_proof_bundle', { ...assembleInput, platform: 'vanta', documentId: 'document' }]] as const) {
        await assert.rejects(localClient(name, [jsonReply({ error: 'SOURCE_REFUSAL', message: 'source refusal' }, status)], input, () => {}), error => error instanceof SwfteApiError && error.status === status && error.code === 'SOURCE_REFUSAL');
      }
    }
  });
  test('original schemas reject identity/grants, partial hash, dot segments and malformed version before transport', () => {
    for (const tool of reviewTools.filter(t => t.group === 'core')) {
      const base = tool.name === 'swfte_open_review_room' ? { actionId: 'action', contentHash: fixtureHash } : tool.name === 'swfte_export_proof_bundle' ? { ...assembleInput, platform: 'vanta', documentId: 'document' } : assembleInput;
      for (const extra of [{ workspaceId: 'foreign' }, { userId: 'admin' }, { via: 'slack' }, { admin: true }, { recordView: true }]) assert.throws(() => tool.inputSchema.parse({ ...base, ...extra }));
      assert.throws(() => tool.inputSchema.parse({ ...base, contentHash: 'sha256:abc' }));
    }
    assert.throws(() => reviewTools.find(t => t.name === 'swfte_open_review_room')!.inputSchema.parse({ actionId: '..', contentHash: fixtureHash }));
    assert.throws(() => reviewTools.find(t => t.name === 'swfte_assemble_proof_bundle')!.inputSchema.parse({ ...assembleInput, bundleVersion: 'latest' }));
  });
  test('API-key material uses existing configured tenancy headers; foreign signed workspace refuses', async () => {
    const fixture = signedFixture();
    await localClient('swfte_assemble_proof_bundle', [binaryReply(fixture.bytes), versionsReply(), keyReply()], assembleInput, (_, calls) => {
      for (const call of calls) { const headers = call.init.headers as Record<string, string>; assert.equal(headers['X-Workspace-ID'], 'ws_a'); assert.equal(headers['X-API-Key'], 'sk_local_fixture'); }
    }, config({ credentialKind: 'api-key', credential: 'sk_local_fixture' }));
  });
  test('model room facts scrub credentials at nested depth without exposing signing payloads', async () => {
    const room: any = roomReply('action'); room.reports[0].facts = { credential: { nested: 'opaque-sensitive' }, note: 'Bearer local-secret', arbitrary: { apiKey: ['opaque-sensitive'] }, secretNames: ['private'] };
    await localClient('swfte_open_review_room', [jsonReply(room)], { actionId: 'action', contentHash: fixtureHash }, result => {
      const json = JSON.stringify(result); assert.equal(json.includes('opaque-sensitive'), false); assert.equal(json.includes('local-secret'), false); assert.match(json, /redacted/);
    });
  });
  test('deadline during binary body aborts with one request and no metadata fallback', async () => {
    const cfg = config(), client = new SwfteClient(cfg), originalFetch = globalThis.fetch; let requests = 0;
    globalThis.fetch = async (_url, init) => {
      requests++;
      return new Response(new ReadableStream({ start(controller) {
        init!.signal!.addEventListener('abort', () => controller.error(new Error('local body aborted')), { once: true });
      } }), { headers: { 'Content-Type': 'application/json', 'X-Bundle-Version': '2' } });
    };
    try {
      const tool = reviewTools.find(t => t.name === 'swfte_assemble_proof_bundle')!;
      await assert.rejects(client.withDeadline(Date.now() + 30, () => tool.execute(tool.inputSchema.parse(assembleInput), { client, config: cfg })), /aborted|time budget/i);
      assert.equal(requests, 1);
      await assert.rejects(client.withDeadline(Date.now() - 1, () => tool.execute(tool.inputSchema.parse(assembleInput), { client, config: cfg })), error => error instanceof OperationDeadlineError);
      assert.equal(requests, 1);
    } finally { globalThis.fetch = originalFetch; }
  });
});

// Bound-consumer source controls, authored only: QUEUED/UNRUN.
function planWire() { return {
  steps: [{ stage: 'SHADOW', candidateWeight: 0, minimumUnits: 0 }, { stage: 'AB', candidateWeight: 5000, minimumUnits: 100 }],
  assignment: { unit: 'RUN', saltRef: 'salt:v1' }, cohorts: [], primaryMetric: 'success', baselineRate: .5, mde: .1, alpha: .05, power: .8,
  minDurationDays: 0, maxDurationDays: 14, expectedDailyUnits: 1000, userFacing: false, guardrails: [],
  inference: { designId: 'server-design', fixedHorizonPerArm: 100, maximumPerArm: 200, informationFractions: [.5, 1], boundaries: [3, 2],
    allocation: { designId: 'allocation-design', alpha: .001, admissionFraction: .25 } }
}; }
function statusWire(kind = 'WORKFLOW') { return { releaseId: 'r', workspaceId: 'ws_a', targetId: 'target', environment: 'production', subject: 'ARTIFACT_TRAFFIC', kind,
  artifactId: 'artifact', baseline: { version: 'v1', contentHash, bundleHash: null }, candidate: { version: 'v2', contentHash: fixtureHash, bundleHash: null },
  stage: 'AB', plan: planWire(), planHash, candidateWeight: 5000, revision: 1, ledgerSeq: 3, underpowered: false, allocationMismatch: false }; }
function summaryWire(kind = 'WORKFLOW') { return { releaseId: 'r', workspaceId: 'ws_a', subject: 'ARTIFACT_TRAFFIC', kind, artifactId: 'artifact', contentHash: fixtureHash, planHash,
  stage: 'AB', baselineUnits: 10, candidateUnits: 10, requiredPerArm: 200, ledgerSeq: 3, underpowered: true, withheld: 'NONE',
  primary: { outcome: 'INCONCLUSIVE_UNDERPOWERED', difference: null, intervalLow: null, intervalHigh: null, wording: 'More information required' },
  guardrails: [{ key: 'error', status: 'UNKNOWN', observed: null, threshold: '0.1', effect: null }], baselineCost: null, candidateCost: null, bundleVersion: null }; }

describe('bound consumers through actual SwfteClient with declared fetch replies', { concurrency: false }, () => {
  test('all seven actual release status and summary wires preserve explicit unknown evidence and cache refusal', async () => {
    for (const kind of ['WORKFLOW', 'AGENT', 'CHATFLOW', 'MODEL', 'APPLICATION', 'WIDGET', 'STUDIO_CHANGE']) {
      for (const [name, wire] of [['swfte_release_status', statusWire(kind)], ['swfte_release_report', summaryWire(kind)]] as const) {
        await localClient(name, [jsonReply(wire)], { releaseId: 'r' }, (result, calls) => {
          assert.deepEqual(result, wire); assert.equal(calls.length, 1); assert.equal(new Headers(calls[0]!.init.headers).get('Cache-Control'), 'no-store');
          assert.equal(calls[0]!.init.method, 'GET'); assert.equal('score' in result, false);
        });
      }
    }
  });
  test('status refuses foreign identity, unsafe counts, coercion, missing plan and unsafe traffic', async () => {
    for (const changed of [{ releaseId: 'sibling' }, { workspaceId: 'foreign' }, { kind: 'workflow' }, { subject: 'OTHER' }, { planHash: planHash+'\n' },
      { underpowered: 'false' }, { allocationMismatch: null }, { revision: 1.5 }, { ledgerSeq: Number.MAX_SAFE_INTEGER+1 }, { candidateWeight: -1 },
      { stage: 'PAUSED', candidateWeight: 5000 }, { baseline: { version: 'v1', contentHash: 'latest', bundleHash: null } }, { plan: null },
      { plan: { ...planWire(), inference: { ...planWire().inference, boundaries: ['2', 3] } } }]) {
      await assert.rejects(localClient('swfte_release_status', [jsonReply({ ...statusWire(), ...changed })], { releaseId: 'r' }, () => {}), code('RELEASE_STATUS_BINDING_INVALID'));
    }
  });
  test('summary refuses impossible improvement, withheld primary, malformed guardrails and coerced counts', async () => {
    for (const changed of [{ releaseId: 'other' }, { workspaceId: 'other' }, { requiredPerArm: 0 }, { baselineUnits: '10' }, { candidateUnits: 1.5 }, { ledgerSeq: -1 },
      { contentHash: fixtureHash+'\n' }, { underpowered: null }, { withheld: 'ALLOCATION_MISMATCH' }, { primary: { ...summaryWire().primary, outcome: 'BETTER' } },
      { guardrails: [{ key: 'error', status: 'UNKNOWN', observed: null, threshold: null, effect: false }] }, { primary: { ...summaryWire().primary, difference: 'NaN' } }]) {
      await assert.rejects(localClient('swfte_release_report', [jsonReply({ ...summaryWire(), ...changed })], { releaseId: 'r' }, () => {}), code('RELEASE_SUMMARY_BINDING_INVALID'));
    }
    const pending = { ...summaryWire(), primary: { outcome: 'PENDING', difference: null, intervalLow: null, intervalHigh: null, wording: null } };
    await localClient('swfte_release_report', [jsonReply(pending)], { releaseId: 'r' }, result => assert.deepEqual(result, pending));
    const withheld = { ...summaryWire(), withheld: 'ALLOCATION_MISMATCH', primary: null };
    await localClient('swfte_release_report', [jsonReply(withheld)], { releaseId: 'r' }, result => assert.deepEqual(result, withheld));
  });
  test('safe transitions confirm exact actual wire with one post and malformed success is unconfirmed', async () => {
    const input = { releaseId: 'r', expectedContentHash: contentHash, expectedPlanHash: planHash, trigger: 'operator' };
    for (const control of ['pause', 'rollback']) {
      const wire = { releaseId: 'r', stage: 'ROLLED_BACK', candidateWeight: 0, ledgerSeq: 4 };
      await localClient(`swfte_release_${control}`, [jsonReply(wire)], input, (result, calls) => {
        assert.deepEqual(result, wire); assert.equal(calls.length, 1); assert.equal(calls[0]!.init.method, 'POST');
        assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { expectedContentHash: contentHash, expectedPlanHash: planHash, trigger: 'operator' });
      });
      for (const changed of [{ releaseId: 'other' }, { stage: 'RAMP' }, { candidateWeight: 1 }, { ledgerSeq: '4' }, { ledgerSeq: 4.5 }])
        await assert.rejects(localClient(`swfte_release_${control}`, [jsonReply({ ...wire, ...changed })], input, () => {}), code('RELEASE_CONTROL_UNCONFIRMED'));
    }
  });
  test('all seven proposal targets validate before presentation and invalid successful action is unconfirmed', async () => {
    const input = { releaseId: 'r', expectedContentHash: contentHash, expectedPlanHash: planHash, desiredStage: 'AB', candidateWeight: 5000 };
    const action = { id: 'action:r', capability: 'release.ramp', target: { kind: 'workflow', id: 'artifact' }, environment: 'production', status: 'PROPOSED', requiresApproval: true,
      contentHash, planHash, params: { releaseId: 'r', stage: 'AB', planHash, candidateWeight: '5000' } };
    for (const kind of REVIEW_KINDS) await localClient('swfte_release_propose_ramp', [jsonReply({ ...statusWire(kind.toUpperCase().replace('-', '_')), candidate: { ...statusWire().candidate, contentHash } }), jsonReply({ ...action, target: { ...action.target, kind } })], input, (result, calls) => {
      assert.equal(result.changesTraffic, false); assert.equal(result.target.kind, kind); assert.equal(calls.length, 2); assert.equal(calls[0]!.init.method, 'GET'); assert.equal(calls[1]!.init.method, 'POST');
    });
    for (const changed of [{ id: 'action:r\n' }, { target: null }, { target: { kind: 'WORKFLOW', id: 'artifact' } }, { environment: ' ' }, { requiresApproval: 'true' },
      { params: { ...action.params, arbitrary: false } }, { params: { ...action.params, planHash: undefined } }, { params: { ...action.params, candidateWeight: 5000 } }])
      await assert.rejects(localClient('swfte_release_propose_ramp', [jsonReply({ ...statusWire(), candidate: { ...statusWire().candidate, contentHash } }), jsonReply({ ...action, ...changed })], input, () => {}), code('RELEASE_PROPOSAL_UNCONFIRMED'));
  });
  test('room alias uses the same full binding validator for all seven kinds and no human write', async () => {
    for (const kind of REVIEW_KINDS) {
      const room = roomReply('action'); room.action.kind = kind;
      await localClient('swfte_review_room', [jsonReply(room)], { actionId: 'action', contentHash: fixtureHash }, (result, calls) => {
        assert.deepEqual(result, room); assert.equal(calls.length, 1); assert.equal(calls[0]!.init.method, 'GET');
        assert.equal(new Headers(calls[0]!.init.headers).get('Cache-Control'), 'no-store'); assert.equal('humanViewRecorded' in result, false);
      });
      await assert.rejects(localClient('swfte_review_room', [jsonReply({ ...room, reports: [] })], { actionId: 'action', contentHash: fixtureHash }, () => {}), code('REVIEW_ROOM_BINDING_INVALID'));
    }
  });
  test('proof alias verifies original signed binary, subject, retained membership and key for all seven kinds', async () => {
    for (const kind of REVIEW_KINDS) {
      const signed = signedFixture(kind);
      await localClient('swfte_proof_bundle', [binaryReply(signed.bytes), versionsReply(), keyReply()], { ...assembleInput, kind }, (result, calls) => {
        assert.deepEqual(result, signed.root); assert.equal(calls.length, 3);
        for (const call of calls) assert.equal(new Headers(call.init.headers).get('Cache-Control'), 'no-store');
      });
      const foreign = signedFixture(kind, statement => { statement.predicate.artifact.workspace = 'foreign'; });
      await assert.rejects(localClient('swfte_proof_bundle', [binaryReply(foreign.bytes)], { ...assembleInput, kind }, () => {}), code('PROOF_BINDING_INVALID'));
    }
  });
  test('binary noStore is opt-in and preserves raw bytes and original default headers', async () => {
    const originalFetch = globalThis.fetch, calls: RequestInit[] = [], raw = new Uint8Array([0, 255, 13, 10]);
    globalThis.fetch = async (_, init) => { calls.push(init ?? {}); return new Response(raw, { headers: { 'Content-Type': 'application/octet-stream' } }); };
    try {
      const client = new SwfteClient(config());
      for (const options of [{}, { noStore: false }, { noStore: true, accept: 'application/octet-stream' }]) {
        const result = await client.getBinary('/v2/proof-bundles/raw', options); assert.deepEqual(result.bytes, raw);
      }
      assert.equal(calls.length, 3);
      assert.equal(new Headers(calls[0]!.headers).get('Cache-Control'), null); assert.equal(new Headers(calls[1]!.headers).get('Cache-Control'), null);
      assert.equal(new Headers(calls[2]!.headers).get('Cache-Control'), 'no-store'); assert.equal(new Headers(calls[2]!.headers).get('Accept'), 'application/octet-stream');
      assert.equal(new Headers(calls[2]!.headers).get('Authorization'), new Headers(calls[0]!.headers).get('Authorization'));
    } finally { globalThis.fetch = originalFetch; }
  });
});

describe('underlying refusal and alias hostile evidence controls', { concurrency: false }, () => {
  test('safe controls retain original 403/409/410/422/503 envelopes without replay', async () => {
    for (const status of [403, 409, 410, 422, 503]) {
      await assert.rejects(localClient('swfte_release_pause', [jsonReply({ code: 'ORIGINAL_REFUSAL', message: 'Original refusal' }, status)],
        { releaseId: 'r', expectedContentHash: contentHash, expectedPlanHash: planHash, trigger: 'operator' }, () => {}),
        error => error instanceof SwfteApiError && error.status === status && error.code === 'ORIGINAL_REFUSAL');
    }
  });
  test('proof alias refuses retained membership substitution, private keys and altered signatures', async () => {
    const signed = signedFixture();
    await assert.rejects(localClient('swfte_proof_bundle', [binaryReply(signed.bytes), jsonReply([{ bundleVersion: '2', keyId: contentHash }])], assembleInput, () => {}), code('PROOF_MATERIAL_UNAVAILABLE'));
    for (const privateKey of privatePemFixtures()) await assert.rejects(localClient('swfte_proof_bundle',
      [binaryReply(signed.bytes), versionsReply(), jsonReply({ keyId, publicKey: privateKey })], assembleInput, () => {}), code('PROOF_SIGNATURE_INVALID'));
    const altered = Buffer.from(fixtureJson({ ...signed.root, signatures: [{ keyid: keyId, sig: Buffer.alloc(70).toString('base64') }] }));
    await assert.rejects(localClient('swfte_proof_bundle', [binaryReply(altered)], assembleInput, () => {}), code('PROOF_BINDING_INVALID'));
  });
  test('release read inputs refuse blank, controlled and oversized identities before transport', () => {
    for (const name of ['swfte_release_status', 'swfte_release_report']) for (const releaseId of ['', ' ', 'r\n', 'r\x7f', 'x'.repeat(513)]) {
      const h = harness(name, statusWire()); assert.throws(() => h.run({ releaseId })); assert.equal(h.calls.length, 0);
    }
  });
});

// Current native release authority is declared HTTP data; this is no delivered backend/provider credit.
const proposalInput = { releaseId: 'r', expectedContentHash: fixtureHash, expectedPlanHash: planHash, desiredStage: 'AB', candidateWeight: 5000 };
function proposalWire(kind = 'workflow', environment = 'production', input = proposalInput) {
  return { id: 'action:r', capability: input.desiredStage === 'COMPLETE' ? 'release.complete' : 'release.ramp', target: { kind, id: 'artifact' },
    environment, status: 'PROPOSED', requiresApproval: true, contentHash: input.expectedContentHash, planHash: input.expectedPlanHash,
    params: { releaseId: input.releaseId, stage: input.desiredStage, candidateWeight: String(input.candidateWeight), planHash: input.expectedPlanHash } };
}
async function proposalAttempt(authority: unknown | Response, action: unknown | Response, input = proposalInput) {
  const saved = globalThis.fetch, calls: { url: URL; init: RequestInit }[] = [];
  const replies = [authority instanceof Response ? authority : jsonReply(authority), action instanceof Response ? action : jsonReply(action)];
  globalThis.fetch = async (url, init) => { calls.push({ url: new URL(String(url)), init: init ?? {} }); const reply = replies.shift(); assert.ok(reply, 'No automatic effect retry or extra authority read'); return reply; };
  try {
    const cfg = config(), tool = releaseTools.find(t => t.name === 'swfte_release_propose_ramp')!;
    try { return { result: await tool.execute(tool.inputSchema.parse(input), { client: new SwfteClient(cfg), config: cfg }), error: null, calls }; }
    catch (error) { return { result: null, error, calls }; }
  } finally { globalThis.fetch = saved; }
}
function oneAuthorityGet(calls: { url: URL; init: RequestInit }[]) {
  assert.equal(calls[0]!.init.method, 'GET'); assert.equal(calls[0]!.url.pathname, '/agents/v2/releases/r');
  assert.equal(new Headers(calls[0]!.init.headers).get('Cache-Control'), 'no-store');
  for (const call of calls) assert.equal(new Headers(call.init.headers).get('Authorization'), 'Bearer pat_local_fixture');
  assert.equal(calls.filter(c => c.init.method === 'GET').length, 1);
}

describe('native release proposal authority through actual SwfteClient', { concurrency: false }, () => {
  test('literal native target schema preserves leading punctuation and rejects padded or invalid identities before POST', async () => {
    for (const artifactId of ['.artifact', '_artifact', ':artifact', '@artifact', '-artifact', 'a'.repeat(200)]) {
      const action = { ...proposalWire(), target: { kind: 'workflow', id: artifactId } };
      const positive = await proposalAttempt({ ...statusWire(), artifactId }, action);
      assert.equal(positive.error, null); assert.equal((positive.result as any).target.id, artifactId);
      oneAuthorityGet(positive.calls); assert.equal(positive.calls.length, 2);
      assert.equal(positive.calls.filter(call => call.init.method === 'POST').length, 1);
    }
    for (const artifactId of ['a'.repeat(201), 'folder/artifact', ' artifact', 'artifact ', '\tartifact', 'artifact\n', 'artifact\0', 'artifact\u007f', 'artifact\u00a0']) {
      const negative = await proposalAttempt({ ...statusWire(), artifactId }, proposalWire());
      assert.ok(code('RELEASE_AUTHORITY_UNCONFIRMED')(negative.error)); oneAuthorityGet(negative.calls);
      assert.equal(negative.calls.length, 1); assert.equal(negative.calls.filter(call => call.init.method === 'POST').length, 0);
    }
  });
  test('operation deadline expiring after complete native GET admits zero proposal POST', async () => {
    const savedFetch = globalThis.fetch, savedNow = Date.now;
    try {
      for (const expireAfterGet of [false, true]) {
        let clock = 100000; const deadline = clock + 1000;
        const calls: { url: URL; init: RequestInit }[] = []; let authorityBodyCompleted = false;
        Date.now = () => clock;
        globalThis.fetch = async (url, init) => {
          calls.push({ url: new URL(String(url)), init: init ?? {} });
          if (init?.method === 'GET') {
            const response = jsonReply(statusWire()), read = response.text.bind(response);
            response.text = async () => {
              const body = await read(); authorityBodyCompleted = true;
              if (expireAfterGet) clock = deadline;
              return body;
            };
            return response;
          }
          assert.equal(init?.method, 'POST'); assert.equal(calls.length, 2);
          return jsonReply(proposalWire());
        };
        const cfg = config(), client = new SwfteClient(cfg);
        const tool = releaseTools.find(t => t.name === 'swfte_release_propose_ramp')!;
        const operation = () => client.withDeadline(deadline, () => tool.execute(tool.inputSchema.parse(proposalInput), { client, config: cfg }));
        if (expireAfterGet) await assert.rejects(operation(), error => error instanceof OperationDeadlineError);
        else assert.equal((await operation() as any).changesTraffic, false);
        assert.equal(authorityBodyCompleted, true); oneAuthorityGet(calls);
        assert.equal(calls.length, expireAfterGet ? 1 : 2);
        assert.equal(calls.filter(call => call.init.method === 'POST').length, expireAfterGet ? 0 : 1);
      }
    } finally { globalThis.fetch = savedFetch; Date.now = savedNow; }
  });
  test('all seven native kinds and genuine Java-trim canonical environments admit exactly one proposal after GET', async () => {
    for (const kind of REVIEW_KINDS) for (const [nativeEnv, environment] of [['development', 'development'], [' DeVeLoPmEnT ', 'development'], ['\tSTAGING\r\n', 'staging'], ['\0production ', 'production']]) {
      const native = { ...statusWire(kind.toUpperCase().replace('-', '_')), environment: nativeEnv };
      const attempt = await proposalAttempt(native, proposalWire(kind, environment));
      assert.equal(attempt.error, null); assert.equal((attempt.result as any).changesTraffic, false);
      assert.equal((attempt.result as any).target.kind, kind); assert.equal((attempt.result as any).environment, environment);
      oneAuthorityGet(attempt.calls); assert.equal(attempt.calls.length, 2); assert.equal(attempt.calls[1]!.init.method, 'POST');
      assert.equal(attempt.calls[1]!.url.pathname, '/agents/v2/releases/r/propose-next-step');
      assert.deepEqual(JSON.parse(String(attempt.calls[1]!.init.body)), { expectedContentHash: fixtureHash, expectedPlanHash: planHash, desiredStage: 'AB', candidateWeight: 5000 });
    }
  });
  test('same-hash foreign returned target kind id and environment refuse after only the original POST', async () => {
    const positive = await proposalAttempt(statusWire(), proposalWire()); assert.equal(positive.error, null);
    for (const changed of [{ target: { kind: 'agent', id: 'artifact' } }, { target: { kind: 'workflow', id: 'foreign-artifact' } },
      { environment: 'staging' }, { environment: ' PRODUCTION ' }]) {
      const attempt = await proposalAttempt(statusWire(), { ...proposalWire(), ...changed });
      assert.ok(code('RELEASE_PROPOSAL_UNCONFIRMED')(attempt.error)); oneAuthorityGet(attempt.calls); assert.equal(attempt.calls.length, 2);
      assert.equal(attempt.calls.filter(c => c.init.method === 'POST').length, 1); assert.equal(attempt.result, null);
    }
  });
  test('foreign missing changed hash plan and malformed full native authority admit zero POST', async () => {
    assert.equal((await proposalAttempt(statusWire(), proposalWire())).error, null);
    for (const changed of [{ releaseId: 'foreign' }, { workspaceId: 'foreign' }, { artifactId: '' }, { kind: 'workflow' }, { targetId: null },
      { candidate: { ...statusWire().candidate, version: null } }, { candidate: { ...statusWire().candidate, contentHash } }, { candidate: { version: 'v2', contentHash: fixtureHash } },
      { planHash: contentHash }, { plan: null }, { revision: 1.5 }, { ledgerSeq: '3' }, { environment: null },
      { environment: 'PROD' }, { environment: 'LIVE' }, { environment: '\u00a0production\u00a0' }, { environment: 'production\u2003' }]) {
      const attempt = await proposalAttempt({ ...statusWire(), ...changed }, proposalWire());
      assert.ok(attempt.error instanceof SwfteApiError); assert.equal(attempt.error.status, 503); assert.equal(attempt.error.method, 'GET');
      oneAuthorityGet(attempt.calls); assert.equal(attempt.calls.length, 1); assert.equal(attempt.calls.filter(c => c.init.method === 'POST').length, 0);
    }
    const absent = await proposalAttempt(null, proposalWire()); assert.ok(code('RELEASE_AUTHORITY_UNCONFIRMED')(absent.error)); assert.equal(absent.calls.length, 1);
  });
  test('changed native target or environment is fresh authority and an old same-hash response cannot pass', async () => {
    for (const [native, returned] of [[{ ...statusWire('AGENT'), artifactId: 'current-agent' }, { ...proposalWire('agent'), target: { kind: 'agent', id: 'current-agent' } }],
      [{ ...statusWire(), environment: 'staging' }, proposalWire('workflow', 'staging')]] as const) {
      const positive = await proposalAttempt(native, returned); assert.equal(positive.error, null); assert.equal(positive.calls.length, 2);
      const stale = await proposalAttempt(native, proposalWire()); assert.ok(code('RELEASE_PROPOSAL_UNCONFIRMED')(stale.error)); assert.equal(stale.calls.length, 2);
    }
  });
  test('malformed bounded string params and inherited capability hash approval bindings remain unconfirmed', async () => {
    assert.equal((await proposalAttempt(statusWire(), proposalWire())).error, null);
    const original = proposalWire();
    for (const changed of [{ params: { ...original.params, releaseId: 'foreign' } }, { params: { ...original.params, planHash: contentHash } },
      { params: { ...original.params, stage: 'RAMP' } }, { params: { ...original.params, candidateWeight: 5000 } },
      { params: { ...original.params, arbitrary: 'x'.repeat(2049) } }, { params: { ...original.params, arbitrary: {} } },
      { params: { ...original.params, planHash: null } }, { capability: 'release.complete' }, { status: 'APPROVED' }, { requiresApproval: false },
      { contentHash }, { planHash: contentHash }]) {
      const attempt = await proposalAttempt(statusWire(), { ...original, ...changed }); assert.ok(code('RELEASE_PROPOSAL_UNCONFIRMED')(attempt.error));
      assert.equal(attempt.calls.length, 2); assert.equal(attempt.calls.filter(c => c.init.method === 'POST').length, 1);
    }
  });
  test('SHADOW intent and COMPLETE capability stay server proposals and refusal never retries the mutation', async () => {
    for (const [desiredStage, candidateWeight] of [['SHADOW', 0], ['COMPLETE', 10000]] as const) {
      const input = { ...proposalInput, desiredStage, candidateWeight }, attempt = await proposalAttempt(statusWire(), proposalWire('workflow', 'production', input), input);
      assert.equal(attempt.error, null); assert.equal((attempt.result as any).changesTraffic, false); assert.equal(attempt.calls.length, 2);
      assert.equal(JSON.parse(String(attempt.calls[1]!.init.body)).desiredStage, desiredStage);
    }
    for (const status of [403, 409, 422, 503]) {
      const failedGet = await proposalAttempt(new Response(JSON.stringify({ code: 'AUTHORITY_REFUSED' }), { status }), proposalWire());
      assert.ok(failedGet.error instanceof SwfteApiError); assert.equal(failedGet.calls.length, 1);
      const failedPost = await proposalAttempt(statusWire(), new Response(JSON.stringify({ code: 'PROPOSAL_REFUSED' }), { status }));
      assert.ok(failedPost.error instanceof SwfteApiError); assert.equal(failedPost.calls.length, 2); assert.equal(failedPost.calls.filter(c => c.init.method === 'POST').length, 1);
    }
  });
});
