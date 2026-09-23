/**
 * Fetch everything the rules need, once, serially.
 *
 * Serial on purpose: the platform returns "fetch failed" under concurrency, and
 * a preflight that reported a healthy solution as broken because it fanned out
 * would be the exact class of lying check this tool exists to prevent.
 *
 * Anything that cannot be fetched is recorded as an ERROR on the snapshot, not
 * omitted. A rule whose input is missing returns `skip`, and skips are printed.
 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { get, tryGet, isError } from './api.mjs';

const PATHS = {
  workflow: (id) => `/v2/workflows/${id}`,
  agent: (id) => `/v2/agents/${id}`,
  chatflow: (id) => `/v2/chatflows/${id}`,
  widget: (id) => `/api/v2/widgets/${id}`,
  dataset: (id) => `/api/v2/datasets/${id}`,
  // Agent.knowledgeModuleIds lives in the KnowledgeModule id space, which
  // /v2/modules does not serve — it 404s on a knowledge-module id.
  module: (id) => `/v1/knowledge-modules/${id}`,
  application: (id) => `/v2/applications/${id}`,
};

export async function buildSnapshot(manifest, { executionsPerWorkflow = 3, log = () => {} } = {}) {
  const snap = { manifest, workspaceId: String(manifest.workspaceId), errors: [] };

  /* components */
  snap.components = [];
  for (const c of manifest.components ?? []) {
    if (!c.id) { snap.components.push({ ...c, record: null, error: 'no id in manifest' }); continue; }
    const p = PATHS[c.kind];
    if (!p) { snap.components.push({ ...c, record: null, error: `no fetch path for kind "${c.kind}"` }); continue; }
    log(`  fetch ${c.kind} ${c.key}`);
    const r = await tryGet(p(c.id));
    if (isError(r)) {
      snap.components.push({ ...c, record: null, error: r.$error });
      snap.errors.push(`${c.key}: ${r.$error}`);
    } else {
      snap.components.push({ ...c, record: r, error: null });
    }
  }

  snap.workflows = snap.components.filter((c) => c.kind === 'workflow' && c.record);

  /* executions + traces, per workflow */
  snap.executions = {};
  for (const wf of snap.workflows) {
    log(`  fetch executions ${wf.key}`);
    const list = await tryGet(`/v2/workflows/${wf.id}/executions`);
    const rows = isError(list) ? [] : (list.content ?? list ?? []);
    const take = (Array.isArray(rows) ? rows : []).slice(0, executionsPerWorkflow);
    const runs = [];
    for (const header of take) {
      const eid = header.executionId ?? header.id;
      const t = await tryGet(`/v2/workflows/executions/${eid}/traces`);
      const envelope = isError(t) ? null : t;
      const raw = envelope?.traces ?? {};
      const traces = Array.isArray(raw)
        ? raw
        : Object.entries(raw).map(([nodeId, v]) => ({ nodeId, ...v }));
      // The executions LIST carries the flattened variable pool — the per-node
      // output bags. That is where `inserted: 0, success: true` lives, and it
      // is the only place a write that wrote nothing is visible.
      const pool = header.outputData?.parameters ?? header.outputData ?? null;
      runs.push({ header: { ...header, id: eid, outputData: undefined }, envelopeStatus: envelope?.status ?? null, traces, pool });
    }
    snap.executions[wf.key] = runs;
  }

  /* workspace-wide catalogues */
  log('  fetch data tables');
  const dt = await tryGet('/v2/data-tables');
  snap.dataTablesLive = isError(dt) ? null : dt;

  log('  fetch knowledge modules');
  const km = await tryGet(`/v1/knowledge-modules?workspaceId=${snap.workspaceId}`);
  snap.knowledgeModules = isError(km) ? null : km.content ?? km.modules ?? km;

  log('  fetch datasets');
  const ds = await tryGet('/api/v2/datasets?limit=200');
  snap.datasets = isError(ds) ? null : ds.content ?? ds.data ?? ds;

  /* documents per dataset in the solution */
  snap.datasetDocs = {};
  for (const c of snap.components.filter((x) => x.kind === 'dataset' && x.id)) {
    log(`  fetch documents ${c.key}`);
    const docs = await tryGet(`/api/v2/datasets/${c.id}/documents`);
    snap.datasetDocs[c.id] = isError(docs) ? null : docs.content ?? docs.data ?? docs;
  }

  /* local build sources, for the checks whose subject is the operator */
  if (manifest.sourceDirs?.length) {
    snap.sourceFiles = [];
    for (const d of manifest.sourceDirs) {
      const root = join(manifest.$dir ?? '.', d);
      walk(root, (f) => {
        if (!['.mjs', '.js', '.ts', '.json'].includes(extname(f))) return;
        try { snap.sourceFiles.push({ path: f, text: readFileSync(f, 'utf8') }); } catch { /* unreadable */ }
      });
    }
  }

  return snap;
}

function walk(dir, fn) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    let st;
    // lstat: a symlink is never followed, so a source dir cannot reach outside itself.
    try { st = lstatSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, fn);
    else if (st.isFile()) fn(p);
  }
}

export { get };
