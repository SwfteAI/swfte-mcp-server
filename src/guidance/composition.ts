/**
 * The composition classifier.
 *
 * Two *independent* dimensions, per the Studio unification brief
 * (`02-SURFACES-AND-JOURNEYS.md` § C):
 *
 *   execution approach  — bounded workflow | agentic investigation | hybrid
 *   delivery surface    — internal automation | conversational | widget
 *                         | application | coordinated solution
 *
 * They are independent on purpose. The single-axis `advise()` below this file
 * collapsed them into one word ("product", "workflow", "agentic"), which made
 * "agentic" read as a synonym for "product" and pushed every uncertain task
 * toward a dedicated interface it did not need. A bounded workflow can be
 * delivered as a widget; an agentic investigation can be delivered as pure
 * internal automation. Naming the two choices separately is the whole point.
 *
 * Three rules this file refuses to break:
 *
 *  1. **Smallest sufficient.** Each dimension is a ladder and the classifier
 *     stops on the lowest rung the supplied signals actually justify. The rung
 *     above is reported as `escalateWhen` — what would have to be true — rather
 *     than taken pre-emptively.
 *  2. **No default.** Absent signals produce `value: null` with
 *     `confidence: 'UNDETERMINED'` and the missing signal named. A default
 *     recommendation is indistinguishable from a measured one once it reaches
 *     the UI, and the brief forbids that.
 *  3. **Local only.** This is a design opinion computed from the caller's own
 *     answers and the illustrative case catalogue. It observes no workspace, no
 *     entitlement and no runtime, and says so in `evidenceLevel`.
 */
import { z } from 'zod';
import catalog from './case-studies.json';

export const EXECUTION_APPROACHES = ['bounded-workflow', 'agentic-investigation', 'hybrid'] as const;
export const DELIVERY_SURFACES = [
  'internal-automation',
  'conversational',
  'widget',
  'application',
  'solution',
] as const;

export type ExecutionApproach = (typeof EXECUTION_APPROACHES)[number];
export type DeliverySurface = (typeof DELIVERY_SURFACES)[number];

export const ExecutionApproachEnum = z.enum(EXECUTION_APPROACHES);
export const DeliverySurfaceEnum = z.enum(DELIVERY_SURFACES);

/** Rung order for the delivery ladder; index is the rung number. */
const SURFACE_LADDER: DeliverySurface[] = [
  'internal-automation',
  'conversational',
  'widget',
  'application',
  'solution',
];

/**
 * What the wizard asks, in the caller's own terms.
 *
 * Every field is optional because a wizard collects them progressively; an
 * unanswered question becomes a `missingSignals` entry rather than an assumed
 * `false`. `deterministicSteps` and `uncertainSteps` are arrays, not booleans,
 * so the explanation can quote the caller's own words back.
 */
export const CompositionSignals = z
  .object({
    expectedAudience: z
      .enum(['single-operator', 'team', 'external-customers'])
      .optional()
      .describe('Who reads the output. A single operator rarely needs a shared interface.'),
    recurringInteraction: z
      .boolean()
      .optional()
      .describe('Do the same people come back to this repeatedly, or is it one run?'),
    deterministicSteps: z
      .array(z.string().min(1))
      .optional()
      .describe('Steps whose order and stopping condition can be written down before execution.'),
    uncertainSteps: z
      .array(z.string().min(1))
      .optional()
      .describe('Steps where the next action cannot be known until earlier evidence is inspected.'),
    sharedDurableRecords: z
      .boolean()
      .optional()
      .describe('Must a queue, decision history or ranking outlive any single run and be shared?'),
    sharedReviewInterface: z
      .boolean()
      .optional()
      .describe('Do several people need to look at, and act on, the same records together?'),
    dedicatedInterfaceRequired: z
      .boolean()
      .optional()
      .describe('Is a table, dashboard or form insufficient — genuinely custom screens and navigation?'),
    conversationalIntake: z
      .boolean()
      .optional()
      .describe('Does a human open this by asking a question, with clarification turns?'),
    existingSystemOfRecord: z
      .boolean()
      .optional()
      .describe('Does an existing ticketing/repository/BI system already own this state and its review?'),
    independentlyUsefulArtifacts: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('How many of the pieces would still be worth having on their own?'),
    sources: z.array(z.string().min(1)).optional().describe('Systems read from.'),
    permissions: z.array(z.string().min(1)).optional().describe('Authorisations the run needs.'),
    humanDecisions: z.array(z.string().min(1)).optional().describe('Decisions a person must make.'),
    outputTypes: z.array(z.string().min(1)).optional().describe('What it produces.'),
    budgetBoundary: z.string().min(1).optional().describe('Spend ceiling per run.'),
    timeBoundary: z.string().min(1).optional().describe('Wall-clock ceiling per run.'),
    sideEffects: z.array(z.string().min(1)).optional().describe('Writes, sends or mutations outside Studio.'),
    deploymentNeeds: z.array(z.string().min(1)).optional().describe('Where it must be reachable from.'),
    caseStudyIds: z.array(z.string()).max(5).optional().describe('Case IDs to weigh explicitly.'),
  })
  .strict();

export type Signals = z.infer<typeof CompositionSignals>;

export interface DimensionVerdict<T> {
  value: T | null;
  confidence: 'RECOMMENDED' | 'PROVISIONAL' | 'UNDETERMINED';
  question: string;
  why: string[];
  /** What would have to become true to justify the next rung up. Null at the top. */
  escalateWhen: string | null;
}

export interface CompositionRecommendation {
  schemaVersion: 1;
  executionApproach: DimensionVerdict<ExecutionApproach>;
  deliverySurface: DimensionVerdict<DeliverySurface> & {
    /** The artifact kind a human actually opens. Null for pure automation. */
    entryPointKind: 'workflow' | 'agent' | 'chatflow' | 'widget' | 'application' | null;
  };
  composition: {
    smallestSufficient: Array<{ kind: string; role: string; required: boolean }>;
    omitted: Array<{ kind: string; whyNot: string }>;
  };
  explanation: string;
  influencedBy: Array<{ caseStudyId: string; title: string; how: string }>;
  facts: {
    expectedAudience: string | null;
    recurringInteraction: boolean | null;
    deterministicSteps: string[];
    uncertainSteps: string[];
    sources: string[];
    permissions: string[];
    humanDecisions: string[];
    outputTypes: string[];
    budgetBoundary: string | null;
    timeBoundary: string | null;
    sideEffects: string[];
    deploymentNeeds: string[];
  };
  missingSignals: string[];
  alternatives: Array<{
    executionApproach: ExecutionApproach;
    deliverySurface: DeliverySurface;
    when: string;
  }>;
  revisable: true;
  evidenceLevel: 'LOCAL_CLASSIFICATION_ONLY';
  persistence: { persistedWithArtifact: boolean; blocker: string | null };
}

const EXECUTION_QUESTION =
  'How predictable is the process, where is judgement needed, and how is execution bounded?';
const SURFACE_QUESTION =
  'Who uses it, through which interface, with what permissions and operational ownership?';

/** The role text that marks an agent as genuinely adaptive rather than a fixed specialist step. */
const ADAPTIVE_ROLE = /AGENTIC|adaptive|investigat|iterative|experiment|diagnos/i;

function classifyExecution(signals: Signals): DimensionVerdict<ExecutionApproach> {
  const deterministic = signals.deterministicSteps ?? [];
  const uncertain = signals.uncertainSteps ?? [];
  const bothAnswered = signals.deterministicSteps !== undefined && signals.uncertainSteps !== undefined;

  if (uncertain.length > 0 && deterministic.length > 0) {
    return {
      value: 'hybrid',
      confidence: 'RECOMMENDED',
      question: EXECUTION_QUESTION,
      why: [
        `A bounded spine covers ${deterministic.length} step(s) that can be written down in advance.`,
        `${uncertain.length} step(s) cannot be ordered until earlier evidence is inspected, so an investigator picks its own next move inside that spine.`,
        'Keep approvals and mutations on the deterministic side; let the agent gather evidence, not commit it.',
      ],
      escalateWhen: null,
    };
  }
  if (uncertain.length > 0) {
    return {
      value: 'agentic-investigation',
      confidence: bothAnswered ? 'RECOMMENDED' : 'PROVISIONAL',
      question: EXECUTION_QUESTION,
      why: [
        'No step order survives contact with the evidence, so the next action is chosen at run time.',
        'This obliges you to configure real tools, a budget ceiling, a time ceiling and a human escalation point. A prompt does not implement any of those.',
      ],
      escalateWhen:
        'Name even one stage whose order and stopping condition are fixed, and the shape becomes hybrid: that stage should be a workflow the agent runs inside.',
    };
  }
  if (deterministic.length > 0) {
    return {
      value: 'bounded-workflow',
      confidence: bothAnswered ? 'RECOMMENDED' : 'PROVISIONAL',
      question: EXECUTION_QUESTION,
      why: [
        'Every named step has a known trigger, order and stopping condition.',
        'Specialist judgement belongs in explicit AGENT nodes inside the workflow; that is still a bounded workflow, not an agentic system.',
      ],
      escalateWhen:
        'Name a decision that cannot be made until something is inspected at run time, and the shape becomes hybrid.',
    };
  }
  return {
    value: null,
    confidence: 'UNDETERMINED',
    question: EXECUTION_QUESTION,
    why: [
      'Neither the deterministic steps nor the uncertain ones were described, and this classifier does not guess.',
    ],
    escalateWhen: null,
  };
}

function classifySurface(
  signals: Signals
): DimensionVerdict<DeliverySurface> & {
  entryPointKind: CompositionRecommendation['deliverySurface']['entryPointKind'];
} {
  const why: string[] = [];
  const audienceAnswered = signals.expectedAudience !== undefined;
  const interfaceAnswered =
    signals.sharedReviewInterface !== undefined ||
    signals.conversationalIntake !== undefined ||
    signals.sharedDurableRecords !== undefined;

  if (!audienceAnswered && !interfaceAnswered) {
    return {
      value: null,
      confidence: 'UNDETERMINED',
      question: SURFACE_QUESTION,
      why: ['Nobody said who uses this or how they reach it, and this classifier does not guess.'],
      escalateWhen: null,
      entryPointKind: null,
    };
  }

  let rung = 0; // internal-automation
  let entryPointKind: CompositionRecommendation['deliverySurface']['entryPointKind'] = null;

  if (signals.conversationalIntake === true) {
    rung = Math.max(rung, 1);
    entryPointKind = 'chatflow';
    why.push('A person opens this by asking a question and expects clarification turns, so the entry point is a conversation.');
  }
  if (signals.sharedReviewInterface === true) {
    rung = Math.max(rung, 2);
    entryPointKind = 'widget';
    why.push('Several people act on the same records together, which a chat transcript cannot represent. A bound table, dashboard or form can.');
  }
  if (
    signals.sharedDurableRecords === true &&
    signals.sharedReviewInterface === true &&
    signals.dedicatedInterfaceRequired === true
  ) {
    rung = Math.max(rung, 3);
    entryPointKind = 'application';
    why.push('A table, dashboard or form was explicitly declared insufficient, so custom screens and navigation are the requirement, not a preference.');
  }
  if (rung === 0) {
    why.push('No human opens this directly: it runs on a trigger and writes its result into systems people already use.');
  }

  // The existing system of record caps the ladder. A second interface over
  // records somebody else's system already owns is a migration nobody asked for.
  let cappedBy: string | null = null;
  if (signals.existingSystemOfRecord === true && rung >= 2) {
    rung = 1;
    entryPointKind = signals.conversationalIntake === true ? 'chatflow' : null;
    if (rung === 0) entryPointKind = null;
    cappedBy =
      'An existing system already owns these records and their review, so this stops below a new shared interface. Write into that system and add a Studio surface only for a demonstrated gap in it.';
    why.push(cappedBy);
  }

  // Solution is a packaging rung, not a different interface: it sits above
  // whichever entry point was chosen, and only for a durable shared product.
  const artifacts = signals.independentlyUsefulArtifacts ?? 0;
  let value = SURFACE_LADDER[rung]!;
  if (signals.sharedDurableRecords === true && artifacts >= 2 && cappedBy === null) {
    value = 'solution';
    why.push(
      `${artifacts} of the pieces are worth having on their own, so ship them as a bundle with explicit dependencies rather than one monolith. The human entry point is still the ${entryPointKind ?? 'automation trigger'}.`
    );
  }

  const escalateWhen =
    value === 'solution'
      ? null
      : value === 'application'
        ? 'Once two or more of the pieces are independently useful, package the bundle as a coordinated solution instead of growing one application.'
        : value === 'widget'
          ? 'Declare that a table, dashboard or form is insufficient — that custom screens and navigation are required — and this becomes an application.'
          : value === 'conversational'
            ? 'Say that several people must act on the same records together, and this becomes a widget.'
            : 'Say that a person opens this by asking a question, and this becomes a conversational surface.';

  const answeredAll =
    signals.expectedAudience !== undefined &&
    signals.sharedReviewInterface !== undefined &&
    signals.sharedDurableRecords !== undefined &&
    signals.conversationalIntake !== undefined;

  return {
    value,
    confidence: answeredAll ? 'RECOMMENDED' : 'PROVISIONAL',
    question: SURFACE_QUESTION,
    why,
    escalateWhen,
    entryPointKind,
  };
}

function compositionFor(
  execution: ExecutionApproach | null,
  surface: DeliverySurface | null,
  entryPointKind: CompositionRecommendation['deliverySurface']['entryPointKind']
): CompositionRecommendation['composition'] {
  const smallest: Array<{ kind: string; role: string; required: boolean }> = [];
  const omitted: Array<{ kind: string; whyNot: string }> = [];

  if (execution === 'bounded-workflow' || execution === 'hybrid') {
    smallest.push({ kind: 'workflow', role: 'The bounded spine: trigger, ordered stages, stopping condition.', required: true });
  } else {
    omitted.push({ kind: 'workflow', whyNot: 'No stage order survives contact with the evidence, so a workflow would encode a sequence that does not exist.' });
  }
  if (execution === 'agentic-investigation' || execution === 'hybrid') {
    smallest.push({ kind: 'agent', role: 'The investigator: configured tools, budget ceiling, time ceiling, escalation point.', required: true });
  } else if (execution === 'bounded-workflow') {
    smallest.push({ kind: 'agent', role: 'Optional AGENT nodes for fixed specialist steps inside the workflow. A stored agentId is not an invocation — set configuration.agentId and check the trace.', required: false });
  }
  if (entryPointKind === 'chatflow') {
    smallest.push({ kind: 'chatflow', role: 'Question intake and clarification turns.', required: true });
  }
  if (entryPointKind === 'widget') {
    smallest.push({ kind: 'widget', role: 'The shared review surface. One brain; graphical views bind to workspace data instead.', required: true });
  }
  if (entryPointKind === 'application') {
    smallest.push({ kind: 'application', role: 'Custom screens and navigation over durable authorised storage.', required: true });
  } else if (surface !== null) {
    omitted.push({ kind: 'application', whyNot: 'A table, dashboard or form was not declared insufficient, so an application would be a larger surface than the work requires.' });
  }
  if (surface !== null && surface !== 'internal-automation') {
    smallest.push({ kind: 'module', role: 'Versioned grounding. Attach it only after documents are indexed and a retrieval probe returns something — an empty module is not grounding.', required: false });
  }
  return { smallestSufficient: smallest, omitted };
}

function influenced(execution: ExecutionApproach | null, surface: DeliverySurface | null, ids?: string[]) {
  const explicit = ids?.length ? CASE_COMPOSITIONS.filter(c => ids.includes(c.caseStudyId)) : [];
  const matched = explicit.length
    ? explicit
    : CASE_COMPOSITIONS.filter(
        c =>
          (execution === null || c.executionApproach === execution) &&
          (surface === null || c.deliverySurface === surface)
      ).slice(0, 3);
  return matched.map(c => ({
    caseStudyId: c.caseStudyId,
    title: c.title,
    how: `${c.title} lands on ${c.executionApproach} × ${c.deliverySurface} for the same reason: ${c.why}`,
  }));
}

/**
 * The `advise`-facing entry point, and the function the Studio wizard UI is
 * contracted against (`docs/studio-ui-unification-20260913/mcp/COMPOSITION-CONTRACT.md`).
 */
export function classifyComposition(signals: Signals): CompositionRecommendation {
  const execution = classifyExecution(signals);
  const surface = classifySurface(signals);

  const missing = (
    [
      'expectedAudience',
      'recurringInteraction',
      'deterministicSteps',
      'uncertainSteps',
      'sharedDurableRecords',
      'sharedReviewInterface',
      'conversationalIntake',
      'existingSystemOfRecord',
      'humanDecisions',
      'outputTypes',
      'sideEffects',
      'deploymentNeeds',
    ] as const
  ).filter(key => signals[key] === undefined);

  const explanation =
    execution.value === null || surface.value === null
      ? `Not enough was said to recommend a composition. Missing: ${missing.join(', ')}. Answer those and ask again — a recommendation invented from silence is indistinguishable from a measured one once it reaches a screen.`
      : `Smallest sufficient composition: a ${execution.value.replace('-', ' ')} delivered as ${surface.value.replace('-', ' ')}` +
        (surface.entryPointKind ? `, entered through a ${surface.entryPointKind}` : ', with no human entry point') +
        `. ${execution.why[0]} ${surface.why[0]}` +
        (surface.escalateWhen ? ` Next rung up: ${surface.escalateWhen}` : '');

  return {
    schemaVersion: 1,
    executionApproach: execution,
    deliverySurface: surface,
    composition: compositionFor(execution.value, surface.value, surface.entryPointKind),
    explanation,
    influencedBy: influenced(execution.value, surface.value, signals.caseStudyIds),
    facts: {
      expectedAudience: signals.expectedAudience ?? null,
      recurringInteraction: signals.recurringInteraction ?? null,
      deterministicSteps: signals.deterministicSteps ?? [],
      uncertainSteps: signals.uncertainSteps ?? [],
      sources: signals.sources ?? [],
      permissions: signals.permissions ?? [],
      humanDecisions: signals.humanDecisions ?? [],
      outputTypes: signals.outputTypes ?? [],
      budgetBoundary: signals.budgetBoundary ?? null,
      timeBoundary: signals.timeBoundary ?? null,
      sideEffects: signals.sideEffects ?? [],
      deploymentNeeds: signals.deploymentNeeds ?? [],
    },
    missingSignals: missing,
    alternatives: [
      {
        executionApproach: 'bounded-workflow',
        deliverySurface: 'internal-automation',
        when: 'The steps are known and the result lands in a system people already use. The cheapest shape there is.',
      },
      {
        executionApproach: 'agentic-investigation',
        deliverySurface: 'conversational',
        when: 'A person asks an open question and the answer requires looking things up in an order nobody can fix in advance.',
      },
      {
        executionApproach: 'hybrid',
        deliverySurface: 'widget',
        when: 'A bounded pipeline produces rows a team reviews together, with an investigator filling the gaps the pipeline cannot.',
      },
      {
        executionApproach: 'hybrid',
        deliverySurface: 'solution',
        when: 'Several of the pieces are independently useful and the bundle needs explicit dependencies and one versioned delivery.',
      },
    ],
    revisable: true,
    evidenceLevel: 'LOCAL_CLASSIFICATION_ONLY',
    persistence: {
      persistedWithArtifact: false,
      blocker:
        'Classifying stores nothing: POST /v2/studio/compositions/classify computes and returns, it never writes. To keep the rationale with the artifact, send this recommendation as the nullable compositionRationale field on the artifact itself (WorkflowV2, Agent, ChatFlow, WidgetConfig, AppArtifact) when you create or update it; the per-kind GET returns it unchanged. An artifact without the field reads as unknown, never as a measured blank — so do not park the rationale in browser state and call it saved.',
    },
  };
}

// ---------------------------------------------------------------------------
// Case-study mapping
// ---------------------------------------------------------------------------

/**
 * Every catalogue case placed on the two axes, derived from the case's own
 * declared form and component roles rather than hand-copied, so the published
 * contract table cannot drift from this code.
 *
 * The derivation:
 *   deterministic  — the case includes a workflow component
 *   uncertain      — the case's form is `agentic`, or an agent's role reads as
 *                    adaptive. A fixed specialist review agent inside a known
 *                    stage does NOT make a design agentic.
 *   conversational — the case includes a chatflow
 *   widget         — the case includes a widget
 *   solution       — the case's form is `product` and at least two components
 *                    would be worth having on their own
 */
function deriveCaseComposition(c: (typeof catalog.cases)[number]) {
  const kinds = c.components.map(x => x.kind);
  const deterministic = kinds.includes('workflow');
  const uncertain = c.form === 'agentic' || c.components.some(x => x.kind === 'agent' && ADAPTIVE_ROLE.test(x.role));

  const executionApproach: ExecutionApproach =
    uncertain && deterministic ? 'hybrid' : uncertain ? 'agentic-investigation' : 'bounded-workflow';

  const entryPointKind = kinds.includes('widget')
    ? ('widget' as const)
    : kinds.includes('chatflow')
      ? ('chatflow' as const)
      : null;

  const independentlyUseful = c.components.filter(x =>
    ['workflow', 'agent', 'chatflow', 'widget', 'application'].includes(x.kind)
  ).length;

  const rung: DeliverySurface = entryPointKind === 'widget' ? 'widget' : entryPointKind === 'chatflow' ? 'conversational' : 'internal-automation';
  const deliverySurface: DeliverySurface =
    c.form === 'product' && independentlyUseful >= 2 ? 'solution' : rung;

  const why =
    (uncertain && deterministic
      ? 'a bounded spine carries the known stages while an investigator chooses its own next move inside them'
      : uncertain
        ? 'no stage order survives contact with the evidence'
        : 'every stage has a known trigger, order and stopping condition, with specialist judgement in explicit agent nodes') +
    ', delivered ' +
    (deliverySurface === 'solution'
      ? `as a bundle of ${independentlyUseful} independently useful artifacts entered through the ${entryPointKind}`
      : deliverySurface === 'widget'
        ? 'through a shared review surface several people act on together'
        : deliverySurface === 'conversational'
          ? 'through a conversation a person opens with a question'
          : 'with no human entry point — it runs on a trigger and writes into systems people already use');

  return {
    caseStudyId: c.id,
    title: c.title,
    declaredForm: c.form,
    executionApproach,
    deliverySurface,
    entryPointKind,
    independentlyUseful,
    componentKinds: [...new Set(kinds)].sort(),
    why,
    alternative: c.alternative,
  };
}

export const CASE_COMPOSITIONS = catalog.cases.map(deriveCaseComposition);

/** One case's placement, or undefined for an unknown id. */
export function compositionForCase(id: string) {
  return CASE_COMPOSITIONS.find(c => c.caseStudyId === id);
}
