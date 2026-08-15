import { SwfteApiError } from '../client.js';
import {
  pickList,
  type DeployOpts,
  type DeployPreview,
  type DeployResult,
  type KindAdapter,
  type RunInput,
  type RunResult,
  type VerifyCheck,
  type VerifyOpts,
  type VerifyReport,
} from './_adapter.js';

const VAULT = '/v2/model-vault';

/** Model deployments settle into one of these. */
const TERMINAL_DEPLOY = new Set(['READY', 'RUNNING', 'FAILED', 'STOPPED', 'TERMINATED']);

/**
 * Model-vault models.
 *
 * Deliberately has no `build`: a model is *uploaded*, not generated, and a
 * multi-part upload of weights is not something to drive through a chat turn.
 * Use the Studio upload flow (or the vault upload endpoints directly) to get
 * weights in; everything after that — promote, deploy, probe, verify — is here.
 */
export const modelAdapter: KindAdapter = {
  kind: 'model',
  label: 'Model',
  notes:
    'Models are uploaded, not generated, so there is no build step. Upload weights via Studio → ' +
    'Model Vault, then use swfte_deploy / swfte_run / swfte_verify here.',

  async deployPreview(client, id): Promise<DeployPreview> {
    const model = await client.request<any>({
      method: 'GET',
      path: `${VAULT}/models/${encodeURIComponent(id)}`,
      retries: 1,
    });

    // Deploying a model always needs a GPU, so the useful preview is what it is
    // and whether it is in a deployable state — not a provider choice.
    return {
      requiresGpu: true,
      models: [model],
      runtimeProfile: { status: model?.status, sizeBytes: model?.sizeBytes, format: model?.format },
      raw: {
        model,
        note:
          'Model serving is GPU-backed and billed while running. Check status is PROMOTED/READY ' +
          'before deploying, and tear the deployment down when you are finished.',
      },
    };
  },

  async deploy(client, id, opts: DeployOpts): Promise<DeployResult> {
    const started = await client.request<any>({
      method: 'POST',
      path: `${VAULT}/models/${encodeURIComponent(id)}/deploy`,
      body: { gpuTier: opts.gpuTier ? String(opts.gpuTier).toUpperCase() : undefined, region: opts.region },
      expectStatuses: [200, 201, 202],
      retries: 0,
      timeoutMs: 120_000,
    });

    const { snapshot, timedOut } = await client.pollUntil<any>(
      () =>
        client.request<any>({
          method: 'GET',
          path: `${VAULT}/models/${encodeURIComponent(id)}/deploy/status`,
          retries: 1,
        }),
      (s) => TERMINAL_DEPLOY.has(String(s?.status ?? s?.phase ?? '').toUpperCase()),
      { timeoutMs: opts.timeoutMs ?? 900_000, intervalMs: 10_000 }
    );

    return {
      deploymentId: started?.deploymentId ?? started?.id,
      phase: String(snapshot?.status ?? snapshot?.phase ?? 'UNKNOWN'),
      endpoint: snapshot?.endpoint ?? snapshot?.url,
      url: snapshot?.url ?? snapshot?.endpoint,
      timedOut,
      raw: { started, status: snapshot },
    };
  },

  async teardown(client, id) {
    await client.request({
      method: 'DELETE',
      path: `${VAULT}/models/${encodeURIComponent(id)}/deploy`,
      expectStatuses: [200, 202, 204, 404],
      retries: 1,
    });
  },

  async run(client, id, input: RunInput): Promise<RunResult> {
    const started = Date.now();
    const prompt = input.message ?? String(input.inputs?.prompt ?? 'Hello');

    try {
      const res = await client.request<any>({
        method: 'POST',
        // The vault proxies inference through to the deployed model.
        path: `${VAULT}/models/${encodeURIComponent(id)}/proxy/v1/completions`,
        body: { prompt, max_tokens: input.inputs?.maxTokens ?? 64, ...input.inputs },
        retries: 0,
        timeoutMs: input.timeoutMs ?? 120_000,
      });
      const text = res?.choices?.[0]?.text ?? res?.choices?.[0]?.message?.content ?? res;
      return { ok: Boolean(text), status: 'OK', output: text, elapsedMs: Date.now() - started, raw: res };
    } catch (err) {
      if (err instanceof SwfteApiError && (err.status === 404 || err.status === 409 || err.status === 503)) {
        return {
          ok: false,
          status: 'NOT_SERVING',
          output: 'The model is not currently deployed, so there is nothing to send a prompt to.',
          elapsedMs: Date.now() - started,
          raw: err.toJSON(),
        };
      }
      throw err;
    }
  },

  async get(client, id) {
    return client.request({ method: 'GET', path: `${VAULT}/models/${encodeURIComponent(id)}`, retries: 1 });
  },

  async list(client) {
    const body = await client.request<any>({ method: 'GET', path: `${VAULT}/models`, retries: 1 });
    return pickList(body);
  },

  async remove(client, id) {
    await client.request({
      method: 'DELETE',
      path: `${VAULT}/models/${encodeURIComponent(id)}`,
      expectStatuses: [200, 202, 204],
      retries: 0,
    });
  },

  async verify(client, id, opts: VerifyOpts): Promise<VerifyReport> {
    const checks: VerifyCheck[] = [];
    const nextActions: string[] = [];

    let model: any = null;
    try {
      model = await client.request<any>({ method: 'GET', path: `${VAULT}/models/${encodeURIComponent(id)}`, retries: 1 });
      checks.push({ id: 'persisted', ok: true, detail: `Model "${model?.name ?? id}" found (${model?.format ?? 'unknown format'})` });
    } catch (err) {
      const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
      checks.push({ id: 'persisted', ok: false, detail: `GET model ${id} → ${msg}` });
      return { ok: false, kind: 'model', id, checks, nextActions: ['Model not found — list them with swfte_model_vault_list.'] };
    }

    // A model whose upload never completed looks present but has no weights.
    const status = String(model?.status ?? '').toUpperCase();
    const uploaded = !['UPLOADING', 'PENDING', 'FAILED', ''].includes(status);
    checks.push({
      id: 'upload-complete',
      ok: uploaded,
      detail: uploaded ? `status=${status}` : `status=${status || 'unknown'} — the upload has not finished, so there are no weights to serve`,
    });
    if (!uploaded) nextActions.push('Finish or restart the weight upload in Studio → Model Vault.');

    // Deployed?
    let serving = false;
    try {
      const deployStatus = await client.request<any>({
        method: 'GET',
        path: `${VAULT}/models/${encodeURIComponent(id)}/deploy/status`,
        retries: 1,
      });
      const phase = String(deployStatus?.status ?? deployStatus?.phase ?? '').toUpperCase();
      serving = ['READY', 'RUNNING'].includes(phase);
      checks.push({
        id: 'deployed',
        ok: serving ? true : null,
        detail: serving ? `Serving (${phase})${deployStatus?.endpoint ? ` at ${deployStatus.endpoint}` : ''}` : `Not serving (${phase || 'no deployment'})`,
      });
      if (serving) {
        nextActions.push('This model is serving on GPU and billing while it runs — tear it down when finished.');
      }
    } catch {
      checks.push({ id: 'deployed', ok: null, detail: 'No deployment status available' });
    }

    if (opts.run && serving) {
      const result = await this.run!(client, id, { message: String(opts.inputs?.prompt ?? 'Say hello in five words.') });
      checks.push({
        id: 'infers',
        ok: result.ok,
        detail: result.ok
          ? `Inference returned in ${((result.elapsedMs ?? 0) / 1000).toFixed(1)}s`
          : `Inference failed: ${result.status}`,
      });
    } else {
      checks.push({
        id: 'infers',
        ok: null,
        detail: opts.run ? 'Skipped — the model is not serving' : 'Skipped — pass run:true to send a test prompt',
      });
    }

    const ok = checks.every((c) => c.ok !== false);
    if (ok && nextActions.length === 0) nextActions.push('Looks healthy.');

    return { ok, kind: 'model', id, checks, nextActions };
  },
};
