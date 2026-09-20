/**
 * Solution-level integrity.
 *
 * `swfte_verify` asks "is this artifact well-formed?" — one artifact, one
 * answer. That question has a blind spot which no amount of per-kind checking
 * can close: every component can pass its own sweep while the solution they
 * are supposed to form does not exist. A widget with no brain is a valid
 * widget. A chatflow that hands off to nobody is a valid chatflow. An agent
 * grounded on nothing is a valid agent. The defect lives in the space
 * *between* artifacts, and nothing in the platform currently owns that space.
 *
 * This module owns it. It takes a declared set of components and the wiring
 * they are meant to form, then asks, per wire, whether the link is actually
 * present in live state — and, separately, whether each component *covers*
 * what it was commissioned to cover.
 *
 * Two conventions carried over from the per-kind adapters, deliberately:
 *   - findings are `VerifyCheck` ({ id, ok, detail }) with `ok: null` meaning
 *     "not applicable", never "failed";
 *   - every failure carries a concrete next action, because a report nobody
 *     can act on is a report nobody reads.
 *
 * Strictly read-only. Every call it makes is a GET.
 */
import type { SwfteClient } from './client.js';
import { getAdapter, type Kind } from './kinds/index.js';
import type { VerifyCheck } from './kinds/_adapter.js';

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

/**
 * Datasets are readable and are routinely the far end of a wire ("this agent
 * is grounded on that dataset"), but they have no kind adapter — they are not
 * something the wizards build. Widening the kind here rather than in `KINDS`
 * keeps them addressable as wire endpoints without pretending they are
 * buildable artifacts.
 */
export type SolutionKind = Kind | 'dataset';

/**
 * The relations a solution can declare. Each one implies a different question
 * about live state, which is what makes a wire checkable without the author
 * having to hand-write a selector for it.
 */
export const RELATIONS = [
  'binds', // widget → its backing brain
  'hands-off-to', // chatflow → the agent that picks the case up
  'grounds', // agent → the knowledge it reasons over
  'invokes', // workflow/agent → something it calls
  'reads', // workflow → a source it pulls from
  'writes', // workflow → a sink it pushes to
  'exports-to', // workflow → where its output lands
  'references', // catch-all: the id must appear somewhere
] as const;

export type Relation = (typeof RELATIONS)[number];

/** Grounding a component's role requires it to actually have. */
export type Requirement = 'knowledge' | 'tools' | 'downstream' | 'brain';

export interface CoverageAssertion {
  /** Stable name, so a failure reads as a rule rather than as an anonymous list. */
  id: string;
  /** The set the component must cover. */
  of: string[];
  /**
   * Where in the component body to look, as a small path expression:
   * `fields[].id`, `nodes.*.configuration`, `tools[].name`, or `$text` for the
   * whole serialised body.
   */
  in: string;
  /**
   * `normalized` (default) compares after lowercasing and stripping
   * punctuation, so `sum_insured_contents` and `sumInsuredContents` are the
   * same field — which they are, and a check that says otherwise is noise.
   * `exact` is literal. `contains` looks for each token as a substring of the
   * joined haystack, for prose-shaped surfaces like a prompt.
   */
  match?: 'exact' | 'normalized' | 'contains';
  /** Fraction of `of` that must be present. Defaults to 1 — cover all of it. */
  minRatio?: number;
  /** Human phrasing of what the set is, for the failure line. */
  label?: string;
}

export interface SolutionComponent {
  key: string;
  kind: SolutionKind;
  /** Accepts `{ id }` or the `{ live: { id } }` shape a solution spec uses. */
  id?: string;
  live?: { id?: string } | null;
  title?: string;
  /** Grounding this component's role requires. Unmet requirements fail. */
  requires?: Requirement[];
  /** Sets this component must demonstrably cover. */
  covers?: CoverageAssertion[];
  /** Suppress the orphan check for a deliberate entry point or leaf. */
  entry?: boolean;
  terminal?: boolean;
}

export interface SolutionWire {
  from: string;
  to: string;
  relation: Relation | string;
  note?: string;
  /**
   * Override the relation's default lookup. Rarely needed — the point of the
   * relation vocabulary is that the author does not have to know the field
   * names the backend happens to use this month.
   */
  path?: string;
  /** Declare a wire un-checkable on purpose, with the reason recorded. */
  externalReason?: string;
}

export interface SolutionSpecInput {
  id?: string;
  name?: string;
  workspaceId?: string;
  components: SolutionComponent[];
  wiring?: SolutionWire[];
}

export type WireState =
  | 'connected'
  | 'broken'
  | 'inert'
  | 'placeholder'
  | 'external'
  | 'unknown';

export interface WireEvidence {
  path: string;
  value: string;
}

export interface WireResult {
  from: string;
  to: string;
  relation: string;
  state: WireState;
  /** `null` where the state is informational rather than a verdict. */
  ok: boolean | null;
  detail: string;
  evidence: WireEvidence[];
  nextAction?: string;
  note?: string;
}

export interface CoverageResult {
  component: string;
  id: string;
  label: string;
  required: number;
  covered: number;
  ratio: number;
  minRatio: number;
  ok: boolean;
  missing: string[];
  found: string[];
  detail: string;
  nextAction?: string;
}

export interface SolutionVerifyReport {
  ok: boolean;
  solution: string;
  workspaceId?: string;
  components: Array<{
    key: string;
    kind: SolutionKind;
    id: string;
    readable: boolean;
    detail: string;
    /** Present only when `includeComponentVerify` was requested. */
    componentOk?: boolean | null;
    failedChecks?: string[];
  }>;
  wires: WireResult[];
  coverage: CoverageResult[];
  checks: VerifyCheck[];
  nextActions: string[];
  summary: string;
}

export interface SolutionVerifyOpts {
  /** Also run each component's own kind sweep and fold the result in. */
  includeComponentVerify?: boolean;
  /** Treat `external` and `unknown` wires as failures. Off by default. */
  strict?: boolean;
}

/* ------------------------------------------------------------------ *
 * Where a link is allowed to live
 *
 * Per (kind, relation), the fields that may carry an outbound reference.
 *
 * `effective` is the load-bearing column. The platform has fields that store
 * a link and fields that the runtime actually reads, and they are not the same
 * set. `agent.knowledgeSources` is written by the agent wizard and echoed by
 * the export path, but AgentInferenceService reads `knowledgeModuleIds` and
 * only that — so an agent can hold the right dataset id in the wrong field and
 * be, at runtime, grounded on nothing. Nothing in a per-artifact sweep can see
 * that, because from one artifact's point of view the id is right there.
 * ------------------------------------------------------------------ */

interface BindingField {
  path: string;
  effective: boolean;
  /** Why the runtime ignores this field — quoted back in the finding. */
  inertReason?: string;
}

const BINDINGS: Record<string, BindingField[]> = {
  // `brain` ({kind, id}) is what WidgetControllerV1 resolves; the top-level
  // `agentId` is a deprecated denormalisation the service synthesises a
  // BrainRef from when `brain` is null. `binding`/`attach` are wizard-request
  // vocabulary that never lands on the stored record — listed last so a hit
  // there is reported rather than silently ignored.
  'widget:binds': [
    { path: 'brain.id', effective: true },
    { path: 'brain', effective: true },
    { path: 'agentId', effective: true },
    { path: 'chatFlowId', effective: true },
    { path: 'workflowId', effective: true },
    { path: 'binding.id', effective: true },
    { path: 'attach.id', effective: true },
  ],
  'chatflow:hands-off-to': [
    { path: 'agentId', effective: true },
    { path: 'agentConfig.agentId', effective: true },
    { path: 'handoffAgentId', effective: true },
    { path: 'settings.handoffAgentId', effective: true },
    { path: 'goalConfig.handoffAgentId', effective: true },
  ],
  'agent:grounds': [
    { path: 'knowledgeModuleIds[]', effective: true },
    { path: 'groundingModuleIds[]', effective: true },
    { path: 'intelligenceModuleId', effective: true },
    {
      path: 'knowledgeSources',
      effective: false,
      inertReason:
        'knowledgeSources is a legacy comma-separated string that the agent wizard writes and the ' +
        'export path echoes, but AgentInferenceService resolves knowledge from knowledgeModuleIds ' +
        'and nothing else — an id parked here never reaches a retrieval call',
    },
  ],
  'agent:invokes': [
    { path: 'tools[]', effective: true },
    { path: 'tools[].id', effective: true },
    { path: 'toolIds[]', effective: true },
    { path: 'linkedWorkflows[]', effective: true },
    { path: 'linkedAgents[]', effective: true },
    { path: 'workflowId', effective: true },
    { path: 'chatFlowId', effective: true },
  ],
  'agent:hands-off-to': [
    { path: 'linkedAgents[]', effective: true },
    { path: 'linkedWorkflows[]', effective: true },
    { path: 'chatFlowId', effective: true },
  ],
};

/**
 * Workflows do not carry links on the record; they carry them inside node
 * configuration, which is free-form per node type. Rather than enumerate 380
 * node schemas, every workflow relation resolves by deep scan over
 * `nodes.*.configuration` — which is both simpler and more honest, because it
 * finds the id wherever the node type happens to put it.
 */
const WORKFLOW_SCAN_ROOT = 'nodes';

/**
 * The node types that make a workflow's link to another artifact a fact about
 * stored state rather than an inference.
 *
 * This matters more than it looks. A workflow that reaches an agent through a
 * TEMPLATE_TRANSFORM holding a prose instruction, or a dataset through an
 * HTTP_REQUEST holding a URL, has expressed nothing the platform can read: the
 * link exists only in the author's head and in whatever the node happens to do
 * at runtime. The same workflow built from AGENT / KNOWLEDGE_RETRIEVAL /
 * SUBWORKFLOW / CHATFLOW_TURN nodes carries the target id in node
 * configuration, where a checker — or a human reading the canvas — can see it.
 *
 * So "this wire is not verifiable" is usually not a platform limitation. It is
 * a report that the generator reached for an untyped node when a typed one
 * exists, and the fix is to say which one.
 */
const TYPED_REFERENCE_NODE: Partial<Record<SolutionKind, { type: string; key: string }>> = {
  agent: { type: 'AGENT ("agent")', key: 'configuration.agentId' },
  dataset: { type: 'KNOWLEDGE_RETRIEVAL ("knowledge-retrieval")', key: 'configuration.datasetId' },
  workflow: { type: 'SUBWORKFLOW ("subworkflow")', key: 'configuration.workflowId' },
  chatflow: { type: 'CHATFLOW_TURN ("chatflow-turn")', key: 'configuration.chatFlowId' },
  widget: { type: 'WIDGET_EMIT ("widget-emit")', key: 'configuration.widgetId' },
};

/**
 * Relations with no typed node behind them, and why. Stated rather than left
 * as an unexplained gap — a checker that says "cannot verify" without saying
 * what would make it verifiable just moves the question.
 */
const NO_TYPED_NODE: Partial<Record<string, string>> = {
  'dataset:writes':
    'there is no dataset-write node type — a workflow adds documents through the datasets API, which leaves no reference on the workflow record. This wire is verifiable only by backend change (a DATASET_WRITE node, or a references[] array the executor populates).',
  'application:reads':
    'an application is reached over HTTP by URL, not by id, so the link can only be inferred from a URL that matches the app\'s hosted origin — and this workspace has no hosting deployment, so there is no origin to match.',
  'application:exports-to':
    'an application is reached over HTTP by URL, not by id, so the link can only be inferred from a URL that matches the app\'s hosted origin — and this workspace has no hosting deployment, so there is no origin to match.',
  'application:hands-off-to':
    'an application is reached over HTTP by URL, not by id, so the link can only be inferred from a URL that matches the app\'s hosted origin — and this workspace has no hosting deployment, so there is no origin to match.',
};

/** How to make a broken workflow→artifact wire real, in one sentence. */
function repairHint(sourceKind: SolutionKind, targetKind: SolutionKind | undefined, relation: string, targetId: string): string {
  // Kinds that hold their links as fields name the field to set.
  const fields = BINDINGS[`${sourceKind}:${relation}`]?.filter((f) => f.effective);
  if (fields?.length) {
    return `Set ${fields[0]!.path} = ${targetId} on the ${sourceKind} (the runtime also accepts ${fields.slice(1, 3).map((f) => f.path).join(', ') || 'no alternative'}).`;
  }

  if (sourceKind !== 'workflow' || !targetKind) {
    return `Wire the ${relation} link, or drop it from the solution if it was never intended.`;
  }
  const blocked = NO_TYPED_NODE[`${targetKind}:${relation}`];
  if (blocked) return `Not expressible on the workflow record today: ${blocked}`;
  const typed = TYPED_REFERENCE_NODE[targetKind];
  if (!typed) return `Wire the ${relation} link, or drop it from the solution if it was never intended.`;
  const article = /^[AEIOU]/.test(typed.type) ? 'an' : 'a';
  return `Add ${article} ${typed.type} node with ${typed.key} = ${targetId}. The current graph reaches the target, if at all, through an untyped node that stores no reference.`;
}

/* ------------------------------------------------------------------ *
 * Path selection
 * ------------------------------------------------------------------ */

/**
 * A deliberately tiny path language: dotted segments, `[]` to fan out an
 * array, `*` to fan out an object's values, `$text` for the whole body.
 * Anything richer would be a query engine, and a query engine in a spec file
 * is a second program nobody tests.
 */
/**
 * The prompt text the runtime will actually apply.
 *
 * The gateway ignores `systemPrompt` entirely unless BOTH `persona` and
 * `instructions` are blank. An agent can therefore carry a meticulous
 * eighteen-field checklist in `systemPrompt` and behave as though it had never
 * been written. This is the same stored-versus-effective split as
 * `knowledgeSources` versus `knowledgeModuleIds`, and measuring coverage
 * against stored text rather than effective text would report the checklist as
 * present when it governs nothing.
 */
function effectivePrompt(body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const persona = str(b.persona);
  const instructions = str(b.instructions);
  if (persona || instructions) return [persona, instructions, str(b.toolNotes)].filter(Boolean).join('\n');
  return str(b.systemPrompt);
}

export function selectPath(body: unknown, selector: string): Array<{ path: string; value: unknown }> {
  if (selector === '$text') return [{ path: '$text', value: JSON.stringify(body ?? {}) }];
  if (selector === '$effectivePrompt') return [{ path: '$effectivePrompt', value: effectivePrompt(body) }];
  if (selector === '$storedPrompt') {
    const b = (body ?? {}) as Record<string, unknown>;
    return [
      {
        path: '$storedPrompt',
        value: [b.systemPrompt, b.persona, b.instructions, b.toolNotes].filter((v) => typeof v === 'string').join('\n'),
      },
    ];
  }
  let frontier: Array<{ path: string; value: unknown }> = [{ path: '$', value: body }];

  for (const rawSeg of selector.split('.')) {
    const fanOutArray = rawSeg.endsWith('[]');
    const seg = fanOutArray ? rawSeg.slice(0, -2) : rawSeg;
    const next: Array<{ path: string; value: unknown }> = [];

    for (const node of frontier) {
      if (node.value == null) continue;

      if (seg === '*') {
        if (typeof node.value !== 'object') continue;
        for (const [k, v] of Object.entries(node.value as Record<string, unknown>)) {
          next.push({ path: `${node.path}.${k}`, value: v });
        }
        continue;
      }

      const picked = seg === '' ? node.value : (node.value as Record<string, unknown>)[seg];
      const pickedPath = seg === '' ? node.path : `${node.path}.${seg}`;
      if (picked === undefined) continue;

      if (fanOutArray && Array.isArray(picked)) {
        picked.forEach((v, i) => next.push({ path: `${pickedPath}[${i}]`, value: v }));
      } else {
        next.push({ path: pickedPath, value: picked });
      }
    }
    frontier = next;
  }
  return frontier;
}

/** Every leaf string in a body, with the path it was found at. */
function leaves(value: unknown, path = '$', out: Array<{ path: string; value: string }> = [], depth = 0): Array<{ path: string; value: string }> {
  if (depth > 12 || out.length > 20_000) return out;
  if (value == null) return out;
  if (typeof value === 'string') {
    out.push({ path, value });
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${path}[${i}]`, out, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    leaves(v, `${path}.${k}`, out, depth + 1);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Placeholder detection
 *
 * A generated workflow whose HTTP node points at `{{TODO: Licence feed URL}}`
 * has a sound graph, no dangling edges, and no unwired nodes. It passes every
 * check the workflow adapter makes and fails the first time it runs. The wire
 * it is supposed to carry is neither connected nor plainly absent — it is
 * *stubbed*, and that deserves its own verdict rather than being rounded to
 * either neighbour.
 * ------------------------------------------------------------------ */

const PLACEHOLDER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\{\{\s*TODO\b[^}]*\}\}/i, label: 'unresolved {{TODO}} template' },
  // The wizard now separates a value it could not determine ({{TODO}}) from one that
  // was never its to choose — which credential, which recipient — and writes
  // {{ASK: label}} for the latter. That artifact is SAVED and reported as NEEDS_INPUT
  // rather than INCOMPLETE, which is right for someone sitting at the canvas and the
  // wrong thing to be relaxed about here: an unanswered {{ASK}} fails on first
  // execution exactly like a {{TODO}}. Without this line a solution carrying three
  // unanswered questions reports READY.
  // Matched as a HEAD TOKEN, not a substring: `{{ask-user-step.answer}}` is one node
  // reading another's output, and flagging it would bury the real questions in noise.
  // The backend validator makes the same distinction for the same reason.
  { re: /\{\{\s*(ASK|ASK_USER|ASKUSER|USER_INPUT)\s*(?::[^}]*)?\s*\}\}/i, label: 'unanswered {{ASK}} question' },
  { re: /\bTODO\b\s*:/i, label: 'literal TODO' },
  { re: /\bapi\.example\.com\b/i, label: 'example.com placeholder host' },
  { re: /\bexample\.(com|org|net)\/(?!$)/i, label: 'example domain' },
  { re: /\b(CHANGE_?ME|REPLACE_?ME|FIXME)\b/i, label: 'CHANGEME marker' },
  { re: /<your[-_ ]/i, label: '<your-…> template' },
  { re: /\bYOUR_[A-Z_]{3,}\b/, label: 'YOUR_… template' },
  { re: /\bxxx+\b/i, label: 'xxx filler' },
];

export interface PlaceholderHit {
  path: string;
  label: string;
  value: string;
}

export function findPlaceholders(body: unknown, root?: string): PlaceholderHit[] {
  const scope = root ? selectPath(body, root).map((n) => n.value) : [body];
  const hits: PlaceholderHit[] = [];
  for (const s of scope) {
    for (const leaf of leaves(s)) {
      for (const p of PLACEHOLDER_PATTERNS) {
        if (p.re.test(leaf.value)) {
          hits.push({ path: leaf.path, label: p.label, value: leaf.value.slice(0, 160) });
          break;
        }
      }
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * Reading live state
 * ------------------------------------------------------------------ */

const DATASETS = '/api/v2/datasets';

async function fetchBody(client: SwfteClient, kind: SolutionKind, id: string): Promise<unknown> {
  if (kind === 'dataset') {
    return client.request({ method: 'GET', path: `${DATASETS}/${encodeURIComponent(id)}`, retries: 1 });
  }
  const adapter = getAdapter(kind);
  if (typeof adapter.get !== 'function') {
    throw new Error(`${kind} has no read path on this server — it cannot be a wire endpoint.`);
  }
  return adapter.get(client, id);
}

/* ------------------------------------------------------------------ *
 * Wire resolution
 * ------------------------------------------------------------------ */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Does this leaf value point at the target id? */
const pointsAt = (value: string, targetId: string) =>
  value === targetId || (value.length < 4096 && value.includes(targetId));

function declaredBindings(kind: SolutionKind, relation: string): BindingField[] {
  return BINDINGS[`${kind}:${relation}`] ?? [];
}

function resolveWire(
  wire: SolutionWire,
  fromComponent: SolutionComponent,
  fromBody: unknown,
  targetId: string,
  targetKey: string,
  targetKind?: SolutionKind
): WireResult {
  const base = {
    from: wire.from,
    to: wire.to,
    relation: wire.relation,
    note: wire.note,
    evidence: [] as WireEvidence[],
  };

  if (wire.externalReason) {
    return {
      ...base,
      state: 'external',
      ok: null,
      detail: `Declared un-checkable: ${wire.externalReason}`,
    };
  }

  const kind = fromComponent.kind;

  // 1. Look in the fields this (kind, relation) is supposed to use.
  const fields = wire.path
    ? [{ path: wire.path, effective: true } as BindingField]
    : declaredBindings(kind, wire.relation);

  const effectiveHits: WireEvidence[] = [];
  const inertHits: Array<WireEvidence & { reason: string }> = [];

  for (const field of fields) {
    for (const node of selectPath(fromBody, field.path)) {
      for (const leaf of leaves(node.value, node.path)) {
        if (!pointsAt(leaf.value, targetId)) continue;
        if (field.effective) effectiveHits.push({ path: leaf.path, value: leaf.value.slice(0, 200) });
        else inertHits.push({ path: leaf.path, value: leaf.value.slice(0, 200), reason: field.inertReason ?? 'the runtime does not read this field' });
      }
    }
  }

  if (effectiveHits.length > 0) {
    const seen = dedupe(effectiveHits);
    return {
      ...base,
      state: 'connected',
      ok: true,
      detail: `${wire.from} → ${wire.to}: ${targetId} present at ${seen[0]!.path}`,
      evidence: seen.slice(0, 4),
    };
  }

  // 2. Nowhere the runtime reads. Sweep the whole body before calling it
  //    broken, because an id sitting in the wrong field is a different defect
  //    from an id that was never wired at all — and the fix differs.
  const scanRoot = kind === 'workflow' ? WORKFLOW_SCAN_ROOT : undefined;
  const scanScope = scanRoot ? selectPath(fromBody, scanRoot).map((n) => n.value) : [fromBody];
  const anywhere: WireEvidence[] = [];
  for (const scope of scanScope) {
    for (const leaf of leaves(scope)) {
      if (pointsAt(leaf.value, targetId)) anywhere.push({ path: leaf.path, value: leaf.value.slice(0, 200) });
    }
  }

  if (inertHits.length > 0) {
    const hit = inertHits[0]!;
    return {
      ...base,
      state: 'inert',
      ok: false,
      detail:
        `${wire.from} → ${wire.to}: the id is stored at ${hit.path}, but ${hit.reason}. ` +
        'The link looks present on the record and does not exist at runtime.',
      evidence: dedupe(inertHits.map(({ path, value }) => ({ path, value }))).slice(0, 4),
      nextAction:
        kind === 'agent' && wire.relation === 'grounds'
          ? `Attach the dataset properly: POST /v2/agents/${fromComponent.id ?? fromComponent.live?.id}/knowledge-modules, or set knowledgeModuleIds to include ${targetId}.`
          : `Move the reference to a field the runtime reads for "${wire.relation}".`,
    };
  }

  if (anywhere.length > 0) {
    return {
      ...base,
      state: 'inert',
      ok: false,
      detail:
        `${wire.from} → ${wire.to}: ${targetId} appears at ${anywhere[0]!.path}, which is not a field ` +
        `the platform consults for "${wire.relation}".`,
      evidence: dedupe(anywhere).slice(0, 4),
      nextAction: `Re-point the ${wire.relation} link at a supported binding field.`,
    };
  }

  // 3. A wire whose own binding field is a stub. Narrow on purpose: this only
  //    fires when the author named the field with `path`, so the placeholder
  //    can be attributed to THIS wire. Unattributed stubs elsewhere in the
  //    artifact are reported once per component instead — blaming every wire
  //    out of a workflow on one TODO in an unrelated node reads as four
  //    findings where there is one, and sends the reader to the wrong node.
  if (wire.path) {
    const own = findPlaceholders(selectPath(fromBody, wire.path).map((n) => n.value));
    if (own.length > 0) {
      return {
        ...base,
        state: 'placeholder',
        ok: false,
        detail:
          `${wire.from} → ${wire.to}: the declared binding field ${wire.path} is still a stub — ` +
          `${own[0]!.label} (${own[0]!.value}).`,
        evidence: own.slice(0, 4).map((p) => ({ path: p.path, value: p.value })),
        nextAction: `Fill in ${wire.path} on ${wire.from} — a generated placeholder fails the first time it runs.`,
      };
    }
  }

  // 4. The id is nowhere in the body. That is a verdict, not the absence of
  //    one: the stored artifact does not reference the target, so the link
  //    does not exist in anything the platform can execute.
  const stubs = findPlaceholders(fromBody, scanRoot);
  const context = stubs.length
    ? ` The ${kind} also carries ${stubs.length} unresolved placeholder(s) (see the config-resolved check), ` +
      'so this may be a step that was generated and never finished rather than one that was omitted.'
    : '';

  return {
    ...base,
    state: 'broken',
    ok: false,
    detail: `${wire.from} → ${wire.to}: no reference to ${targetKey} (${targetId}) anywhere in the stored ${kind}.${context}`,
    evidence: [],
    nextAction: repairHint(kind, targetKind, wire.relation, targetId),
  };
}

/** Same path twice is one piece of evidence, not two. */
function dedupe(hits: WireEvidence[]): WireEvidence[] {
  const seen = new Set<string>();
  return hits.filter((h) => (seen.has(h.path) ? false : (seen.add(h.path), true)));
}

/* ------------------------------------------------------------------ *
 * Coverage
 *
 * The general fix for "the gate asserted the component existed rather than
 * that it covered the scheme". An existence assertion is satisfied by any
 * artifact of the right shape; a coverage assertion is satisfied only by one
 * that carries the thing it was commissioned to carry.
 * ------------------------------------------------------------------ */

export function measureCoverage(
  component: SolutionComponent,
  id: string,
  body: unknown,
  assertion: CoverageAssertion
): CoverageResult {
  const mode = assertion.match ?? 'normalized';
  const minRatio = assertion.minRatio ?? 1;
  const label = assertion.label ?? assertion.id;

  const selected = selectPath(body, assertion.in);
  const values: string[] = [];
  for (const node of selected) {
    if (typeof node.value === 'string') values.push(node.value);
    else for (const leaf of leaves(node.value)) values.push(leaf.value);
  }

  const exactSet = new Set(values);
  const normSet = new Set(values.map(norm));
  const haystack = norm(values.join(' '));

  const found: string[] = [];
  const missing: string[] = [];
  for (const token of assertion.of) {
    const hit =
      mode === 'exact'
        ? exactSet.has(token)
        : mode === 'contains'
          ? haystack.includes(norm(token))
          : normSet.has(norm(token));
    (hit ? found : missing).push(token);
  }

  const ratio = assertion.of.length === 0 ? 1 : found.length / assertion.of.length;
  const ok = ratio >= minRatio - 1e-9;
  const pct = Math.round(ratio * 100);

  return {
    component: component.key,
    id,
    label,
    required: assertion.of.length,
    covered: found.length,
    ratio,
    minRatio,
    ok,
    missing,
    found,
    detail: ok
      ? `${component.key} covers ${found.length}/${assertion.of.length} of ${label} (${pct}%) at ${assertion.in}`
      : `${component.key} covers only ${found.length}/${assertion.of.length} of ${label} (${pct}%, floor ${Math.round(minRatio * 100)}%) at ` +
        `${assertion.in} — missing: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? `, +${missing.length - 12} more` : ''}`,
    nextAction: ok
      ? undefined
      : `Extend ${component.key} to cover the remaining ${missing.length} item(s) of ${label}, or lower minRatio if partial coverage is genuinely intended.`,
  };
}

/* ------------------------------------------------------------------ *
 * Role requirements
 * ------------------------------------------------------------------ */

const REQUIREMENT_SOURCES: Record<Requirement, Record<string, string[]>> = {
  knowledge: {
    agent: ['knowledgeModuleIds[]', 'groundingModuleIds[]', 'intelligenceModuleId'],
  },
  tools: {
    agent: ['tools[]', 'toolIds[]', 'linkedWorkflows[]', 'connectors[]'],
  },
  brain: {
    widget: ['brain.id', 'agentId', 'chatFlowId', 'workflowId'],
  },
  downstream: {
    chatflow: ['agentId', 'agentConfig.agentId', 'handoffAgentId', 'settings.handoffAgentId'],
    agent: ['linkedAgents[]', 'linkedWorkflows[]', 'chatFlowId'],
  },
};

const REQUIREMENT_WHY: Record<Requirement, string> = {
  knowledge:
    'the role is to validate or answer against a body of rules — without a linked knowledge module the model invents them',
  tools: 'the role is to act, and an agent with no tools can only describe the action',
  brain: 'the role is to answer, and a widget with no backing agent/chatflow/workflow renders but responds to nothing',
  downstream: 'the role is to collect and hand on — collected data with no downstream goes nowhere',
};

function requirementCheck(component: SolutionComponent, body: unknown, req: Requirement): { check: VerifyCheck; nextAction?: string } {
  const paths = REQUIREMENT_SOURCES[req]?.[component.kind];
  if (!paths) {
    return {
      check: {
        id: `requires:${req}:${component.key}`,
        ok: null,
        detail: `No known ${req} field for kind "${component.kind}" — skipped rather than guessed.`,
      },
    };
  }

  const present: string[] = [];
  for (const p of paths) {
    for (const node of selectPath(body, p)) {
      const v = node.value;
      const nonEmpty =
        (typeof v === 'string' && v.trim() !== '') ||
        (Array.isArray(v) && v.length > 0) ||
        (v != null && typeof v === 'object' && Object.keys(v as object).length > 0);
      if (nonEmpty) present.push(node.path);
    }
  }

  if (present.length > 0) {
    return {
      check: { id: `requires:${req}:${component.key}`, ok: true, detail: `${component.key} has ${req} at ${present.slice(0, 3).join(', ')}` },
    };
  }

  return {
    check: {
      id: `requires:${req}:${component.key}`,
      ok: false,
      detail: `${component.key} (${component.kind}) declares it requires ${req} and has none — ${REQUIREMENT_WHY[req]}. Checked ${paths.join(', ')}.`,
    },
    nextAction: `Give ${component.key} its ${req}, or drop the requirement if the role changed.`,
  };
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

export async function verifySolution(
  client: SwfteClient,
  spec: SolutionSpecInput,
  opts: SolutionVerifyOpts = {}
): Promise<SolutionVerifyReport> {
  const idOf = (c: SolutionComponent) => c.id ?? c.live?.id ?? '';
  const byKey = new Map(spec.components.map((c) => [c.key, c]));

  const bodies = new Map<string, unknown>();
  const componentRows: SolutionVerifyReport['components'] = [];
  const checks: VerifyCheck[] = [];
  const nextActions: string[] = [];

  // Read every component once. Sequential on purpose: the backend rate-limits
  // a burst of concurrent reads into "fetch failed", which would read as a
  // broken solution rather than as a throttled client.
  for (const c of spec.components) {
    const id = idOf(c);
    if (!id) {
      componentRows.push({ key: c.key, kind: c.kind, id: '', readable: false, detail: 'No live id declared — nothing to read.' });
      checks.push({ id: `readable:${c.key}`, ok: false, detail: `${c.key} has no live id.` });
      continue;
    }
    try {
      const body = await fetchBody(client, c.kind, id);
      bodies.set(c.key, body);
      const name = (body as any)?.name ?? (body as any)?.agentName ?? c.title ?? 'unnamed';
      componentRows.push({ key: c.key, kind: c.kind, id, readable: true, detail: `${c.kind} "${name}"` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      componentRows.push({ key: c.key, kind: c.kind, id, readable: false, detail: msg.slice(0, 200) });
      checks.push({ id: `readable:${c.key}`, ok: false, detail: `${c.key} (${c.kind}/${id}) not readable: ${msg.slice(0, 160)}` });
      nextActions.push(`Check that ${c.key} still exists — ${c.kind} ${id} did not read back.`);
    }
  }

  // Wires.
  const wires: WireResult[] = [];
  for (const wire of spec.wiring ?? []) {
    const from = byKey.get(wire.from);
    const to = byKey.get(wire.to);
    const shared = { from: wire.from, to: wire.to, relation: wire.relation, note: wire.note, evidence: [] as WireEvidence[] };

    if (!from) {
      wires.push({ ...shared, state: 'unknown', ok: false, detail: `Wire source "${wire.from}" is not a declared component.` });
      continue;
    }
    if (!to && !wire.externalReason) {
      wires.push({ ...shared, state: 'unknown', ok: false, detail: `Wire target "${wire.to}" is not a declared component.` });
      continue;
    }
    if (!bodies.has(wire.from)) {
      wires.push({ ...shared, state: 'unknown', ok: null, detail: `Source ${wire.from} was not readable — the wire could not be judged.` });
      continue;
    }
    const targetId = to ? idOf(to) : '';
    const result = resolveWire(wire, from, bodies.get(wire.from), targetId, wire.to, to?.kind);
    wires.push(result);
    if (result.nextAction) nextActions.push(result.nextAction);
  }

  // Coverage and role requirements.
  const coverage: CoverageResult[] = [];
  for (const c of spec.components) {
    const body = bodies.get(c.key);
    if (body === undefined) continue;
    const id = idOf(c);

    for (const assertion of c.covers ?? []) {
      const r = measureCoverage(c, id, body, assertion);
      coverage.push(r);
      checks.push({ id: `covers:${c.key}:${assertion.id}`, ok: r.ok, detail: r.detail });
      if (r.nextAction) nextActions.push(r.nextAction);
    }

    for (const req of c.requires ?? []) {
      const { check, nextAction } = requirementCheck(c, body, req);
      checks.push(check);
      if (nextAction) nextActions.push(nextAction);
    }

    // Unresolved generated configuration. A workflow whose HTTP node points at
    // `{{TODO: Licence feed URL}}` has a sound graph, no dangling edges and no
    // unwired nodes — it passes every structural check the workflow adapter
    // makes and fails the first time it executes. Reported once per component,
    // where the fix is, rather than once per wire that happens to leave it.
    const stubs = findPlaceholders(body, c.kind === 'workflow' ? WORKFLOW_SCAN_ROOT : undefined);
    if (stubs.length > 0) {
      const shown = stubs.slice(0, 6).map((s) => `${s.path} (${s.label})`);
      checks.push({
        id: `config-resolved:${c.key}`,
        ok: false,
        detail:
          `${c.key} carries ${stubs.length} unresolved placeholder(s) that will fail at execution: ` +
          `${shown.join('; ')}${stubs.length > 6 ? `; +${stubs.length - 6} more` : ''}`,
      });
      nextActions.push(`Fill in the ${stubs.length} placeholder(s) in ${c.key} — generated stubs, not configuration.`);
    }
  }

  // Orphans. A component that no wire reaches and that reaches nothing is
  // either dead weight or a wire somebody forgot to declare; either way the
  // solution is not what the spec says it is.
  const touched = new Set<string>();
  for (const w of spec.wiring ?? []) {
    touched.add(w.from);
    touched.add(w.to);
  }
  const orphans = spec.components.filter((c) => !touched.has(c.key) && !c.entry && !c.terminal).map((c) => c.key);
  checks.push({
    id: 'no-orphans',
    ok: orphans.length === 0,
    detail:
      orphans.length === 0
        ? 'Every component participates in at least one declared wire.'
        : `${orphans.length} component(s) participate in no wire: ${orphans.join(', ')}. Either they are unused, or a wire was never declared.`,
  });
  if (orphans.length > 0) {
    nextActions.push(`Declare the wiring for ${orphans.join(', ')}, or remove them from the solution.`);
  }

  // Fold the wire verdicts into the same check shape everything else uses, so
  // a caller can treat the report uniformly.
  for (const w of wires) {
    checks.push({ id: `wire:${w.from}→${w.to}`, ok: opts.strict && w.ok === null ? false : w.ok, detail: `[${w.state}] ${w.detail}` });
  }

  // Optional: fold in each component's own sweep, so one call answers both
  // levels of the question.
  if (opts.includeComponentVerify) {
    for (const row of componentRows) {
      if (!row.readable || row.kind === 'dataset') {
        row.componentOk = null;
        continue;
      }
      try {
        const report = await getAdapter(row.kind).verify(client, row.id, {});
        row.componentOk = report.ok;
        row.failedChecks = report.checks.filter((ch) => ch.ok === false).map((ch) => ch.id);
      } catch {
        row.componentOk = null;
      }
    }
    const passing = componentRows.filter((r) => r.componentOk === true).length;
    const rated = componentRows.filter((r) => r.componentOk !== null && r.componentOk !== undefined).length;
    checks.push({
      id: 'component-level',
      ok: null,
      detail: `${passing}/${rated} component(s) pass their own kind sweep — recorded for contrast, not as the solution verdict.`,
    });
  }

  const failed = checks.filter((ch) => ch.ok === false);
  const ok = failed.length === 0;

  const brokenWires = wires.filter((w) => w.ok === false);
  const failedCoverage = coverage.filter((r) => !r.ok);

  const summary = ok
    ? `Solution intact: ${wires.length} wire(s) resolve, ${coverage.length} coverage assertion(s) met across ${spec.components.length} component(s).`
    : `${failed.length} solution-level failure(s): ` +
      [
        brokenWires.length ? `${brokenWires.length} wire(s) not live (${brokenWires.map((w) => `${w.from}→${w.to} ${w.state}`).join(', ')})` : '',
        failedCoverage.length ? `${failedCoverage.length} coverage shortfall(s) (${failedCoverage.map((r) => `${r.component} ${r.covered}/${r.required}`).join(', ')})` : '',
      ]
        .filter(Boolean)
        .join('; ');

  return {
    ok,
    solution: spec.name ?? spec.id ?? 'solution',
    workspaceId: spec.workspaceId,
    components: componentRows,
    wires,
    coverage,
    checks,
    nextActions: [...new Set(nextActions)],
    summary,
  };
}
