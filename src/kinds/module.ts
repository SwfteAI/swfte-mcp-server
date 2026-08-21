import { SwfteApiError } from '../client.js';
import {
  pickId,
  pickList,
  type BuildInput,
  type BuildSnapshot,
  type KindAdapter,
  type RunInput,
  type RunResult,
  type VerifyCheck,
  type VerifyOpts,
  type VerifyReport,
} from './_adapter.js';

const MODULES = '/v2/modules';

/**
 * Knowledge modules.
 *
 * Unlike the wizard-backed kinds, a module is not written from a description —
 * it is *assembled* from resources and then compiled. So `build` here means
 * "create the module and kick off a build", and progress is tracked by watching
 * for a new version rather than by polling a wizard run store.
 *
 * The backend exposes build progress over SSE only (`/{id}/build/progress`),
 * which does not survive the request boundaries this server works across, so
 * `status` polls the version list instead: a completed build appends a version.
 */
export const moduleAdapter: KindAdapter = {
  kind: 'module',
  label: 'Knowledge module',
  notes:
    'Modules are assembled from resources rather than generated from a description. swfte_build ' +
    'creates one and starts a build; attach documents with swfte_modules_* before building, or the ' +
    'module will compile with nothing in it.',

  async build(client, input: BuildInput) {
    // The prompt is the module's purpose, not a generation instruction.
    const created = await client.request<any>({
      method: 'POST',
      path: MODULES,
      body: {
        name: input.options?.name ?? input.prompt.slice(0, 60),
        description: input.prompt,
        ...input.options,
      },
      expectStatuses: [200, 201],
      retries: 0,
      timeoutMs: 60_000,
    });

    const id = pickId(created);
    if (!id) throw new Error(`Module create returned no id: ${JSON.stringify(created).slice(0, 300)}`);

    await client.request({
      method: 'POST',
      path: `${MODULES}/${encodeURIComponent(id)}/build`,
      body: { changeNotes: 'Initial build via MCP' },
      // 409 means a build is already running for this module, which is fine —
      // we are about to watch it either way.
      expectStatuses: [200, 202, 409],
      retries: 0,
    });

    // The module id doubles as the build correlation id, so it also serves as
    // our session handle.
    return { sessionId: id };
  },

  async status(client, sessionId): Promise<BuildSnapshot> {
    const [module, versions] = await Promise.all([
      client.request<any>({ method: 'GET', path: `${MODULES}/${encodeURIComponent(sessionId)}`, retries: 1 }),
      client
        .request<any>({ method: 'GET', path: `${MODULES}/${encodeURIComponent(sessionId)}/versions`, retries: 1 })
        .catch(() => []),
    ]);

    const versionList = pickList(versions);
    const status = String(module?.buildStatus ?? module?.status ?? 'BUILDING').toUpperCase();
    const failed = status.includes('FAIL') || status.includes('ERROR');
    // A build is done when it has produced a version, or the record says so.
    const done = versionList.length > 0 || failed || status === 'READY' || status === 'ACTIVE';

    return {
      sessionId,
      status,
      message: failed ? 'Module build failed' : `${versionList.length} version(s) built`,
      progress: done ? 100 : 50,
      done,
      error: failed ? (module?.buildError ?? 'Module build failed') : null,
      nodes: [],
      edges: [],
      speculativeNodes: [],
      finalResponse: { module, versions: versionList },
      raw: module,
    };
  },

  extractArtifact(snapshot) {
    return (snapshot.finalResponse as any)?.module ?? null;
  },

  extractId(snapshot) {
    return snapshot.sessionId;
  },

  async run(client, id, input: RunInput): Promise<RunResult> {
    // "Running" a knowledge module means querying it.
    const query = input.message ?? String(input.inputs?.query ?? '');
    if (!query) {
      return { ok: false, status: 'NO_QUERY', output: 'Pass a message or inputs.query to search the module.' };
    }

    const started = Date.now();
    const res = await client.request<any>({
      method: 'POST',
      path: '/v2/rag/search',
      body: { query, moduleIds: [id], topK: input.inputs?.topK ?? 5 },
      retries: 1,
      timeoutMs: input.timeoutMs ?? 60_000,
    });

    const hits = pickList(res?.results ?? res);
    return {
      ok: hits.length > 0,
      status: hits.length > 0 ? 'OK' : 'NO_RESULTS',
      output: hits,
      elapsedMs: Date.now() - started,
      raw: res,
    };
  },

  async get(client, id) {
    return client.request({ method: 'GET', path: `${MODULES}/${encodeURIComponent(id)}`, retries: 1 });
  },

  async list(client) {
    return client.paginate({ path: MODULES, sizeParam: 'size', pageSize: 50 });
  },

  async remove(client, id) {
    await client.request({
      method: 'DELETE',
      path: `${MODULES}/${encodeURIComponent(id)}`,
      expectStatuses: [200, 202, 204],
      retries: 0,
    });
  },

  async verify(client, id, opts: VerifyOpts): Promise<VerifyReport> {
    const checks: VerifyCheck[] = [];
    const nextActions: string[] = [];

    let module: any = null;
    try {
      module = await client.request<any>({ method: 'GET', path: `${MODULES}/${encodeURIComponent(id)}`, retries: 1 });
      checks.push({ id: 'persisted', ok: true, detail: `GET ${MODULES}/${id} → 200 ("${module?.name ?? 'unnamed'}")` });
    } catch (err) {
      const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
      checks.push({ id: 'persisted', ok: false, detail: `GET ${MODULES}/${id} → ${msg}` });
      return { ok: false, kind: 'module', id, checks, nextActions: ['Module not found — check the id with swfte_modules_list.'] };
    }

    // A module with no resources compiles happily and then retrieves nothing —
    // the most common way a knowledge module silently does not work.
    const resources = module?.resources ?? module?.dataSources ?? [];
    checks.push({
      id: 'has-resources',
      ok: resources.length > 0,
      detail: resources.length > 0 ? `${resources.length} resource(s) attached` : 'No resources attached — retrieval will always come back empty',
    });
    if (resources.length === 0) nextActions.push('Attach documents or data sources, then rebuild the module.');

    // Built at least once?
    try {
      const versions = pickList(
        await client.request<any>({ method: 'GET', path: `${MODULES}/${encodeURIComponent(id)}/versions`, retries: 1 })
      );
      checks.push({
        id: 'built',
        ok: versions.length > 0,
        detail: versions.length > 0 ? `${versions.length} version(s) built` : 'Never built — nothing is indexed yet',
      });
      if (versions.length === 0) nextActions.push('Build the module so its resources get indexed.');
    } catch {
      checks.push({ id: 'built', ok: null, detail: 'Version history unavailable — skipped' });
    }

    // Does retrieval actually return anything?
    if (opts.run) {
      const query = String(opts.inputs?.query ?? 'What is this module about?');
      const result = await this.run!(client, id, { message: query });
      checks.push({
        id: 'retrieves',
        ok: result.ok,
        detail: result.ok
          ? `Query "${query}" returned ${(result.output as unknown[]).length} hit(s)`
          : `Query "${query}" returned nothing — the module is indexed but not answering`,
      });
      if (!result.ok) nextActions.push('Check that the attached documents finished indexing, then retry retrieval.');
    } else {
      checks.push({ id: 'retrieves', ok: null, detail: 'Skipped — pass run:true to query the module' });
    }

    const ok = checks.every((c) => c.ok !== false);
    if (ok && nextActions.length === 0) {
      nextActions.push(opts.run ? 'Looks healthy — link it to an agent.' : 'Re-run with run:true to confirm retrieval works.');
    }

    return { ok, kind: 'module', id, checks, nextActions };
  },
};
