import { SwfteApiError } from '../client.js';
import {
  pickId,
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

const WIZARD = '/v2/widgets/wizard';
const WIDGETS_V2 = '/api/v2/widgets';
const WIDGETS_V1 = '/v1/widgets';

export const widgetAdapter: KindAdapter = {
  kind: 'widget',
  label: 'Widget',
  notes:
    'The widget wizard persists as part of generation, so there is no separate create, steer, or ' +
    'refine step. Widgets can be CHAT, TABLE, SHEET, DASHBOARD, KPI_CARDS, STATUS_TIMELINE, PROGRESS, FORM or MIXED. ' +
    'Graphical widgets may use a native workspace data binding instead of a conversational brain. ' +
    'PUT /api/v2/widgets/{id} supports viewType, binding and dataBindingId; always read back persistence. ' +
    'Workspace data/forms require authenticated Studio rendering, not a public snapshot. ' +
    'Native POST /api/v2/widgets/{id}/resume restores an existing release; swfte_deploy does not accept action:resume. ' +
    'On deploy failure read current history before retrying; key rotation must persist the new signing-key reference.',

  async build(client, input: BuildInput) {
    // `attach` points the widget at an existing agent/chatflow/workflow instead
    // of generating a new backing brain. Without it the wizard creates a
    // chatflow, which is why this path passes the same creation gate.
    const attach = input.options?.attach as { kind?: string; id?: string } | undefined;

    const body = await client.request<any>({
      method: 'POST',
      path: `${WIZARD}/generate/async`,
      body: {
        description: input.prompt,
        ...(attach?.id ? { attach: { kind: attach.kind, id: attach.id } } : {}),
      },
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
    const raw = await client.request<any>({
      method: 'GET',
      path: `${WIZARD}/${encodeURIComponent(sessionId)}/status`,
      retries: 1,
    });
    return toSnapshot(raw, sessionId);
  },

  extractArtifact(snapshot) {
    const fr = snapshot.finalResponse as any;
    return fr?.widget ?? fr;
  },

  extractId(snapshot) {
    const fr = snapshot.finalResponse as any;
    return pickId(fr?.widget) ?? pickId(fr);
  },

  async deploy(client, id, _opts: DeployOpts): Promise<DeployResult> {
    // Public WidgetControllerV1 rejects inactive configs even if a deployment
    // record is LIVE. Confirmed deployment includes enabling this surface.
    const path = `${WIDGETS_V2}/${encodeURIComponent(id)}`;
    const initial = await client.request<any>({ method: 'GET', path, retries: 1 });
    if (initial?.active !== true) {
      await client.request({ method: 'PUT', path, body: { active: true }, retries: 0 });
      const enabled = await client.request<any>({ method: 'GET', path, retries: 1 });
      if (enabled?.active !== true) throw new Error('WIDGET_ACTIVATION_NOT_PERSISTED: active:true was not retained; no deployment snapshot was created. Inspect the existing widget before retrying.');
    }
    const body = await client.request<any>({
      method: 'POST', path: `${path}/deploy`, expectStatuses: [200, 201, 202], retries: 0, timeoutMs: 120_000,
    });
    const verificationErrors: string[] = [];
    let saved: any = null, publicConfig: any = null;
    try { saved = await client.request({ method: 'GET', path, retries: 1 }); }
    catch (error) { verificationErrors.push(`Saved readback failed: ${error instanceof Error ? error.message : String(error)}`); }
    try { publicConfig = await client.request({ method: 'GET', path: `${WIDGETS_V1}/${encodeURIComponent(id)}`, retries: 1 }); }
    catch (error) { verificationErrors.push(`Public config readback failed: ${error instanceof Error ? error.message : String(error)}`); }
    const deploymentId = body?.deploymentId ?? body?.id;
    const live = String(body?.deploymentStatus ?? body?.status ?? '').toUpperCase() === 'LIVE';
    const active = saved?.active === true;
    const matches = Boolean(deploymentId && saved?.deploymentId === deploymentId);
    return {
      deploymentId,
      phase: live && active && matches && publicConfig ? 'LIVE' : 'UNVERIFIED',
      url: body?.url ?? body?.embedUrl,
      raw: { deployed: body, saved, checks: { live, active, deploymentPointerMatches: matches, publicConfigReadable: Boolean(publicConfig), runtimeVerified: false }, verificationErrors,
        nextAction: saved?.dataBindingId ? 'Verify the authenticated data view and any FORM/MIXED submission readback. LIVE/config does not prove source execution or browser rendering.' : 'Exercise the widget in its allowed browser origin and observe its brain invocation. LIVE/config readback is not conversation or UI evidence.' },
    };
  },

  async teardown(client, id) {
    // Widgets pause rather than tear down — the lifecycle is
    // deploy → pause → resume → rollback. Pausing takes the widget off the
    // embed surface; the record and its deployment history survive, so it is
    // reversible with a resume.
    await client.request({
      method: 'POST',
      path: `${WIDGETS_V2}/${encodeURIComponent(id)}/pause`,
      expectStatuses: [200, 202, 204, 404],
      retries: 1,
    });
  },

  async get(client, id) {
    return client.request({ method: 'GET', path: `${WIDGETS_V2}/${encodeURIComponent(id)}`, retries: 1 });
  },

  async list(client) {
    return client.paginate({ path: WIDGETS_V2, sizeParam: 'size', pageSize: 50 });
  },

  async remove(client, id) {
    await client.request({
      method: 'DELETE',
      path: `${WIDGETS_V2}/${encodeURIComponent(id)}`,
      expectStatuses: [200, 202, 204],
      retries: 0,
    });
  },

  async verify(client, id, opts: VerifyOpts): Promise<VerifyReport> {
    const checks: VerifyCheck[] = [];
    const nextActions: string[] = [];

    let widget: any = null;
    try {
      widget = await client.request<any>({ method: 'GET', path: `${WIDGETS_V2}/${encodeURIComponent(id)}`, retries: 1 });
      checks.push({ id: 'persisted', ok: true, detail: `GET ${WIDGETS_V2}/${id} → 200 ("${widget?.name ?? 'unnamed'}")` });
    } catch (err) {
      const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
      checks.push({ id: 'persisted', ok: false, detail: `GET ${WIDGETS_V2}/${id} → ${msg}` });
      return { ok: false, kind: 'widget', id, checks, nextActions: ['Widget not found — check the id with swfte_widgets_list.'] };
    }

    const graphical = widget?.dataBindingId || (widget?.viewType && widget.viewType !== 'CHAT');
    const brain = widget?.brain?.id ? widget.brain : null;
    if (graphical) {
      if (widget?.dataBindingId) {
        try {
          const source = await client.request<any>({ method: 'GET', path: `/v1/widget-bindings/${encodeURIComponent(widget.dataBindingId)}`, retries: 1 });
          const scoped = Boolean(widget?.workspaceId) && source?.id === widget.dataBindingId && String(source?.workspaceId) === String(widget.workspaceId) && Boolean(source?.sourceType);
          checks.push({ id: 'bound', ok: scoped, detail: scoped ? `Data source ${source.sourceType}; view ${widget.viewType}. Source execution is not established by this record.` : 'Data binding is missing or belongs to another workspace.' });
          if (source?.sourceType === 'STUDIO_OPERATIONS') nextActions.push('Open the authenticated Studio widget view. Verify actual scoped rows and form save/reload; this source is not an anonymous public embed.');
        } catch (error) { checks.push({ id: 'bound', ok: false, detail: `Data binding read failed: ${String(error)}` }); }
      } else {
        checks.push({ id: 'bound', ok: null, detail: 'Graphical widget has no PULL source; verify its configured PUSH state and rendering before claiming functionality.' });
        nextActions.push('Attach a data source or exercise the PUSH state producer. A display type alone is not a working data widget.');
      }
    } else {
      const binding = brain ?? widget?.agentId;
      checks.push({ id: 'bound', ok: Boolean(binding), detail: binding ? `Conversational brain: ${JSON.stringify(binding)}` : 'No backing agent/chatflow/workflow for the conversational widget.' });
      if (!binding) nextActions.push('Attach an agent/chatflow/workflow for chat, or choose a graphical display with a data source.');
    }

    let status = String(widget?.deploymentStatus ?? 'DRAFT').toUpperCase();
    if (widget?.deploymentId) {
      try {
        const history = await client.request<any>({ method: 'GET', path: `${WIDGETS_V2}/${encodeURIComponent(id)}/deployments`, retries: 1 });
        const entries = Array.isArray(history) ? history : history?.content ?? [];
        const current = entries.find((d: any) => (d.id ?? d.deploymentId) === widget.deploymentId);
        status = String(current?.status ?? 'UNKNOWN').toUpperCase();
      } catch { status = 'UNVERIFIED'; }
    }
    const deployed = status === 'LIVE' && widget?.active === true;
    checks.push({ id: 'active', ok: widget?.active === true ? true : opts.requirePublished ? false : null, detail: `Public runtime requires active:true; saved active=${String(widget?.active)}` });
    checks.push({
      id: 'deployed',
      ok: deployed ? true : opts.requirePublished ? false : null,
      detail: deployed ? 'Deployed' : `Not deployed (status=${status})`,
    });

    if (deployed) {
      try {
        const config = await client.request<any>({ method: 'GET', path: `${WIDGETS_V1}/${encodeURIComponent(id)}`, retries: 1 });
        checks.push({ id: 'public-config', ok: Boolean(config), detail: 'Public configuration read; this does not establish data access, rendering or input persistence.' });
      } catch (error) { checks.push({ id: 'public-config', ok: false, detail: String(error) }); }
    }
    checks.push({ id: 'rendering', ok: null, detail: 'Browser rendering and runtime behavior require a separate live check. No native /v1/widgets/{id}/embed endpoint is assumed.' });
    nextActions.push(graphical ? 'Verify actual data in the Studio view; for FORM/MIXED submit a sourced record and read it back. Test read-only and cross-workspace rejection.' : 'Open the allowed browser origin and verify an actual conversation response.');

    const ok = checks.every((c) => c.ok !== false);
    if (ok && nextActions.length === 0) nextActions.push('Looks healthy — drop the embed snippet into a page to try it.');

    return { ok, kind: 'widget', id, checks, nextActions };
  },
};
