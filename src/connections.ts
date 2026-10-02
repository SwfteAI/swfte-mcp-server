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
import { SwfteApiError, type RequestOptions, type SwfteClient } from './client.js';

const NODE_CATALOG = '/v2/workflows/nodes/catalog';
const OAUTH_INTEGRATIONS = '/v1/secrets/oauth/integrations';
const CONNECTIONS = '/v2/connections';
const AUTO_BIND = `${CONNECTIONS}/auto-bind`;

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

/** Safe projections of the actual brief05 wire records. No credential-bearing fields are copied. */
export interface ConnectionHandle {
  connectionId: string;
  provider: string;
  label: string;
  authType: string;
  status: 'HEALTHY' | 'EXPIRED' | 'REFRESH_FAILED' | 'REVOKED' | 'UNKNOWN';
  scope: 'PERSONAL' | 'WORKSPACE';
  lastUsedAt?: number | null;
  lastCheckedAt?: number | null;
  degraded?: boolean | null;
  dependents?: Array<{
    workflowId: string;
    name: string;
    criticality?: 'CRITICAL' | 'OPTIONAL';
    schedules?: Array<{ id: string; status: string; pauseReason?: string; nextRunTime?: number; missedRunPolicy: 'REPLAY' | 'SKIP' }>;
  }>;
}

export interface ConnectionNeedTuple { nodeId: string; field: string; provider: string }

export interface ConnectionBinding extends ConnectionNeedTuple {
  outcome: 'AUTO_BOUND' | 'NEEDS_CONNECTION';
  connectionId?: string;
  alternatives: ConnectionHandle[];
  choiceVisible: boolean;
  reason?: 'NONE' | 'EXPIRED' | 'DANGLING' | 'NOT_OWNED';
}

export interface ConnectionInspection {
  source: 'server' | 'legacy';
  requirements: ConnectionRequirement[];
  /** Native AutoBindResult contains bindings; these tuples are a projection of those server rows. */
  needs?: ConnectionNeedTuple[];
  bindings?: ConnectionBinding[];
}

const STATUSES = ['HEALTHY', 'EXPIRED', 'REFRESH_FAILED', 'REVOKED', 'UNKNOWN'] as const;
const AUTH_TYPES = new Set(['oauth', 'api_key', 'basic', 'oauth_or_pat', 'token-exchange', 'aws',
  'pat', 'token_exchange', 'aws_keys', 'bearer', 'none']);
const FORBIDDEN_KEYS = new Set(['accesstoken', 'refreshtoken', 'secret', 'value', 'password', 'apikey',
  'clientsecret', 'secretaccesskey', 'accesskeyid', 'sessiontoken', 'token', 'credentials', 'privatekey']);

function invalidResponse(method: RequestOptions['method'], path: string): SwfteApiError {
  return new SwfteApiError({ status: 502, code: 'CONNECTIONS_INVALID_RESPONSE',
    message: 'Connections returned an invalid response. No connection readiness was established.',
    method, path });
}

function invalidWire(): never {
  throw invalidResponse('POST', AUTO_BIND);
}

/** Refuse a leaked credential key at any depth, even when it would otherwise be projected away. */
function inspectWire(value: unknown, workspaceId: string | undefined, depth = 0, seen = new WeakSet<object>()): void {
  if (depth > 32) invalidWire();
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) invalidWire();
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 10_000) invalidWire();
    value.forEach(item => inspectWire(item, workspaceId, depth + 1, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) invalidWire();
      if (key === 'workspaceId' && workspaceId !== undefined && item !== workspaceId) invalidWire();
      inspectWire(item, workspaceId, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidWire();
  return value as Record<string, unknown>;
}

function text(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > 512
      || /[\u0000-\u001f\u007f]/.test(value)) invalidWire();
  return value;
}

function epoch(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidWire();
  return value;
}

function handle(value: unknown): ConnectionHandle {
  const body = record(value);
  const provider = text(body.provider);
  const authType = text(body.authType);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(provider) || !AUTH_TYPES.has(authType)
      || !STATUSES.includes(body.status as ConnectionHandle['status'])
      || (body.scope !== 'PERSONAL' && body.scope !== 'WORKSPACE')) invalidWire();
  const output: ConnectionHandle = { connectionId: text(body.connectionId), provider, label: text(body.label, true),
    authType, status: body.status as ConnectionHandle['status'], scope: body.scope };
  for (const key of ['lastUsedAt', 'lastCheckedAt'] as const) {
    if (body[key] !== undefined) output[key] = body[key] === null ? null : epoch(body[key]);
  }
  if (body.degraded !== undefined) {
    if (body.degraded !== null && typeof body.degraded !== 'boolean') invalidWire();
    output.degraded = body.degraded as boolean | null;
  }
  if (body.dependents !== undefined) {
    if (!Array.isArray(body.dependents)) invalidWire();
    output.dependents = body.dependents.map(item => {
      const dependent = record(item);
      const safe: NonNullable<ConnectionHandle['dependents']>[number] = {
        workflowId: text(dependent.workflowId), name: text(dependent.name, true),
      };
      if (dependent.criticality !== undefined) {
        if (dependent.criticality !== 'CRITICAL' && dependent.criticality !== 'OPTIONAL') invalidWire();
        safe.criticality = dependent.criticality;
      }
      if (dependent.schedules !== undefined) {
        if (!Array.isArray(dependent.schedules)) invalidWire();
        safe.schedules = dependent.schedules.map(raw => {
          const schedule = record(raw);
          if (schedule.missedRunPolicy !== 'REPLAY' && schedule.missedRunPolicy !== 'SKIP') invalidWire();
          const projected: NonNullable<NonNullable<ConnectionHandle['dependents']>[number]['schedules']>[number] = {
            id: text(schedule.id), status: text(schedule.status), missedRunPolicy: schedule.missedRunPolicy,
            ...(schedule.pauseReason == null ? {} : { pauseReason: text(schedule.pauseReason) }),
            ...(schedule.nextRunTime == null ? {} : { nextRunTime: epoch(schedule.nextRunTime) }) };
          return projected;
        });
      }
      return safe;
    });
  }
  return output;
}

/** Fixed text/envelope only: backend error bodies and transport messages may contain credential material. */
export function connectionFailure(error: unknown): SwfteApiError {
  const status = error instanceof SwfteApiError ? error.status : 503;
  return new SwfteApiError({ status, code: status === 401 || status === 403 ? 'CONNECTIONS_ACCESS_REFUSED' : 'CONNECTIONS_UNAVAILABLE',
    message: 'Connections could not be checked. No verification or execution readiness was established.',
    method: 'POST', path: AUTO_BIND });
}

async function serverRequest(client: SwfteClient, options: RequestOptions): Promise<unknown> {
  if (client.credentialKind === 'api-key' && !client.configuredWorkspaceId) throw connectionFailure(undefined);
  try {
    return await client.request({ ...options, workspaceId: client.configuredWorkspaceId, retries: 0 });
  } catch (error) {
    throw connectionFailure(error);
  }
}

/** Null means only the actual list route answered404. Errors and malformed bodies never become an empty list. */
export async function serverConnectionHandles(client: SwfteClient): Promise<ConnectionHandle[] | null> {
  if (!client.serverConnectionsEnabled) return null;
  let body: unknown;
  try { body = await serverRequest(client, { method: 'GET', path: CONNECTIONS }); }
  catch (error) { if (error instanceof SwfteApiError && error.status === 404) return null; throw error; }
  try {
    inspectWire(body, client.configuredWorkspaceId);
    if (!Array.isArray(body)) invalidWire();
    const handles = body.map(handle);
    if (new Set(handles.map(item => item.connectionId)).size !== handles.length) invalidWire();
    return handles;
  } catch {
    throw invalidResponse('GET', CONNECTIONS);
  }
}

function bindings(body: unknown, handles: ConnectionHandle[], client: SwfteClient): ConnectionBinding[] {
  inspectWire(body, client.configuredWorkspaceId);
  const response = record(body);
  if (!Array.isArray(response.bindings)) invalidWire();
  const visible = new Map(handles.map(item => [item.connectionId, item]));
  const identities = new Set<string>();
  return response.bindings.map(raw => {
    const row = record(raw);
    const nodeId = text(row.nodeId), field = text(row.field), provider = text(row.provider);
    const identity = JSON.stringify([nodeId, field]);
    if (identities.has(identity) || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(provider)
        || !Array.isArray(row.alternatives) || typeof row.choiceVisible !== 'boolean'
        || (row.outcome !== 'AUTO_BOUND' && row.outcome !== 'NEEDS_CONNECTION')) invalidWire();
    identities.add(identity);
    const alternatives = row.alternatives.map(handle);
    const ids = new Set<string>();
    for (const candidate of alternatives) {
      const actual = visible.get(candidate.connectionId);
      if (ids.has(candidate.connectionId) || !actual || actual.provider !== provider || candidate.provider !== provider
          || actual.status !== candidate.status) invalidWire();
      ids.add(candidate.connectionId);
    }
    const safe: ConnectionBinding = { nodeId, field, provider, outcome: row.outcome, alternatives, choiceVisible: row.choiceVisible };
    if (row.reason != null) {
      if (!['NONE', 'EXPIRED', 'DANGLING', 'NOT_OWNED'].includes(String(row.reason))) invalidWire();
      safe.reason = row.reason as ConnectionBinding['reason'];
    }
    if (row.outcome === 'AUTO_BOUND') {
      const id = text(row.connectionId), chosen = visible.get(id);
      if (!chosen || chosen.provider !== provider || chosen.status !== 'HEALTHY' || ids.has(id)
          || alternatives.some(item => item.status !== 'HEALTHY')
          || row.choiceVisible !== (alternatives.length > 0) || (safe.reason !== undefined && safe.reason !== 'NONE')) invalidWire();
      safe.connectionId = id;
    } else if (row.connectionId != null || row.choiceVisible) invalidWire();
    return safe;
  });
}

/** Uses the server's workflow derivation and selected handles, with no local provider ranking or alias table. */
export async function inspectConnections(client: SwfteClient, workflow: unknown, workflowId?: string): Promise<ConnectionInspection> {
  if (client.serverConnectionsEnabled) {
    const handles = await serverConnectionHandles(client);
    if (handles !== null) {
      const id = workflowId ?? (workflow && typeof workflow === 'object' ? (workflow as Record<string, unknown>).id : undefined);
      if (typeof id !== 'string' || !id.trim()) throw connectionFailure(undefined);
      const rows = bindings(await serverRequest(client, { method: 'POST', path: AUTO_BIND, body: { workflowId: id } }), handles, client);
      const grouped = new Map<string, ConnectionRequirement>();
      for (const row of rows) {
        const requirement = grouped.get(row.provider) ?? { provider: row.provider, nodeIds: [], nodeTypes: [], connected: true };
        if (!requirement.nodeIds.includes(row.nodeId)) requirement.nodeIds.push(row.nodeId);
        requirement.connected &&= row.outcome === 'AUTO_BOUND';
        grouped.set(row.provider, requirement);
      }
      return { source: 'server', requirements: [...grouped.values()], bindings: rows,
        needs: rows.map(({ nodeId, field, provider }) => ({ nodeId, field, provider })) };
    }
    // Only a missing list route activates legacy derivation. A workflow-scoped auto-bind404 is a refusal.
    if (workflow === undefined && workflowId) {
      try { workflow = await client.request({ method: 'GET', path: `/v2/workflows/${encodeURIComponent(workflowId)}`, workspaceId: client.configuredWorkspaceId, retries: 0 }); }
      catch (error) { throw connectionFailure(error); }
    }
    if (workflowId) {
      const saved = record(workflow);
      if ((saved.id !== workflowId) || !saved.nodes || typeof saved.nodes !== 'object'
          || (client.configuredWorkspaceId !== undefined && saved.workspaceId != null && saved.workspaceId !== client.configuredWorkspaceId))
        invalidWire();
    }
  }
  return { source: 'legacy', requirements: await legacyRequiredConnections(client, workflow, client.serverConnectionsEnabled) };
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
  return new Set((await inspectConnectionInventory(client)).providers);
}

export async function inspectConnectionInventory(client: SwfteClient): Promise<{
  source: 'server' | 'legacy'; providers: string[]; connections?: ConnectionHandle[];
}> {
  const handles = await serverConnectionHandles(client);
  if (handles !== null) return { source: 'server', connections: handles,
    providers: [...new Set(handles.filter(item => item.status === 'HEALTHY').map(item => item.provider))].sort() };
  try { return { source: 'legacy', providers: [...await legacyConnectedProviders(client, client.serverConnectionsEnabled)].sort() }; }
  catch (error) { if (client.serverConnectionsEnabled) throw connectionFailure(error); throw error; }
}

async function legacyConnectedProviders(client: SwfteClient, strict = false): Promise<Set<string>> {
  const body = await client.request<any>({
    method: 'GET',
    path: OAUTH_INTEGRATIONS,
    retries: 1,
  });

  const out = new Set<string>();
  if (strict && (!body || typeof body !== 'object' || Array.isArray(body) || body.error
      || !body.integrations || typeof body.integrations !== 'object' || Array.isArray(body.integrations))) invalidWire();
  const integrations = body?.integrations ?? {};
  for (const appName of Object.keys(integrations)) {
    if (strict && !Array.isArray(integrations[appName])) invalidWire();
    if (!appName || appName === 'Unknown') continue;
    out.add(normaliseProvider(appName));
    // Also index by each secret's own provider field where present, since the
    // grouping key is a display name and the node catalog is not.
    for (const secret of integrations[appName] ?? []) {
      if (strict && (!secret || typeof secret !== 'object' || Array.isArray(secret))) invalidWire();
      const p = secret?.provider ?? secret?.oauthProvider ?? secret?.appName;
      if (strict && p != null) text(p);
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
export async function providerByNodeType(client: SwfteClient, strict = false): Promise<Map<string, string>> {
  const body = await client.request<any>({ method: 'GET', path: NODE_CATALOG, retries: 1 });
  const entries: CatalogEntry[] = Array.isArray(body)
    ? body
    : (body?.nodes ?? body?.catalog ?? body?.content ?? body?.entries ?? []);
  if (strict && (!Array.isArray(entries) || (!Array.isArray(body)
      && (!body || body.error || !['nodes', 'catalog', 'content', 'entries'].some(key => Array.isArray(body[key])))))) invalidWire();

  const map = new Map<string, string>();
  for (const e of entries) {
    if (strict && (!e || typeof e !== 'object' || Array.isArray(e))) invalidWire();
    if (strict) for (const value of [e.type, e.code, e.oauthProvider]) if (value != null) text(value);
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
 * missing. Default-off legacy checks remain best effort. Enabled server checks
 * and their404 compatibility path refuse unavailable or malformed reads.
 */
export async function requiredConnections(
  client: SwfteClient,
  workflow: any,
  workflowId?: string
): Promise<ConnectionRequirement[]> {
  return (await inspectConnections(client, workflow, workflowId)).requirements;
}

async function legacyRequiredConnections(client: SwfteClient, workflow: any, strict: boolean): Promise<ConnectionRequirement[]> {
  let byType: Map<string, string>;
  let connected: Set<string>;
  try {
    [byType, connected] = await Promise.all([providerByNodeType(client, strict), legacyConnectedProviders(client, strict)]);
  } catch (error) {
    if (strict) throw connectionFailure(error);
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
