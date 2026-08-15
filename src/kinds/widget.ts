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
    'refine step. Rebuild with a fuller prompt, or edit the backing chatflow, to change one.',

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
    // Widgets deploy to the embed CDN rather than to compute — no sizing, no
    // provider, and nothing to poll: the response is the deployed state.
    const body = await client.request<any>({
      method: 'POST',
      path: `${WIDGETS_V2}/${encodeURIComponent(id)}/deploy`,
      expectStatuses: [200, 201, 202],
      retries: 0,
      timeoutMs: 120_000,
    });
    return {
      deploymentId: body?.deploymentId ?? body?.id,
      phase: String(body?.deploymentStatus ?? body?.status ?? 'READY'),
      url: body?.url ?? body?.embedUrl,
      raw: body,
    };
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

  async verify(client, id, _opts: VerifyOpts): Promise<VerifyReport> {
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

    // A widget with no backing brain renders but answers nothing.
    const binding = widget?.binding ?? widget?.attach ?? widget?.chatflowId ?? widget?.agentId;
    checks.push({
      id: 'bound',
      ok: Boolean(binding),
      detail: binding ? `Bound to ${JSON.stringify(binding).slice(0, 120)}` : 'No backing agent/chatflow/workflow — the widget has nothing to answer with',
    });
    if (!binding) nextActions.push('Rebuild the widget with an attach target, or bind it to an existing agent/chatflow.');

    const status = String(widget?.deploymentStatus ?? 'draft');
    const deployed = status === 'deployed';
    checks.push({
      id: 'deployed',
      ok: deployed ? true : null,
      detail: deployed ? 'Deployed' : `Not deployed (status=${status})`,
    });

    // The embed snippet is the actual deliverable — if it can't be fetched, the
    // widget is not usable regardless of what its record says.
    if (deployed) {
      try {
        const embed = await client.request<any>({
          method: 'GET',
          path: `${WIDGETS_V1}/${encodeURIComponent(id)}/embed`,
          retries: 1,
        });
        const snippet = embed?.snippet ?? embed?.script ?? embed?.embedCode;
        checks.push({
          id: 'embeddable',
          ok: Boolean(snippet),
          detail: snippet ? `Embed snippet available (${String(snippet).length} chars)` : 'Embed endpoint returned no snippet',
        });
        if (!snippet) nextActions.push('Redeploy the widget — the embed snippet did not generate.');
      } catch (err) {
        checks.push({
          id: 'embeddable',
          ok: false,
          detail: err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err),
        });
      }
    } else {
      checks.push({ id: 'embeddable', ok: null, detail: 'Skipped — deploy the widget first' });
      nextActions.push('Deploy the widget with swfte_deploy to get its embed snippet.');
    }

    const ok = checks.every((c) => c.ok !== false);
    if (ok && nextActions.length === 0) nextActions.push('Looks healthy — drop the embed snippet into a page to try it.');

    return { ok, kind: 'widget', id, checks, nextActions };
  },
};
