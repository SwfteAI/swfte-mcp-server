import { z } from 'zod';
import { SwfteApiError } from '../client.js';
import { TOOL_GROUPS } from '../config.js';
import type { ToolDefinition } from './_types.js';

type ProbeResult<T> =
  | { ok: true; value: T }
  | { ok: false; label: string; error: string; status?: number };

/**
 * Probes run in parallel and each may fail independently — a workspace on a plan
 * that doesn't expose usage summaries should still get a useful identity answer
 * rather than a blanket error.
 */
async function probe<T>(label: string, fn: () => Promise<T>): Promise<ProbeResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof SwfteApiError) {
      return { ok: false, label, error: err.message, status: err.status };
    }
    return { ok: false, label, error: err instanceof Error ? err.message : String(err) };
  }
}

export const whoamiTools: ToolDefinition[] = [
  {
    name: 'swfte_whoami',
    title: 'Who am I / connection check',
    group: 'core',
    readOnly: true,
    description:
      'Verify the connection and resolve the acting identity: user, workspace, role, credential ' +
      'kind, and where available current usage. CALL THIS FIRST in any session that will create ' +
      'or deploy anything — it turns an opaque later "403 Forbidden" into a concrete answer about ' +
      'which workspace you are acting in and what this credential is allowed to do.',
    inputSchema: z.object({}),
    execute: async (_input, { client, config }) => {
      const [member, tokens, usage] = await Promise.all([
        probe('workspace-member', () =>
          client.request<Record<string, unknown>>({
            method: 'GET',
            path: '/v2/workspace/members/me',
            retries: 1,
          })
        ),
        // Listing PATs both proves the credential is live and reveals its scopes.
        probe('personal-access-tokens', () =>
          client.request<any[]>({ method: 'GET', path: '/v1/personal-access-tokens', retries: 1 })
        ),
        probe('usage', () =>
          client.request<Record<string, unknown>>({
            method: 'GET',
            path: '/v1/billing/usage/summary',
            retries: 1,
          })
        ),
      ]);

      const results: ProbeResult<unknown>[] = [member, tokens, usage];
      const failures = results.filter((r): r is Extract<ProbeResult<unknown>, { ok: false }> => !r.ok);

      // Every probe failing on auth means the credential itself is bad. Say that
      // once, plainly, instead of returning three separate 401s.
      const allAuthFailed =
        failures.length === results.length &&
        failures.every((f) => f.status === 401 || f.status === 403);

      return {
        connected: results.some((result) => result.ok),
        endpoint: client.baseUrl,
        credentialKind: config.credentialKind,
        ...(allAuthFailed
          ? {
              problem: 'Every identity probe was rejected — the credential is invalid, expired, or revoked.',
              suggestedAction:
                config.credentialKind === 'pat'
                  ? 'Mint a fresh PAT in Studio → Modules → any module → Documents → Connect CLI, then update SWFTE_PAT.'
                  : 'Check SWFTE_API_KEY against Studio → Settings → API keys.',
            }
          : {}),
        identity: member.ok ? member.value : null,
        activeTokens: tokens.ok
          ? {
              count: tokens.value.length,
              // Never echo token material — prefix and metadata only.
              tokens: tokens.value.map((t) => ({
                name: t?.name,
                prefix: t?.prefix,
                scopes: t?.scopes?.length ? t.scopes : '(unscoped — full studio-user access)',
                status: t?.status,
                expiresAtIso: t?.expiresAtIso,
                lastUsedAtIso: t?.lastUsedAtIso,
              })),
            }
          : null,
        usage: usage.ok ? usage.value : null,
        capabilities: {
          deployEnabled: config.allowDeploy,
          deployNote: config.allowDeploy
            ? 'swfte_deploy may provision real infrastructure when called with confirm:true.'
            : 'swfte_deploy is preview-only. Set SWFTE_ALLOW_DEPLOY=1 in the server environment to permit provisioning.',
          toolGroups: config.enabledGroups.size === 0 ? 'all' : Array.from(config.enabledGroups).sort(),
          ...(config.enabledGroups.size > 0
            ? {
                toolGroupsNote:
                  'A curated subset is advertised by default so tool selection stays reliable. ' +
                  `Hidden groups: ${TOOL_GROUPS.filter((g) => !config.enabledGroups.has(g)).join(', ')}. ` +
                  'Set SWFTE_TOOLS=all (or a comma-separated list) to widen.',
              }
            : {}),
        },
        ...(failures.length > 0 && !allAuthFailed
          ? { partialFailures: failures.map((f) => ({ probe: f.label, status: f.status, error: f.error })) }
          : {}),
        ...(config.credentialKind === 'pat'
          ? {
              note:
                'A PAT is bound to a single workspace. The workspace above is the only one this server ' +
                'can act in; to work in another, configure a second server with that workspace’s token.',
            }
          : {}),
      };
    },
  },
];
