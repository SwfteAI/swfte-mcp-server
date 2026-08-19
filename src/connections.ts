/**
 * Detecting and repairing missing OAuth connections.
 *
 * A workflow containing a Slack node is accepted, saved, and published happily
 * whether or not Slack is connected — the credential is only consulted when the
 * node actually executes. So the failure lands at run time, on a workflow that
 * looked fine, as an opaque node error. Detecting it up front and offering the
 * sign-in link is the difference between "your workflow is broken" and
 * "connect Slack and this will work".
 */
import { spawn } from 'node:child_process';
import type { SwfteClient } from './client.js';

const NODE_CATALOG = '/v2/workflows/nodes/catalog';
const OAUTH_INTEGRATIONS = '/v1/secrets/oauth/integrations';

export interface CatalogEntry {
  type?: string;
  code?: string;
  /** The provider whose credential this node needs, when it needs one. */
  oauthProvider?: string;
  name?: string;
}

export interface ConnectionRequirement {
  /** Provider slug, e.g. "slack". */
  provider: string;
  /** Node ids in the workflow that need it. */
  nodeIds: string[];
  /** Node types that need it, for a caller that has no graph. */
  nodeTypes: string[];
  connected: boolean;
}

/**
 * Which providers already have a stored OAuth credential in this workspace.
 *
 * Compared case-insensitively: the catalog spells providers as slugs
 * (`google_sheets`) while stored secrets are grouped by display appName
 * (`Google Sheets`), and a mismatch here reads as "not connected" for a
 * provider that plainly is — the most annoying possible false positive.
 */
export async function connectedProviders(client: SwfteClient): Promise<Set<string>> {
  const body = await client.request<any>({
    method: 'GET',
    path: OAUTH_INTEGRATIONS,
    retries: 1,
  });

  const out = new Set<string>();
  const integrations = body?.integrations ?? {};
  for (const appName of Object.keys(integrations)) {
    if (!appName || appName === 'Unknown') continue;
    out.add(normaliseProvider(appName));
    // Also index by each secret's own provider field where present, since the
    // grouping key is a display name and the node catalog is not.
    for (const secret of integrations[appName] ?? []) {
      const p = secret?.provider ?? secret?.oauthProvider ?? secret?.appName;
      if (p) out.add(normaliseProvider(String(p)));
    }
  }
  return out;
}

/** `Google Sheets` / `google-sheets` / `GOOGLE_SHEETS` all collapse to `googlesheets`. */
export function normaliseProvider(p: string): string {
  return p.toLowerCase().replace(/[\s_-]+/g, '');
}

/** Map node type → required oauth provider, from the live catalog. */
export async function providerByNodeType(client: SwfteClient): Promise<Map<string, string>> {
  const body = await client.request<any>({ method: 'GET', path: NODE_CATALOG, retries: 1 });
  const entries: CatalogEntry[] = Array.isArray(body)
    ? body
    : (body?.nodes ?? body?.catalog ?? body?.content ?? body?.entries ?? []);

  const map = new Map<string, string>();
  for (const e of entries) {
    if (!e?.oauthProvider) continue;
    for (const key of [e.type, e.code].filter(Boolean) as string[]) {
      map.set(key.toUpperCase(), e.oauthProvider);
    }
  }
  return map;
}

const nodeType = (n: any): string =>
  String(n?.type ?? n?.nodeType ?? n?.kind ?? n?.data?.type ?? '').toUpperCase();

const nodeId = (n: any): string => String(n?.id ?? n?.nodeId ?? n?.key ?? '');

/**
 * Work out which OAuth providers a workflow needs and which of those are
 * missing. Best-effort by design: if the catalog is unavailable we return an
 * empty requirement list rather than blocking, because a false "you are missing
 * credentials" is worse than staying quiet.
 */
export async function requiredConnections(
  client: SwfteClient,
  workflow: any
): Promise<ConnectionRequirement[]> {
  let byType: Map<string, string>;
  let connected: Set<string>;
  try {
    [byType, connected] = await Promise.all([providerByNodeType(client), connectedProviders(client)]);
  } catch {
    return [];
  }

  const rawNodes = workflow?.nodes ?? [];
  const nodes: any[] = Array.isArray(rawNodes) ? rawNodes : Object.values(rawNodes ?? {});

  const byProvider = new Map<string, ConnectionRequirement>();
  for (const n of nodes) {
    // A node may name its provider directly; otherwise fall back to the catalog.
    // `configuration` is the canonical key the API stores and returns; `config`
    // is the frontend-side spelling. Reading only the latter meant an explicit
    // hint on a persisted node was silently ignored. The catalog fallback masked
    // that for known node types — which is exactly where the hint is redundant.
    // It matters for a generic node type pointed at a provider, or one the
    // catalog does not carry, where the fallback has nothing to offer.
    const explicit =
      n?.oauthProvider ?? n?.configuration?.oauthProvider ?? n?.config?.oauthProvider;
    const provider = explicit ?? byType.get(nodeType(n));
    if (!provider) continue;

    const key = normaliseProvider(provider);
    const existing = byProvider.get(key);
    if (existing) {
      existing.nodeIds.push(nodeId(n));
      if (!existing.nodeTypes.includes(nodeType(n))) existing.nodeTypes.push(nodeType(n));
    } else {
      byProvider.set(key, {
        provider,
        nodeIds: [nodeId(n)],
        nodeTypes: [nodeType(n)],
        connected: connected.has(key),
      });
    }
  }

  return [...byProvider.values()];
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

export interface OpenResult {
  opened: boolean;
  reason?: string;
}

/**
 * Open a URL in the user's default browser.
 *
 * Only meaningful for a locally-running stdio server — a hosted one has no
 * browser to open, and silently doing nothing there would be worse than saying
 * so. Detached and with stdio ignored so the child cannot hold the MCP server's
 * event loop open or write into its stdio, which for a stdio transport would
 * corrupt the protocol stream.
 */
export function openInBrowser(url: string): OpenResult {
  if (!/^https?:\/\//i.test(url)) {
    return { opened: false, reason: 'Refusing to open a non-http(s) URL.' };
  }
  if (process.env.SWFTE_NO_BROWSER) {
    return { opened: false, reason: 'SWFTE_NO_BROWSER is set.' };
  }
  // A headless/CI box has nothing to open. Better to hand back the link.
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return { opened: false, reason: 'No display detected — open the URL manually.' };
  }
  // Over SSH the browser would open on the wrong machine: the box running the
  // server, not the one in front of the person who has to click. Silently
  // opening a sign-in page on a remote desktop is worse than handing back the
  // link, because nothing appears and the reason is invisible.
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT) {
    return { opened: false, reason: 'Remote session detected — open the URL on your own machine.' };
  }

  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    // A spawn error surfaces asynchronously; swallow it so a missing xdg-open
    // cannot take the server down after we have already returned.
    child.on('error', () => {});
    return { opened: true };
  } catch (err) {
    return { opened: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
