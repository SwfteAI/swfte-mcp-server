import { z } from 'zod';
import { adapterCapabilities, advise, DecisionFacts } from '../guidance/index.js';
import {
  CASE_COMPOSITIONS,
  CompositionSignals,
  classifyComposition,
  DELIVERY_SURFACES,
  EXECUTION_APPROACHES,
} from '../guidance/composition.js';
import { IMPLEMENTED_KINDS, type Kind } from '../kinds/index.js';
import type { ToolDefinition, ToolContext } from './_types.js';

const available = (tools: ToolDefinition[], ctx: ToolContext) => tools.filter(t => !t.group || !ctx.config.enabledGroups.size || ctx.config.enabledGroups.has(t.group));
export function guidanceTools(registry: () => ToolDefinition[]): ToolDefinition[] {
  return [
    {
      name: 'swfte_solution_advise', title: 'Choose product, workflow or agentic design', readOnly: true,
      description: 'Choose an architectural form from explicit requirements before building. Returns justified product/workflow/agentic recommendation, missing design facts, illustrative cases with references, composition and acceptance stages. This is local decision guidance; it does not claim live capabilities or deploy artifacts. Product is not an artifact kind. Use swfte_capabilities for supported verbs and topology paths; pass chosen case IDs as designContext to swfte_build or swfte_solution_build.',
      inputSchema: z.object({ facts: DecisionFacts, caseStudyIds: z.array(z.string()).max(5).optional() }),
      execute: async (input, ctx) => ({ ...advise(input.facts, input.caseStudyIds), tools: available(registry(), ctx).filter(t => ['swfte_capabilities', 'swfte_build', 'swfte_solution_build', 'swfte_solution_verify', 'swfte_run'].includes(t.name)).map(t => t.name) }),
    },
    {
      name: 'swfte_composition_classify', title: 'Classify execution approach and delivery surface', readOnly: true,
      description:
        'Place a request on two INDEPENDENT axes before building: execution approach (' + EXECUTION_APPROACHES.join(' | ') + ') and delivery surface (' + DELIVERY_SURFACES.join(' | ') + '). ' +
        'Returns the smallest sufficient composition on each axis, why, what would justify the next rung up, the case study that lands the same way, and the facts the recommendation rests on. ' +
        'Unanswered questions come back as missingSignals with value:null and confidence UNDETERMINED — this tool does not guess, because a guessed recommendation is indistinguishable from a measured one once it reaches a screen. ' +
        '"Agentic" is not a synonym for "product": a bounded workflow can be delivered as a widget and an agentic investigation can be pure internal automation. ' +
        'Local decision guidance only: it observes no workspace, entitlement or runtime, and the rationale is NOT persisted with the artifact — no agents-service wizard endpoint accepts this shape yet. ' +
        'Prefer this over swfte_solution_advise, which collapses both axes into one word.',
      inputSchema: z.object({ signals: CompositionSignals }),
      execute: async (input, ctx) => ({
        ...classifyComposition(input.signals),
        caseIndex: CASE_COMPOSITIONS.map(c => ({ id: c.caseStudyId, title: c.title, executionApproach: c.executionApproach, deliverySurface: c.deliverySurface, entryPointKind: c.entryPointKind })),
        nextTools: available(registry(), ctx).filter(t => ['swfte_capabilities', 'swfte_build', 'swfte_solution_build'].includes(t.name)).map(t => t.name),
      }),
    },
    {
      name: 'swfte_capabilities', title: 'Discover implemented paths and verification requirements', readOnly: true,
      description: 'Discover the actual adapter verb matrix, currently advertised tool groups, build/deployment options, wiring limits and evidence needed to claim readiness. Reports implementation support, not backend availability or tenant entitlement. Read-only and local; does not provision, publish, run or fetch business data. Use before choosing kinds, calling unsupported lifecycle verbs, or assuming shared/dedicated means a verified isolated deployment.',
      inputSchema: z.object({ kind: z.enum(IMPLEMENTED_KINDS as [Kind, ...Kind[]]).optional(), includeToolDescriptions: z.boolean().optional() }),
      execute: async (input, ctx) => ({
        evidenceLevel: 'LOCAL_IMPLEMENTATION_ONLY',
        deploymentEnabled: ctx.config.allowDeploy,
        adapters: adapterCapabilities(input.kind),
        tools: available(registry(), ctx).map(t => ({ name: t.name, group: t.group ?? 'always', readOnly: Boolean(t.readOnly), ...(input.includeToolDescriptions ? { description: t.description } : {}) })),
        buildOptions: {
          widget: { attach: { kind: 'agent or workflow or chatflow', id: 'existing artifact ID' }, note: 'Exactly one brain; verify persisted brain and run the entry point.' },
          chatflow: { constraints: 'wizard constraints object', note: 'Build may persist immediately. Verify exact fields, activation and bound agent.' },
          workflow: { note: 'Explicit AGENT nodes need configuration.agentId; code must normalize actual trigger payload. Declare missing integration inputs.' },
          module: { note: 'Module creation/compilation does not generate source documents. Use swfte_knowledge_build with real documents and a successful retrieval probe.' },
          common: { designContext: { form: 'product | workflow | agentic', caseStudyIds: ['IDs from swfte_solution_advise'] }, note: 'Other options are adapter/backend-specific; presence in an options object does not prove runtime support.' },
        },
        wiring: [
          { from: 'widget', to: 'agent/workflow/chatflow', effective: 'brain{kind,id}', check: 'One brain; read back and exercise a real conversation or workflow input.' },
          { from: 'chatflow', to: 'agent', effective: 'bind-agent operation', check: 'Read back then complete intake and observe the intended agent execution.' },
          { from: 'workflow', to: 'agent', effective: 'AGENT node configuration.agentId', check: 'Inspect completed node trace, actual agent identity and non-mock output. Generic wire writer does not rewrite graph nodes.' },
          { from: 'agent', to: 'module', effective: 'knowledgeModuleIds', check: 'Read back attachment, retrieve known document text, then verify grounded answer.' },
          { from: 'agent', to: 'agent', effective: 'Runtime-dependent delegation capability', check: 'Stored linkedAgents alone is insufficient. Require actual downstream invocation traces; use explicit workflow nodes for fixed specialist reviews.' },
        ],
        readinessEvidence: [
          'Artifact schema and exact behavior coverage, effective references, configured connections and retrieval',
          'Positive and negative runtime traces, including non-mock execution and cross-run conversation isolation',
          'Enabled entry point and live UI interaction, durable state readback and authorization boundary',
          'Deployment phase plus actual target/profile/endpoint and execution associated with the requested shared or dedicated deployment',
          'Correlated execution ID/time window in analytics, tokens/latency/error telemetry, and rendered UI; empty analytics is not healthy evidence',
        ],
        recovery: [
          { condition: 'Wizard timeout or expired session', action: 'Poll returned session; inspect artifact list and IDs before retrying creation.' },
          { condition: 'HTTP 403/405 or unexpected HTML', action: 'Record endpoint/status and verify permission plus supported method. Do not infer body-size cause or repeat mutations blindly.' },
          { condition: 'Stored reference with no invocation', action: 'Check runtime-consumed field and traces; a successful write or structural check does not establish execution.' },
          { condition: 'Publish preflight expects already published artifact', action: 'Use an accurate pre-publication manifest (expectLive:false), retain relevant checks, then separately verify the published run.' },
          { condition: 'Workflow PAUSED at HUMAN_INPUT', action: 'Return the existing execution ID and required review inputs. Paused is an observable wait, not a completed business result or failure; do not auto-approve or restart it.' },
          { condition: 'Widget deployment reports LIVE', action: 'Verify active:true and the current deployment pointer, then test public config, allowed browser origin and actual brain invocation. A LIVE record alone is insufficient.' },
          { condition: 'Provisioning accepted or timed out', action: 'Poll deployment record/trail; do not retry provisioning while status is uncertain. READY still requires an endpoint execution.' },
        ],
      }),
    },
  ];
}
