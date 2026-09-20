import { z } from 'zod';
import { ADAPTERS, type Kind } from '../kinds/index.js';
import catalog from './case-studies.json';
import { classifyComposition, type Signals } from './composition.js';

export * from './composition.js';

export const Form = z.enum(['product', 'workflow', 'agentic']);
export const DesignContext = z.object({
  form: Form.optional().describe('Architectural form; this is not an artifact kind or a deployment topology.'),
  caseStudyIds: z.array(z.string()).max(5).optional().describe('Illustrative case IDs returned by swfte_solution_advise. Unknown IDs are rejected before generating.'),
});
export const DecisionFacts = z.object({
  sharedState: z.boolean().optional().describe('Multiple people must maintain durable queues, decisions or history.'),
  sharedReviewUI: z.boolean().optional().describe('A dedicated shared review interface is required beyond existing systems.'),
  adaptiveInvestigation: z.boolean().optional().describe('Evidence determines which tool or investigation step happens next.'),
  boundedSteps: z.boolean().optional().describe('The trigger, stages, termination and outputs can be defined in advance.'),
  existingSystemOfRecord: z.boolean().optional().describe('An existing ticketing, repository or business system already owns persistent state and review.'),
});
export type Design = z.infer<typeof DesignContext>;
export type Facts = z.infer<typeof DecisionFacts>;

export function selectedCases(ids?: string[]) {
  if (!ids?.length) return [];
  const unknown = ids.filter(id => !catalog.cases.some(c => c.id === id));
  if (unknown.length) throw new Error(`UNKNOWN_CASE_STUDY: ${unknown.join(', ')}. Call swfte_solution_advise to list current case IDs; no build was started.`);
  return catalog.cases.filter(c => ids.includes(c.id));
}

export function advise(facts: Facts, ids?: string[]) {
  const requested = selectedCases(ids);
  const reasons: string[] = [];
  let form: z.infer<typeof Form> | null = null;
  if (facts.sharedState === true && facts.sharedReviewUI === true && facts.existingSystemOfRecord !== true) {
    form = 'product';
    reasons.push('Durable shared decisions and a dedicated review interface justify a product surface and storage contract.');
  } else if (facts.adaptiveInvestigation === true) {
    form = 'agentic';
    reasons.push('Evidence selects the next investigation step; an agent needs bounded tool access, stopping conditions and escalation.');
  } else if (facts.boundedSteps === true && facts.adaptiveInvestigation === false) {
    form = 'workflow';
    reasons.push('Known stages and termination fit an explicit workflow, with specialized agent nodes where needed.');
  }
  if (facts.existingSystemOfRecord) reasons.push('Reuse the existing system of record and review controls; add a product only for a demonstrated interface gap.');
  const missingFacts = Object.keys(DecisionFacts.shape).filter(key => facts[key as keyof Facts] === undefined);
  const examples = requested.length ? requested : catalog.cases.filter(c => !form || c.form === form).slice(0, 5);
  const referenceIds = new Set(examples.flatMap(c => c.referenceIds));
  return {
    recommendation: form,
    status: form === null ? 'NEEDS_DESIGN_FACTS' : missingFacts.length ? 'PROVISIONAL' : 'RECOMMENDED',
    reasons,
    missingFacts,
    alternatives: [
      { form: 'product', when: 'Persistent shared state and review UI are requirements; a chat bubble alone does not implement them.' },
      { form: 'workflow', when: 'Stages, inputs, outputs and stop conditions are known; use explicit AGENT nodes for specialist steps.' },
      { form: 'agentic', when: 'Next actions depend on evidence; configure actual tools, budgets, isolation and human escalation.' },
    ],
    caseIndex: catalog.cases.map(c => ({ id: c.id, title: c.title, form: c.form })),
    composition: form === null ? [] : form === 'product' ? ['application or implemented dashboard', 'durable authorized storage', 'workflow and/or agents', 'optional widget/chatflow entry'] : form === 'workflow' ? ['workflow', 'optional specialized AGENT nodes', 'existing review system'] : ['agent', 'configured tools', 'optional bounded worker workflow', 'existing case system'],
    examples,
    references: catalog.references.filter(r => referenceIds.has(r.id)),
    examplesAre: 'Illustrative designs, not customer success stories or deployed capability evidence.',
    // The single-word form above is kept for callers that already depend on it,
    // but it collapses two independent choices into one and so reads "agentic"
    // as "product". The two-axis answer is the one the wizard UI renders.
    compositionAxes: classifyComposition({
      deterministicSteps: facts.boundedSteps === true ? ['caller reported that the trigger, stages and stopping condition can be named in advance'] : facts.boundedSteps === false ? [] : undefined,
      uncertainSteps: facts.adaptiveInvestigation === true ? ['caller reported that evidence selects the next step'] : facts.adaptiveInvestigation === false ? [] : undefined,
      sharedDurableRecords: facts.sharedState,
      sharedReviewInterface: facts.sharedReviewUI,
      existingSystemOfRecord: facts.existingSystemOfRecord,
    } as Signals),
    compositionAxesNote: 'swfte_composition_classify asks the full question set; these axes are derived from the five legacy decision facts only, so their confidence is correspondingly low.',
    lifecycle: ['Discover capabilities and connections', 'Generate with case references and explicit acceptance criteria', 'Validate and persist', 'Read back effective bindings', 'Execute positive and negative cases', 'Publish/activate appropriate artifacts', 'Preview capacity where supported', 'Deploy and read actual topology', 'Probe endpoint and correlate execution, analytics and UI evidence'],
  };
}

export function wizardContext(prompt: string, design?: Design): string {
  const examples = selectedCases(design?.caseStudyIds);
  const referenceIds = new Set(examples.flatMap(c => c.referenceIds));
  return `${prompt}\n\n[Studio design guidance]\n${JSON.stringify({
    form: design?.form ?? 'Determine product, bounded workflow or agentic system from requirements; do not assume every request needs a product.',
    rules: [
      'Product requires implemented persistent shared state and review controls. A conversational widget is only an entry point.',
      'Use bounded workflows for known stages and typed AGENT nodes for fixed specialist reviews. A stored linked-agent ID does not prove invocation.',
      'Use agentic investigation when evidence selects next steps. Prompts do not implement tools, isolated workers or permissions.',
      'Attach knowledge only after actual document indexing and a positive retrieval probe. Empty modules are not grounding.',
      'Separate saved, linked, executed, enabled, published and deployed evidence. Deployment topology must be read from runtime records.',
      'Missing required connections, storage, credentials or controls must be explicit NEEDS_CONFIGURATION; never substitute fixture evidence for business integration.',
      'Test missing inputs, failed tools, retries, rejected approval, conversation isolation and actual UI behavior as applicable.',
    ],
    examples,
    references: catalog.references.filter(r => referenceIds.has(r.id)),
    examplesAre: 'Illustrative patterns only; references guide design and do not guarantee platform support.',
  })}`;
}

const VERBS = ['build', 'status', 'steer', 'validate', 'create', 'refine', 'get', 'list', 'run', 'verify', 'deployPreview', 'deploy', 'teardown'] as const;
export function adapterCapabilities(kind?: Kind) {
  return Object.entries(ADAPTERS).filter(([key]) => !kind || key === kind).map(([key, adapter]) => ({
    kind: key,
    verbs: VERBS.filter(verb => typeof adapter?.[verb] === 'function'),
    notes: adapter?.notes ?? null,
    deployment: key === 'workflow' ? {
      path: 'swfte_deploy', capacityIntents: ['shared', 'dedicated', 'BYO'],
      options: ['option', 'provider', 'region', 'cloudConnectionId', 'providerConfigName', 'sizing', 'lifecycle', 'idleTimeoutSec', 'path', 'timeoutMs'],
      limitation: 'gpuTier is a legacy alias mapped to sizing.gpuTier; secretId is rejected. Preview is the unified router estimate and does not consume capacity intent. An explicit option uses the managed route. Read deployment target/profile and execute through that deployment to prove topology.',
    } : key === 'application' ? {
      path: 'swfte_deploy', capacityIntents: ['dedicated'], options: ['option', 'timeoutMs'],
      limitation: 'dedicated maps to hosting tier SERVER. Other capacity values use backend default; no sizing preview. Read hosting record and probe the resulting URL.',
    } : key === 'widget' ? {
      path: 'swfte_deploy', capacityIntents: [], options: [], limitation: 'Confirmed deploy enables active:true, reads it back, snapshots a LIVE deployment, and checks its pointer/public config. It does not provision dedicated capacity or prove browser access, allowed-origin behavior or brain execution.',
    } : key === 'model' ? {
      path: 'swfte_deploy', capacityIntents: [], options: ['gpuTier', 'region', 'timeoutMs'], limitation: 'Model vault deployment. Shared/dedicated option is not forwarded by this adapter.',
    } : key === 'mcp-server' ? {
      path: 'swfte_deploy', capacityIntents: [], options: [], limitation: 'Registers the saved server definition; capacity options are not forwarded. Verify actual server connectivity.',
    } : { path: null, capacityIntents: [], options: [], limitation: 'No deploy verb in this adapter. Verify enabled state and access via the supported artifact runtime; do not fabricate a deployment.' },
  }));
}
