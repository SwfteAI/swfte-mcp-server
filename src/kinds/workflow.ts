import type { SwfteClient } from '../client.js';
import { SwfteApiError } from '../client.js';
import {
  isSucceededRunStatus,
  isTerminalRunStatus,
  pickId,
  pickList,
  toFindings,
  toSnapshot,
  type BuildInput,
  type BuildSnapshot,
  type DeployOpts,
  type DeployPreview,
  type DeployResult,
  type KindAdapter,
  type RunInput,
  type RunResult,
  type ValidationReport,
  type VerifyCheck,
  type VerifyOpts,
  type VerifyReport,
} from './_adapter.js';

const WIZARD = '/v2/workflows/wizard';
const WORKFLOWS = '/v2/workflows';
const EXECUTIONS = '/v2/workflow-executions';

/**
 * Deploy phases, in order. `READY` and `FAILED` are terminal.
 * Mirrors the studio's `WORKFLOW_DEPLOY_PHASE_ORDER`.
 */
const TERMINAL_DEPLOY_PHASES = new Set(['READY', 'FAILED', 'CANCELLED', 'DESTROYED']);

/**
 * The wizard's `GeneratedWorkflow` uses `connections`; the draft store and the
 * canvas use `edges`. Both spellings appear on the wire depending on which side
 * produced the object, so normalise once and carry both.
 */
function normaliseGraph(artifact: any): { nodes: any[]; edges: any[] } {
  const nodes = artifact?.nodes ?? [];
  const edges = artifact?.connections ?? artifact?.edges ?? [];
  return {
    nodes: Array.isArray(nodes) ? nodes : Object.values(nodes ?? {}),
    edges: Array.isArray(edges) ? edges : [],
  };
}

const nodeId = (n: any): string => String(n?.id ?? n?.nodeId ?? n?.key ?? '');
const edgeSource = (e: any): string => String(e?.source ?? e?.sourceNodeId ?? e?.from ?? '');
const edgeTarget = (e: any): string => String(e?.target ?? e?.targetNodeId ?? e?.to ?? '');

/** Node types that legitimately have no inbound edge. */
const ENTRY_TYPES = /trigger|start|webhook|schedule|cron|manual|entry/i;

const isEntryNode = (n: any): boolean =>
  ENTRY_TYPES.test(String(n?.type ?? n?.nodeType ?? n?.kind ?? n?.data?.type ?? ''));

/**
 * Static graph soundness. This catches the failure the wizard is most prone to
 * and that the API itself will happily accept: nodes generated but never wired,
 * and edges pointing at ids that don't exist.
 */
export function analyseGraph(artifact: unknown): {
  ok: boolean;
  nodeCount: number;
  edgeCount: number;
  orphans: string[];
  danglingEdges: string[];
  summary: string;
} {
  const { nodes, edges } = normaliseGraph(artifact);
  const ids = new Set(nodes.map(nodeId).filter(Boolean));

  const connected = new Set<string>();
  const dangling: string[] = [];
  for (const e of edges) {
    const s = edgeSource(e);
    const t = edgeTarget(e);
    if ((s && !ids.has(s)) || (t && !ids.has(t))) dangling.push(`${s || '?'} → ${t || '?'}`);
    if (s) connected.add(s);
    if (t) connected.add(t);
  }

  // A single-node graph is trivially connected; don't report its one node as an orphan.
  const orphans =
    nodes.length > 1
      ? nodes.filter((n) => nodeId(n) && !connected.has(nodeId(n)) && !isEntryNode(n)).map(nodeId)
      : [];

  const ok = orphans.length === 0 && dangling.length === 0 && nodes.length > 0;
  const parts = [`${nodes.length} nodes`, `${edges.length} edges`];
  if (orphans.length) parts.push(`${orphans.length} unwired: ${orphans.join(', ')}`);
  else parts.push('0 unwired');
  if (dangling.length) parts.push(`${dangling.length} dangling: ${dangling.join(', ')}`);
  else parts.push('0 dangling');

  return { ok, nodeCount: nodes.length, edgeCount: edges.length, orphans, danglingEdges: dangling, summary: parts.join(', ') };
}

/**
 * Look for credentials pasted literally into node config instead of referenced
 * as secrets. A false positive here is cheap; a leaked key in an exported
 * workflow is not.
 */
const SECRET_LIKE = /^(sk-|pat_|ghp_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9_\-]{8,}/;
const SECRET_KEY = /(api[_-]?key|secret|password|token|credential|passwd)/i;

function scanForPlaintextSecrets(artifact: unknown): string[] {
  const hits: string[] = [];
  const walk = (value: unknown, path: string[]): void => {
    if (path.length > 12) return; // depth guard against cyclic-ish structures
    if (typeof value === 'string') {
      const key = path[path.length - 1] ?? '';
      // A `{{secrets.X}}` / `${...}` reference is exactly what we want to see.
      if (/\{\{|\$\{/.test(value)) return;
      if (SECRET_LIKE.test(value) || (SECRET_KEY.test(key) && value.length > 16)) {
        hits.push(path.join('.'));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...path, String(i)]));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
    }
  };
  walk(artifact, []);
  return hits;
}

async function executeAndPoll(
  client: SwfteClient,
  id: string,
  input: RunInput,
  opts: { testingFlag: boolean }
): Promise<RunResult> {
  const started = Date.now();

  const start = await client.request<any>({
    method: 'POST',
    path: `${WORKFLOWS}/${encodeURIComponent(id)}/execute`,
    query: opts.testingFlag ? { skipValidation: true } : undefined,
    body: { inputs: input.inputs ?? {}, ...(opts.testingFlag ? { testingFlag: true } : {}) },
    expectStatuses: [200, 201, 202],
    // Never auto-retry a start: a duplicate here means two real executions.
    retries: 0,
    timeoutMs: 60_000,
  });

  const executionId = start?.executionId ?? start?.id;
  if (!executionId) {
    return {
      ok: false,
      status: 'NO_EXECUTION_ID',
      output: start,
      elapsedMs: Date.now() - started,
      raw: start,
    };
  }

  const { snapshot, timedOut, elapsedMs } = await client.pollUntil<any>(
    () =>
      client.request<any>({
        method: 'GET',
        path: `${EXECUTIONS}/${encodeURIComponent(String(executionId))}`,
        retries: 1,
      }),
    (s) => isTerminalRunStatus(s?.status),
    { timeoutMs: input.timeoutMs ?? 180_000, intervalMs: 3_000 }
  );

  // Per-node traces live under outputData._traces, keyed by node id.
  const traces = (snapshot?.outputData?._traces ?? {}) as Record<string, any>;

  return {
    ok: isSucceededRunStatus(snapshot?.status),
    status: timedOut ? `${snapshot?.status ?? 'UNKNOWN'} (still running at timeout)` : String(snapshot?.status ?? 'UNKNOWN'),
    output: snapshot?.outputData,
    nodeTraces: Object.entries(traces).map(([tid, t]: [string, any]) => ({
      id: tid,
      status: String(t?.status ?? 'UNKNOWN'),
      type: t?.nodeType,
      error: t?.error,
    })),
    elapsedMs,
    raw: { executionId, execution: snapshot },
  };
}

export const workflowAdapter: KindAdapter = {
  kind: 'workflow',
  label: 'Workflow',

  async build(client, input: BuildInput) {
    const body = await client.request<any>({
      method: 'POST',
      path: `${WIZARD}/generate/async`,
      body: {
        description: input.prompt,
        model: input.model,
        autoCreate: input.autoCreate ?? false,
        ...input.options,
      },
      expectStatuses: [200, 202],
      retries: 0,
      timeoutMs: 60_000,
    });
    const sessionId = body?.sessionId;
    if (!sessionId) throw new Error(`Wizard did not return a sessionId: ${JSON.stringify(body).slice(0, 300)}`);
    return { sessionId };
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
    return fr?.generatedWorkflow ?? fr?.workflow ?? null;
  },

  extractId(snapshot) {
    const fr = snapshot.finalResponse as any;
    return pickId(fr) ?? pickId(fr?.generatedWorkflow);
  },

  async steer(client, sessionId, instruction) {
    // 202 = queued; 409 = the build already finished, which is a real answer
    // rather than an error the caller should retry.
    const res = await client.request<any>({
      method: 'POST',
      path: `${WIZARD}/${encodeURIComponent(sessionId)}/steer`,
      body: { message: instruction },
      expectStatuses: [200, 202, 409],
      retries: 0,
    });
    return res;
  },

  async validate(client, artifact): Promise<ValidationReport> {
    // The wizard's own reviewer understands the generated shape and returns
    // suggestions alongside errors, which /v2/workflows/validate does not.
    const review = await client.request<any>({
      method: 'POST',
      path: `${WIZARD}/review`,
      body: artifact,
      retries: 1,
    });

    const graph = analyseGraph(artifact);
    const findings = toFindings(review?.validationErrors);

    // Fold the static analysis in — the backend reviewer does not currently
    // reject an unwired node, and that is the defect most worth catching.
    if (graph.orphans.length > 0) {
      findings.push({
        severity: 'error',
        message: `${graph.orphans.length} node(s) are not connected by any edge: ${graph.orphans.join(', ')}. They will never execute.`,
      });
    }
    for (const d of graph.danglingEdges) {
      findings.push({ severity: 'error', message: `Edge references a node that does not exist: ${d}` });
    }

    return {
      valid: Boolean(review?.valid) && graph.ok,
      findings,
      suggestions: review?.suggestions ?? [],
      raw: { review, graph },
    };
  },

  async create(client, artifact) {
    const body = await client.request<any>({
      method: 'POST',
      path: `${WIZARD}/create`,
      body: { workflow: artifact },
      expectStatuses: [200, 201],
      retries: 0,
      timeoutMs: 90_000,
    });
    const id = pickId(body);
    if (!id) throw new Error(`Create succeeded but returned no id: ${JSON.stringify(body).slice(0, 300)}`);
    return { id, raw: body };
  },

  async refine(client, artifact, feedback) {
    // `currentWorkflow` is REQUIRED — the backend rebuilds the refine prompt
    // from the existing graph, and omitting it makes every refine fail.
    return client.request<any>({
      method: 'POST',
      path: `${WIZARD}/refine`,
      body: { feedback, currentWorkflow: artifact },
      retries: 0,
      timeoutMs: 180_000,
    });
  },

  async run(client, id, input): Promise<RunResult> {
    try {
      return await executeAndPoll(client, id, input, { testingFlag: false });
    } catch (err) {
      // A created-but-unpublished workflow 409s on /execute. That's the normal
      // state right after a build, so fall back to the draft test path the UI's
      // "Test workflow → Run" uses rather than making the caller know this.
      const isUnpublished =
        err instanceof SwfteApiError &&
        (err.status === 409 || /NOT_PUBLISHED/i.test(err.code) || /not published/i.test(err.message));
      if (!isUnpublished) throw err;

      const result = await executeAndPoll(client, id, input, { testingFlag: true });
      return {
        ...result,
        raw: {
          ...(result.raw as object),
          note: 'Workflow is not published; ran via the draft test path (testingFlag). Publish it to run the released version.',
        },
      };
    }
  },

  async deployPreview(client, id): Promise<DeployPreview> {
    // The unified deploy router runs the dependency / GPU / runtime-profile
    // analyzers and reports the target IT chose. Callers never name a provider.
    const [preview, plan] = await Promise.all([
      client.request<any>({ method: 'GET', path: `${WORKFLOWS}/${encodeURIComponent(id)}/deploy/preview`, retries: 1 }),
      client
        .request<any>({ method: 'GET', path: `${WORKFLOWS}/${encodeURIComponent(id)}/deploy/plan`, retries: 1 })
        .catch(() => null),
    ]);

    return {
      target: preview?.target,
      requiresGpu: preview?.requiresGpu,
      models: preview?.models,
      estimatedCost: preview?.estimatedCost,
      runtimeProfile: preview?.runtimeProfile,
      managedDatabases: plan,
      raw: { preview, plan },
    };
  },

  async deploy(client, id, opts: DeployOpts): Promise<DeployResult> {
    // Default path: the unified router picks the target. `option` opts into the
    // managed path where the caller wants explicit capacity control.
    const useManaged = Boolean(opts.option || opts.gpuTier || opts.region);

    const started = await client.request<any>(
      useManaged
        ? {
            method: 'POST',
            path: `${WORKFLOWS}/${encodeURIComponent(id)}/deploy/managed`,
            body: {
              option: opts.option,
              region: opts.region,
              lifecycle: opts.lifecycle,
              secretId: opts.secretId,
              // gpuTier travels UPPERCASE on the wire; normalising here rather
              // than at the tool boundary keeps the caller from having to know.
              gpuTier: opts.gpuTier ? String(opts.gpuTier).toUpperCase() : undefined,
            },
            expectStatuses: [200, 201, 202],
            retries: 0,
            timeoutMs: 120_000,
          }
        : {
            method: 'POST',
            path: `${WORKFLOWS}/${encodeURIComponent(id)}/deploy`,
            expectStatuses: [200, 201, 202],
            retries: 0,
            timeoutMs: 120_000,
          }
    );

    // A 202 for an async provision can carry an EMPTY body — `request` already
    // returns undefined rather than throwing, so handle the absence here.
    const deploymentId = started?.deploymentId ?? started?.id;
    if (!deploymentId) {
      return {
        phase: 'QUEUED',
        timedOut: false,
        raw: {
          started: started ?? null,
          note: 'Provisioning was accepted but no deployment id came back. Use swfte_deployments_list to find it.',
        },
      };
    }

    const { snapshot, timedOut } = await client.pollUntil<any>(
      () =>
        client.request<any>({
          method: 'GET',
          path: `${WORKFLOWS}/${encodeURIComponent(id)}/deploy/${encodeURIComponent(String(deploymentId))}/status`,
          retries: 1,
        }),
      (s) => TERMINAL_DEPLOY_PHASES.has(String(s?.phase ?? s?.state ?? '').toUpperCase()),
      { timeoutMs: opts.timeoutMs ?? 600_000, intervalMs: 5_000 }
    );

    return {
      deploymentId: String(deploymentId),
      phase: String(snapshot?.phase ?? snapshot?.state ?? 'UNKNOWN'),
      url: snapshot?.url ?? snapshot?.connectionDetails?.url,
      endpoint: snapshot?.endpoint ?? snapshot?.connectionDetails?.endpoint,
      timedOut,
      raw: { started, status: snapshot },
    };
  },

  async teardown(client, id, deploymentId) {
    await client.request({
      method: 'DELETE',
      path: deploymentId
        ? `${WORKFLOWS}/${encodeURIComponent(id)}/deploy/${encodeURIComponent(deploymentId)}`
        : `${WORKFLOWS}/${encodeURIComponent(id)}/deploy/managed`,
      expectStatuses: [200, 202, 204, 404],
      retries: 1,
    });
  },

  async get(client, id) {
    return client.request({ method: 'GET', path: `${WORKFLOWS}/${encodeURIComponent(id)}`, retries: 1 });
  },

  async list(client) {
    return client.paginate({ path: WORKFLOWS, sizeParam: 'size', pageSize: 50 });
  },

  async remove(client, id) {
    await client.request({
      method: 'DELETE',
      path: `${WORKFLOWS}/${encodeURIComponent(id)}`,
      expectStatuses: [200, 202, 204],
      retries: 0,
    });
  },

  async verify(client, id, opts: VerifyOpts): Promise<VerifyReport> {
    const checks: VerifyCheck[] = [];
    const nextActions: string[] = [];

    // 1. Persisted?
    let workflow: any = null;
    try {
      workflow = await client.request<any>({
        method: 'GET',
        path: `${WORKFLOWS}/${encodeURIComponent(id)}`,
        retries: 1,
      });
      checks.push({ id: 'persisted', ok: true, detail: `GET ${WORKFLOWS}/${id} → 200 ("${workflow?.name ?? 'unnamed'}")` });
    } catch (err) {
      const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
      checks.push({ id: 'persisted', ok: false, detail: `GET ${WORKFLOWS}/${id} → ${msg}` });
      return {
        ok: false,
        kind: 'workflow',
        id,
        checks,
        nextActions: ['The workflow does not exist or is not readable — check the id with swfte_workflows_list.'],
      };
    }

    // 2. Graph soundness — the check the API itself will not do for you.
    const graph = analyseGraph(workflow);
    checks.push({ id: 'graph-sound', ok: graph.ok, detail: graph.summary });
    if (graph.orphans.length > 0) {
      nextActions.push(
        `Wire up the unconnected node(s) ${graph.orphans.join(', ')} — swfte_refine with an instruction naming them.`
      );
    }
    if (graph.danglingEdges.length > 0) {
      nextActions.push('Remove or repoint the dangling edge(s) — they reference node ids that do not exist.');
    }

    // 3. No plaintext credentials.
    const leaks = scanForPlaintextSecrets(workflow);
    checks.push({
      id: 'secrets-bound',
      ok: leaks.length === 0,
      detail:
        leaks.length === 0
          ? 'No literal-looking credentials in node config'
          : `Possible plaintext credential(s) at: ${leaks.join(', ')}`,
    });
    if (leaks.length > 0) {
      nextActions.push('Replace inline credentials with secret references before exporting or sharing this workflow.');
    }

    // 4. Published?
    let published = false;
    try {
      const versions = await client.request<any>({
        method: 'GET',
        path: `${WORKFLOWS}/execution/${encodeURIComponent(id)}/versions`,
        retries: 1,
      });
      const list = pickList(versions);
      published = list.length > 0;
      checks.push({
        id: 'published',
        ok: published,
        detail: published ? `${list.length} published version(s)` : 'No published versions — only a draft exists',
      });
      if (!published) {
        nextActions.push('Publish the workflow to run the released version (swfte_run falls back to the draft test path meanwhile).');
      }
    } catch {
      checks.push({ id: 'published', ok: null, detail: 'Version history unavailable on this instance — skipped' });
    }

    // 5. Does it actually run? Opt-in, because it costs time and tokens.
    if (opts.run) {
      try {
        const result = await this.run!(client, id, { inputs: opts.inputs, timeoutMs: opts.timeoutMs });
        checks.push({
          id: 'executes',
          ok: result.ok,
          detail: `run → ${result.status}${result.elapsedMs ? ` in ${(result.elapsedMs / 1000).toFixed(1)}s` : ''}`,
        });

        // A node can report COMPLETED and still have produced nothing useful —
        // an unbound channel, an empty query. Surface that separately from the
        // overall run status, which would otherwise read as a clean pass.
        const failedNodes = (result.nodeTraces ?? []).filter((t) => !isSucceededRunStatus(t.status));
        checks.push({
          id: 'node-traces',
          ok: (result.nodeTraces?.length ?? 0) > 0 ? failedNodes.length === 0 : null,
          detail:
            (result.nodeTraces?.length ?? 0) === 0
              ? 'No per-node traces returned'
              : failedNodes.length === 0
                ? `All ${result.nodeTraces!.length} nodes reached a success state`
                : failedNodes.map((t) => `${t.id} → ${t.status}${t.error ? `: ${t.error}` : ''}`).join('; '),
        });

        if (!result.ok) {
          nextActions.push(
            result.degraded
              ? 'The backend load-shed rather than failing the workflow — retry swfte_run before changing anything.'
              : 'Inspect the failing node traces above, then swfte_refine to fix the offending node.'
          );
        }
      } catch (err) {
        checks.push({
          id: 'executes',
          ok: false,
          detail: err instanceof SwfteApiError ? `${err.code}: ${err.message}` : String(err),
        });
      }
    } else {
      checks.push({ id: 'executes', ok: null, detail: 'Skipped — pass run:true to execute it' });
      checks.push({ id: 'node-traces', ok: null, detail: 'Skipped — requires run:true' });
    }

    const ok = checks.every((c) => c.ok !== false);
    if (ok && nextActions.length === 0) {
      nextActions.push(opts.run ? 'Looks healthy — swfte_deploy to ship it.' : 'Re-run with run:true to confirm it executes.');
    }

    return { ok, kind: 'workflow', id, checks, nextActions };
  },
};
