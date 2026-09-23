import { DesignContext, wizardContext } from '../guidance/index.js';
import { z } from 'zod';
import { orchestrateSolution, MAX_ORCHESTRATION_MS, type SolutionPlan } from '../orchestrator.js';
import { buildKnowledge, checkKnowledgeDocs } from '../knowledge.js';
import { checkGroundingIsUsable, moduleForDataset, writeWire, type SolutionKindLike } from '../wiring.js';
import { RELATIONS } from '../solution.js';
import type { ToolDefinition } from './_types.js';
import { IndexingTechniqueEnum } from '../contracts/backend-options.js';

/** Datasets are wire endpoints and knowledge sources, though no wizard builds one. */
const KindArg = z.enum([
  'workflow',
  'agent',
  'chatflow',
  'widget',
  'application',
  'module',
  'mcp-server',
  'model',
  'dataset',
]);

const CoverageSchema = z.object({
  id: z.string(),
  of: z.array(z.string()).min(1),
  in: z.string().describe('Where to look: fields[].id, tools[].name, $text, $effectivePrompt.'),
  match: z.enum(['exact', 'normalized', 'contains']).optional(),
  minRatio: z.number().min(0).max(1).optional(),
  label: z.string().optional(),
});

const KnowledgeSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  documents: z
    .array(
      z.object({
        name: z.string().describe('Display name. Must not contain path separators or "..".'),
        text: z.string().optional().describe('Inline content, uploaded as a file — the API only takes a fileId.'),
        path: z.string().optional().describe('Path to an existing file inside the project directory, instead of text. Local (stdio) server only; refused when hosted.'),
        mimeType: z.string().optional(),
      })
    )
    .min(1),
  indexingTechnique: IndexingTechniqueEnum.optional(),
  permission: z.string().optional(),
  probeQuery: z.string().optional().describe('Query used for the retrieval probe. Defaults to the description.'),
  waitMs: z.number().int().min(10_000).max(MAX_ORCHESTRATION_MS).optional(),
});

const ComponentSchema = z.object({
  key: z.string().describe('Stable name used by wiring.'),
  kind: KindArg,
  id: z.string().optional().describe('Adopt an artifact that already exists instead of building one.'),
  prompt: z.string().optional().describe('What to build. Required unless id is given.'),
  knowledge: KnowledgeSchema.optional().describe('For kind:"dataset" — documents to create and index.'),
  options: z.record(z.unknown()).optional().describe('Kind-specific extras merged into the wizard request.'),
  requires: z.array(z.enum(['knowledge', 'tools', 'downstream', 'brain'])).optional(),
  covers: z.array(CoverageSchema).optional(),
  entry: z.boolean().optional(),
  terminal: z.boolean().optional(),
});

const WireSchema = z.object({
  from: z.string(),
  to: z.string(),
  relation: z.string().describe(`Known relations: ${RELATIONS.join(', ')}.`),
  note: z.string().optional(),
  externalReason: z.string().optional().describe('Declare the wire un-checkable on purpose, recording why.'),
});

export const orchestrateTools: ToolDefinition[] = [
  // -------------------------------------------------------------------------
  {
    name: 'swfte_solution_build',
    title: 'Build a whole solution',
    group: 'core',
    description:
      'Compose multiple artifacts only where required; a single bounded workflow or investigator may be enough. Use swfte_solution_advise first, and supply plan.designContext for referenced wizard guidance. Build several artifacts as ONE solution: order them by dependency, give every component the same ' +
      'shared context, then write the cross-references into the fields the runtime actually reads and ' +
      'verify the whole thing before reporting success. This is the gap swfte_build leaves — it builds one ' +
      'artifact at a time and no artifact can reference a sibling that does not exist yet, so a solution ' +
      'driven wizard-by-wizard ends up as a set of components that each pass their own check and do not ' +
      'connect to each other. Wires are written through the effective field only (widget brain, chatflow ' +
      'bind-agent, agent knowledgeModuleIds) and each write is confirmed by re-reading the source: a 200 ' +
      'from an update is not evidence that the runtime will see it. Unresolved {{TODO}} stubs come back as ' +
      'required inputs and the run reports NEEDS_INPUT rather than READY. Pass dryRun to see the build ' +
      'order and which wires have a writer without creating anything.',
    inputSchema: z.object({
      plan: z.object({
        name: z.string(),
        designContext: DesignContext.optional(),
        workspaceId: z.string().optional(),
        sharedContext: z
          .string()
          .optional()
          .describe(
            'Facts every component must agree on — a scheme field set, a brand, a lawful basis. Injected ' +
              'verbatim into every build prompt. State a required set here AND as a covers[] assertion so ' +
              'the rule and the prompt read from one source.'
          ),
        components: z.array(ComponentSchema).min(1).max(40),
        wiring: z.array(WireSchema).max(200).optional(),
      }),
      dryRun: z.boolean().optional().describe('Plan and report without creating or writing anything.'),
      waitMs: z.number().int().min(30_000).max(MAX_ORCHESTRATION_MS).optional().describe('Per-component build budget, capped by the total budget. Default 600000.'),
      totalWaitMs: z.number().int().min(30_000).max(MAX_ORCHESTRATION_MS).optional().describe('Total operation budget across builds, wiring and verification. Default and maximum 600000.'),
      includeComponentVerify: z.boolean().optional().describe('Also run each component\'s own sweep in the review pass.'),
    }),
    execute: async (input, { client, localFilesystem }) => {
      // Refuse unsafe document names/paths before any component is built.
      for (const c of input.plan.components) if (c.knowledge) checkKnowledgeDocs(c.knowledge.documents, { localFilesystem });
      return orchestrateSolution(client, { ...input.plan, sharedContext: wizardContext(input.plan.sharedContext ?? '', input.plan.designContext) } as SolutionPlan, {
        dryRun: input.dryRun,
        waitMs: input.waitMs,
        totalWaitMs: input.totalWaitMs,
        includeComponentVerify: input.includeComponentVerify,
        localFilesystem,
      });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'swfte_solution_wire',
    title: 'Write one cross-artifact reference',
    group: 'core',
    description:
      'Make one wire real between two artifacts that already exist. Writes the target id into the field ' +
      'the runtime consults — brain{kind,id} for a widget, POST bind-agent for a chatflow, ' +
      'knowledgeModuleIds for an agent — and never into a field that merely accepts it: knowledgeSources, ' +
      'attach, binding and boundAgentId are refused, because writing them produces a record that reads as ' +
      'connected and behaves disconnected. The target is read before the write (a dangling id is the same ' +
      'defect as no id) and the source is re-read after it, so the result says connected only when the ' +
      'reference is genuinely resolvable. Where no field can carry the wire — a workflow writing to a ' +
      'dataset, an agent grounding on a raw dataset id — it reports needs-backend and names the change.',
    inputSchema: z.object({
      // The two endpoints are described separately rather than sharing one
      // object schema: an identical shape used twice is emitted as a $ref, and
      // not every MCP client resolves those.
      from: z.object({
        kind: KindArg.describe('Kind of the artifact that will HOLD the reference.'),
        id: z.string().describe('Id of the artifact that will hold the reference.'),
        key: z.string().optional().describe('Label for this end in the report.'),
      }),
      to: z.object({
        kind: KindArg.describe('Kind of the artifact being POINTED AT.'),
        id: z.string().describe('Id of the artifact being pointed at. Read before the write.'),
        key: z.string().optional().describe('Label for this end in the report.'),
      }),
      relation: z.string().describe(`Known relations: ${RELATIONS.join(', ')}.`),
      dryRun: z.boolean().optional().describe('Report what would be written without writing it.'),
    }),
    execute: async (input, { client }) =>
      writeWire(client, {
        from: { key: input.from.key ?? input.from.kind, kind: input.from.kind as SolutionKindLike, id: input.from.id },
        to: { key: input.to.key ?? input.to.kind, kind: input.to.kind as SolutionKindLike, id: input.to.id },
        relation: input.relation,
        dryRun: input.dryRun,
      }),
  },

  // -------------------------------------------------------------------------
  {
    name: 'swfte_knowledge_build',
    title: 'Create and index knowledge',
    group: 'core',
    description:
      'Turn documents into a dataset that can actually be retrieved from, in one call: create the dataset, ' +
      'upload each document, attach it, wait for indexing, and then PROVE it by running a retrieval probe. ' +
      'The proof matters because a document reports indexingStatus COMPLETED whether or not anything was ' +
      'indexed — on a live workspace both knowledge datasets report COMPLETED with totalSegments 0 and ' +
      'return zero candidates on search. This tool treats COMPLETED-with-zero-segments as a failure and ' +
      'reports the retrieval result rather than the status field, so knowledge that grounds nothing cannot ' +
      'be handed on as done. Note that grounding an agent needs a further hop: knowledgeModuleIds holds ' +
      'KnowledgeModule ids, not dataset ids.',
    inputSchema: KnowledgeSchema.extend({ workspaceId: z.string().optional() }),
    execute: async (input, { client, localFilesystem }) => buildKnowledge(client, input, undefined, { localFilesystem }),
  },

  // -------------------------------------------------------------------------
  {
    name: 'swfte_agent_ground',
    title: 'Ground an agent on a dataset',
    group: 'core',
    description:
      'Link an agent to knowledge so that it is actually retrieved. This is three steps, not one, and ' +
      'missing any of them is silent: a dataset id is wrapped in a KnowledgeModule (knowledgeModuleIds ' +
      'holds module ids — a dataset id there is dropped by the retrieval resolver without an error), the ' +
      'module id is merged into knowledgeModuleIds (never knowledgeSources, which nothing reads at ' +
      'inference), and the capability tier is checked, because below AGENTIC the tool loop returns an ' +
      'empty list before search_knowledge is ever registered and a correctly grounded agent retrieves ' +
      'nothing. Pass an existing moduleId to skip the wrapping step.',
    inputSchema: z.object({
      agentId: z.string(),
      datasetId: z.string().optional().describe('Dataset to ground on. A KnowledgeModule is minted over it.'),
      moduleId: z.string().optional().describe('An existing KnowledgeModule id, if you already have one.'),
      moduleName: z.string().optional().describe('Name for the minted module. Defaults to the dataset id.'),
      workspaceId: z.string().optional(),
    }),
    execute: async (input, { client }) => {
      if (!input.moduleId && !input.datasetId) {
        return { grounded: false, reason: 'NOTHING_TO_GROUND_ON', nextAction: 'Pass either datasetId or moduleId.' };
      }

      let moduleId = input.moduleId;
      let minted: unknown;
      if (!moduleId) {
        try {
          const res = await moduleForDataset(
            client,
            input.datasetId!,
            input.moduleName ?? `Knowledge over ${input.datasetId}`
          );
          moduleId = res.moduleId;
          minted = res.raw;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            grounded: false,
            reason: 'MODULE_CREATE_FAILED',
            detail: msg.slice(0, 300),
            nextAction:
              'A dataset cannot be grounded on directly — knowledgeModuleIds holds module ids. If this failed ' +
              'on a module cap, free a slot with swfte_modules_delete or report the agent as ungrounded. Do ' +
              'not fall back to writing the dataset id into knowledgeModuleIds: it resolves to a silent skip.',
          };
        }
      }

      const wire = await writeWire(client, {
        from: { key: 'agent', kind: 'agent', id: input.agentId },
        to: { key: 'knowledge', kind: 'module', id: moduleId! },
        relation: 'grounds',
      });

      const tier = await checkGroundingIsUsable(client, input.agentId);

      return {
        grounded: wire.ok && tier.ok,
        moduleId,
        minted: minted ? true : false,
        link: wire,
        capability: tier,
        nextActions: [wire.nextAction, tier.nextAction].filter(Boolean),
      };
    },
  },
];
