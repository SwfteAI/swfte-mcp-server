import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogProofBindingError, getCatalogProof, getCatalogDelta, extendCatalogSuite, declareCatalogDeviation, getCatalogShelves, rerunParentSuite } from '../src/catalog-proof.js';
import { catalogProofTools } from '../src/tools/catalog-proof.js';
import type { SwfteClient, RequestOptions } from '../src/client.js';
const hash = 'a'.repeat(64), suiteHash = 'b'.repeat(64);
const suite = { entryRef: 'workflow:copy/1', suiteHash };
function fixture(reply: unknown) {
  const calls: RequestOptions[] = [];
  return { calls, client: { request: async (opts: RequestOptions) => { calls.push(opts); return reply; } } as unknown as SwfteClient };
}
test('exact hash request preserves separate parent and own evidence', async () => {
  const response = { entryRef: suite.entryRef, contentHash: hash, suite, parentEvidence: { runs: 50 }, ownEvidence: { level: 'observed', runs: { total: 0 } }, bundle: null };
  const f = fixture(response); const view = await getCatalogProof(f.client, suite.entryRef, hash);
  assert.deepEqual(f.calls[0], { method: 'GET', path: '/v2/catalog/workflow/copy%2F1/proof-suite', query: { contentHash: hash } });
  assert.strictEqual(view, response); assert.equal(view.ownEvidence.runs?.total, 0);
});
test('stale content, foreign entry and sibling bundle cannot be presented as requested checks', async () => {
  for (const changed of [{ contentHash: suiteHash }, { entryRef: 'workflow:foreign' }, { bundle: { entryRef: 'workflow:sibling', contentHash: hash } }]) {
    const f = fixture({ entryRef: suite.entryRef, contentHash: hash, suite, bundle: null, ...changed });
    await assert.rejects(getCatalogProof(f.client, suite.entryRef, hash), CatalogProofBindingError);
  }
});
test('delta response itself is bound to exact entry, content and suite', async () => {
  const response = { entryRef: suite.entryRef, contentHash: hash, suiteHash, proof: { pass: false } };
  assert.strictEqual(await getCatalogDelta(fixture(response).client, suite.entryRef, hash), response);
  await assert.rejects(getCatalogDelta(fixture({ ...response, contentHash: suiteHash }).client, suite.entryRef, hash), CatalogProofBindingError);
  await assert.rejects(getCatalogDelta(fixture({ ...response, entryRef: 'workflow:sibling' }).client, suite.entryRef, hash), CatalogProofBindingError);
});
test('signed bundle response must bind the current suite as well as the same artifact', async () => {
  const bundle = { entryRef: suite.entryRef, contentHash: hash, suiteHash, bundleDigest: 'c'.repeat(64), signatureValid: true, downloadPath: '/bundle' };
  const response = { entryRef: suite.entryRef, contentHash: hash, suite, bundle };
  assert.strictEqual(await getCatalogProof(fixture(response).client, suite.entryRef, hash), response);
  for (const changed of [{ suiteHash: 'd'.repeat(64) }, { suiteHash: undefined }, { signatureValid: false }, { bundleDigest: 'unsigned' }]) {
    await assert.rejects(getCatalogProof(fixture({ ...response, bundle: { ...bundle, ...changed } }).client, suite.entryRef, hash), CatalogProofBindingError);
  }
});
test('definitions accept node references but reject claimed measured coverage, PASS or inherited authority', async () => {
  const f = fixture(suite); const definition = { scenarioId: 'delta', definition: { input: {} }, severity: 'MAJOR' as const, nodeIds: ['changed'] };
  await extendCatalogSuite(f.client, suite.entryRef, { expectedContentHash: hash, expectedSuiteHash: suiteHash, scenarios: [definition] });
  assert.equal(f.calls[0]?.retries, 0); assert.equal((f.calls[0]?.body as any).scenarios[0].inherited, false);
  for (const extra of [{ measuredNodeIds: ['changed'] }, { result: 'PASS' }, { inherited: true }]) {
    await assert.rejects(extendCatalogSuite(f.client, suite.entryRef, { expectedContentHash: hash, expectedSuiteHash: suiteHash, scenarios: [{ ...definition, ...extra }] }));
  }
  assert.equal(f.calls.length, 1);
});
test('deviation actor cannot be supplied and mutation is never automatically retried', async () => {
  const f = fixture(suite); const body = { expectedContentHash: hash, expectedSuiteHash: suiteHash, scenarioIds: ['original'], reason: 'Policy changed' };
  await declareCatalogDeviation(f.client, suite.entryRef, body); assert.equal(f.calls[0]?.retries, 0);
  await assert.rejects(declareCatalogDeviation(f.client, suite.entryRef, { ...body, declaredBy: 'forged' } as any));
  assert.equal(f.calls.length, 1);
});
test('shelves route binds taxonomy, kind and cursor without exposing owner workspace override', async () => {
  const f = fixture({ items: [], eligibleCount: 0, countIsComplete: true });
  await getCatalogShelves(f.client, { industry: 'finance', task: 'refunds', kind: 'application', cursor: 'bound' });
  assert.deepEqual(f.calls[0]?.query, { industry: 'finance', task: 'refunds', kind: 'application', cursor: 'bound', limit: 20 });
  assert.throws(() => getCatalogShelves(f.client, { industry: 'finance', task: 'refunds', workspaceId: 'victim' } as any));
});
test('upgrade rerun proposes exact latest suite and no activation request', async () => {
  const f = fixture({ actionId: 'sandbox-proposal' });
  assert.deepEqual(await rerunParentSuite(f.client, suite.entryRef, hash, suiteHash), { actionId: 'sandbox-proposal' });
  assert.equal(f.calls[0]?.path, '/v2/catalog/workflow/copy%2F1/proof-suite/rerun');
  assert.deepEqual(f.calls[0]?.body, { expectedContentHash: hash, expectedParentSuiteHash: suiteHash }); assert.equal(f.calls[0]?.retries, 0);
});
test('neutral protocol names and truthful readOnly hints; malformed evidence rejected before execute', () => {
  assert.equal(catalogProofTools.length, 5); const read = catalogProofTools.find(t => t.name === 'swfte_catalog_proof')!;
  assert.equal(read.readOnly, true); assert.throws(() => read.inputSchema.parse({ catalogRef: 'workflow:f', contentHash: hash, pass: true }));
  for (const tool of catalogProofTools) { assert.match(tool.name, /^swfte_[a-z_]+$/); if (tool.name.includes('extend') || tool.name.includes('deviation') || tool.name.includes('rerun')) assert.notEqual(tool.readOnly, true); }
});
test('upstream 404,409,503 propagate instead of fabricating an empty success', async () => {
  for (const status of [404, 409, 503]) {
    const error = Object.assign(new Error('dependency'), { status });
    const client = { request: async () => { throw error; } } as unknown as SwfteClient;
    await assert.rejects(getCatalogProof(client, suite.entryRef, hash), e => e === error);
  }
});
