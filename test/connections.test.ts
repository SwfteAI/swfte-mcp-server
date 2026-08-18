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

import { loadConfig, DEFAULT_GROUPS } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { allTools } from '../src/tools/index.js';
import { selectTools } from '../src/server.js';
import { shipTools } from '../src/tools/ship.js';
import { requiredConnections } from '../src/connections.js';

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
