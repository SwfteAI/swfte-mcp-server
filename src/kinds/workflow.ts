import type { SwfteClient } from '../client.js';
import { SwfteApiError } from '../client.js';
import { TERMINAL_DEPLOY_PHASES, toWireDeployOption } from '../contracts/backend-options.js';
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
 * Has the managed deploy stopped moving?
 *
 * `GET /deploy/{id}/status` returns a `DeploymentStatusEvent`, which carries an
 * authoritative `terminal` boolean alongside `phase`. Trust the boolean: the
 * backend's `derivePhase` maps STOPPING and TERMINATING onto phase TERMINATED
 * while `isTerminal` still reports false, so phase alone would call a
 * shutting-down deployment finished and return a URL that is going away.
 *
 * The phase set is only the fallback for a response that carries no `terminal`
 * field, and it is read from the options contract rather than guessed — the
 * previous hand-written set waited for CANCELLED or DESTROYED, neither of which
 * `DeploymentStatusEvent.Phase` can ever produce, and did not list TERMINATED,
 * so a torn-down deploy polled until the 10-minute ceiling and was reported as
 * a timeout instead of a finished teardown.
 */
function deployIsTerminal(snapshot: any): boolean {
  if (typeof snapshot?.terminal === 'boolean') return snapshot.terminal;
  return TERMINAL_DEPLOY_PHASES.has(String(snapshot?.phase ?? snapshot?.state ?? '').toUpperCase());
}

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

/**
 * /invoke answers 409 PUBLISHED_SNAPSHOT_UNAVAILABLE for a workflow with no
 * active published snapshot (a draft, or a published-but-disabled one). An
 * older backend without /invoke answers 404/405. Both mean "use the
 * pre-existing /execute path", nothing more.
 */
function isNoPublishedSnapshot(err: unknown): boolean {
  if (!(err instanceof SwfteApiError)) return false;
  if (err.status === 404 || err.status === 405) return /\/invoke$/.test(err.path);
  return err.status === 409 && /PUBLISHED_SNAPSHOT_UNAVAILABLE|NOT_PUBLISHED/i.test(`${err.code} ${err.message}`);
}

async function executeAndPoll(
  client: SwfteClient,
  id: string,
  input: RunInput,
  opts: { testingFlag: boolean; path?: 'invoke' | 'execute' }
): Promise<RunResult> {
  const started = Date.now();
  // /invoke runs the immutable published snapshot (what a deployed caller
  // gets); /execute runs the live draft record. testingFlag is rejected by
  // /invoke, so the draft test path always goes through /execute.
  const route = opts.testingFlag ? 'execute' : (opts.path ?? 'execute');

  const start = await client.request<any>({
    method: 'POST',
    path: `${WORKFLOWS}/${encodeURIComponent(id)}/${route}`,
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
    (s) => isTerminalRunStatus(s?.status) || ['PAUSED', 'WAITING_FOR_INPUT', 'AWAITING_HUMAN'].includes(String(s?.status ?? '').toUpperCase()),
    { timeoutMs: input.timeoutMs ?? 180_000, intervalMs: 3_000 }
  );

  // Per-node traces live under outputData._traces, keyed by node id.
  const traces = (snapshot?.outputData?._traces ?? {}) as Record<string, any>;

  const isWaiting = ['PAUSED', 'WAITING_FOR_INPUT', 'AWAITING_HUMAN'].includes(String(snapshot?.status ?? '').toUpperCase());
  const humanInputs = Object.entries(snapshot?.outputData ?? {}).filter(([, value]: [string, any]) => value && typeof value === 'object' && String(value.status ?? '').toLowerCase() === 'waiting' && Array.isArray(value.required_variables)).map(([nodeId, value]: [string, any]) => ({ nodeId, prompt: value.prompt, requiredVariables: value.required_variables, optionalVariables: value.optional_variables ?? [], inputSchema: value.input_schema, timeoutMs: value.timeout_ms }));
  return {
    ok: isSucceededRunStatus(snapshot?.status),
    ...(isWaiting ? { needsHuman: humanInputs.length > 0, waiting: { executionId: String(executionId), status: String(snapshot.status), details: humanInputs, ...(humanInputs.length ? { review: { method: 'POST', path: `${EXECUTIONS}/${encodeURIComponent(String(executionId))}/resume`, bodyContract: '{nodeId: paused node ID, inputs: values matching the returned inputSchema}', requiresHumanDecision: true } } : {}), nextAction: 'Execution is paused, not completed. Review required inputs through the authenticated workflow review UI; do not auto-approve or start a duplicate execution.' } } : {}),
    status: timedOut && !isWaiting ? `${snapshot?.status ?? 'UNKNOWN'} (still running at timeout)` : String(snapshot?.status ?? 'UNKNOWN'),
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
    // Published workflows run through /invoke — the released snapshot a
    // deployed caller would reach, not whatever the draft autosaved last.
    try {
      const result = await executeAndPoll(client, id, input, { testingFlag: false, path: 'invoke' });
      return { ...result, raw: { ...(result.raw as object), path: 'invoke', note: 'Ran the published snapshot via POST /v2/workflows/{id}/invoke.' } };
    } catch (err) {
      if (!isNoPublishedSnapshot(err)) throw err;
    }
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
    if (opts.secretId !== undefined) throw new Error('UNSUPPORTED_DEPLOY_OPTION: secretId is not a ManagedDeployRequest field. Use cloudConnectionId or providerConfigName.');
    const legacyGpuTier = opts.gpuTier?.toUpperCase();
    if (legacyGpuTier && !['NONE', 'T4', 'A10', 'A100', 'H100'].includes(legacyGpuTier)) throw new Error('UNSUPPORTED_DEPLOY_OPTION: workflow gpuTier must be NONE, T4, A10, A100 or H100.');
    if (legacyGpuTier && opts.sizing?.gpuTier && legacyGpuTier !== opts.sizing.gpuTier.toUpperCase()) throw new Error('CONFLICTING_DEPLOY_OPTIONS: gpuTier and sizing.gpuTier disagree.');
    const sizing = legacyGpuTier ? { ...opts.sizing, gpuTier: legacyGpuTier } : opts.sizing;
    const useManaged = Boolean(opts.option || opts.gpuTier || opts.region || opts.provider || opts.cloudConnectionId || opts.providerConfigName || sizing || opts.path || opts.idleTimeoutSec !== undefined || opts.lifecycle);

    const started = await client.request<any>(
      useManaged
        ? {
            method: 'POST',
            path: `${WORKFLOWS}/${encodeURIComponent(id)}/deploy/managed`,
            body: {
              option: toWireDeployOption(opts.option),
              region: opts.region,
              lifecycle: opts.lifecycle,
              provider: opts.provider, cloudConnectionId: opts.cloudConnectionId, providerConfigName: opts.providerConfigName,
              sizing, idleTimeoutSec: opts.idleTimeoutSec, path: opts.path,
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
      (s) => deployIsTerminal(s),
      { timeoutMs: opts.timeoutMs ?? 600_000, intervalMs: 5_000 }
    );

    return {
      deploymentId: String(deploymentId),
      phase: String(snapshot?.phase ?? snapshot?.state ?? 'UNKNOWN'),
      url: snapshot?.url ?? snapshot?.endpointUrl ?? snapshot?.connectionDetails?.url ?? started?.url ?? started?.invokeEndpoint ?? started?.endpoint,
      endpoint: snapshot?.endpoint ?? snapshot?.endpointUrl ?? snapshot?.connectionDetails?.endpoint ?? snapshot?.connectionDetails?.invokeEndpoint ?? started?.invokeEndpoint ?? started?.endpoint,
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
      // Being unpublished is the NORMAL state right after a build, and
      // swfte_run handles it by falling back to the draft test path. Failing
      // the whole report on it made every freshly-built workflow look broken —
      // which is the fastest way to train someone to ignore the report. It is
      // informational unless the caller says they expect a released version.
      checks.push({
        id: 'published',
        ok: published ? true : opts.requirePublished ? false : null,
        detail: published
          ? `${list.length} published version(s)`
          : 'Draft only — no published version yet (swfte_run uses the draft test path)',
      });
      if (!published) {
        nextActions.push('Publish the workflow when you want the released version to run rather than the draft.');
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
        //
        // SKIPPED is NOT a failure. It is the normal state of a branch that was
        // not taken, and of everything downstream of a node that did fail.
        // Counting it made a correct conditional workflow report as broken, and
        // turned one real failure into a cascade of apparent ones.
        const traces = result.nodeTraces ?? [];
        const failedNodes = traces.filter(
          (t) => !isSucceededRunStatus(t.status) && String(t.status).toUpperCase() !== 'SKIPPED'
        );
        const skipped = traces.filter((t) => String(t.status).toUpperCase() === 'SKIPPED');

        const traceDetail = (): string => {
          if (traces.length === 0) return 'No per-node traces returned';
          const parts: string[] = [];
          if (failedNodes.length === 0) {
            parts.push(`${traces.length - skipped.length}/${traces.length} nodes succeeded`);
          } else {
            parts.push(failedNodes.map((t) => `${t.id} → ${t.status}${t.error ? `: ${t.error}` : ''}`).join('; '));
          }
          if (skipped.length > 0) {
            parts.push(`${skipped.length} skipped (${skipped.map((t) => t.id).join(', ')})`);
          }
          return parts.join(' — ');
        };

        checks.push({
          id: 'node-traces',
          ok: traces.length > 0 ? failedNodes.length === 0 : null,
          detail: traceDetail(),
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
