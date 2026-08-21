/**
 * "Disconnect" in a client has to end the credential, not just forget it locally.
 *
 * Revocation needed no new backend endpoint: a PAT may not mint another PAT, but it may
 * list and delete its own. So the provider authenticates *as* the presented token, finds
 * its own row by the display prefix the list exposes, and deletes it — the
 * self-authenticating shape RFC 7009 describes, where holding the token is the proof.
 *
 * The prefix is 12 characters, so the interesting case is what happens when it does not
 * identify exactly one row. Deleting the wrong credential is much worse than failing to
 * delete this one.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { SwfteOAuthProvider, loadOAuthOptions } from '../src/oauth.js';

const TOKEN = 'pat_abcdefgh1234567890';
const PREFIX = 'pat_abcdefgh…'; // first 12 chars + ellipsis, mirroring the backend

const ENV = {
  SWFTE_PAT: 'pat_test',
  SWFTE_MCP_PUBLIC_URL: 'https://mcp.test',
  SWFTE_MCP_OAUTH_SECRET: 'secret-for-tests-secret-for-tests',
} as never;

const provider = () => new SwfteOAuthProvider(loadOAuthOptions(loadConfig(ENV), ENV));

/** Patch SwfteClient.request for the duration of one call. */
async function withStubbedClient<T>(
  handler: (req: { method: string; path: string }) => unknown,
  fn: () => Promise<T>
): Promise<T> {
  const mod = await import('../src/client.js');
  const proto = (mod.SwfteClient as any).prototype;
  const saved = proto.request;
  proto.request = async function (req: { method: string; path: string }) {
    return handler({ method: req.method, path: req.path });
  };
  try {
    return await fn();
  } finally {
    proto.request = saved;
  }
}

describe('revokeToken', () => {
  test('finds its own row by prefix and deletes it', async () => {
    const p = provider();
    const calls: Array<{ method: string; path: string }> = [];

    await withStubbedClient(
      (req) => {
        calls.push(req);
        if (req.method === 'GET') {
          return [
            { id: 'other-row', prefix: 'pat_zzzzzzzz…' },
            { id: 'my-row', prefix: PREFIX },
          ];
        }
        return {};
      },
      () => p.revokeToken({ client_id: 'c' } as never, { token: TOKEN })
    );

    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      ['GET /v1/personal-access-tokens', 'DELETE /v1/personal-access-tokens/my-row']
    );
  });

  test('refuses rather than guessing when the prefix is ambiguous', async () => {
    // Two rows sharing a prefix is improbable, and deleting the wrong one is
    // unrecoverable, so this must not pick.
    const p = provider();
    let deleted = false;

    await assert.rejects(
      () =>
        withStubbedClient(
          (req) => {
            if (req.method === 'DELETE') deleted = true;
            return [
              { id: 'row-a', prefix: PREFIX },
              { id: 'row-b', prefix: PREFIX },
            ];
          },
          () => p.revokeToken({ client_id: 'c' } as never, { token: TOKEN })
        ),
      /more than one token/i
    );
    assert.equal(deleted, false, 'an ambiguous match must delete nothing');
  });

  test('reports failure when the token is not in the list', async () => {
    // Silence here would tell the user their credential was revoked when it still works
    // — a false statement about their own security.
    const p = provider();

    await assert.rejects(
      () =>
        withStubbedClient(
          () => [{ id: 'someone-else', prefix: 'pat_zzzzzzzz…' }],
          () => p.revokeToken({ client_id: 'c' } as never, { token: TOKEN })
        ),
      /could not find this token/i
    );
  });

  test('a non-credential is accepted silently, so validity cannot be probed', async () => {
    // RFC 7009: an unrecognised token is a success, or the endpoint becomes an oracle
    // for whether a given string is a live credential.
    const p = provider();
    let called = false;

    await withStubbedClient(
      () => {
        called = true;
        return [];
      },
      () => p.revokeToken({ client_id: 'c' } as never, { token: 'not-a-swfte-token' })
    );

    assert.equal(called, false, 'a non-credential must not reach the network');
  });
});
