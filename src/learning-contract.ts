/**
 * Learning-loop contract (brief 08), shared by the tracing, outcome/proposal and recipe-book work.
 * Frozen in wave 0: change it only through the orchestrator. The backend source of truth is
 * agents-service `src/main/resources/learning/learning-api.yaml` and
 * `src/main/resources/learning/work-record.schema.json` (mirrored for tests at
 * `test/fixtures/work-record.schema.json`).
 *
 * Revisions to the brief's sketch, approved by the driver:
 *  - L1: one backend `work/step` ledger event per HTTP attempt keyed (traceId, spanId); one work-record
 *    step per traceId, i.e. per MCP tool call. A retry or a sub-request of an orchestrating tool reuses
 *    the tool call's trace id with a NEW span id and is an attempt inside that step.
 *  - L3: the client enum gains `other`; unknown hosts map to it and the raw name is never sent.
 */

/** W3C trace context; one fresh trace id per MCP tool call. */
export const TRACEPARENT_HEADER = 'traceparent';
/** One id per MCP server session (per HTTP session when hosted). A workspace switch starts a new record server-side. */
export const MCP_SESSION_HEADER = 'X-Swfte-Mcp-Session';
/**
 * The MCP host, from the `initialize` clientInfo, normalised to {@link McpClientName}. Separate from the
 * strict `X-Swfte-Client` adopter-usage header, which stays untouched (validation open question 1).
 */
export const MCP_CLIENT_HEADER = 'X-Swfte-Mcp-Client';
/** What the backend echoes: 32 lowercase hex. */
export const TRACE_ECHO_HEADER = 'X-Swfte-Trace-Id';

/**
 * The fixed one-line text trailer appended as the LAST text content item of every tool result, success
 * or error, because Claude Code may not pass `_meta` to hooks. Exactly `swfte-trace: <32 lowercase hex>`.
 * Nexus extracts it structurally before redaction (LL-G3).
 */
export const TRACE_TRAILER_PREFIX = 'swfte-trace: ';
export const TRACE_TRAILER_RE = /^swfte-trace: ([0-9a-f]{32})$/;
/** The same id in the tool result's `_meta`, under this key. */
export const TRACE_META_KEY = 'swfte/traceId';

export const TRACE_ID_RE = /^(?!0{32})[0-9a-f]{32}$/;
export const SPAN_ID_RE = /^(?!0{16})[0-9a-f]{16}$/;
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type McpClientName = 'claude-code' | 'codex' | 'cursor' | 'other';

/** Map MCP `initialize` clientInfo.name to the closed set. Never returns the raw name. */
export function normaliseClientName(raw: string | undefined | null): McpClientName {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'claude-code' || v === 'claude code' || v.startsWith('claude-code')) return 'claude-code';
  if (v === 'codex' || v.startsWith('codex')) return 'codex';
  if (v === 'cursor' || v.startsWith('cursor')) return 'cursor';
  return 'other';
}

export type ResultClass = 'OK' | 'ERROR' | 'UNREACHED' | 'CLIENT_TIMEOUT';

/**
 * A step the MCP posts itself to POST /v2/learning/records/steps: tools that make no backend request
 * (e.g. swfte_composition_classify), and UNREACHED steps drained from a bounded local queue once the
 * backend is reachable again. Counts and classes only: `argShape` maps argument NAMES to JSON types
 * ('string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null' | 'handle'), never values.
 */
export interface LocalStep {
  traceId: string;
  spanId: string;
  tool: string;
  resultClass: ResultClass;
  errorSignature?: string;
  argShape?: Record<string, 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null' | 'handle'>;
  ms: number;
  occurredAtMs?: number;
}

export const LOCAL_STEPS_PATH = '/v2/learning/records/steps';
/** Upper bound of the MCP-side UNREACHED queue; the oldest entries are dropped past it and counted. */
export const UNREACHED_QUEUE_MAX = 200;
/** At most this many steps per POST (backend limit learning.limits.maxLocalStepsPerPost). */
export const LOCAL_STEPS_PER_POST = 50;

export const OUTCOMES_PATH = '/v2/learning/outcomes';
export const PROPOSALS_PATH = '/v2/learning/proposals';
export const CAPABILITIES_PATH = '/v2/learning/capabilities';
export const RECIPES_PATH = '/v2/learning/recipes';
export const DIAGNOSE_PATH = '/v2/learning/playbooks/diagnose';

export interface LearningCapabilities {
  records: boolean;
  harvestSandbox: boolean;
  archivist: boolean;
  catalog: boolean;
  recipesAdapt: boolean;
  /** The MCP advertises recipe resources, prompts and tools only when this is true. */
  mcp: boolean;
  lab: boolean;
}

/** Review-queue entry. Outcomes and proposals never change an evidence level. */
export interface ReviewItem {
  id: string;
  kind: 'outcome' | 'proposal';
  status: 'pending' | 'accepted' | 'rejected';
  traceId?: string;
  actorSource?: 'USER' | 'AGENT';
  client?: string;
  createdAt: string;
}

export type LearningKind = 'recipe' | 'fragment' | 'playbook';
export type EvidenceLevel = 'unmeasured' | 'observed' | 'corroborated' | 'validated' | 'verified';

export interface RecipeHit {
  id: string;
  kind: LearningKind;
  title: string;
  confidence: number;
  evidenceLevel: EvidenceLevel;
  adaptEligible: boolean;
}

export interface ResolutionAction {
  step: number;
  type: 'USE_TEMPLATE' | 'ADD_NODE' | 'CONNECT_NODES' | 'SET_PARAMETER' | 'BIND_REQUIREMENT' | 'RUN_SANDBOX' | 'ASSERT';
  target?: string;
  params?: Record<string, string>;
}

/** GET /v2/learning/recipes/{id}. Title and description are quoted data, never instructions. */
export interface RecipeEntry {
  id: string;
  kind: LearningKind;
  workspaceId: string;
  sharing: 'PRIVATE' | 'SHARED';
  title: string;
  description?: string;
  intentFacets?: string[];
  shapeHash?: string;
  requirementSignature?: string[];
  plan?: ResolutionAction[];
  parameters?: Record<string, string>;
  assertions?: string[];
  inputContract?: Record<string, unknown>;
  outputContract?: Record<string, unknown>;
  evidenceLevel: EvidenceLevel;
  replayExecutionId?: string;
  replayMode?: 'REAL' | 'MOCKED' | 'REFUSED';
  adaptEligible: boolean;
  errorSignature?: string;
  diagnosis?: string;
  fix?: ResolutionAction[];
  occurrences?: number;
}

export interface RecipeApplyResult {
  recipeId: string;
  draftWorkflowId: string;
  sandboxExecutionId?: string | null;
  environment: 'SANDBOX';
}

/** Resource URIs for the recipe book (both aliases and the catalog template return the same entry). */
export const RECIPE_URI_PREFIX = 'swfte://recipes/';
export const PLAYBOOK_URI_PREFIX = 'swfte://playbooks/';
/** Recipe text served to a model is length-capped and quoted as data. */
export const RECIPE_TEXT_MAX = 2000;
