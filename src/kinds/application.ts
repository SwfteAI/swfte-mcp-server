import { SwfteApiError } from '../client.js';
import {
  pickId,
  pickList,
  toSnapshot,
  type BuildInput,
  type BuildSnapshot,
  type DeployOpts,
  type DeployResult,
  type KindAdapter,
  type VerifyCheck,
  type VerifyOpts,
  type VerifyReport,
} from './_adapter.js';

const WIZARD = '/v2/applications/wizard';
const APPLICATIONS = '/v2/applications';

/** Hosting deployments settle into one of these; anything else is in flight. */
const TERMINAL_HOSTING = new Set(['RUNNING', 'READY', 'FAILED', 'STOPPED', 'DESTROYED']);

export const applicationAdapter: KindAdapter = {
  kind: 'application',
  label: 'Application',
  notes:
    'The applications wizard is experimental and produces a PRD-grade blueprint, not a persisted ' +
    'app — it exposes neither steer nor refine. Feed the blueprint into swfte_applications_create.',

  async build(client, input: BuildInput) {
    const body = await client.request<any>({
      method: 'POST',
      path: `${WIZARD}/blueprint/async`,
      // This wizard takes `objective`, not `description`.
      body: { objective: input.prompt },
      expectStatuses: [200, 202],
      retries: 0,
      timeoutMs: 60_000,
    });
    if (!body?.sessionId) {
      throw new Error(`Wizard did not return a sessionId: ${JSON.stringify(body).slice(0, 300)}`);
    }
    return { sessionId: body.sessionId };
  },

  async status(client, sessionId): Promise<BuildSnapshot> {
    // Note the path shape differs from every other wizard: the session id is a
    // trailing segment of /blueprint/status, not a leading one.
    const raw = await client.request<any>({
      method: 'GET',
      path: `${WIZARD}/blueprint/status/${encodeURIComponent(sessionId)}`,
      retries: 1,
    });
    return toSnapshot(raw, sessionId);
  },

  extractArtifact(snapshot) {
    const fr = snapshot.finalResponse as any;
    return fr?.blueprint ?? fr;
  },

  async create(client, artifact) {
    const body = await client.request<any>({
      method: 'POST',
      path: APPLICATIONS,
      body: artifact,
      expectStatuses: [200, 201],
      retries: 0,
      timeoutMs: 90_000,
    });
    const id = pickId(body);
    if (!id) throw new Error(`Create succeeded but returned no id: ${JSON.stringify(body).slice(0, 300)}`);
    return { id, raw: body };
  },

  async deploy(client, id, opts: DeployOpts): Promise<DeployResult> {
    const started = await client.request<any>({
      method: 'POST',
      path: `${APPLICATIONS}/${encodeURIComponent(id)}/host`,
      body: { tier: opts.option === 'dedicated' ? 'SERVER' : undefined },
      expectStatuses: [200, 201, 202],
      retries: 0,
      timeoutMs: 120_000,
    });

    const deploymentId = started?.deploymentId ?? started?.id;
    if (!deploymentId) {
      return { phase: 'QUEUED', raw: { started: started ?? null } };
    }

    const { snapshot, timedOut } = await client.pollUntil<any>(
      () =>
        client.request<any>({
          method: 'GET',
          path: `${APPLICATIONS}/${encodeURIComponent(id)}/hosting/${encodeURIComponent(String(deploymentId))}`,
          retries: 1,
        }),
      (s) => TERMINAL_HOSTING.has(String(s?.status ?? s?.phase ?? '').toUpperCase()),
      { timeoutMs: opts.timeoutMs ?? 600_000, intervalMs: 5_000 }
    );

    return {
      deploymentId: String(deploymentId),
      phase: String(snapshot?.status ?? snapshot?.phase ?? 'UNKNOWN'),
      url: snapshot?.url ?? snapshot?.publicUrl,
      timedOut,
      raw: { started, status: snapshot },
    };
  },

  async teardown(client, id, deploymentId) {
    if (!deploymentId) throw new Error('An application teardown needs the deploymentId to destroy.');
    await client.request({
      method: 'DELETE',
      path: `${APPLICATIONS}/${encodeURIComponent(id)}/hosting/${encodeURIComponent(deploymentId)}`,
      expectStatuses: [200, 202, 204, 404],
      retries: 1,
    });
  },

  async get(client, id) {
    return client.request({ method: 'GET', path: `${APPLICATIONS}/${encodeURIComponent(id)}`, retries: 1 });
  },

  async list(client) {
    return client.paginate({ path: APPLICATIONS, sizeParam: 'size', pageSize: 50 });
  },

  async remove(client, id) {
    await client.request({
      method: 'DELETE',
      path: `${APPLICATIONS}/${encodeURIComponent(id)}`,
      expectStatuses: [200, 202, 204],
      retries: 0,
    });
  },

  async verify(client, id, _opts: VerifyOpts): Promise<VerifyReport> {
    const checks: VerifyCheck[] = [];
    const nextActions: string[] = [];

    let app: any = null;
    try {
      app = await client.request<any>({ method: 'GET', path: `${APPLICATIONS}/${encodeURIComponent(id)}`, retries: 1 });
      checks.push({ id: 'persisted', ok: true, detail: `GET ${APPLICATIONS}/${id} → 200 ("${app?.name ?? 'unnamed'}")` });
    } catch (err) {
      const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
      checks.push({ id: 'persisted', ok: false, detail: `GET ${APPLICATIONS}/${id} → ${msg}` });
      return { ok: false, kind: 'application', id, checks, nextActions: ['Application not found — check the id with swfte_applications_list.'] };
    }

    try {
      const deployments = pickList(
        await client.request<any>({
          method: 'GET',
          path: `${APPLICATIONS}/${encodeURIComponent(id)}/hosting`,
          retries: 1,
        })
      ) as any[];

      const live = deployments.filter((d) => ['RUNNING', 'READY'].includes(String(d?.status ?? '').toUpperCase()));
      checks.push({
        id: 'hosted',
        ok: deployments.length === 0 ? null : live.length > 0,
        detail:
          deployments.length === 0
            ? 'No hosting deployments'
            : `${live.length}/${deployments.length} deployment(s) live${live[0]?.url ? ` at ${live[0].url}` : ''}`,
      });

      if (live.length > 0 && live[0]?.url) {
        // The record saying RUNNING is not the same as the URL answering.
        try {
          const res = await fetch(live[0].url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
          checks.push({
            id: 'reachable',
            ok: res.ok,
            detail: `HEAD ${live[0].url} → ${res.status} ${res.statusText}`,
          });
          if (!res.ok) nextActions.push('The app is deployed but its URL is not serving — check deployment logs.');
        } catch (err) {
          checks.push({
            id: 'reachable',
            ok: false,
            detail: `HEAD ${live[0].url} failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          nextActions.push('The deployed URL did not respond — check deployment logs.');
        }
      } else {
        checks.push({ id: 'reachable', ok: null, detail: 'Skipped — nothing live to reach' });
        if (deployments.length === 0) nextActions.push('Deploy the application with swfte_deploy to get a live URL.');
      }
    } catch {
      checks.push({ id: 'hosted', ok: null, detail: 'Hosting API unavailable on this instance — skipped' });
      checks.push({ id: 'reachable', ok: null, detail: 'Skipped' });
    }

    const ok = checks.every((c) => c.ok !== false);
    if (ok && nextActions.length === 0) nextActions.push('Looks healthy.');

    return { ok, kind: 'application', id, checks, nextActions };
  },
};
