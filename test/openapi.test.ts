import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getOpenApi } from '../src/openapi.js';
import { contractExtraTools } from '../src/tools/contract-extras.js';

test('OpenAPI reads the encoded catalog endpoint and preserves schemas/hash', async () => {
  const calls: unknown[] = [];
  const document = { openapi: '3.1.0', info: { title: 'Test', version: '1' },
    paths: { '/v2/workflows/wf/invoke': { post: { requestBody: { required: true } } } },
    'x-swfte-contract-hash': 'contract-hash' };
  const client = { request: async (request: unknown) => { calls.push(request); return document; } } as never;
  assert.deepEqual(await getOpenApi(client, 'workflow:wf/with?delimiter'), document);
  assert.deepEqual(calls, [{ method: 'GET', path: '/v2/catalog/workflow/wf%2Fwith%3Fdelimiter/openapi' }]);
});

test('Unavailable invocation remains empty instead of inventing an invoke route', async () => {
  const document = { openapi: '3.1.0', info: { title: 'Adopt first', version: '1' }, paths: {},
    'x-swfte-invoke-unavailable': 'adopt first' };
  const tool = contractExtraTools.find(tool => tool.name === 'swfte_get_openapi')!;
  assert.equal(tool.readOnly, true);
  const result = await tool.execute(tool.inputSchema.parse({ ref: 'workflow:public-wf' }),
    { client: { request: async () => document } as never, config: {} as never, localFilesystem: false });
  assert.deepEqual(result, document);
});

test('Unknown kinds fail before any backend call and backend visibility errors propagate', async () => {
  let calls = 0;
  const failure = new Error('not found');
  const client = { request: async () => { calls++; throw failure; } } as never;
  assert.throws(() => getOpenApi(client, 'unknown:artifact'), /Unknown catalog kind/);
  assert.equal(calls, 0);
  await assert.rejects(getOpenApi(client, 'workflow:foreign'), error => error === failure);
  assert.equal(calls, 1);
});
