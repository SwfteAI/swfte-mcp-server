/**
 * The login handshake, end to end, without a browser or a backend.
 *
 * What these pin is the seam between the three pieces built in parallel: the redirect
 * this server sends the browser to, the shape it accepts back, and the token it hands
 * the client. A break anywhere in that chain shows up in production as "claude mcp login
 * hangs", with nothing in any single component looking wrong.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { loadConfig } from '../src/config.js';
import { createOAuthEndpoints, type OAuthEndpoints, type OAuthOptions } from '../src/oauth.js';
import { createHostedHandler, resolveClientFromAuth } from '../src/http.js';

const ISSUER = 'https://mcp.test';
const LOGIN_URL = 'https://api.test/agents/v1/mcp/login';
const EXCHANGE_URL = 'https://api.test/agents/v1/mcp/exchange';
const CLIENT_REDIRECT = 'http://localhost:9876/callback';

const config = () =>
  loadConfig({ SWFTE_PAT: 'pat_placeholder', SWFTE_BASE_URL: 'https://api.test/agents' } as never);

/** Recorded outbound exchange calls, so the contract can be asserted on the wire. */
interface ExchangeCall {
  url: string;
  body: unknown;
  authorization?: string;
}

function endpoints(overrides: Partial<OAuthOptions> = {}): {
  api: OAuthEndpoints;
  exchanges: ExchangeCall[];
  exchangeReply: { status: number; body: unknown };
} {
  const exchanges: ExchangeCall[] = [];
  const exchangeReply = { status: 200, body: { access_token: 'pat_live_token', expires_in: 604800 } as unknown };

  const api = createOAuthEndpoints({
    issuerUrl: new URL(ISSUER),
    mcpPath: '/mcp',
    loginUrl: LOGIN_URL,
    exchangeUrl: EXCHANGE_URL,
    signingSecret: 'test-signing-secret',
    config: config(),
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      exchanges.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')),
        authorization: headers.get('authorization') ?? undefined,
      });
      return new Response(JSON.stringify(exchangeReply.body), {
        status: exchangeReply.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    ...overrides,
  });

  return { api, exchanges, exchangeReply };
}

/** A PKCE pair the SDK's token handler will accept: challenge = base64url(sha256(verifier)). */
const VERIFIER = 'swfte-test-verifier-0123456789abcdefghijklmnop';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

async function register(api: OAuthEndpoints, redirectUris: string[] = [CLIENT_REDIRECT]): Promise<any> {
  const res = await api.handle(
    new Request(`${ISSUER}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'Test Client' }),
    })
  );
  assert.ok(res, '/register did not answer');
  return { status: res.status, body: await res.json() };
}

function authorizeUrl(clientId: string, extra: Record<string, string> = {}): string {
  const url = new URL(`${ISSUER}/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', CHALLENGE);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', CLIENT_REDIRECT);
  url.searchParams.set('state', 'client-state-abc');
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return url.href;
}

describe('discovery metadata', () => {
  test('the authorization server document names every endpoint a client must find', async () => {
    const { api } = endpoints();
    const res = await api.handle(new Request(`${ISSUER}/.well-known/oauth-authorization-server`));
    assert.ok(res);
    const meta = (await res.json()) as any;

    assert.equal(meta.issuer, `${ISSUER}/`);
    assert.equal(meta.authorization_endpoint, `${ISSUER}/authorize`);
    assert.equal(meta.token_endpoint, `${ISSUER}/token`);
    assert.equal(meta.registration_endpoint, `${ISSUER}/register`);
    // Anything but S256 would let a client fall back to a challenge that protects nothing.
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  });

  test('the protected-resource document points at the MCP endpoint and its issuer', async () => {
    const { api } = endpoints();
    const res = await api.handle(new Request(`${ISSUER}/.well-known/oauth-protected-resource/mcp`));
    assert.ok(res);
    const meta = (await res.json()) as any;

    assert.equal(meta.resource, `${ISSUER}/mcp`);
    assert.deepEqual(meta.authorization_servers, [`${ISSUER}/`]);
  });

  test('a path this server does not own is declined rather than answered', async () => {
    const { api } = endpoints();
    assert.equal(await api.handle(new Request(`${ISSUER}/mcp`, { method: 'POST' })), null);
  });

  test('an MCP request keeps its body — the OAuth layer must not drink it', async () => {
    // A body can only be read once. If the OAuth handlers went looking for form fields on
    // an MCP POST, the transport behind them would find an empty request and every tool
    // call would fail with a parse error that points nowhere near here.
    const { api } = endpoints();
    const req = new Request(`${ISSUER}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    assert.equal(await api.handle(req), null);
    assert.equal(req.bodyUsed, false);

    await api.authenticate(req);
    assert.equal(req.bodyUsed, false);
    assert.equal(((await req.json()) as any).method, 'tools/list');
  });
});

describe('dynamic client registration', () => {
  test('a client gets an id back and no secret it would have to keep', async () => {
    const { api } = endpoints();
    const { status, body } = await register(api);

    assert.equal(status, 201);
    assert.ok(body.client_id, 'no client_id issued');
    // A secret would have to be stored to be verified, and nothing here stores anything —
    // returning one would promise an authentication that never happens.
    assert.equal(body.client_secret, undefined);
    assert.equal(body.token_endpoint_auth_method, 'none');
  });

  test('the id is self-describing, so any instance can serve the next step', async () => {
    // Registration happens on one invocation and authorization on another; with no shared
    // store, a second endpoint object standing in for a second instance must still
    // recognise the client — as long as it holds the same signing secret.
    const first = endpoints();
    const { body } = await register(first.api);

    const second = endpoints();
    const res = await second.api.handle(new Request(authorizeUrl(body.client_id)));
    assert.ok(res);
    assert.equal(res.status, 302);
  });

  test('an id signed with a different secret is not a client', async () => {
    const { body } = await register(endpoints().api);
    const other = endpoints({ signingSecret: 'a-different-secret' });

    const res = await other.api.handle(new Request(authorizeUrl(body.client_id)));
    assert.ok(res);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error, 'invalid_client');
  });

  test('a redirect_uri that could hand the code elsewhere is refused', async () => {
    const { api } = endpoints();
    for (const uri of ['javascript:alert(1)', 'data:text/html,x', 'myapp://cb', 'http://evil.example/cb']) {
      const { status, body } = await register(api, [uri]);
      assert.equal(status, 400, `${uri} was accepted`);
      assert.equal(body.error, 'invalid_client_metadata');
    }
  });
});

describe('authorization redirect', () => {
  test('the browser is sent to agents-service carrying state and this server’s callback', async () => {
    const { api } = endpoints();
    const { body: client } = await register(api);

    const res = await api.handle(new Request(authorizeUrl(client.client_id)));
    assert.ok(res);
    assert.equal(res.status, 302);

    const location = new URL(res.headers.get('location')!);
    assert.equal(location.origin + location.pathname, LOGIN_URL);
    // agents-service allowlists this exact value, and it must be ours — not the client's —
    // or the PKCE challenge would have nowhere to be remembered.
    assert.equal(location.searchParams.get('redirect_uri'), `${ISSUER}/callback`);

    const state = location.searchParams.get('state');
    assert.ok(state, 'no state on the login redirect');
    // The client's own state must not leak upstream in the clear; it travels sealed and
    // comes back untouched on the final redirect.
    assert.ok(!state.includes('client-state-abc'));
  });

  test('PKCE is required — an authorize without a challenge is refused', async () => {
    const { api } = endpoints();
    const { body: client } = await register(api);

    const url = new URL(authorizeUrl(client.client_id));
    url.searchParams.delete('code_challenge');

    const res = await api.handle(new Request(url.href));
    assert.ok(res);
    assert.equal(res.status, 302);
    // Once the client and its redirect_uri check out, errors are reported to the client
    // rather than rendered — so this lands as an error redirect, not a login one.
    const location = new URL(res.headers.get('location')!);
    assert.equal(location.origin + location.pathname, CLIENT_REDIRECT);
    assert.equal(location.searchParams.get('error'), 'invalid_request');
  });

  test('an unregistered redirect_uri is rejected in place, never redirected to', async () => {
    const { api } = endpoints();
    const { body: client } = await register(api);

    const res = await api.handle(
      new Request(authorizeUrl(client.client_id, { redirect_uri: 'http://localhost:1/elsewhere' }))
    );
    assert.ok(res);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null);
  });
});

describe('callback and token exchange', () => {
  /** Walk the flow to the point where the client holds an authorization code. */
  async function codeInHand(api: OAuthEndpoints) {
    const { body: client } = await register(api);
    const authorize = await api.handle(new Request(authorizeUrl(client.client_id)));
    const state = new URL(authorize!.headers.get('location')!).searchParams.get('state')!;

    const callback = await api.handle(
      new Request(`${ISSUER}/callback?code=upstream-one-time-code&state=${encodeURIComponent(state)}`)
    );
    assert.ok(callback);
    assert.equal(callback.status, 302);
    const back = new URL(callback.headers.get('location')!);
    return { client, back };
  }

  test('the callback returns the client to its own redirect with a code and its state', async () => {
    const { api } = endpoints();
    const { back } = await codeInHand(api);

    assert.equal(back.origin + back.pathname, CLIENT_REDIRECT);
    assert.ok(back.searchParams.get('code'));
    // The client's state is its CSRF defence; it has to come back exactly as it went out.
    assert.equal(back.searchParams.get('state'), 'client-state-abc');
    // The upstream code must not be what the client receives — it is redeemed by this
    // server, once, and only after PKCE has been checked.
    assert.notEqual(back.searchParams.get('code'), 'upstream-one-time-code');
  });

  test('the token endpoint returns the PAT the exchange minted', async () => {
    const { api, exchanges } = endpoints();
    const { client, back } = await codeInHand(api);

    const res = await api.handle(
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: back.searchParams.get('code')!,
          code_verifier: VERIFIER,
          redirect_uri: CLIENT_REDIRECT,
        }).toString(),
      })
    );

    assert.ok(res);
    assert.equal(res.status, 200);
    const tokens = (await res.json()) as any;
    assert.equal(tokens.access_token, 'pat_live_token');
    assert.equal(tokens.token_type, 'bearer');
    assert.equal(tokens.expires_in, 604800);

    // The one-time code goes to agents-service, and nothing else does.
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0]!.url, EXCHANGE_URL);
    assert.deepEqual(exchanges[0]!.body, { code: 'upstream-one-time-code' });
  });

  test('the redemption is authenticated when a shared secret is configured', async () => {
    // The one-time code travels through the user's browser, so it can be copied. Proving
    // the redemption came from this server is what makes a copy worthless.
    const { api, exchanges } = endpoints({ exchangeToken: 'shared-secret-value' });
    const { client, back } = await codeInHand(api);

    await api.handle(
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: back.searchParams.get('code')!,
          code_verifier: VERIFIER,
        }).toString(),
      })
    );

    assert.equal(exchanges[0]!.authorization, 'Bearer shared-secret-value');
  });

  test('a wrong code_verifier does not get a token', async () => {
    const { api, exchanges } = endpoints();
    const { client, back } = await codeInHand(api);

    const res = await api.handle(
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: back.searchParams.get('code')!,
          code_verifier: 'not-the-verifier-that-started-this-flow',
        }).toString(),
      })
    );

    assert.ok(res);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error, 'invalid_grant');
    // Crucially the exchange was never attempted: a stolen code must not burn the PAT.
    assert.equal(exchanges.length, 0);
  });

  test('an exchange that answers with something that is not a credential fails loudly', async () => {
    const { api, exchangeReply } = endpoints();
    exchangeReply.body = { access_token: 'eyJhbGciOi.session.jwt' };
    const { client, back } = await codeInHand(api);

    const res = await api.handle(
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: back.searchParams.get('code')!,
          code_verifier: VERIFIER,
        }).toString(),
      })
    );

    assert.ok(res);
    assert.equal(res.status, 500);
    // Accepting it would mean every later tool call fails with an opaque 401, far from
    // the misconfiguration that caused it.
    assert.equal(((await res.json()) as any).error, 'server_error');
  });

  test('a login the user abandoned is reported to the client, not left hanging', async () => {
    const { api } = endpoints();
    const { body: client } = await register(api);
    const authorize = await api.handle(new Request(authorizeUrl(client.client_id)));
    const state = new URL(authorize!.headers.get('location')!).searchParams.get('state')!;

    const res = await api.handle(
      new Request(
        `${ISSUER}/callback?error=access_denied&error_description=User+declined&state=${encodeURIComponent(state)}`
      )
    );
    assert.ok(res);
    const back = new URL(res.headers.get('location')!);
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('state'), 'client-state-abc');
  });

  test('a callback with a forged state is answered in place, never redirected', async () => {
    const { api } = endpoints();
    // Redirecting somewhere named in an unverified query would make this an open
    // redirector, usable to launder phishing links through the Swfte domain.
    const res = await api.handle(new Request(`${ISSUER}/callback?code=x&state=forged`));
    assert.ok(res);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null);
  });
});

describe('bearer authentication', () => {
  const identityResponses: { status: number; body: unknown }[] = [];
  let fetchCalls: { url: string; authorization?: string }[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    identityResponses.length = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      fetchCalls.push({ url: String(url), authorization: headers.get('authorization') ?? undefined });
      const next = identityResponses.shift() ?? { status: 200, body: { userId: 'u1', workspaceId: 'w1' } };
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const mcpRequest = (authorization?: string) =>
    new Request(`${ISSUER}/mcp`, {
      method: 'POST',
      headers: authorization ? { authorization } : {},
    });

  test('no Authorization header is a 401 that says where to log in', async () => {
    const { api } = endpoints();
    const result = await api.authenticate(mcpRequest());

    assert.ok('response' in result);
    assert.equal(result.response.status, 401);
    const challenge = result.response.headers.get('www-authenticate') ?? '';
    assert.match(challenge, /^Bearer /);
    // Without this the client has no way to discover the authorization server.
    assert.ok(challenge.includes(`${ISSUER}/.well-known/oauth-protected-resource/mcp`));
    assert.equal(fetchCalls.length, 0);
  });

  test('a malformed Authorization header is a 401, not a crash', async () => {
    const { api } = endpoints();
    for (const header of ['Bearer', 'Basic abc123', 'pat_looks_right_but_no_scheme']) {
      const result = await api.authenticate(mcpRequest(header));
      assert.ok('response' in result, `${header} was accepted`);
      assert.equal(result.response.status, 401);
    }
    assert.equal(fetchCalls.length, 0);
  });

  test('a token that is not a Swfte credential is rejected without a round trip', async () => {
    const { api } = endpoints();
    const result = await api.authenticate(mcpRequest('Bearer just-some-string'));

    assert.ok('response' in result);
    assert.equal(result.response.status, 401);
    assert.equal(((await result.response.json()) as any).error, 'invalid_token');
    // Nothing about this token could have been valid, so agents-service is never troubled.
    assert.equal(fetchCalls.length, 0);
  });

  test('a live PAT is verified by using it, and the result is briefly cached', async () => {
    const { api } = endpoints();

    const first = await api.authenticate(mcpRequest('Bearer pat_alice'));
    assert.ok('authInfo' in first);
    assert.equal(first.authInfo.token, 'pat_alice');
    assert.equal(first.authInfo.expiresAt! > Math.floor(Date.now() / 1000), true);
    assert.equal(fetchCalls[0]!.authorization, 'Bearer pat_alice');

    await api.authenticate(mcpRequest('Bearer pat_alice'));
    // A second call inside the cache window must not pay for another round trip.
    assert.equal(fetchCalls.length, 1);

    // A different user must not be served from the first user's entry — the failure this
    // guards against is the quiet one where every caller acts as whoever came first.
    const bob = await api.authenticate(mcpRequest('Bearer pat_bob'));
    assert.ok('authInfo' in bob);
    assert.equal(bob.authInfo.token, 'pat_bob');
    assert.equal(fetchCalls.length, 2);
  });

  test('the advertised expiry outlasts the cache entry behind it', async () => {
    // A whole-second expiry rounded down would land inside the cache window, and the
    // middleware would then reject its own cached verification as expired — for about a
    // second out of every minute, per token, which reads as a random 401.
    const clock = 2_000_000_000_500;
    const { api } = endpoints({ now: () => clock });

    const result = await api.authenticate(mcpRequest('Bearer pat_alice'));
    assert.ok('authInfo' in result);
    assert.ok(result.authInfo.expiresAt! * 1000 >= clock + 60_000);
  });

  test('a revoked PAT stops working', async () => {
    const { api } = endpoints();
    identityResponses.push({ status: 401, body: { error: 'invalid_token' } });

    const result = await api.authenticate(mcpRequest('Bearer pat_revoked'));
    assert.ok('response' in result);
    assert.equal(result.response.status, 401);
    assert.equal(((await result.response.json()) as any).error, 'invalid_token');
  });

  test('a backend outage is a 500, not a bogus "log in again"', async () => {
    const { api } = endpoints();
    // Three because the client retries a 503 before giving up.
    for (let i = 0; i < 3; i++) identityResponses.push({ status: 503, body: { error: 'upstream' } });

    const result = await api.authenticate(mcpRequest('Bearer pat_alice'));
    assert.ok('response' in result);
    // Telling the user their token is bad would send them through a whole browser
    // re-login to be handed a token that fails identically.
    assert.equal(result.response.status, 500);
  });
});

describe('the hosted handler', () => {
  const env = {
    SWFTE_MCP_PUBLIC_URL: ISSUER,
    SWFTE_MCP_OAUTH_SECRET: 'test-signing-secret',
    SWFTE_BASE_URL: 'https://api.test/agents',
  } as never;

  test('the MCP endpoint is behind the bearer gate', async () => {
    const handler = createHostedHandler({ env });
    const res = await handler(new Request(`${ISSUER}/mcp`, { method: 'POST' }));

    assert.equal(res.status, 401);
    assert.ok(res.headers.get('www-authenticate'));
  });

  test('metadata is served without auth, since discovery precedes it', async () => {
    const handler = createHostedHandler({ env });
    const res = await handler(new Request(`${ISSUER}/.well-known/oauth-authorization-server`));

    assert.equal(res.status, 200);
  });

  test('the login endpoints default off the agents-service base URL', () => {
    const handler = createHostedHandler({ env });
    assert.equal(handler.mcpPath, '/mcp');
    assert.equal(handler.oauth.protectedResourceMetadataUrl, `${ISSUER}/.well-known/oauth-protected-resource/mcp`);
  });

  test('a bearer token gets all the way through to an MCP response', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ userId: 'u1', workspaceId: 'w1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    try {
      const handler = createHostedHandler({ env });
      const res = await handler(
        new Request(`${ISSUER}/mcp`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer pat_alice',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
          }),
        })
      );

      // Anything else means the verified request never reached the transport with its
      // body and its auth intact — the one thing this whole file exists to guarantee.
      assert.equal(res.status, 200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('an unknown path 404s and names the endpoint the caller wanted', async () => {
    const handler = createHostedHandler({ env });
    const res = await handler(new Request(`${ISSUER}/whatever`));

    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as any).mcp_endpoint, '/mcp');
  });

  test('a hosted deployment refuses to start without its signing secret', () => {
    // A per-instance secret would look fine locally and then fail whichever logins landed
    // on a different instance than the one that started them.
    assert.throws(
      () => createHostedHandler({ env: { SWFTE_MCP_PUBLIC_URL: ISSUER } as never }),
      /SWFTE_MCP_OAUTH_SECRET/
    );
  });
});

describe('resolveClient', () => {
  test('the client is built from the token that arrived on the call', () => {
    const resolve = resolveClientFromAuth(config());
    const client = resolve({ token: 'pat_alice', clientId: 'c', scopes: [] });

    assert.equal((client as any).config.credential, 'pat_alice');
    assert.equal(client.credentialKind, 'pat');
  });

  test('a workspace API key presented as a bearer token keeps its own header treatment', () => {
    const resolve = resolveClientFromAuth(config());
    const client = resolve({ token: 'sk-swfte-abc', clientId: 'c', scopes: [] });

    // Sending a key as though it were a PAT drops X-API-Key and the workspace header,
    // which reads downstream as an unauthenticated call.
    assert.equal(client.credentialKind, 'api-key');
  });

  test('a call with no auth is a wiring bug and says so', () => {
    const resolve = resolveClientFromAuth(config());
    assert.throws(() => resolve(undefined), /bearer gate/);
  });
});
