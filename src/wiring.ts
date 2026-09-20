/**
 * Writing a reference from one artifact to another.
 *
 * `swfte_solution_verify` answers "does this wire resolve?". Nothing answers
 * "make it resolve" — so every cross-artifact link in a generated solution is
 * written by hand, and the Evidence Book shows what that costs: three wires
 * pointing at nothing and one pointing at a field the runtime never reads.
 *
 * This module is the writing half. It knows, per (source kind, relation), the
 * one field the runtime actually consults, and it refuses to write anywhere
 * else. `knowledgeSources`, `attach`, `binding` and `boundAgentId` are not
 * fallbacks: writing them is how a solution ends up looking connected and
 * behaving disconnected.
 *
 * Three disciplines, all of which the hand-driven build lacked:
 *
 *   1. PRE-FLIGHT the target. A dangling id is the same defect as no id, and
 *      the backend stores one happily — WidgetServiceV2.create performs no
 *      existence check on `brain.id`.
 *   2. Write into the EFFECTIVE field, named in ARTIFACT-CONTRACTS.md.
 *   3. POST-VERIFY by re-reading the source. A 200 from an update is not
 *      evidence. The whole `inert` verdict exists because a write can succeed
 *      into a field nobody reads.
 *
 * Where a wire cannot be expressed on the record at all, this reports
 * `needs-backend` with the named change rather than redirecting the write
 * somewhere it would be silently ignored.
 */

import type { SwfteClient } from './client.js';
import { SwfteApiError } from './client.js';
import { getAdapter } from './kinds/index.js';
import { selectPath, type SolutionKind } from './solution.js';

/** Re-exported so tool schemas can name the wire-endpoint kind without importing solution.ts. */
export type SolutionKindLike = SolutionKind;

/* ------------------------------------------------------------------ *
 * Result vocabulary
 *
 * Deliberately shares `WireState` language with solution.ts so a write
 * report and a verify report can be read side by side without translation.
 * ------------------------------------------------------------------ */

export type WriteState =
  /** Written, and re-reading the source found it in the effective field. */
  | 'connected'
  /** Already present before we touched it. Idempotent re-run. */
  | 'already-connected'
  /** The update returned 2xx but the source does not read back with the id. */
  | 'write-not-reflected'
  /** The target does not exist, or is not readable. Nothing was written. */
  | 'target-missing'
  /** No field on this record can carry the reference. Named change required. */
  | 'needs-backend'
  /** The write itself failed. */
  | 'failed';

export interface WriteResult {
  from: string;
  to: string;
  relation: string;
  state: WriteState;
  ok: boolean;
  /** The field the id was written into, as stored. */
  field?: string;
  /** How the write was performed, for the audit trail. */
  via?: string;
  detail: string;
  nextAction?: string;
}

export interface WriteRef {
  key: string;
  kind: SolutionKind;
  id: string;
}

export interface WriteWireInput {
  from: WriteRef;
  to: WriteRef;
  relation: string;
  /** Report what would be written without writing it. */
  dryRun?: boolean;
}

/* ------------------------------------------------------------------ *
 * Endpoints
 * ------------------------------------------------------------------ */

const WIDGETS_V2 = '/api/v2/widgets';
const CHATFLOWS = '/v2/chatflows';
const AGENTS_V2 = '/v2/agents';
const DATASETS = '/api/v2/datasets';
const MODULES = '/v2/modules';

/** BrainKind, as the backend spells it (models/widget/BrainKind.java). */
const BRAIN_KIND: Record<string, string> = {
  agent: 'AGENT',
  chatflow: 'CHATFLOW',
  workflow: 'WORKFLOW',
};

/**
 * Relations that cannot be expressed on the source record today, with the
 * backend change each one needs. Stated rather than attempted, because an
 * attempted write into a non-field is indistinguishable from a successful one
 * until something fails at runtime.
 */
const NEEDS_BACKEND: Record<string, string> = {
  'workflow:writes:dataset':
    'No DATASET_WRITE node type exists — every occurrence of that token in agents-service is a ' +
    'Spring Security authority string, not a NodeType. A workflow cannot express a dataset write. ' +
    'Needs: a DATASET_WRITE executor, or references[] on the workflow record.',
  'agent:grounds:dataset':
    'Agent.knowledgeModuleIds holds KnowledgeModule ids, not dataset ids — ' +
    'KnowledgeRetrievalServiceV2 resolves findById(moduleId) then module.getDatasetId(), and drops ' +
    'anything else with a silent continue. Mint a KnowledgeModule with datasetId set and ground on ' +
    'that instead. Needs (to ground on a dataset directly): knowledgeModuleIds to accept a dataset id.',
  'application:reads':
    'An application is reached over HTTP by URL. Its id is its parent Module id (ApplicationProfile.moduleId), ' +
    'which only an APP_FLOW_SEGMENT node carries — not an HTTP_REQUEST poll. Needs: hosting, so URL-origin ' +
    'matching becomes a real check.',
};

/* ------------------------------------------------------------------ *
 * Reading, for pre-flight and post-verify
 * ------------------------------------------------------------------ */

async function readBody(client: SwfteClient, kind: SolutionKind, id: string): Promise<unknown> {
  if (kind === 'dataset') {
    return client.request({ method: 'GET', path: `${DATASETS}/${encodeURIComponent(id)}`, retries: 1 });
  }
  const adapter = getAdapter(kind);
  if (typeof adapter.get !== 'function') {
    throw new Error(`${kind} has no read path on this server.`);
  }
  return adapter.get(client, id);
}

/**
 * Does `id` sit at `selector` on `body`?
 *
 * Uses the same path grammar as solution.ts so a write target and a verify
 * target are described identically — one vocabulary, not two.
 */
function holds(body: unknown, selector: string, id: string): boolean {
  return selectPath(body, selector).some((n) => {
    const v = n.value;
    if (typeof v === 'string') return v === id;
    if (Array.isArray(v)) return v.some((x) => x === id);
    return false;
  });
}

/* ------------------------------------------------------------------ *
 * The writers
 *
 * One per (source kind, relation). Each returns the effective field it wrote
 * and how, so the caller can post-verify without knowing the backend.
 * ------------------------------------------------------------------ */

interface Writer {
  /** The field the runtime reads. Post-verify checks exactly this. */
  field: string;
  via: string;
  write(client: SwfteClient, from: WriteRef, to: WriteRef): Promise<void>;
}

/**
 * Widget → brain.
 *
 * `brain` ({kind, id}) is what WidgetControllerV1 resolves; it falls back to
 * a synthesised BrainRef(AGENT, agentId) only when brain is null. `attach` is
 * a wizard request record that never lands on WidgetConfig, and `binding` is a
 * PUSH/PULL/HYBRID enum, not a reference — writing either is a no-op that
 * reads as success.
 *
 * There is no PATCH on widgets, so this is GET → merge → PUT.
 */
const widgetBinds: Writer = {
  field: 'brain.id',
  via: `PUT ${WIDGETS_V2}/{id} with brain={kind,id}`,
  async write(client, from, to) {
    const kind = BRAIN_KIND[to.kind];
    if (!kind) {
      throw new Error(
        `A widget brain must be an agent, chatflow or workflow — "${to.kind}" is not a BrainKind ` +
          `(DASHBOARD is declared in the enum but WidgetControllerV1 rejects it as unsupported_brain_kind).`
      );
    }
    await client.mergePut(`${WIDGETS_V2}/${encodeURIComponent(from.id)}`, {
      brain: { kind, id: to.id },
    });
  },
};

/**
 * Chatflow → downstream agent.
 *
 * The typed endpoint writes ChatFlow.agentId, which AgentOverlayService reads
 * as the fallback branch after agentConfig.defaultAgentId. It 409s when a
 * DIFFERENT agent is already bound, so it is idempotent for the same id and
 * loud for a conflicting one — both of which are what we want.
 *
 * `boundAgentId` does not exist on the record. It is request-and-report
 * vocabulary only, and the solution spec's check path names it.
 */
const chatflowHandsOff: Writer = {
  field: 'agentId',
  via: `POST ${CHATFLOWS}/{id}/bind-agent/{agentId}`,
  async write(client, from, to) {
    await client.request({
      method: 'POST',
      path: `${CHATFLOWS}/${encodeURIComponent(from.id)}/bind-agent/${encodeURIComponent(to.id)}`,
      expectStatuses: [200, 201, 202, 409],
      retries: 0,
    });
  },
};

/**
 * Agent → knowledge module.
 *
 * knowledgeModuleIds is the only field AgentInferenceService consults.
 * knowledgeSources — which the agent wizard writes as a comma-joined string —
 * is read by nothing except the exporter, so an id parked there never reaches
 * a retrieval call. We never write it.
 *
 * v2 PATCH wipes omitted fields, hence merge-PUT.
 */
const agentGrounds: Writer = {
  field: 'knowledgeModuleIds[]',
  via: `PUT ${AGENTS_V2}/{id} (merge) with knowledgeModuleIds`,
  async write(client, from, to) {
    const current = (await readBody(client, 'agent', from.id)) as Record<string, unknown>;
    const existing = Array.isArray(current.knowledgeModuleIds)
      ? (current.knowledgeModuleIds as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    if (existing.includes(to.id)) return;
    await client.mergePut(`${AGENTS_V2}/${encodeURIComponent(from.id)}`, {
      knowledgeModuleIds: [...existing, to.id],
    });
  },
};

/** Agent → another agent or workflow it can call. */
const agentInvokes: Writer = {
  field: 'linkedWorkflows[]',
  via: `PUT ${AGENTS_V2}/{id} (merge) with linkedWorkflows / linkedAgents`,
  async write(client, from, to) {
    const key = to.kind === 'agent' ? 'linkedAgents' : 'linkedWorkflows';
    const current = (await readBody(client, 'agent', from.id)) as Record<string, unknown>;
    const existing = Array.isArray(current[key])
      ? (current[key] as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];
    if (existing.includes(to.id)) return;
    await client.mergePut(`${AGENTS_V2}/${encodeURIComponent(from.id)}`, { [key]: [...existing, to.id] });
  },
};

/** Which writer, for a given (source kind, relation, target kind). */
function pickWriter(from: WriteRef, relation: string, to: WriteRef): Writer | undefined {
  if (from.kind === 'widget' && relation === 'binds') return widgetBinds;
  if (from.kind === 'chatflow' && relation === 'hands-off-to' && to.kind === 'agent') return chatflowHandsOff;
  if (from.kind === 'agent' && relation === 'grounds' && to.kind === 'module') return agentGrounds;
  if (from.kind === 'agent' && relation === 'invokes') return agentInvokes;
  return undefined;
}

/** The effective field to post-verify against, for the agent-invokes fan-out. */
function verifyField(writer: Writer, to: WriteRef): string {
  if (writer === agentInvokes) return to.kind === 'agent' ? 'linkedAgents[]' : 'linkedWorkflows[]';
  return writer.field;
}

/* ------------------------------------------------------------------ *
 * Typed workflow nodes
 *
 * A workflow carries links only inside node configuration — there is no
 * references[] array on the record. Rewriting a live graph to insert a node is
 * a graph edit, not a field write, and doing it blind would be worse than not
 * doing it. So this layer reports the exact node type and config key the
 * generator should have used, which is the actionable half.
 * ------------------------------------------------------------------ */

const TYPED_NODE: Partial<Record<SolutionKind, { type: string; key: string }>> = {
  agent: { type: 'AGENT ("agent")', key: 'configuration.agentId' },
  dataset: { type: 'KNOWLEDGE_RETRIEVAL ("knowledge-retrieval")', key: 'configuration.datasetId' },
  workflow: { type: 'SUBWORKFLOW ("subworkflow")', key: 'configuration.workflowId' },
  chatflow: { type: 'CHATFLOW_TURN ("chatflow-turn")', key: 'configuration.chatFlowId' },
  application: { type: 'APP_FLOW_SEGMENT ("app-flow-segment")', key: 'configuration.moduleId' },
};

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export async function writeWire(client: SwfteClient, input: WriteWireInput): Promise<WriteResult> {
  const { from, to, relation } = input;
  const base = { from: from.key, to: to.key, relation };

  // Declared-impossible first: saying so is more useful than a failed attempt.
  const blocked = NEEDS_BACKEND[`${from.kind}:${relation}:${to.kind}`] ?? NEEDS_BACKEND[`${from.kind}:${relation}`];
  if (blocked) {
    return { ...base, state: 'needs-backend', ok: false, detail: blocked };
  }

  if (from.kind === 'workflow') {
    const typed = TYPED_NODE[to.kind];
    return {
      ...base,
      state: 'needs-backend',
      ok: false,
      detail:
        `A workflow expresses a reference through node configuration, not a record field, and this ` +
        `server does not rewrite a live graph.` +
        (typed
          ? ` Use a ${typed.type} node with ${typed.key} = ${to.id}.`
          : ` No typed node carries a ${to.kind} reference.`),
      nextAction: typed
        ? `Rebuild or refine ${from.key} so it reaches ${to.key} through a ${typed.type} node, then re-verify.`
        : `Drop the ${relation} wire, or record it as external with a reason.`,
    };
  }

  const writer = pickWriter(from, relation, to);
  if (!writer) {
    return {
      ...base,
      state: 'needs-backend',
      ok: false,
      detail: `No effective field carries "${relation}" from a ${from.kind} to a ${to.kind} on this platform.`,
      nextAction: 'Drop the wire, or record it as external with a reason.',
    };
  }

  const field = verifyField(writer, to);

  // Pre-flight the target. Writing a dangling id produces a record that reads
  // as connected and resolves to nothing — the failure mode this exists to stop.
  try {
    await readBody(client, to.kind, to.id);
  } catch (err) {
    const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
    return {
      ...base,
      state: 'target-missing',
      ok: false,
      field,
      detail: `Target ${to.kind} ${to.id} did not read back (${msg.slice(0, 160)}) — nothing written.`,
      nextAction: `Create ${to.key} before wiring ${from.key} to it.`,
    };
  }

  // Idempotence: a re-run of a solution build must not look like a change.
  try {
    const before = await readBody(client, from.kind, from.id);
    if (holds(before, field, to.id)) {
      return {
        ...base,
        state: 'already-connected',
        ok: true,
        field,
        via: writer.via,
        detail: `${from.key}.${field} already holds ${to.id}.`,
      };
    }
  } catch {
    // Unreadable source is the write's problem to report, not the pre-check's.
  }

  if (input.dryRun) {
    return {
      ...base,
      state: 'connected',
      ok: true,
      field,
      via: writer.via,
      detail: `DRY RUN — would set ${from.key}.${field} = ${to.id} via ${writer.via}.`,
    };
  }

  try {
    await writer.write(client, from, to);
  } catch (err) {
    const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
    return {
      ...base,
      state: 'failed',
      ok: false,
      field,
      via: writer.via,
      detail: `Write failed: ${msg.slice(0, 240)}`,
    };
  }

  // Post-verify. A 2xx is not evidence — re-read the source and confirm the id
  // landed in the field the runtime consults.
  let after: unknown;
  try {
    after = await readBody(client, from.kind, from.id);
  } catch (err) {
    const msg = err instanceof SwfteApiError ? `${err.status} ${err.message}` : String(err);
    return {
      ...base,
      state: 'write-not-reflected',
      ok: false,
      field,
      via: writer.via,
      detail: `Write returned success but ${from.key} could not be re-read (${msg.slice(0, 160)}).`,
      nextAction: `Re-read ${from.kind} ${from.id} and confirm ${field} before trusting this wire.`,
    };
  }

  if (!holds(after, field, to.id)) {
    return {
      ...base,
      state: 'write-not-reflected',
      ok: false,
      field,
      via: writer.via,
      detail:
        `Write returned success but ${from.key}.${field} does not hold ${to.id} on re-read. ` +
        `The id is either stored somewhere the runtime ignores, or was dropped.`,
      nextAction: `Inspect ${from.kind} ${from.id} directly — do not report this wire as connected.`,
    };
  }

  return {
    ...base,
    state: 'connected',
    ok: true,
    field,
    via: writer.via,
    detail: `${from.key}.${field} = ${to.id}, confirmed by re-read.`,
  };
}

/* ------------------------------------------------------------------ *
 * Grounding an agent needs more than an id
 * ------------------------------------------------------------------ */

/**
 * Below AGENTIC, resolveTools() returns an empty list at an early return, so
 * the search_knowledge tool is never registered and a correctly grounded agent
 * retrieves nothing. Nothing errors; the agent simply answers without looking.
 */
const TIER_RANK: Record<string, number> = { SIMPLE: 0, RAG: 0, KNOWLEDGE: 0, CONVERSATIONAL: 1, AGENTIC: 2, AUTONOMOUS: 3 };

export interface GroundingCheck {
  ok: boolean;
  detail: string;
  nextAction?: string;
}

/** Is this agent capable of using the knowledge it is linked to? */
export async function checkGroundingIsUsable(client: SwfteClient, agentId: string): Promise<GroundingCheck> {
  const agent = (await readBody(client, 'agent', agentId)) as Record<string, unknown>;
  const tier = String(agent.capabilityTier ?? '').toUpperCase();
  const rank = TIER_RANK[tier];

  if (!tier) {
    return {
      ok: false,
      detail:
        'No capabilityTier on the record. The runtime parses an absent tier as SIMPLE, the most ' +
        'restrictive one, which disables tools, sessions and memory.',
      nextAction: 'Set capabilityTier to AGENTIC.',
    };
  }
  if (rank === undefined) {
    return {
      ok: false,
      detail: `capabilityTier="${tier}" is not a value the runtime parses — it fails open to SIMPLE, which disables tools.`,
      nextAction: 'Set capabilityTier to AGENTIC.',
    };
  }
  if (rank < TIER_RANK.AGENTIC!) {
    return {
      ok: false,
      detail:
        `capabilityTier=${tier} is below AGENTIC, so resolveTools() returns an empty list before ` +
        'search_knowledge is ever registered. Linked knowledge is never retrieved and nothing errors.',
      nextAction: 'Raise capabilityTier to AGENTIC so the linked knowledge is actually queried.',
    };
  }
  return { ok: true, detail: `capabilityTier=${tier} — knowledge tools will be registered.` };
}

/**
 * Mint a KnowledgeModule over an existing dataset.
 *
 * This is the missing hop. `Agent.knowledgeModuleIds` holds module ids;
 * `KnowledgeModule.datasetId` is the only bridge to a dataset. Putting a
 * dataset id straight into knowledgeModuleIds resolves to a silent skip, which
 * is why the Evidence Book's grounding wire could not have worked even if the
 * id had been written into the "right" field.
 */
export async function moduleForDataset(
  client: SwfteClient,
  datasetId: string,
  name: string,
  description?: string
): Promise<{ moduleId: string; raw: unknown }> {
  const body = await client.request<any>({
    method: 'POST',
    path: MODULES,
    body: { name, description: description ?? `Knowledge module over dataset ${datasetId}`, datasetId, type: 'KNOWLEDGE' },
    expectStatuses: [200, 201],
    retries: 0,
    timeoutMs: 60_000,
  });
  const moduleId = body?.id ?? body?.moduleId ?? body?.data?.id;
  if (!moduleId) {
    throw new Error(`Module create returned no id: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return { moduleId: String(moduleId), raw: body };
}
