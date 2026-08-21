/**
 * The MCP handler returned a correct-looking response with an empty body.
 *
 * `handleRequest` resolves once the status and headers are known, while the body is
 * still streaming. Closing the transport in a `finally` at that point therefore killed
 * the stream mid-write: status 200, right content-type, zero bytes. Nothing threw, so a
 * client saw a protocol timeout with nothing pointing back at the server.
 *
 * Asserting the status is what let this through the first time — it passes either way.
 * These assert the bytes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { createHttpHandler } from '../src/http.js';
import { SwfteClient } from '../src/client.js';

const config = () => loadConfig({ SWFTE_PAT: 'pat_test' } as never);

const initialize = () =>
  new Request('https://mcp.example.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    }),
  });

describe('the handler returns a body, not just a status', () => {
  test('initialize responds with a non-empty body', async () => {
    const handle = createHttpHandler({
      config: config(),
      resolveClient: () => new SwfteClient(config()),
    });

    const res = await handle(initialize());
    const text = await res.text();

    assert.equal(res.status, 200);
    // The regression this guards: 200 with zero bytes.
    assert.ok(text.length > 0, 'response body was empty — the transport was closed before the stream finished');
    assert.match(text, /"protocolVersion"/, `body did not carry an initialize result: ${text.slice(0, 200)}`);
  });

  test('the body survives a second, independent request', async () => {
    // Each request builds its own transport; closing one must not affect the next.
    const handle = createHttpHandler({
      config: config(),
      resolveClient: () => new SwfteClient(config()),
    });

    const first = await (await handle(initialize())).text();
    const second = await (await handle(initialize())).text();

    assert.ok(first.length > 0 && second.length > 0, 'a request returned an empty body');
  });
});
