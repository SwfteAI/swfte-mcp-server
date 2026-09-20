import { z } from 'zod';
import { IMPLEMENTED_KINDS, type Kind } from '../kinds/index.js';
import { RELATIONS, verifySolution, type SolutionSpecInput } from '../solution.js';
import type { ToolDefinition } from './_types.js';

// Datasets are readable and are routinely the far end of a wire, but they are
// not something a wizard builds, so they live outside `KINDS` and are widened
// back in only here — where "can be a wire endpoint" is the relevant property.
const SOLUTION_KINDS = [...IMPLEMENTED_KINDS, 'dataset'] as Array<Kind | 'dataset'>;
const SolutionKindArg = z.enum(SOLUTION_KINDS as unknown as [Kind | 'dataset', ...Array<Kind | 'dataset'>]);

const CoverageSchema = z.object({
  id: z.string().describe('Stable name for the rule, so a failure reads as a rule rather than an anonymous list.'),
  of: z.array(z.string()).min(1).describe('The set the component must cover — e.g. the 19 mandatory scheme field ids.'),
  in: z
    .string()
    .describe(
      'Where to look, as a small path expression: "fields[].id", "nodes.*.configuration", "tools[].name", ' +
        'or "$text" for the whole serialised body.'
    ),
  match: z
    .enum(['exact', 'normalized', 'contains'])
    .optional()
    .describe(
      'normalized (default) ignores case and punctuation, so sum_insured_contents matches sumInsuredContents. ' +
        'exact is literal. contains looks for each token as a substring, for prose surfaces like a prompt.'
    ),
  minRatio: z.number().min(0).max(1).optional().describe('Fraction of "of" that must be present. Defaults to 1.'),
  label: z.string().optional(),
});

const ComponentSchema = z.object({
  key: z.string().describe('Stable name used by the wiring.'),
  kind: SolutionKindArg,
  id: z.string().optional(),
  live: z.object({ id: z.string().optional() }).nullish().describe('Accepted so an existing solution spec can be passed verbatim.'),
  title: z.string().optional(),
  requires: z
    .array(z.enum(['knowledge', 'tools', 'downstream', 'brain']))
    .optional()
    .describe('Grounding this component\'s role requires. An unmet requirement is a failure.'),
  covers: z.array(CoverageSchema).optional(),
  entry: z.boolean().optional().describe('Suppress the orphan check for a deliberate entry point.'),
  terminal: z.boolean().optional().describe('Suppress the orphan check for a deliberate leaf.'),
});

const WireSchema = z.object({
  from: z.string(),
  to: z.string(),
  relation: z
    .string()
    .describe(`What the link is. Known relations resolve without a selector: ${RELATIONS.join(', ')}.`),
  note: z.string().optional(),
  path: z.string().optional().describe('Override the relation\'s default lookup. Rarely needed.'),
  externalReason: z.string().optional().describe('Declare the wire un-checkable on purpose, recording why.'),
});

const SolutionSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  workspaceId: z.string().optional(),
  components: z.array(ComponentSchema).min(1).max(60),
  wiring: z.array(WireSchema).max(200).optional(),
});

export const solutionTools: ToolDefinition[] = [
  {
    name: 'swfte_solution_verify',
    title: 'Cross-check a whole solution',
    group: 'core',
    readOnly: true,
    description:
      'Verify that a set of artifacts actually forms the solution it is declared to be. This is the ' +
      'question swfte_verify structurally cannot answer: every component can pass its own sweep while ' +
      'the solution is broken, because the defect lives between artifacts, not inside one. A widget ' +
      'with no backing brain is a valid widget. A chatflow that hands off to nobody is a valid ' +
      'chatflow. An agent grounded on nothing is a valid agent. Pass the components and the wiring ' +
      'they are meant to form and this reports, per wire, whether the link resolves in live state — ' +
      'connected, broken (no reference anywhere), inert (the id is stored in a field the runtime ' +
      'never reads), or placeholder (the config that would carry it is still a generated stub). It ' +
      'also measures coverage assertions: declare that a component must cover a field set and get it ' +
      'measured, so "the chatflow exists" can never again stand in for "the chatflow covers the ' +
      'scheme". Strictly read-only — every call it makes is a GET. Run it before any deploy that ' +
      'ships more than one artifact.',
    inputSchema: z.object({
      solution: SolutionSchema,
      includeComponentVerify: z
        .boolean()
        .optional()
        .describe('Also run each component\'s own kind sweep and report it alongside, for contrast. Slower.'),
      strict: z.boolean().optional().describe('Treat wires declared external or judged unknown as failures too.'),
    }),
    execute: async (input, { client }) =>
      verifySolution(client, input.solution as SolutionSpecInput, {
        includeComponentVerify: input.includeComponentVerify,
        strict: input.strict,
      }),
  },
];
