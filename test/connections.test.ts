/**
 * A workflow whose integration nodes have no credential publishes clean, verifies
 * clean, and then fails at the first integration node — the credential is only
 * consulted when the node runs. These pin the three things that turn that from an
 * opaque runtime failure into "connect Notion and this will work": the connect
 * tools are advertised at all, a run does not spend a metered execution on a run
 * that cannot succeed, and an explicit provider hint is actually read.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { loadConfig, DEFAULT_GROUPS } from '../src/config.js';
import { LOCAL_STEPS_PATH } from '../src/learning-contract.js';
import { SwfteApiError, SwfteClient, type RequestOptions } from '../src/client.js';
import { allTools } from '../src/tools/index.js';
import { buildServer, selectTools } from '../src/server.js';
import { shipTools } from '../src/tools/ship.js';
import { connectedProviders, inspectConnections, requiredConnections, type ConnectionHandle } from '../src/connections.js';
import { connectTools } from '../src/tools/connect.js';
import { verifyTools } from '../src/tools/verify.js';

const NODE_CATALOG = '/v2/workflows/nodes/catalog';
const OAUTH_INTEGRATIONS = '/v1/secrets/oauth/integrations';

/**
 * A client that answers only the three reads this path makes. Anything else
 * throws, so a test cannot pass by accidentally hitting the network.
 */
function fakeClient(opts: {
  catalog?: Array<{ type?: string; code?: string; oauthProvider?: string }>;
  connected?: Record<string, unknown[]>;
  workflow?: unknown;
}) {
  const client = new SwfteClient(loadConfig({ SWFTE_PAT: 'pat_test' } as never));
  (client as any).request = async ({ path }: { path: string }) => {
    if (path === NODE_CATALOG) return opts.catalog ?? [];
    if (path === OAUTH_INTEGRATIONS) return { integrations: opts.connected ?? {} };
    if (path.startsWith('/v2/workflows/')) return opts.workflow ?? {};
    throw new Error(`unexpected request to ${path}`);
  };
  return client;
}

const runTool = () => {
  const t = shipTools.find((x) => x.name === 'swfte_run');
  assert.ok(t, 'missing swfte_run');
  return t;
};

describe('the connect tools are reachable', () => {
  test('connect is advertised by default', () => {
    // Hidden, an agent cannot repair or even name a missing credential, so the
    // sign-in prompt this whole path exists for can never happen.
    assert.ok(DEFAULT_GROUPS.includes('connect'));
  });

  test('the default surface actually carries the sign-in tools', () => {
    const names = selectTools(allTools, loadConfig({ SWFTE_PAT: 'pat_test' } as never)).map((t) => t.name);
    assert.ok(names.includes('swfte_connect_start'));
    assert.ok(names.includes('swfte_connections_check'));
  });
});

const CONNECTIONS = '/v2/connections';
const AUTO_BIND = CONNECTIONS + '/auto-bind';
const CANARY = ['meadow', 'willow', 'amber', 'fern'][randomInt(4)] + ' '
  + ['granite', 'river', 'sparrow', 'orchard'][randomInt(4)];

function connection(id: string, provider = 'google', status: ConnectionHandle['status'] = 'HEALTHY'): ConnectionHandle {
  return { connectionId: id, provider, label: 'Fixture connection', authType: 'oauth', status,
    scope: 'WORKSPACE', lastUsedAt: 100, lastCheckedAt: 200, degraded: false, dependents: [] };
}

function autoBound(nodeId: string, provider: string, id: string, alternatives: ConnectionHandle[] = []) {
  return { nodeId, field: 'credentialId', provider, outcome: 'AUTO_BOUND', connectionId: id,
    alternatives, choiceVisible: alternatives.length > 0, reason: 'NONE' };
}

function needsConnection(nodeId: string, provider: string, reason = 'NONE', alternatives: ConnectionHandle[] = []) {
  return { nodeId, field: 'credentialId', provider, outcome: 'NEEDS_CONNECTION',
    alternatives, choiceVisible: false, reason };
}

function apiFailure(status: number, path = CONNECTIONS): SwfteApiError {
  return new SwfteApiError({ status, code: 'fixture_error', message: CANARY,
    envelope: { accessToken: CANARY }, reason: CANARY, method: 'GET', path });
}

function serverClient(options: {
  handles?: unknown;
  autoBind?: unknown;
  inventoryError?: unknown;
  bindError?: unknown;
  legacyCatalog?: unknown;
  legacyIntegrations?: unknown;
  workflow?: unknown;
  enabled?: string;
} = {}) {
  const config = loadConfig({ SWFTE_PAT: 'pat_test', SWFTE_WORKSPACE_ID: 'ws-a',
    SWFTE_MCP_SERVER_CONNECTIONS: options.enabled ?? 'true' } as NodeJS.ProcessEnv);
  const client = new SwfteClient(config);
  const requests: RequestOptions[] = [];
  client.request = async <T>(request: RequestOptions): Promise<T> => {
    // Learning-loop step delivery (parallel/learning-loop-mcp) posts here for a call that made no counted
    // request; the fixture accepts it so the queue-empty assertions below measure the connections tools only.
    if (request.path === LOCAL_STEPS_PATH) return {} as T;
    // The artifact setup route (promotion-confidence-setup branch) is probed first by swfte_connections_check.
    // These fixtures model a server without it (404), so the check falls through to the connections routes;
    // the probe is deliberately not logged so the existing exact-request assertions keep their meaning.
    if (/\/v2\/artifacts\/[^/]+\/[^/]+\/setup$/.test(request.path)) {
      throw new SwfteApiError({ status: 404, code: 'NOT_FOUND', message: 'not found', method: request.method, path: request.path });
    }
    requests.push(request);
    if (request.path === CONNECTIONS) {
      if (options.inventoryError !== undefined) throw options.inventoryError;
      return (options.handles ?? []) as T;
    }
    if (request.path === AUTO_BIND) {
      if (options.bindError !== undefined) throw options.bindError;
      return (options.autoBind ?? { bindings: [] }) as T;
    }
    if (request.path === NODE_CATALOG) return (options.legacyCatalog ?? []) as T;
    if (request.path === OAUTH_INTEGRATIONS) return (options.legacyIntegrations ?? { integrations: {} }) as T;
    if (request.path === '/v2/workflows/w1') return (options.workflow ?? { id: 'w1', nodes: [] }) as T;
    throw new Error('unexpected-request:' + request.method + ':' + request.path);
  };
  return { client, config, requests };
}

function connectTool(name: string) {
  const tool = connectTools.find(item => item.name === name);
  assert.ok(tool, 'missing tool ' + name);
  return tool;
}

function assertSanitized(error: unknown, status?: number) {
  assert.ok(error instanceof SwfteApiError);
  if (status !== undefined) assert.equal(error.status, status);
  const output = JSON.stringify(error.toJSON());
  assert.ok(!output.includes(CANARY), output);
  assert.ok(!output.includes('accessToken'), output);
  assert.ok(!output.includes('refreshToken'), output);
  return true;
}

describe('the server Connections flag is scoped and default off', () => {
  test('unset and every false spelling preserve inherited endpoint behavior', async () => {
    for (const value of [undefined, '', '0', 'false', 'off', 'no']) {
      const config = loadConfig({ SWFTE_PAT: 'pat_test', ...(value === undefined ? {} : { SWFTE_MCP_SERVER_CONNECTIONS: value }) });
      assert.equal(config.serverConnections, false);
      const fixture = serverClient({ enabled: value ?? '', legacyCatalog: [{ type: 'NOTION', oauthProvider: 'notion' }] });
      const result = await requiredConnections(fixture.client, { nodes: [{ id: 'n', type: 'NOTION' }] });
      assert.equal(result[0]?.connected, false);
      assert.ok(fixture.requests.every(request => !request.path.startsWith(CONNECTIONS)));
    }
  });

  test('true values configure a client without reading later process environment changes', () => {
    for (const value of ['1', 'true', 'TRUE', 'on', 'yes']) {
      const on = loadConfig({ SWFTE_PAT: 'pat_test', SWFTE_MCP_SERVER_CONNECTIONS: value });
      const off = loadConfig({ SWFTE_PAT: 'pat_test' });
      assert.equal(new SwfteClient(on).serverConnectionsEnabled, true);
      assert.equal(new SwfteClient(off).serverConnectionsEnabled, false);
    }
  });

  test('default registration preserves the same existing connect tool names', () => {
    const fixture = serverClient();
    const names = selectTools(allTools, fixture.config).filter(tool => tool.group === 'connect').map(tool => tool.name).sort();
    assert.ok(names.includes('swfte_connections_list'));
    assert.ok(names.includes('swfte_connections_check'));
    assert.ok(names.includes('swfte_connect_start'));
    assert.ok(names.includes('swfte_connect_wait'));
  });
});

describe('server-authoritative needs and bindings', () => {
  const batteries = [
    {
      name: 'the google-youtube alias uses the server canonical google provider',
      handles: [connection('google-choice')],
      rows: [autoBound('youtube-node', 'google', 'google-choice')],
    },
    {
      name: 'an expired stored Slack reference remains explicit',
      handles: [connection('slack-expired', 'slack', 'EXPIRED')],
      rows: [needsConnection('slack-node', 'slack', 'EXPIRED', [connection('slack-expired', 'slack', 'EXPIRED')])],
    },
    {
      name: 'a provider with no healthy handle reports the server need',
      handles: [connection('notion-unknown', 'notion', 'UNKNOWN')],
      rows: [needsConnection('notion-node', 'notion')],
    },
  ];
  for (const battery of batteries) test(battery.name, async () => {
    const fixture = serverClient({ handles: battery.handles, autoBind: { bindings: battery.rows } });
    const result: any = await connectTool('swfte_connections_check').execute({ workflowId: 'w1' }, fixture);
    assert.equal(result.source, 'server');
    assert.deepEqual(result.bindings, battery.rows);
    assert.deepEqual(result.needs, battery.rows.map(({ nodeId, field, provider }) => ({ nodeId, field, provider })));
    assert.equal(result.ok, battery.rows.every(row => row.outcome === 'AUTO_BOUND'));
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS, AUTO_BIND]);
    assert.deepEqual(fixture.requests[1]?.body, { workflowId: 'w1' });
    assert.ok(fixture.requests.every(request => request.workspaceId === 'ws-a' && request.retries === 0));
  });

  test('a graph hint and local last-used ranking cannot replace the actual server choice', async () => {
    const first = { ...connection('locally-recent'), lastUsedAt: 9999 };
    const selected = { ...connection('server-current'), lastUsedAt: 1 };
    const row = autoBound('youtube', 'google', selected.connectionId, [first]);
    const fixture = serverClient({ handles: [first, selected], autoBind: { bindings: [row] },
      legacyCatalog: [{ type: 'YOUTUBE', oauthProvider: 'google-youtube' }] });
    const inspection = await inspectConnections(fixture.client,
      { id: 'w1', nodes: [{ id: 'invented', type: 'YOUTUBE', configuration: { oauthProvider: 'google-youtube' } }] }, 'w1');
    assert.deepEqual(inspection.bindings, [row]);
    assert.deepEqual(inspection.needs, [{ nodeId: 'youtube', field: 'credentialId', provider: 'google' }]);
    assert.deepEqual(inspection.requirements, [{ provider: 'google', nodeIds: ['youtube'], nodeTypes: [], connected: true }]);
    assert.ok(fixture.requests.every(request => ![NODE_CATALOG, OAUTH_INTEGRATIONS].includes(request.path)));
  });

  test('one unresolved node keeps the provider unresolved without losing either server binding', async () => {
    const rows = [autoBound('working-node', 'google', 'google-choice'), needsConnection('missing-node', 'google', 'DANGLING')];
    const fixture = serverClient({ handles: [connection('google-choice')], autoBind: { bindings: rows } });
    const result: any = await connectTool('swfte_connections_check').execute({ workflowId: 'w1' }, fixture);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['google']);
    assert.deepEqual(result.bindings, rows);
    assert.deepEqual(result.requires[0].nodes, ['working-node', 'missing-node']);
  });

  test('a real empty auto-bind response is preserved without catalog inference', async () => {
    const fixture = serverClient({ legacyCatalog: [{ type: 'SLACK', oauthProvider: 'slack' }] });
    const result: any = await connectTool('swfte_connections_check').execute({ workflowId: 'w1' }, fixture);
    assert.deepEqual(result.needs, []);
    assert.deepEqual(result.bindings, []);
    assert.equal(result.ok, true);
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS, AUTO_BIND]);
  });

  test('listing returns safe actual handles and UNKNOWN is never counted as a connected provider', async () => {
    const handles = [connection('google-healthy'), connection('slack-unknown', 'slack', 'UNKNOWN'), connection('notion-revoked', 'notion', 'REVOKED')];
    const fixture = serverClient({ handles });
    const result: any = await connectTool('swfte_connections_list').execute({}, fixture);
    assert.equal(result.source, 'server');
    assert.deepEqual(result.connections, handles);
    assert.deepEqual(result.connected, ['google']);
    assert.equal(result.connectedCount, 1);
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS]);
  });

  test('native provider slugs retain their canonical separators without inherited normalization', async () => {
    const fixture = serverClient({ handles: [connection('canonical', 'token-exchange')] });
    const result: any = await connectTool('swfte_connections_list').execute({}, fixture);
    assert.deepEqual(result.connected, ['token-exchange']);
    assert.deepEqual(result.connections[0].provider, 'token-exchange');
  });

  test('handle responses and health are read again on every check, with no response cache', async () => {
    const fixture = serverClient();
    let reads = 0;
    fixture.client.request = async <T>(request: RequestOptions): Promise<T> => {
      assert.equal(request.path, CONNECTIONS);
      return [connection('google-choice', 'google', reads++ === 0 ? 'HEALTHY' : 'UNKNOWN')] as T;
    };
    assert.deepEqual([...await connectedProviders(fixture.client)], ['google']);
    assert.deepEqual([...await connectedProviders(fixture.client)], []);
    assert.equal(reads, 2);
  });
});

describe('only actual route404 permits legacy fallback', () => {
  test('a genuine missing inventory route uses inherited aliases and selected workspace', async () => {
    const fixture = serverClient({ inventoryError: apiFailure(404),
      workflow: { id: 'w1', nodes: [{ id: 'sheet', type: 'GOOGLE_SHEETS' }] },
      legacyCatalog: [{ type: 'GOOGLE_SHEETS', oauthProvider: 'google-sheets' }],
      legacyIntegrations: { integrations: { 'Google Sheets': [{ provider: 'google-sheets' }] } } });
    const result: any = await connectTool('swfte_connections_check').execute({ workflowId: 'w1' }, fixture);
    assert.equal(result.ok, true);
    assert.equal(result.requires[0].provider, 'google-sheets');
    assert.equal(result.bindings, undefined);
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS, '/v2/workflows/w1', NODE_CATALOG, OAUTH_INTEGRATIONS]);
    assert.equal(fixture.requests[1]?.workspaceId, 'ws-a');
    assert.ok(fixture.requests.every(request => request.path !== AUTO_BIND));
  });

  for (const status of [401, 403, 408, 429, 500, 503]) test('inventory' + status + ' refuses instead of deriving or reporting healthy', async () => {
    const fixture = serverClient({ inventoryError: apiFailure(status) });
    await assert.rejects(connectTool('swfte_connections_check').execute({ workflowId: 'w1' }, fixture), error => assertSanitized(error, status));
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS]);
  });

  test('an arbitrary thrown object with a404-looking property does not enable fallback', async () => {
    const fixture = serverClient({ inventoryError: Object.assign(new Error(CANARY), { status: 404 }) });
    await assert.rejects(requiredConnections(fixture.client, undefined, 'w1'), error => assertSanitized(error, 503));
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS]);
  });

  for (const status of [401, 403, 404, 503]) test('auto-bind' + status + ' is a workflow refusal after inventory established the native route', async () => {
    const fixture = serverClient({ bindError: apiFailure(status, AUTO_BIND) });
    await assert.rejects(requiredConnections(fixture.client, undefined, 'w1'), error => assertSanitized(error, status));
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS, AUTO_BIND]);
  });

  test('legacy auth failure after an allowed404 fallback cannot become an empty healthy requirement list', async () => {
    const fixture = serverClient({ inventoryError: apiFailure(404) });
    const inherited = fixture.client.request;
    fixture.client.request = async <T>(request: RequestOptions): Promise<T> => {
      if (request.path === NODE_CATALOG) throw apiFailure(403, NODE_CATALOG);
      return inherited<T>(request);
    };
    await assert.rejects(connectTool('swfte_connections_check').execute({ workflowId: 'w1' }, fixture), error => assertSanitized(error, 403));
    assert.ok(fixture.requests.every(request => request.path !== AUTO_BIND));
  });

  for (const workflow of [
    { id: 'another-workflow', workspaceId: 'ws-a', nodes: [] },
    { id: 'w1', workspaceId: 'foreign-workspace', nodes: [] },
  ]) test('fallback refuses a saved workflow with mismatched identity ' + workflow.workspaceId + '/' + workflow.id, async () => {
    const fixture = serverClient({ inventoryError: apiFailure(404), workflow });
    await assert.rejects(connectTool('swfte_connections_check').execute({ workflowId: 'w1' }, fixture), error => assertSanitized(error, 502));
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS, '/v2/workflows/w1']);
  });

  for (const [name, options] of [
    ['missing workflow graph', { workflow: { id: 'w1' } }],
    ['malformed inherited catalog', { legacyCatalog: { error: CANARY } }],
    ['malformed inherited inventory', { legacyIntegrations: { integrations: { Slack: CANARY } } }],
  ] as const) test('an allowed route404 still refuses ' + name, async () => {
    const fixture = serverClient({ inventoryError: apiFailure(404), ...options });
    await assert.rejects(connectTool('swfte_connections_check').execute({ workflowId: 'w1' }, fixture), error => assertSanitized(error, 502));
  });
});

describe('native response validation and secret canary controls', () => {
  for (const [name, body] of [
    ['bodyless', undefined], ['nonJSON', CANARY], ['envelope', { integrations: {} }],
    ['missing status', [{ ...connection('one'), status: undefined }]],
    ['invalid status', [{ ...connection('one'), status: 'SUCCESS' }]],
    ['invalid scope', [{ ...connection('one'), scope: 'GLOBAL' }]],
    ['nonfinite timestamp', [{ ...connection('one'), lastUsedAt: NaN }]],
    ['duplicate handles', [connection('one'), connection('one')]],
    ['foreign workspace marker', [{ ...connection('one'), workspaceId: 'ws-b' }]],
  ] as const) test('inventory refuses ' + name + ' without echo', async () => {
    const fixture = serverClient();
    fixture.client.request = async <T>(): Promise<T> => body as T;
    await assert.rejects(connectTool('swfte_connections_list').execute({}, fixture), error => assertSanitized(error, 502));
  });

  for (const key of ['accessToken', 'refreshToken', 'secret', 'value', 'password', 'client_secret', 'secretAccessKey', 'api_key', 'privateKey']) {
    test('a ' + key + ' canary anywhere in a handle is refused before result serialization', async () => {
      const fixture = serverClient({ handles: [{ ...connection('one'), extra: { [key]: CANARY } }] });
      await assert.rejects(connectTool('swfte_connections_list').execute({}, fixture), error => assertSanitized(error, 502));
    });
  }

  test('unknown noncredential wire fields are projected away without copying their canary content', async () => {
    const fixture = serverClient({ handles: [{ ...connection('one'), unsupportedMetadata: CANARY }] });
    const result: any = await connectTool('swfte_connections_list').execute({}, fixture);
    assert.deepEqual(result.connections, [connection('one')]);
    assert.ok(!JSON.stringify(result).includes(CANARY));
  });

  const chosen = connection('chosen');
  const alternative = connection('alternative');
  for (const [name, row] of [
    ['foreign selected id', autoBound('n', 'google', 'foreign')],
    ['provider mismatch', autoBound('n', 'slack', 'chosen')],
    ['hidden multiple choice', { ...autoBound('n', 'google', 'chosen', [alternative]), choiceVisible: false }],
    ['selected id in alternatives', autoBound('n', 'google', 'chosen', [chosen])],
    ['foreign alternative', autoBound('n', 'google', 'chosen', [connection('foreign')])],
    ['duplicate alternatives', autoBound('n', 'google', 'chosen', [alternative, alternative])],
    ['claimed missing selection', { ...needsConnection('n', 'google'), connectionId: 'chosen' }],
    ['unknown outcome', { ...autoBound('n', 'google', 'chosen'), outcome: 'READY' }],
    ['credential canary', { ...autoBound('n', 'google', 'chosen'), extra: { accessToken: CANARY } }],
  ] as const) test('auto-bind refuses ' + name, async () => {
    const fixture = serverClient({ handles: [chosen, alternative], autoBind: { bindings: [row] } });
    await assert.rejects(requiredConnections(fixture.client, undefined, 'w1'), error => assertSanitized(error, 502));
  });

  test('a server-selected UNKNOWN handle cannot establish an AUTO_BOUND result', async () => {
    const fixture = serverClient({ handles: [connection('unknown', 'google', 'UNKNOWN')],
      autoBind: { bindings: [autoBound('n', 'google', 'unknown')] } });
    await assert.rejects(requiredConnections(fixture.client, undefined, 'w1'), error => assertSanitized(error, 502));
  });

  test('duplicate node/field tuples are refused rather than silently collapsed', async () => {
    const fixture = serverClient({ handles: [chosen], autoBind: { bindings: [autoBound('n', 'google', 'chosen'), autoBound('n', 'google', 'chosen')] } });
    await assert.rejects(requiredConnections(fixture.client, undefined, 'w1'), error => assertSanitized(error, 502));
  });

  test('a malformed auto-bind envelope cannot become a credential-free workflow', async () => {
    for (const body of [undefined, {}, [], { needs: [] }, { bindings: CANARY }]) {
      const fixture = serverClient();
      const inherited = fixture.client.request;
      fixture.client.request = async <T>(request: RequestOptions): Promise<T> =>
        request.path === AUTO_BIND ? body as T : inherited<T>(request);
      await assert.rejects(requiredConnections(fixture.client, undefined, 'w1'), error => assertSanitized(error, 502));
    }
  });
});

describe('actual client workspace transport and debug secrecy', () => {
  test('both native reads retain the API-key workspace and auto-bind sends only the authoritative workflow id', async t => {
    const config = loadConfig({ SWFTE_API_KEY: 'sk_fixture', SWFTE_WORKSPACE_ID: 'selected-ws',
      SWFTE_MCP_SERVER_CONNECTIONS: 'true', SWFTE_TELEMETRY: 'false' });
    const client = new SwfteClient(config);
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      // Server without the artifact setup route (see the fixture above): probe answers 404, unlogged.
      if (/\/v2\/artifacts\/[^/]+\/[^/]+\/setup$/.test(path)) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      requests.push({ path, init });
      if (path.endsWith(CONNECTIONS)) return Response.json([connection('server-choice')]);
      assert.ok(path.endsWith(AUTO_BIND));
      return Response.json({ bindings: [autoBound('server-node', 'google', 'server-choice')] });
    });
    const result: any = await connectTool('swfte_connections_check').execute({ workflowId: 'w1' }, { client, config });
    assert.equal(result.ok, true);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => new Headers(request.init?.headers).get('X-Workspace-ID') === 'selected-ws'));
    assert.equal(requests[0]?.init?.method, 'GET');
    assert.equal(requests[1]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { workflowId: 'w1' });
    assert.equal(client.pendingLocalSteps.queued, 0);
  });

  test('a PAT retains its server tenant binding without a caller workspace override on either native read', async t => {
    const config = loadConfig({ SWFTE_PAT: 'pat_fixture', SWFTE_WORKSPACE_ID: 'selected-ws',
      SWFTE_MCP_SERVER_CONNECTIONS: 'true', SWFTE_TELEMETRY: 'false' });
    const client = new SwfteClient(config);
    const headers: Headers[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      if (/\/v2\/artifacts\/[^/]+\/[^/]+\/setup$/.test(new URL(String(url)).pathname)) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      headers.push(new Headers(init?.headers));
      return new URL(String(url)).pathname.endsWith(CONNECTIONS) ? Response.json([]) : Response.json({ bindings: [] });
    });
    await connectTool('swfte_connections_check').execute({ workflowId: 'w1' }, { client, config });
    assert.equal(headers.length, 2);
    assert.ok(headers.every(value => value.get('Authorization') === 'Bearer pat_fixture'
      && !value.has('X-Workspace-ID') && !value.has('X-API-Key')));
  });

  test('API-key requests retain the configured workspace and never log leaked response fields', async t => {
    const config = loadConfig({ SWFTE_API_KEY: 'sk_fixture', SWFTE_WORKSPACE_ID: 'selected-ws',
      SWFTE_MCP_SERVER_CONNECTIONS: 'true', SWFTE_DEBUG: 'true', SWFTE_TELEMETRY: 'false' });
    const client = new SwfteClient(config);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const logs: string[] = [];
    t.mock.method(process.stderr, 'write', (value: string | Uint8Array) => { logs.push(String(value)); return true; });
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json([{ ...connection('one'), nested: { accessToken: CANARY } }]);
    });
    await assert.rejects(connectTool('swfte_connections_list').execute({}, { client, config }), error => assertSanitized(error, 502));
    assert.equal(requests.length, 1);
    assert.equal(new Headers(requests[0]?.init?.headers).get('X-Workspace-ID'), 'selected-ws');
    assert.ok(logs.length > 0, 'positive debug control must actually capture logs');
    assert.ok(!logs.join('').includes(CANARY));
    assert.equal(client.pendingLocalSteps.queued, 0);
  });

  test('a workspace API key without a selected workspace refuses before any request', async () => {
    const config = loadConfig({ SWFTE_API_KEY: 'sk_fixture', SWFTE_MCP_SERVER_CONNECTIONS: 'true' });
    const client = new SwfteClient(config);
    client.request = async () => { assert.fail('no request may start without the selected workspace'); };
    await assert.rejects(connectedProviders(client), error => assertSanitized(error, 503));
  });
});

describe('registered MCP response boundary', () => {
  for (const mode of ['server-choice', 'refusal-canary'] as const) test('actual MCP serialization preserves ' + mode, async () => {
    const row = autoBound('server-node', 'google', 'selected', [connection('alternative')]);
    const fixture = serverClient(mode === 'server-choice'
      ? { handles: [connection('selected'), connection('alternative')], autoBind: { bindings: [row] } }
      : { bindError: apiFailure(403, AUTO_BIND) });
    fixture.config.telemetry = false;
    const server = buildServer({ config: fixture.config, resolveClient: () => fixture.client });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'connections-contract-fixture', version: '1.0.0' });
    try {
      await server.connect(serverSide);
      await mcp.connect(clientSide);
      const listed = await mcp.listTools();
      assert.ok(listed.tools.some(tool => tool.name === 'swfte_connections_check'));
      const reply = await mcp.callTool({ name: 'swfte_connections_check', arguments: { workflowId: 'w1' } });
      const first = (reply.content as Array<{ type: string; text?: string }>)[0];
      assert.equal(first?.type, 'text');
      const body = JSON.parse(first!.text!);
      if (mode === 'server-choice') {
        assert.ok(!reply.isError);
        assert.deepEqual(body.bindings, [row]);
        assert.deepEqual(body.needs, [{ nodeId: 'server-node', field: 'credentialId', provider: 'google' }]);
      } else {
        assert.equal(reply.isError, true);
        assert.equal(body.status, 403);
        assert.ok(!JSON.stringify(reply).includes(CANARY));
        assert.ok(!JSON.stringify(reply).includes('accessToken'));
      }
      assert.equal(fixture.client.pendingLocalSteps.queued, 0);
    } finally {
      await mcp.close();
      await server.close();
    }
  });
});

describe('native optional sign-in refuses malformed or credential-bearing authorization results', () => {
  for (const [name, response] of [
    ['bodyless', undefined], ['empty', {}],
    ['missing state', { authorizationUrl: 'https://oauth.example.invalid/authorize' }],
    ['executable URL', { authorizationUrl: 'javascript:alert(1)', state: 'pending' }],
    ['credential URL', { authorizationUrl: 'https://user:password@oauth.example.invalid/authorize', state: 'pending' }],
    ['token query', { authorizationUrl: 'https://oauth.example.invalid/authorize?access_token=' + encodeURIComponent(CANARY), state: 'pending' }],
  ] as const) test('a ' + name + ' start refuses before opening a browser or reporting a started connection', async () => {
    const fixture = serverClient({ autoBind: { bindings: [needsConnection('slack-node', 'slack')] } });
    const inherited = fixture.client.request;
    fixture.client.request = async <T>(request: RequestOptions): Promise<T> =>
      request.path === '/v2/oauth/connect/slack' ? response as T : inherited<T>(request);
    await assert.rejects(connectTool('swfte_connections_check').execute({ workflowId: 'w1', connect: true }, fixture), error => assertSanitized(error, 503));
  });

  test('a declined start projects fixed copy instead of its credential-bearing error envelope', async () => {
    const fixture = serverClient({ autoBind: { bindings: [needsConnection('slack-node', 'slack')] } });
    const inherited = fixture.client.request;
    fixture.client.request = async <T>(request: RequestOptions): Promise<T> => request.path === '/v2/oauth/connect/slack'
      ? { error: CANARY, accessToken: CANARY } as T : inherited<T>(request);
    const result: any = await connectTool('swfte_connections_check').execute({ workflowId: 'w1', connect: true }, fixture);
    assert.equal(result.ok, false);
    assert.deepEqual(result.connectAttempt, { provider: 'slack', started: false, error: 'CONNECTION_START_REFUSED' });
    assert.ok(!JSON.stringify(result).includes(CANARY));
  });
});

describe('server refusal prevents downstream run, verification and shipping credit', () => {
  for (const force of [false, true]) test('a v2 missing connection blocks run even force=' + force, async () => {
    const fixture = serverClient({ autoBind: { bindings: [needsConnection('n', 'slack')] } });
    const inherited = fixture.client.request;
    fixture.client.request = async <T>(request: RequestOptions): Promise<T> => {
      assert.ok([CONNECTIONS, AUTO_BIND].includes(request.path), 'unresolved admission must prevent any downstream run request');
      return inherited<T>(request);
    };
    const result: any = await runTool().execute({ kind: 'workflow', id: 'w1', force }, fixture);
    assert.equal(result.ran, false);
    assert.equal(result.blocked, 'MISSING_CONNECTIONS');
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS, AUTO_BIND]);
  });

  for (const force of [false, true]) test('v2 unavailability prevents a metered run even force=' + force, async () => {
    const fixture = serverClient({ inventoryError: apiFailure(503) });
    await assert.rejects(runTool().execute({ kind: 'workflow', id: 'w1', force }, fixture), error => assertSanitized(error, 503));
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS]);
  });

  test('verify run:true refuses before the adapter executes and never credits an unavailable check as skipped', async () => {
    const fixture = serverClient({ bindError: apiFailure(403, AUTO_BIND) });
    const tool = verifyTools.find(item => item.name === 'swfte_verify');
    assert.ok(tool);
    await assert.rejects(tool.execute({ kind: 'workflow', id: 'w1', run: true }, fixture), error => assertSanitized(error, 403));
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS, AUTO_BIND]);
  });

  test('verify with unresolved server needs returns failure without starting its run sweep', async () => {
    const fixture = serverClient({ autoBind: { bindings: [needsConnection('n', 'slack')] } });
    const tool = verifyTools.find(item => item.name === 'swfte_verify');
    assert.ok(tool);
    const result: any = await tool.execute({ kind: 'workflow', id: 'w1', run: true }, fixture);
    assert.equal(result.ok, false);
    assert.equal(result.ran, false);
    assert.equal(result.checks[0].ok, false);
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS, AUTO_BIND]);
  });

  test('confirmed deploy cannot bypass server needs with skipPreflight/force', async () => {
    const fixture = serverClient({ autoBind: { bindings: [needsConnection('n', 'slack')] } });
    fixture.config.allowDeploy = true;
    const tool = shipTools.find(item => item.name === 'swfte_deploy');
    assert.ok(tool);
    const result: any = await tool.execute({ kind: 'workflow', id: 'w1', confirm: true, action: 'deploy', skipPreflight: true, force: true }, fixture);
    assert.equal(result.refused, true);
    assert.equal(result.reason, 'MISSING_CONNECTIONS');
    assert.deepEqual(fixture.requests.map(request => request.path), [CONNECTIONS, AUTO_BIND]);
  });
});

describe('provider inference', () => {
  test('reads an explicit hint under the canonical configuration key', async () => {
    // `configuration` is what the API stores and returns. Reading only `config`
    // meant the hint was silently ignored on any persisted workflow.
    const client = fakeClient({
      catalog: [], // deliberately empty: only the explicit hint can resolve this
      connected: {},
      workflow: {},
    });

    const required = await requiredConnections(client, {
      nodes: [{ id: 'n1', type: 'HTTP_REQUEST', configuration: { oauthProvider: 'notion' } }],
    });

    assert.equal(required.length, 1);
    assert.equal(required[0]!.provider, 'notion');
    assert.equal(required[0]!.connected, false);
  });

  test('still honours the frontend-side config spelling', async () => {
    const client = fakeClient({ catalog: [], connected: {} });

    const required = await requiredConnections(client, {
      nodes: [{ id: 'n1', type: 'HTTP_REQUEST', config: { oauthProvider: 'slack' } }],
    });

    assert.equal(required[0]?.provider, 'slack');
  });

  test('a connected provider is matched across naming styles', async () => {
    // The catalog says `google-sheets`; the stored secret is grouped under the
    // display name `Google Sheets`. A mismatch here reads as "not connected"
    // for a provider that plainly is.
    const client = fakeClient({
      catalog: [{ type: 'GOOGLE_SHEETS', oauthProvider: 'google-sheets' }],
      connected: { 'Google Sheets': [{ provider: 'google-sheets' }] },
    });

    const required = await requiredConnections(client, {
      nodes: [{ id: 'sheets', type: 'GOOGLE_SHEETS', configuration: {} }],
    });

    assert.equal(required[0]?.connected, true);
  });
});

describe('swfte_run does not spend an execution it knows will fail', () => {
  const workflow = { nodes: [{ id: 'notion', type: 'NOTION', configuration: {} }] };
  const catalog = [{ type: 'NOTION', oauthProvider: 'notion' }];

  test('blocks and names the provider to connect', async () => {
    const client = fakeClient({ catalog, connected: {}, workflow });

    const result: any = await runTool().execute({ kind: 'workflow', id: 'w1' }, { client } as never);

    assert.equal(result.ran, false);
    assert.equal(result.blocked, 'MISSING_CONNECTIONS');
    assert.deepEqual(result.missing, ['notion']);
    assert.match(result.nextStep, /swfte_connect_start/);
  });

  /**
   * "Reached the adapter" is asserted by a marker the fake throws on any path
   * that is not one of the two gate reads. Letting the call fall through into a
   * real run instead costs ~36s of the adapter's own polling to prove a branch.
   */
  const REACHED = 'reached-the-run-adapter';

  test('force overrides the gate, because the check is best-effort', async () => {
    // A credential stored under a name that does not normalise to the provider
    // would otherwise block a run that would have worked.
    const client = fakeClient({});
    (client as any).request = async ({ path }: { path: string }) => {
      if (path === NODE_CATALOG) return catalog;
      if (path === OAUTH_INTEGRATIONS) return { integrations: {} };
      throw new Error(REACHED);
    };

    const err = await runTool()
      .execute({ kind: 'workflow', id: 'w1', force: true }, { client } as never)
      .then(() => null, (e: Error) => e);

    assert.match(String(err?.message), new RegExp(REACHED));
  });

  test('an unreachable catalog lets the run proceed rather than blocking it', async () => {
    // A false "you are missing credentials" that blocks a good run is worse
    // than a real failure, which the trace explains anyway.
    const client = fakeClient({});
    (client as any).request = async ({ path }: { path: string }) => {
      if (path === NODE_CATALOG) throw new Error('catalog down');
      if (path === OAUTH_INTEGRATIONS) throw new Error('secrets down');
      throw new Error(REACHED);
    };

    const err = await runTool()
      .execute({ kind: 'workflow', id: 'w1' }, { client } as never)
      .then(() => null, (e: Error) => e);

    assert.match(String(err?.message), new RegExp(REACHED));
  });

  // Not covered here: that a non-workflow kind skips the gate. It is the single
  // line `if (kind !== 'workflow') return []`, and exercising it through
  // swfte_run costs ~36s — the agent adapter swallows a thrown fake and retries
  // through its load-shedding loop, so there is no cheap way to observe the
  // branch from outside. Not worth a third of a minute on every test run.
});
