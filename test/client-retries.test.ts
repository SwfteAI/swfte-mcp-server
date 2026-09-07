import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
  test(`${method} does not retry an ambiguous transport failure`, async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('connection reset after commit'); };
    try {
      const client = new SwfteClient(loadConfig({ SWFTE_PAT: 'pat_test' } as never));
      await assert.rejects(client.request({ method, path: '/create' }));
      assert.equal(calls, 1);
    } finally { globalThis.fetch = original; }
  });
}
test('GET still retries a transient response', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response('{}', { status: 503 }) : new Response('{"ok":true}');
  try {
    const client = new SwfteClient(loadConfig({ SWFTE_PAT: 'pat_test' } as never));
    assert.deepEqual(await client.request({ method: 'GET', path: '/status' }), { ok: true });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
