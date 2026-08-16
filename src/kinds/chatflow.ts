import { SwfteApiError } from '../client.js';
import {
  pickId,
  toFindings,
  toSnapshot,
  type BuildInput,
  type BuildSnapshot,
  type KindAdapter,
  type ValidationReport,
  type VerifyCheck,
  type VerifyOpts,
  type VerifyReport,
} from './_adapter.js';

const GEN = '/api/v2/chatflow/generate';
const CHATFLOWS = '/v2/chatflows';

export const chatflowAdapter: KindAdapter = {
  kind: 'chatflow',
  label: 'Chatflow',
  notes:
    'The chatflow generator persists as it builds — the id comes back from the build call itself, ' +
    'so there is no separate create step.',

  async build(client, input: BuildInput) {
    const body = await client.request<any>({
      method: 'POST',
      path: `${GEN}/async`,
      body: {
        description: input.prompt,
        constraints: input.options?.constraints,
        ...input.options,
      },
      expectStatuses: [200, 202],
      retries: 0,
      timeoutMs: 60_000,
    });
    if (!body?.sessionId) {
      throw new Error(`Generator did not return a sessionId: ${JSON.stringify(body).slice(0, 300)}`);
    }
    // The chatflow id is pre-generated so the canvas can navigate immediately —
    // stash it on the session handle so `swfte_build` can report it up front.
    return { sessionId: body.sessionId, ...(body.chatflowId ? { id: body.chatflowId } : {}) } as {
      sessionId: string;
    };
  },

  async status(client, sessionId): Promise<BuildSnapshot> {
    const raw = await client.request<any>({
      method: 'GET',
      path: `${GEN}/${encodeURIComponent(sessionId)}/status`,
      retries: 1,
    });
    return toSnapshot(raw, sessionId);
  },

  extractArtifact(snapshot) {
    const fr = snapshot.finalResponse as any;
    return fr?.chatFlow ?? fr?.chatflow ?? null;
  },

  extractId(snapshot) {
    const fr = snapshot.finalResponse as any;
    return pickId(fr?.chatFlow) ?? pickId(fr?.chatflow) ?? pickId(fr);
  },

  async steer(client, sessionId, instruction) {
    return client.request<any>({
      method: 'POST',
      path: `${GEN}/${encodeURIComponent(sessionId)}/steer`,
      body: { message: instruction },
      expectStatuses: [200, 202, 409],
      retries: 0,
    });
  },

  async validate(client, artifact): Promise<ValidationReport> {
    // The generator exposes /preview rather than /review — same intent, it
    // renders the flow without persisting so problems surface first.
    const preview = await client.request<any>({
      method: 'POST',
      path: `${GEN}/preview`,
      body: artifact,
      retries: 1,
    });
    return {
      valid: preview?.success !== false && !preview?.errors?.length,
      findings: toFindings(preview?.errors ?? preview?.validationErrors),
      suggestions: preview?.suggestions ?? [],
      raw: preview,
    };
  },

  async refine(client, artifact, feedback) {
    return client.request<any>({
      method: 'POST',
      path: `${GEN}/refine`,
      body: { feedback, instructions: feedback, chatFlow: artifact, currentChatFlow: artifact },
      retries: 0,
      timeoutMs: 180_000,
    });
  },

  async get(client, id) {
    return client.request({ method: 'GET', path: `${CHATFLOWS}/${encodeURIComponent(id)}`, retries: 1 });
  },

  async list(client) {
    return client.paginate({ path: CHATFLOWS, sizeParam: 'size', pageSize: 50 });
  },

  async remove(client, id) {
    await client.request({
      method: 'DELETE',
      path: `${CHATFLOWS}/${encodeURIComponent(id)}`,
      expectStatuses: [200, 202, 204],
      retries: 0,
    });
  },

  async verify(client, id, _opts: VerifyOpts): Promise<VerifyReport> {
    const checks: VerifyCheck[] = [];
    const nextActions: string[] = [];

    let flow: any = null;
    try {
      flow = await client.request<any>({ method: 'GET', path: `${CHATFLOWS}/${encodeURIComponent(id)}`, retries: 1 });
      checks.push({ id: 'persisted', ok: true, detail: `GET ${CHATFLOWS}/${id} → 200 ("${flow?.name ?? 'unnamed'}")` });
    } catch (err) {
      const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
      checks.push({ id: 'persisted', ok: false, detail: `GET ${CHATFLOWS}/${id} → ${msg}` });
      return { ok: false, kind: 'chatflow', id, checks, nextActions: ['Chatflow not found — check the id with swfte_chatflows_list.'] };
    }

    const fields = flow?.fields ?? [];
    checks.push({
      id: 'has-fields',
      ok: fields.length > 0,
      detail: fields.length > 0 ? `${fields.length} collected field(s)` : 'No fields defined — the flow will not collect anything',
    });
    if (fields.length === 0) nextActions.push('Add the fields this flow should collect via swfte_refine.');

    checks.push({
      id: 'goal-config',
      ok: null,
      detail: flow?.goalConfig ? 'Goal configuration present' : 'No goal configuration — the flow has no completion criterion',
    });

    const published = Boolean(flow?.published ?? flow?.status === 'PUBLISHED');
    // Same reasoning as the workflow adapter: draft is the normal state right
    // after a build, so it is information unless the caller expected it live.
    checks.push({
      id: 'published',
      ok: published ? true : _opts.requirePublished ? false : null,
      detail: published ? 'Published' : 'Draft only — not reachable by end users yet',
    });
    if (!published) nextActions.push('Publish the chatflow with swfte_chatflows_publish to make it reachable.');

    const ok = checks.every((c) => c.ok !== false);
    if (ok && nextActions.length === 0) nextActions.push('Looks healthy — start a session to try it end to end.');

    return { ok, kind: 'chatflow', id, checks, nextActions };
  },
};
