import type { SwfteClient } from '../client.js';
import { SwfteApiError } from '../client.js';
import {
  pickId,
  toFindings,
  toSnapshot,
  type BuildInput,
  type BuildSnapshot,
  type KindAdapter,
  type RunInput,
  type RunResult,
  type ValidationReport,
  type VerifyCheck,
  type VerifyOpts,
  type VerifyReport,
} from './_adapter.js';

const WIZARD = '/v2/agents/wizard';
const AGENTS = '/v1/agents';

/**
 * The list endpoint caps page size at 20 and silently ignores larger values.
 * Requesting exactly the cap keeps the round-trip count honest.
 */
const AGENT_PAGE_SIZE = 20;

/**
 * Capability tiers gate real behaviour, and the failure mode is silent:
 * below AGENTIC an agent will *role-play* calling its tools rather than calling
 * them, and below CONVERSATIONAL it has no session memory, so the opener
 * replays every turn. Neither shows up as an error.
 */
const TIER_RANK = { RAG: 0, CONVERSATIONAL: 1, AGENTIC: 2, AUTONOMOUS: 3 } as const;
const RANK_CONVERSATIONAL = TIER_RANK.CONVERSATIONAL;
const RANK_AGENTIC = TIER_RANK.AGENTIC;

const tierRank = (tier: string): number | undefined =>
  (TIER_RANK as Record<string, number | undefined>)[tier];

/**
 * Chat once, classifying degraded infra responses rather than treating them as
 * agent misconfiguration.
 *
 * The backend sheds load by returning `200` with empty content and
 * `inputTokens: 0`; edge proxies return `504` on slow deep-RAG turns. Both are
 * transient platform state, so callers should retry, not "fix" the agent.
 */
async function chatOnce(
  client: SwfteClient,
  agentId: string,
  userId: string,
  message: string,
  timeoutMs: number
): Promise<RunResult> {
  const started = Date.now();
  let raw: any;
  let status = 200;

  try {
    raw = await client.request<any>({
      method: 'POST',
      path: `${AGENTS}/${encodeURIComponent(agentId)}/chat/${encodeURIComponent(userId)}`,
      body: { message },
      retries: 0,
      timeoutMs,
    });
  } catch (err) {
    if (err instanceof SwfteApiError) {
      status = err.status;
      const gatewayTimeout = status === 504 || status === 502 || status === 503;
      if (!gatewayTimeout) throw err;
      return {
        ok: false,
        status: `HTTP_${status}`,
        degraded: true,
        elapsedMs: Date.now() - started,
        raw: err.toJSON(),
      };
    }
    // AbortError from our own timeout also reads as degraded infra.
    return {
      ok: false,
      status: 'TIMEOUT',
      degraded: true,
      elapsedMs: Date.now() - started,
      raw: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  // The reply key is `response` on this endpoint, not `message` or `reply`.
  const reply = String(raw?.response ?? raw?.reply ?? raw?.message ?? '');
  const emptyShed = reply.trim().length === 0 && (raw?.inputTokens === 0 || raw?.inputTokens == null);

  return {
    ok: !emptyShed,
    status: emptyShed ? 'EMPTY_SHED' : 'OK',
    degraded: emptyShed,
    output: reply,
    elapsedMs: Date.now() - started,
    raw,
  };
}

export const agentAdapter: KindAdapter = {
  kind: 'agent',
  label: 'Agent',
  notes: 'Agents have no graph to deploy; they are reachable as soon as they are created.',

  async build(client, input: BuildInput) {
    const body = await client.request<any>({
      method: 'POST',
      path: `${WIZARD}/generate/async`,
      body: {
        description: input.prompt,
        model: input.model,
        autoCreate: input.autoCreate ?? false,
        autoLinkTools: true,
        autoLinkKnowledge: true,
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
    return fr?.generatedAgent ?? fr?.agent ?? fr?.generatedWorkflow ?? null;
  },

  extractId(snapshot) {
    const fr = snapshot.finalResponse as any;
    return pickId(fr) ?? pickId(fr?.generatedAgent) ?? pickId(fr?.agent);
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
    const review = await client.request<any>({
      method: 'POST',
      path: `${WIZARD}/review`,
      body: artifact,
      retries: 1,
    });
    return {
      valid: Boolean(review?.valid ?? review?.isValid),
      findings: toFindings(review?.validationErrors ?? review?.errors),
      suggestions: review?.suggestions ?? [],
      raw: review,
    };
  },

  async create(client, artifact) {
    const body = await client.request<any>({
      method: 'POST',
      path: `${WIZARD}/create`,
      body: artifact,
      expectStatuses: [200, 201],
      retries: 0,
      timeoutMs: 90_000,
    });
    const id = pickId(body);
    if (!id) throw new Error(`Create succeeded but returned no id: ${JSON.stringify(body).slice(0, 300)}`);
    return { id, raw: body };
  },

  async refine(client, artifact, feedback) {
    return client.request<any>({
      method: 'POST',
      path: `${WIZARD}/refine`,
      body: { feedback, currentAgent: artifact, agent: artifact },
      retries: 0,
      timeoutMs: 180_000,
    });
  },

  async run(client, id, input: RunInput): Promise<RunResult> {
    const message = input.message ?? 'Briefly introduce yourself and list the tools you can use.';
    const userId = String((input.inputs?.userId as string) ?? 'mcp-probe');
    const timeoutMs = input.timeoutMs ?? 120_000;

    // Retry through degraded responses so an overloaded backend doesn't read as
    // a broken agent. Two retries with widening backoff matches what the fleet
    // suite needed in practice.
    let last: RunResult = { ok: false, status: 'NOT_ATTEMPTED', degraded: true };
    for (let attempt = 0; attempt <= 2; attempt++) {
      last = await chatOnce(client, id, userId, message, timeoutMs);
      if (!last.degraded) return last;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 12_000 * (attempt + 1)));
    }
    return last;
  },

  async get(client, id) {
    return client.request({ method: 'GET', path: `${AGENTS}/${encodeURIComponent(id)}`, retries: 1 });
  },

  async list(client) {
    return client.paginate({ path: AGENTS, pageSize: AGENT_PAGE_SIZE });
  },

  async remove(client, id) {
    await client.request({
      method: 'DELETE',
      path: `${AGENTS}/${encodeURIComponent(id)}`,
      expectStatuses: [200, 202, 204],
      retries: 0,
    });
  },

  async verify(client, id, opts: VerifyOpts): Promise<VerifyReport> {
    const checks: VerifyCheck[] = [];
    const nextActions: string[] = [];

    let agent: any = null;
    try {
      agent = await client.request<any>({ method: 'GET', path: `${AGENTS}/${encodeURIComponent(id)}`, retries: 1 });
      checks.push({ id: 'persisted', ok: true, detail: `GET ${AGENTS}/${id} → 200 ("${agent?.name ?? 'unnamed'}")` });
    } catch (err) {
      const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
      checks.push({ id: 'persisted', ok: false, detail: `GET ${AGENTS}/${id} → ${msg}` });
      return {
        ok: false,
        kind: 'agent',
        id,
        checks,
        nextActions: ['The agent does not exist or is not readable — check the id with swfte_agents_list.'],
      };
    }

    // A wizard publish that raced a degraded backend leaves a half-created
    // record: no model, agentType NONE_SELECTED. That record is immutable —
    // every subsequent PUT 500s — so the only fix is delete and rebuild.
    const halfCreated = !agent?.model || String(agent?.agentType ?? '') === 'NONE_SELECTED';
    checks.push({
      id: 'complete',
      ok: !halfCreated,
      detail: halfCreated
        ? `Half-created record (model="${agent?.model ?? ''}", agentType="${agent?.agentType ?? ''}") — this record is immutable and cannot be repaired`
        : `model=${agent.model}, agentType=${agent.agentType ?? 'default'}`,
    });
    if (halfCreated) {
      nextActions.push('Delete this agent and rebuild it — half-created records reject every update.');
    }

    // Capability tier gates tool use and session memory, silently.
    const tier = String(agent?.capabilityTier ?? '').toUpperCase();
    const toolCount = (agent?.tools ?? agent?.toolIds ?? []).length ?? 0;
    const rank = tierRank(tier);
    if (!tier) {
      checks.push({ id: 'capability-tier', ok: null, detail: 'No capabilityTier on the record — skipped' });
    } else if (toolCount > 0 && rank !== undefined && rank < RANK_AGENTIC) {
      checks.push({
        id: 'capability-tier',
        ok: false,
        detail: `capabilityTier=${tier} with ${toolCount} tool(s) attached — below AGENTIC the agent role-plays tool calls instead of making them`,
      });
      nextActions.push('Raise capabilityTier to AGENTIC so the attached tools are actually invoked.');
    } else if (rank !== undefined && rank < RANK_CONVERSATIONAL) {
      checks.push({
        id: 'capability-tier',
        ok: false,
        detail: `capabilityTier=${tier} — below CONVERSATIONAL there is no session memory, so the opener replays every turn`,
      });
      nextActions.push('Raise capabilityTier to at least CONVERSATIONAL for multi-turn behaviour.');
    } else {
      checks.push({ id: 'capability-tier', ok: true, detail: `capabilityTier=${tier} with ${toolCount} tool(s)` });
    }

    // Knowledge linkage — a knowledge-shaped agent with nothing linked is a
    // very common and entirely silent build defect.
    const knowledge = agent?.knowledgeModuleIds ?? agent?.knowledgeIds ?? agent?.datasets ?? [];
    checks.push({
      id: 'knowledge-linked',
      ok: null,
      detail: knowledge.length > 0 ? `${knowledge.length} knowledge module(s) linked` : 'No knowledge modules linked',
    });

    // The systemPrompt is ignored unless persona AND instructions are both blank.
    if (agent?.systemPrompt && (agent?.persona || agent?.instructions)) {
      checks.push({
        id: 'prompt-effective',
        ok: false,
        detail: 'systemPrompt is set but persona/instructions are also set — the runtime ignores systemPrompt unless both are blank',
      });
      nextActions.push('Move the systemPrompt content into instructions, or clear persona+instructions to let systemPrompt apply.');
    } else {
      checks.push({ id: 'prompt-effective', ok: true, detail: 'Prompt configuration is unambiguous' });
    }

    if (opts.run) {
      const result = await this.run!(client, id, { message: opts.inputs?.message as string, timeoutMs: opts.timeoutMs });
      checks.push({
        id: 'responds',
        ok: result.degraded ? null : result.ok,
        detail: result.degraded
          ? `Backend degraded (${result.status}) after retries — infra, not agent config`
          : `Replied in ${((result.elapsedMs ?? 0) / 1000).toFixed(1)}s: "${String(result.output ?? '').slice(0, 120)}"`,
      });
      if (result.degraded) nextActions.push('Retry the chat probe shortly — the backend was shedding load.');
    } else {
      checks.push({ id: 'responds', ok: null, detail: 'Skipped — pass run:true to send a chat probe' });
    }

    const ok = checks.every((c) => c.ok !== false);
    if (ok && nextActions.length === 0) {
      nextActions.push(opts.run ? 'Looks healthy.' : 'Re-run with run:true to confirm it replies.');
    }

    return { ok, kind: 'agent', id, checks, nextActions };
  },
};

/**
 * Link tools onto an existing agent. Exposed separately from the adapter because
 * it is an agent-only affordance the generic tools don't model.
 */
export async function linkAgentTools(client: SwfteClient, agentId: string, toolIds: string[]): Promise<unknown> {
  return client.request({
    method: 'POST',
    path: `${WIZARD}/link-tools`,
    body: { agentId, toolIds, validateCompatibility: true },
    retries: 0,
  });
}

/** Link knowledge bases onto an existing agent. */
export async function linkAgentKnowledge(client: SwfteClient, agentId: string, knowledgeIds: string[]): Promise<unknown> {
  return client.request({
    method: 'POST',
    path: `${WIZARD}/link-knowledge`,
    body: { agentId, knowledgeIds, validateCompatibility: true },
    retries: 0,
  });
}

/**
 * Partial agent update via GET → merge → PUT.
 *
 * The v2 PATCH endpoint wipes fields omitted from the body — patching only
 * `temperature` was observed to blank `systemPrompt` — so partial updates must
 * carry the whole record.
 */
export async function updateAgent(
  client: SwfteClient,
  agentId: string,
  partial: Record<string, unknown>
): Promise<unknown> {
  return client.mergePut(`${AGENTS}/${encodeURIComponent(agentId)}`, partial);
}
