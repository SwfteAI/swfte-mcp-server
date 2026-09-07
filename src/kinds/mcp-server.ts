import { SwfteApiError, type SwfteClient } from '../client.js';
import {
  pickId,
  toFindings,
  type BuildInput,
  type BuildSnapshot,
  type DeployOpts,
  type DeployResult,
  type KindAdapter,
  type ValidationReport,
  type VerifyCheck,
  type VerifyOpts,
  type VerifyReport,
} from './_adapter.js';

const WIZARD = '/v2/mcp/wizard';
const DEPLOYMENTS = '/v2/mcp/deployments';

/**
 * Generating an MCP server is the one wizard that is genuinely synchronous —
 * it returns the finished artifact from `/generate` rather than a session to
 * poll. The adapter fakes a one-shot session so it still fits the common
 * build → status → create shape the tools expect, rather than forcing every
 * caller to special-case this kind.
 */
const syntheticSessions = new WeakMap<SwfteClient, Map<string, BuildSnapshot>>();
function sessionsFor(client: SwfteClient): Map<string, BuildSnapshot> {
  let sessions = syntheticSessions.get(client);
  if (!sessions) {
    sessions = new Map();
    syntheticSessions.set(client, sessions);
  }
  return sessions;
}

let counter = 0;
const nextSessionId = (): string => `mcpwiz-${Date.now().toString(36)}-${(counter += 1)}`;

export const mcpServerAdapter: KindAdapter = {
  kind: 'mcp-server',
  label: 'MCP server',
  notes:
    'MCP-server generation is synchronous: swfte_build returns the finished artifact in one call. ' +
    'Artifacts are versioned in git — see the swfte_mcp_* tools for fork/commit/publish.',

  async build(client, input: BuildInput) {
    const extras = input.options ?? {};
    const options = (extras.options ?? {}) as Record<string, unknown>;
    if (extras.autoDeploy || options.autoDeploy) throw new Error('Build cannot auto-deploy. Use swfte_deploy with its deployment controls.');
    const sessionId = nextSessionId();
    const sessions = sessionsFor(client);

    const body = await client.request<any>({
      method: 'POST',
      path: `${WIZARD}/generate`,
      body: {
        description: input.prompt,
        model: input.model,
        ...input.options,
      },
      retries: 0,
      // Synchronous generation of a whole server takes real time.
      timeoutMs: 300_000,
    });

    sessions.set(sessionId, {
      sessionId,
      status: body?.status ?? 'UNKNOWN',
      message: body?.message ?? null,
      progress: 100,
      done: true,
      error: body?.error ?? null,
      nodes: [],
      edges: [],
      speculativeNodes: [],
      finalResponse: body,
      raw: body,
    });

    // Bounded: this map only exists to bridge sync → poll within one session.
    if (sessions.size > 32) {
      const oldest = sessions.keys().next().value;
      if (oldest) sessions.delete(oldest);
    }

    return { sessionId };
  },

  async status(client, sessionId): Promise<BuildSnapshot> {
    const snap = sessionsFor(client).get(sessionId);
    if (!snap) {
      throw new Error(
        `No MCP wizard session "${sessionId}" in this process. ` +
          'MCP generation is synchronous — its result is returned by swfte_build directly and is not resumable.'
      );
    }
    return snap;
  },

  extractArtifact(snapshot) {
    const fr = snapshot.finalResponse as any;
    return fr?.generatedServer ?? fr?.artifact ?? fr?.server ?? fr;
  },

  extractId(snapshot) {
    const fr = snapshot.finalResponse as any;
    return fr?.savedArtifactId ?? pickId(fr?.artifact) ?? pickId(fr);
  },

  async steer(client, sessionId, instruction) {
    return client.request<any>({
      method: 'POST',
      path: `${WIZARD}/${encodeURIComponent(sessionId)}/steer`,
      body: { message: instruction },
      expectStatuses: [200, 202, 409],
      retries: 0,
    });
  },

  async validate(client, artifact): Promise<ValidationReport> {
    const result = await client.request<any>({
      method: 'POST',
      path: `${WIZARD}/validate`,
      body: artifact,
      retries: 1,
      timeoutMs: 120_000,
    });
    return {
      valid: Boolean(result?.valid ?? result?.success),
      findings: toFindings(result?.errors ?? result?.validationErrors),
      suggestions: result?.suggestions ?? [],
      raw: result,
    };
  },

  async deploy(client, id, _opts: DeployOpts): Promise<DeployResult> {
    const artifact = await client.request<any>({
      method: 'GET', path: `${WIZARD}/artifacts/${encodeURIComponent(id)}`,
    });
    if (!artifact || !artifact.name) throw new Error('Cannot deploy: the saved MCP artifact has no server definition.');
    const server = {
      ...artifact,
      configuration: artifact.configuration ?? {
        transport: artifact.transport ?? 'stdio',
        port: artifact.port,
        environment: artifact.environment,
        requiredSecrets: artifact.requiredSecrets,
      },
    };
    const body = await client.request<any>({
      method: 'POST',
      path: `${WIZARD}/deploy`,
      body: { server },
      expectStatuses: [200, 201, 202],
      retries: 0,
      timeoutMs: 300_000,
    });
    return {
      deploymentId: body?.deployment?.id ?? body?.deploymentId,
      phase: String(body?.deployment?.state ?? body?.status ?? 'UNKNOWN'),
      url: body?.deployment?.endpoint ?? body?.url,
      endpoint: body?.deployment?.endpoint ?? body?.endpoint,
      raw: body,
    };
  },

  async teardown(client, id, deploymentId) {
    // The deployment lives under /v2/mcp/deployments, keyed by its own id —
    // the artifact id is not the deployment id, so prefer the explicit one and
    // fall back to the artifact id for the common case where they match.
    await client.request({
      method: 'DELETE',
      path: `${DEPLOYMENTS}/${encodeURIComponent(deploymentId ?? id)}`,
      expectStatuses: [200, 202, 204, 404],
      retries: 1,
    });
  },

  async get(client, id) {
    return client.request({ method: 'GET', path: `${WIZARD}/artifacts/${encodeURIComponent(id)}`, retries: 1 });
  },

  async list(client) {
    const body = await client.request<any>({ method: 'GET', path: `${WIZARD}/artifacts`, retries: 1 });
    return Array.isArray(body) ? body : (body?.content ?? body?.items ?? []);
  },

  async remove(client, id) {
    await client.request({
      method: 'DELETE',
      path: `${WIZARD}/artifacts/${encodeURIComponent(id)}`,
      expectStatuses: [200, 202, 204],
      retries: 0,
    });
  },

  async verify(client, id, _opts: VerifyOpts): Promise<VerifyReport> {
    const checks: VerifyCheck[] = [];
    const nextActions: string[] = [];

    let artifact: any = null;
    try {
      artifact = await client.request<any>({
        method: 'GET',
        path: `${WIZARD}/artifacts/${encodeURIComponent(id)}`,
        retries: 1,
      });
      checks.push({ id: 'persisted', ok: true, detail: `Artifact "${artifact?.name ?? id}" found` });
    } catch (err) {
      const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
      checks.push({ id: 'persisted', ok: false, detail: `GET artifact ${id} → ${msg}` });
      return { ok: false, kind: 'mcp-server', id, checks, nextActions: ['Artifact not found — list them with swfte_mcp_artifacts_list.'] };
    }

    const tools = artifact?.tools ?? [];
    checks.push({
      id: 'has-tools',
      ok: tools.length > 0,
      detail: tools.length > 0 ? `${tools.length} tool(s) defined` : 'No tools defined — the server would expose nothing',
    });
    if (tools.length === 0) nextActions.push('Regenerate with a prompt that names the operations the server should expose.');

    // The generated code either compiles or it does not; nothing downstream
    // works if it does not, so this is the check that matters most.
    try {
      const validation = await this.validate!(client, artifact);
      checks.push({
        id: 'builds',
        ok: validation.valid,
        detail: validation.valid
          ? 'Validation/build passed'
          : validation.findings.map((f) => f.message).join('; ') || 'Validation failed',
      });
      if (!validation.valid) nextActions.push('Fix the build errors above, then re-validate.');
    } catch (err) {
      checks.push({
        id: 'builds',
        ok: null,
        detail: `Validation unavailable: ${err instanceof SwfteApiError ? err.message : String(err)}`,
      });
    }

    const ok = checks.every((c) => c.ok !== false);
    if (ok && nextActions.length === 0) nextActions.push('Looks healthy — swfte_deploy to host it.');

    return { ok, kind: 'mcp-server', id, checks, nextActions };
  },
};
