/**
 * Hosted over HTTP, one process serves many users and the credential arrives per
 * request. If the client were still captured at construction, every caller would act as
 * whichever identity happened to start the server — the quietest possible security bug,
 * since every call still succeeds and simply belongs to the wrong person.
 *
 * These pin the seam: a resolver is consulted per call and receives that call's auth,
 * and the stdio path (no resolver) keeps sharing one client exactly as before.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { buildServer } from '../src/server.js';
import type { ToolDefinition } from '../src/tools/_types.js';
import { z } from 'zod';

const config = () => loadConfig({ SWFTE_PAT: 'pat_test' } as never);

/** A tool that reports which client instance it was handed. */
const probe: ToolDefinition = {
  name: 'probe',
  group: 'core',
  description: 'Returns the credential of the client it received.',
  inputSchema: z.object({}),
  execute: async (_input, { client }) => ({ credential: (client as any).config.credential }),
};

/**
 * Drive one tools/call through the server the way a transport would, and return the
 * decoded result. Reaches the registered handler directly so the test does not need a
 * live transport.
 */
async function callProbe(server: any, authInfo?: unknown) {
  const handler = server._requestHandlers.get('tools/call');
  assert.ok(handler, 'tools/call handler not registered');
  const res = await handler(
    { method: 'tools/call', params: { name: 'probe', arguments: {} } },
    { authInfo }
  );
  return JSON.parse(res.content[0].text);
}

describe('per-request client resolution', () => {
  test('each call gets a client built from its own auth', async () => {
    const server = buildServer({
      config: config(),
      tools: [probe],
      resolveClient: (authInfo) =>
        new SwfteClient({ ...config(), credential: `pat_${(authInfo as any)?.token ?? 'anon'}` }),
    });

    const alice = await callProbe(server, { token: 'alice', clientId: 'c', scopes: [] });
    const bob = await callProbe(server, { token: 'bob', clientId: 'c', scopes: [] });

    // The failure this guards against is both of these coming back the same.
    assert.equal(alice.credential, 'pat_alice');
    assert.equal(bob.credential, 'pat_bob');
  });

  test('the resolver runs per call, not once at construction', async () => {
    let calls = 0;
    const server = buildServer({
      config: config(),
      tools: [probe],
      resolveClient: () => {
        calls += 1;
        return new SwfteClient(config());
      },
    });

    await callProbe(server);
    await callProbe(server);

    assert.equal(calls, 2);
  });

  test('an async resolver is awaited', async () => {
    // Resolving a credential will mean a lookup, so the seam has to take a promise.
    const server = buildServer({
      config: config(),
      tools: [probe],
      resolveClient: async () => new SwfteClient({ ...config(), credential: 'pat_async' }),
    });

    assert.equal((await callProbe(server)).credential, 'pat_async');
  });

  test('without a resolver every call shares one client, as stdio always has', async () => {
    const server = buildServer({ config: config(), tools: [probe] });

    const first = await callProbe(server);
    const second = await callProbe(server);

    assert.equal(first.credential, 'pat_test');
    assert.equal(second.credential, 'pat_test');
  });
});
