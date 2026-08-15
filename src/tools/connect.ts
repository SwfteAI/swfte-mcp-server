import { z } from 'zod';
import { sleep } from '../client.js';
import type { ToolDefinition } from './_types.js';

const OAUTH = '/v2/oauth';

/**
 * OAuth provider connections for integration nodes.
 *
 * The consent step is unavoidably browser-interactive — a human has to sign in
 * at the provider. Rather than pretend to complete the handshake, these tools
 * hand back the authorization URL for the user to open and then poll for
 * completion. That is the honest shape, and it still automates everything on
 * either side of the click.
 */
export const connectTools: ToolDefinition[] = [
  {
    name: 'swfte_connect_start',
    title: 'Start an OAuth connection',
    description:
      'Begin connecting a third-party provider (slack, gmail, github, stripe, …). Returns an ' +
      'authorizationUrl for the USER to open in a browser, plus a state token. Sign-in cannot be ' +
      'automated — give the user the URL, then call swfte_connect_wait with the state to pick up the ' +
      'resulting secretId. Reports PROVIDER_NOT_CONFIGURED (listing what is available) or ' +
      'PROVIDER_UNSUPPORTED rather than handing back a link that would fail later.',
    inputSchema: z.object({
      provider: z.string().describe('Provider slug, e.g. "slack", "gmail", "github", "stripe".'),
      clientId: z.string().optional().describe('Bring-your-own OAuth app client id.'),
      clientSecret: z.string().optional().describe('Bring-your-own OAuth app client secret.'),
      scopes: z.string().optional().describe('Space- or comma-separated scope override.'),
      tenant: z.string().optional().describe('Tenant hint, for providers that need one.'),
    }),
    execute: async (input, { client }) => {
      const res = await client.request<any>({
        method: 'GET',
        path: `${OAUTH}/connect/${encodeURIComponent(input.provider)}`,
        query: {
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          scopes: input.scopes,
          tenant: input.tenant,
        },
        expectStatuses: [200, 400],
        retries: 1,
      });

      if (res?.error) return { started: false, ...res };

      return {
        started: true,
        provider: res?.provider ?? input.provider,
        authorizationUrl: res?.authorizationUrl,
        state: res?.state,
        callbackUrl: res?.callbackUrl,
        nextStep:
          'Ask the user to open authorizationUrl and complete sign-in, then call swfte_connect_wait ' +
          'with this state to collect the stored credential.',
      };
    },
  },

  {
    name: 'swfte_connect_wait',
    title: 'Wait for an OAuth connection',
    description:
      'Poll a pending OAuth handshake until the user finishes signing in, then return the stored ' +
      'secretId to reference from integration nodes. The state token has a short TTL — if it expires ' +
      'before sign-in completes, start again with swfte_connect_start.',
    inputSchema: z.object({
      provider: z.string(),
      state: z.string().describe('The state token from swfte_connect_start.'),
      waitMs: z.number().int().min(5_000).max(600_000).optional().describe('How long to wait. Default 180s.'),
    }),
    execute: async (input, { client }) => {
      const deadline = Date.now() + (input.waitMs ?? 180_000);
      let last: any = null;

      while (Date.now() < deadline) {
        last = await client.request<any>({
          method: 'GET',
          path: `${OAUTH}/connect/${encodeURIComponent(input.provider)}/status`,
          query: { state: input.state },
          retries: 1,
        });

        if (last?.ready) {
          return {
            connected: true,
            provider: last.provider ?? input.provider,
            secretId: last.secretId,
            note: 'Reference this secretId from integration nodes that need this provider.',
          };
        }
        if (last?.expired) {
          return {
            connected: false,
            reason: 'STATE_EXPIRED',
            note: 'The handshake window closed before sign-in completed. Call swfte_connect_start again.',
          };
        }
        await sleep(3_000);
      }

      return {
        connected: false,
        reason: 'STILL_PENDING',
        note: 'The user has not finished signing in yet. Call swfte_connect_wait again with the same state.',
        last,
      };
    },
  },

  {
    name: 'swfte_connect_status',
    title: 'Check an OAuth handshake',
    readOnly: true,
    description: 'One-shot check of a pending OAuth handshake, without waiting.',
    inputSchema: z.object({ provider: z.string(), state: z.string() }),
    execute: async (input, { client }) =>
      client.request({
        method: 'GET',
        path: `${OAUTH}/connect/${encodeURIComponent(input.provider)}/status`,
        query: { state: input.state },
        retries: 1,
      }),
  },
];
