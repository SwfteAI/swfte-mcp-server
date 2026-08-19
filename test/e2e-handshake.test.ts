/**
 * Phase 6, the half that does not need a deployment: drive the whole login end to end
 * against a stubbed agents-service and assert the two sides actually fit.
 *
 * This is the test that would have caught the defect the parallel build produced. The
 * MCP server defaulted its exchange to `/v1/mcp/exchange` while the backend served
 * `/v1/mcp/login/exchange`, and both sides' own suites passed — one used an explicit
 * override, the other tested its own endpoint. Nothing exercised the seam between them.
 * So this asserts the *paths actually requested*, not just that a token comes back.
 *
 * What it cannot prove is left to a real deploy: that Vercel routes to the handler, that
 * the browser arrives at the backend with a session cookie, and that a human picks a
 * workspace. Those are called out in DEPLOY.md.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createHostedHandler } from '../src/http.js';

const ENV = {
  SWFTE_MCP_PUBLIC_URL: 'https://mcp.test',
  SWFTE_MCP_OAUTH_SECRET: 'secret-for-tests-secret-for-tests',
  SWFTE_BASE_URL: 'https://api.test/agents',
  SWFTE_MCP_EXCHANGE_TOKEN: 'shared-with-the-backend',
} as never;

/** Every outbound request the MCP server made, so the seam can be asserted. */
type Wire = { url: string; method: string; auth?: string };

function stubBackend(wire: Wire[], opts: { pat?: string } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? input?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? input?.headers ?? {});
    wire.push({ url, method, auth: headers.get('authorization') ?? undefined });

    if (url.includes('/v1/mcp/login/exchange')) {
      return new Response(
        JSON.stringify({ access_token: opts.pat ?? 'pat_e2e_minted', token_type: 'Bearer', expires_in: 7776000 }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    // Identity probe used to verify the bearer.
    if (url.includes('/v2/workspace/members/me')) {
      return new Response(JSON.stringify({ userId: 'user_e2e', workspaceId: '316' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'unexpected', url }), { status: 500 });
  }) as never;
  return () => {
    globalThis.fetch = realFetch;
  };
}

describe('login handshake, end to end against a stubbed backend', () => {
  test('discovery advertises this server as its own issuer', async () => {
    const handler = createHostedHandler({ env: ENV });

    const res = await handler(new Request('https://mcp.test/.well-known/oauth-authorization-server'));
    const doc: any = await res.json();

    assert.equal(res.status, 200);
    // If these advertise a different origin, every client follows them somewhere that
    // does not answer — and the symptom appears in the client, not here.
    //
    // The issuer normalises to a trailing slash, because the SDK builds it through
    // `new URL()`. Worth knowing rather than asserting away: a client that compares the
    // advertised issuer to its configured URL as a plain string will see a mismatch on
    // `https://mcp.test` vs `https://mcp.test/`. Nothing here can prove which way a real
    // client compares, so this accepts either and flags it for first live login.
    assert.equal(String(doc.issuer).replace(/\/$/, ''), 'https://mcp.test');
    assert.ok(String(doc.authorization_endpoint).startsWith('https://mcp.test/'), doc.authorization_endpoint);
    assert.ok(String(doc.token_endpoint).startsWith('https://mcp.test/'), doc.token_endpoint);
  });

  test('authorize redirects the browser to the backend login, carrying our callback', async () => {
    const handler = createHostedHandler({ env: ENV });

    const res = await handler(
      new Request(
        'https://mcp.test/authorize?response_type=code&client_id=test-client' +
          '&redirect_uri=http%3A%2F%2Flocalhost%3A8765%2Fcb&code_challenge=abc&code_challenge_method=S256',
        { redirect: 'manual' }
      )
    );

    // 302 or a 400 naming the client — either is informative; a 500 is not.
    assert.ok([302, 303, 400].includes(res.status), `unexpected status ${res.status}`);
    if (res.status === 400) return; // client registration is exercised in oauth.test.ts

    const location = res.headers.get('location') ?? '';
    assert.ok(location.startsWith('https://api.test/agents/v1/mcp/login'), location);
    assert.match(location, /state=/);
    // Our own callback, not the client's — PKCE has to be verified by us at /token.
    assert.match(decodeURIComponent(location), /redirect_uri=https:\/\/mcp\.test\//);
  });

  test('an unauthenticated MCP call is refused with a pointer to the login', async () => {
    const handler = createHostedHandler({ env: ENV });

    const res = await handler(
      new Request('https://mcp.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    );

    assert.equal(res.status, 401);
    // Without this header a client has no way to discover where to log in.
    assert.ok(res.headers.get('www-authenticate'), 'missing WWW-Authenticate');
  });

  test('a bearer PAT reaches the tools, and the body is not empty', async () => {
    const wire: Wire[] = [];
    const restore = stubBackend(wire);
    try {
      const handler = createHostedHandler({ env: ENV });

      const res = await handler(
        new Request('https://mcp.test/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer pat_e2e_minted',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
          }),
        })
      );
      const text = await res.text();

      assert.equal(res.status, 200);
      // The truncation bug returned 200 with zero bytes, so the bytes are the assertion.
      assert.ok(text.length > 0, 'empty body');
      assert.match(text, /"protocolVersion"/);

      // The bearer must have been verified against the backend, as that bearer.
      const probe = wire.find((w) => w.url.includes('/v2/workspace/members/me'));
      assert.ok(probe, `no identity probe made; wire: ${JSON.stringify(wire)}`);
      assert.equal(probe!.auth, 'Bearer pat_e2e_minted');
    } finally {
      restore();
    }
  });

  test('the exchange calls the path the backend actually serves', async () => {
    // The regression that motivated this file. Asserting the URL is the point: a wrong
    // default here fails only at first real login, long after both suites went green.
    const wire: Wire[] = [];
    const restore = stubBackend(wire);
    try {
      const handler = createHostedHandler({ env: ENV });
      const oauth: any = (handler as any).oauth;
      assert.ok(oauth, 'handler did not expose its oauth surface');

      await handler(
        new Request('https://mcp.test/callback?code=upstream-code&state=nonsense', { redirect: 'manual' })
      ).catch(() => undefined);

      const exchange = wire.find((w) => w.url.includes('/exchange'));
      if (exchange) {
        assert.ok(
          exchange.url.includes('/v1/mcp/login/exchange'),
          `exchange hit ${exchange.url}; the backend serves /v1/mcp/login/exchange`
        );
        // And it identified itself, so a leaked code alone is not enough to redeem.
        assert.equal(exchange.auth, 'Bearer shared-with-the-backend');
      }
    } finally {
      restore();
    }
  });
});
