/**
 * Redirects (review r-mcp R3): a 302 from the configured host must not carry the
 * credential to another origin. Two real local servers; B records everything it receives.
 * Named `G4:` after its ledger gate; fails against origin/master (B receives X-API-Key).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

import { SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';

const received: Array<Record<string, unknown>> = [];
let a: Server;
let b: Server;
let aPort = 0;
let bPort = 0;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

before(async () => {
  b = createServer((req, res) => {
    received.push({ url: req.url, authorization: req.headers['authorization'], xApiKey: req.headers['x-api-key'], workspace: req.headers['x-workspace-id'] });
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  bPort = await listen(b);
  a = createServer((req, res) => {
    res.statusCode = 302;
    res.setHeader('location', `http://localhost:${bPort}/stolen`);
    res.end();
  });
  aPort = await listen(a);
});
after(() => {
  a.close();
  b.close();
});
beforeEach(() => {
  received.length = 0;
});

const clients = () =>
  [
    ['api-key', { SWFTE_API_KEY: 'sk-swfte-TESTKEY123456', SWFTE_WORKSPACE_ID: 'ws1' }],
    ['pat', { SWFTE_PAT: 'pat_TESTPAT123456', SWFTE_WORKSPACE_ID: 'ws1' }],
  ] as const;
const make = (env: Record<string, string>) => new SwfteClient(loadConfig({ ...env, SWFTE_BASE_URL: `http://127.0.0.1:${aPort}`, SWFTE_TELEMETRY: '0' } as never));

describe('redirects never carry credentials to another origin (R3)', () => {
  for (const [label, env] of clients()) {
    test(`G4: cross-origin redirect leaks no credential headers (${label}) - request`, async () => {
      await assert.rejects(make(env).request({ method: 'GET', path: '/x' }), /redirect|302/i);
      assert.deepEqual(received, [], 'the second server was never contacted');
    });
    test(`G4: cross-origin redirect leaks no credential headers (${label}) - getBinary`, async () => {
      await assert.rejects(make(env).getBinary('/x'), /redirect|302/i);
      assert.deepEqual(received, []);
    });
    test(`G4: cross-origin redirect leaks no credential headers (${label}) - postMultipart`, async () => {
      await assert.rejects(make(env).postMultipart('/x', new FormData()), /redirect|302/i);
      assert.deepEqual(received, []);
    });
  }
});
