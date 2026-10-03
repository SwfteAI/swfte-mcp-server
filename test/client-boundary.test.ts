import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';

test('client rejects insecure remote transport, tenant overrides and auth-header substitutions before fetch', async () => {
  const cfg = loadConfig({ SWFTE_API_KEY: 'sk-swfte-fixture', SWFTE_WORKSPACE_ID: 'owned', SWFTE_TELEMETRY: '0' });
  const unsafe = new SwfteClient({ ...cfg, baseUrl: 'http://api.swfte.com' });
  await assert.rejects(unsafe.request({ method: 'GET', path: '/v2/prove/verdict', retries: 0 }), /HTTPS/);
  const client = new SwfteClient(cfg);
  for (const name of ['Authorization', 'authorization', 'X-API-Key', 'x-workspace-id']) {
    await assert.rejects(client.request({ method: 'POST', path: '/v2/prove/source', headers: { [name]: 'foreign' }, retries: 0 }), /configured identity/);
  }
  await assert.rejects(client.request({ method: 'POST', path: '/v2/prove/source', workspaceId: 'foreign', retries: 0 }), /configured identity/);
});

test('real HTTP redirect cannot forward configured credentials', async () => {
  let targetHits = 0;
  const server = createServer((req, res) => { if (req.url === '/source') { res.writeHead(302, { Location: '/target' }); res.end(); }
    else { targetHits++; res.end('{}'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    const cfg = loadConfig({ SWFTE_PAT: 'pat_fixture', SWFTE_BASE_URL: `http://127.0.0.1:${address.port}`, SWFTE_TELEMETRY: '0' });
    await assert.rejects(new SwfteClient(cfg).request({ method: 'GET', path: '/source', retries: 0 }));
    assert.equal(targetHits, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
