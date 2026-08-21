import { z } from 'zod';
import { sleep } from '../client.js';
import { connectedProviders, normaliseProvider, openInBrowser, requiredConnections } from '../connections.js';
import { getAdapter } from '../kinds/index.js';
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
      openBrowser: z
        .boolean()
        .optional()
        .describe('Open the sign-in page in the user’s default browser. Default true.'),
      wait: z
        .boolean()
        .optional()
        .describe('Also wait for the user to finish signing in and return the secretId. Default true.'),
      waitMs: z.number().int().min(5_000).max(600_000).optional(),
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

      const url: string | undefined = res?.authorizationUrl;
      const state: string | undefined = res?.state;

      const browser =
        url && input.openBrowser !== false ? openInBrowser(url) : { opened: false, reason: 'not requested' };

      const base = {
        started: true,
        provider: res?.provider ?? input.provider,
        authorizationUrl: url,
        state,
        callbackUrl: res?.callbackUrl,
        browserOpened: browser.opened,
        ...(browser.opened ? {} : { browserNote: browser.reason }),
      };

      // Waiting here is what makes this one call instead of a handshake the
      // model has to remember to finish. The user signs in while we hold.
      if (input.wait === false || !state) {
        return {
          ...base,
          nextStep: browser.opened
            ? 'A browser window is open for the user. Call swfte_connect_wait with this state once they finish.'
            : `Give the user this link to open: ${url}. Then call swfte_connect_wait with this state.`,
        };
      }

      const deadline = Date.now() + (input.waitMs ?? 180_000);
      let last: any = null;
      while (Date.now() < deadline) {
        last = await client.request<any>({
          method: 'GET',
          path: `${OAUTH}/connect/${encodeURIComponent(input.provider)}/status`,
          query: { state },
          retries: 1,
        });
        if (last?.ready) {
          return { ...base, connected: true, secretId: last.secretId,
            note: 'Connected. Nodes for this provider can now execute.' };
        }
        if (last?.expired) {
          return { ...base, connected: false, reason: 'STATE_EXPIRED',
            note: 'The sign-in window closed before it completed. Call swfte_connect_start again.' };
        }
        await sleep(3_000);
      }

      return {
        ...base,
        connected: false,
        reason: 'STILL_PENDING',
        note: 'The user has not finished signing in. Call swfte_connect_wait with this state to keep waiting.',
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

  {
    name: 'swfte_connections_list',
    title: 'List connected providers',
    group: 'connect',
    readOnly: true,
    description:
      'List every third-party provider this workspace already has a stored OAuth credential for. ' +
      'Use before building anything that touches an integration — a workflow with an unconnected ' +
      'Slack node saves and publishes happily and only fails when the node runs.',
    inputSchema: z.object({}),
    execute: async (_input, { client }) => {
      const providers = await connectedProviders(client);
      return {
        connectedCount: providers.size,
        connected: [...providers].sort(),
        note:
          providers.size === 0
            ? 'Nothing connected. Any integration node will fail at execution until you run swfte_connect_start.'
            : 'Names are normalised (lowercase, no spaces or separators) for comparison against node requirements.',
      };
    },
  },

  {
    name: 'swfte_connections_check',
    title: 'Check a workflow’s connection requirements',
    group: 'connect',
    readOnly: true,
    description:
      'Inspect a workflow, work out which OAuth providers its nodes need, and report which are ' +
      'MISSING. This is the check that turns an opaque run-time node failure into "connect Slack ' +
      'and this will work". Run it after swfte_build and before swfte_run — the API accepts and ' +
      'publishes a workflow whose credentials are absent, because the credential is only consulted ' +
      'when the node executes.',
    inputSchema: z.object({
      workflowId: z.string(),
      connect: z
        .boolean()
        .optional()
        .describe('Immediately start the OAuth flow for the first missing provider, opening a browser.'),
    }),
    execute: async (input, { client }) => {
      const workflow = await getAdapter('workflow').get!(client, input.workflowId);
      const required = await requiredConnections(client, workflow);
      const missing = required.filter((r) => !r.connected);

      const base = {
        workflowId: input.workflowId,
        requires: required.map((r) => ({
          provider: r.provider,
          connected: r.connected,
          nodes: r.nodeIds.filter(Boolean),
        })),
        missing: missing.map((m) => m.provider),
        ok: missing.length === 0,
      };

      if (missing.length === 0) {
        return {
          ...base,
          note:
            required.length === 0
              ? 'No nodes in this workflow need a third-party credential.'
              : 'Every provider this workflow needs is connected.',
        };
      }

      const summary =
        `Missing ${missing.length} connection(s): ` +
        missing.map((m) => `${m.provider} (needed by ${m.nodeIds.filter(Boolean).join(', ') || 'unknown node'})`).join('; ') +
        '. These nodes will fail at execution until connected.';

      if (!input.connect) {
        return {
          ...base,
          summary,
          nextStep: `Call swfte_connect_start with provider "${missing[0]!.provider}" to open sign-in, ` +
            'or swfte_connections_check again with connect:true to start it now.',
        };
      }

      // Start the first missing one. One at a time on purpose: each needs the
      // user's attention in a browser, and opening several windows at once
      // makes it unclear which one they are completing.
      const first = missing[0]!;
      const started = await client.request<any>({
        method: 'GET',
        path: `${OAUTH}/connect/${encodeURIComponent(first.provider)}`,
        expectStatuses: [200, 400],
        retries: 1,
      });

      if (started?.error) {
        return { ...base, summary, connectAttempt: { provider: first.provider, ...started } };
      }

      const browser = started?.authorizationUrl ? openInBrowser(started.authorizationUrl) : { opened: false };
      return {
        ...base,
        summary,
        connectAttempt: {
          provider: first.provider,
          authorizationUrl: started?.authorizationUrl,
          state: started?.state,
          browserOpened: browser.opened,
        },
        nextStep:
          `Ask the user to complete sign-in${browser.opened ? ' in the window that just opened' : ''}, ` +
          `then call swfte_connect_wait with provider "${first.provider}" and this state.` +
          (missing.length > 1 ? ` ${missing.length - 1} more provider(s) still to connect after this one.` : ''),
      };
    },
  },
];

/** Exported for the verify path, which folds missing connections into its report. */
export { requiredConnections, normaliseProvider };
