import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { gate, preflight, type PreflightManifest } from '../preflight.js';
import { deriveFromLive, deriveFromSpec, seedsFromRegistry, type Seed } from '../preflight/derive.mjs';
import { withClientTransport } from '../preflight.js';
import type { SwfteClient } from '../client.js';
import type { ToolDefinition } from './_types.js';

/**
 * Preflight and the publish gate.
 *
 * `swfte_verify` asks whether one artifact is sound. `swfte_solution_verify`
 * asks whether a set of artifacts forms the solution it claims to be. Preflight
 * asks the third question, which neither can: whether this solution has walked
 * into one of the platform's known silent-failure modes — the twenty-eight ways
 * a Swfte artifact reports COMPLETED while doing nothing.
 *
 * Every rule has been shown to fail under a deliberate mutation
 * (`npm run preflight:mutation`). A rule with no mutation that kills it is
 * reported BROKEN there rather than counted as passing.
 */

const ComponentSchema = z.object({
  key: z.string(),
  kind: z.enum(['workflow', 'agent', 'chatflow', 'widget', 'dataset', 'module', 'application']),
  id: z.string().optional(),
});

const ManifestSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  workspaceId: z.union([z.string(), z.number()]).optional(),
  tablePrefix: z.string().optional().describe('Solution-wide table name prefix, so a stray minted table is visible.'),
  expectLive: z.boolean().optional(),
  components: z.array(ComponentSchema).min(1).max(120),
  dataTables: z.array(z.string()).optional().describe('Every table this solution may write. An undeclared name is a typo until proven otherwise.'),
  allowedIntegrations: z
    .array(z.string())
    .optional()
    .describe('ALLOW-list of third-party node types. Empty (the default) means every integration node is reported.'),
  allowedOutbound: z
    .array(z.string())
    .optional()
    .describe(
      'ALLOW-list of node types that may reach a person without a human in the loop. Empty (the default) ' +
        'reports every one. Deliberately an allow-list: the deny-list version of this check could not fail, ' +
        'because the hand-written forbid list omitted the platform\'s own EMAIL_SEND.'
    ),
  wires: z
    .array(z.object({ from: z.string(), to: z.string(), relation: z.string(), note: z.string().optional() }))
    .optional(),
  coverage: z.array(z.record(z.unknown())).optional().describe('Sets a component must carry, not merely exist.'),
  baseDir: z.string().optional(),
  sourceDirs: z.array(z.string()).optional().describe('Local build-script directories, for the rules whose subject is the operator.'),
  provenance: z.record(z.unknown()).optional(),
});

const ManifestInput = z.object({
  manifest: ManifestSchema.optional().describe('The manifest itself.'),
  manifestPath: z.string().optional().describe('Path to a manifest JSON file, as an alternative to inlining it.'),
});

/** Resolve manifest | manifestPath | derive-from-id into one manifest. */
async function resolveManifest(
  client: SwfteClient,
  input: { manifest?: unknown; manifestPath?: string },
  fallbackSeed?: Seed
): Promise<PreflightManifest> {
  if (input.manifest) return input.manifest as PreflightManifest;
  if (input.manifestPath) {
    const m = JSON.parse(readFileSync(input.manifestPath, 'utf8')) as PreflightManifest;
    // `sourceDirs` are relative to the manifest's own directory, the same as the CLI resolves them.
    if (!m.$dir) m.$dir = m.baseDir ?? input.manifestPath.replace(/\/[^/]+$/, '');
    return m;
  }
  if (fallbackSeed) return withTransport(client, () => deriveFromLive([fallbackSeed]));
  throw new Error('Pass manifest, manifestPath, or an id to derive from.');
}

/** Lend the vendored client this server's credential for the duration of one call. */
const withTransport = withClientTransport;

export const preflightTools: ToolDefinition[] = [
  // -------------------------------------------------------------------------
  {
    name: 'swfte_preflight',
    title: 'Check for the platform\'s silent-failure modes',
    group: 'core',
    readOnly: true,
    description:
      'Run 28 rules over a whole solution, each one a way a Swfte artifact reports success while doing ' +
      'nothing: a {{node.field}} reference to a code node that files that field under .result; rows ' +
      'handed in as an object so templates never resolve; a DATA_TABLE filter carrying {{…}} the ' +
      'executor never resolves; a templated table name that get-or-creates a brand-new empty table; an ' +
      'execution header that disagrees with its own traces; an output over the size guard that empties ' +
      'the variable pool downstream; a dataset reporting COMPLETED over zero segments; an AGENTIC agent ' +
      'whose only knowledge retrieves nothing, so it answers with an empty string. None of these fail a ' +
      'structural check and all of them ship. Strictly read-only — every call is a GET, one at a time. ' +
      'A rule that cannot run reports SKIP and the skip is returned; a skip is never a pass.',
    inputSchema: ManifestInput.extend({
      workflowId: z.string().optional().describe('Derive a manifest from this workflow when none is given.'),
      executionsPerWorkflow: z.number().int().min(0).max(10).optional().describe('How many recent runs to read per workflow. Default 3.'),
    }),
    execute: async (input, { client }) => {
      const manifest = await resolveManifest(
        client,
        input,
        input.workflowId ? (['workflow', input.workflowId] as Seed) : undefined
      );
      return preflight(client, manifest, { executionsPerWorkflow: input.executionsPerWorkflow });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'swfte_preflight_manifest',
    title: 'Derive a preflight manifest',
    group: 'core',
    readOnly: true,
    description:
      'Build the manifest preflight needs instead of hand-maintaining one. Give it the id registry your ' +
      'build wrote (statePath — every id in it is probed against the platform to learn what kind it is), ' +
      'a solution spec, or a few seed ids to walk out from. What it derives is FACT: the components, and ' +
      'the tables the graphs actually name. What it refuses to derive is INTENT — allowedOutbound, ' +
      'allowedIntegrations, coverage sets and wires are left empty, because deriving an authorisation ' +
      'from what is present authorises whatever is present and the check can then never fire. Every ' +
      'result carries a provenance block naming which rule branches the derivation leaves unexercised ' +
      'and what a human still has to write. Read it: an unexercised branch is not a passing one.',
    inputSchema: z.object({
      statePath: z.string().optional().describe('Path to the id registry (state.json). The most complete source: it sees components that are wired to nothing.'),
      specPath: z.string().optional().describe('Path to a solution spec. The only honest source for wires and coverage.'),
      seeds: z.array(z.string()).optional().describe('Seeds as "kind:id", e.g. "workflow:abc-123". Walked transitively.'),
      id: z.string().optional(),
      name: z.string().optional(),
      baseDir: z.string().optional(),
      sourceDirs: z.array(z.string()).optional(),
    }),
    execute: async (input, { client }) => {
      if (input.specPath) return deriveFromSpec(input.specPath);
      return withTransport(client, async () => {
        const seeds: Seed[] = (input.seeds ?? []).map((s: string) => {
          const [kind, ...rest] = s.split(':');
          return [kind ?? '', rest.join(':')] as Seed;
        });
        let unresolved: string[] = [];
        let source = 'live';
        if (input.statePath) {
          const r = await seedsFromRegistry(input.statePath);
          seeds.push(...r.seeds);
          unresolved = r.unresolved;
          source = `registry:${input.statePath}`;
        }
        if (!seeds.length) throw new Error('Pass statePath, specPath, or at least one seed.');
        return deriveFromLive(seeds, {
          id: input.id,
          name: input.name,
          source,
          registryUnresolved: unresolved,
          baseDir: input.baseDir,
          sourceDirs: input.sourceDirs,
        });
      });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: 'swfte_publish',
    title: 'Publish a workflow, gated on preflight',
    group: 'core',
    description:
      'Publish a workflow — POST /v2/workflows/{id}/publish — but only after preflight reports no ' +
      'blocking finding. Publishing is the promotion gate the backend already enforces structure at ' +
      '(dangling edges 400 there); this adds the semantic half, which is where the real damage lives: ' +
      'a graph can be perfectly sound and still resolve every template to the empty string. With no ' +
      'manifest given, one is derived from the workflow, so a solution that never wrote a manifest ' +
      'still gets checked. Three verdicts, not two: PASS publishes, BLOCKED refuses with the findings ' +
      'and their fixes, and INCONCLUSIVE — the check could not be produced, or a rule errored — also ' +
      'refuses, because a gate that reads "I could not check" as "it is fine" is worse than no gate. ' +
      'force:true publishes anyway and records the override verbatim in the result.',
    inputSchema: ManifestInput.extend({
      workflowId: z.string(),
      releaseNote: z.string().optional(),
      force: z.boolean().optional().describe('Publish despite a blocking or inconclusive verdict. The override is recorded.'),
      forceReason: z.string().optional().describe('Why the override is justified. Recorded verbatim.'),
      skipPreflight: z.boolean().optional().describe('Do not gate at all. Distinct from force: this produces no evidence, and the result says so.'),
    }),
    execute: async (input, { client }) => {
      const doPublish = async () =>
        client.request({
          method: 'POST',
          path: `/v2/workflows/${encodeURIComponent(input.workflowId)}/publish`,
          query: input.releaseNote ? { releaseNote: input.releaseNote } : undefined,
          // Publishing mints a version. A retried duplicate is a spurious
          // version row, so this one does not retry.
          retries: 0,
        });

      if (input.skipPreflight) {
        const published = await doPublish();
        return {
          published: true,
          gated: false,
          warning:
            'Published WITHOUT preflight. No evidence exists that this workflow does what it reports doing. ' +
            'Run swfte_preflight before relying on it.',
          result: published,
        };
      }

      const manifest = await resolveManifest(client, input, ['workflow', input.workflowId] as Seed);
      const verdict = await gate(client, manifest, { force: input.force, forceReason: input.forceReason });

      if (!verdict.allowed) {
        return {
          published: false,
          refused: true,
          verdict: verdict.verdict,
          reason: verdict.reason,
          blocking: verdict.blocking,
          nextActions: verdict.nextActions,
          skippedRules: verdict.report?.skipped ?? [],
          note:
            'Nothing was published. Fix the findings and call again, or pass force:true with forceReason ' +
            'if you have a reason this is acceptable.',
        };
      }

      const published = await doPublish();
      return {
        published: true,
        gated: true,
        verdict: verdict.verdict,
        reason: verdict.reason,
        ...(verdict.verdict !== 'PASS' ? { overridden: true, blocking: verdict.blocking } : {}),
        skippedRules: verdict.report?.skipped ?? [],
        provenance: verdict.report?.provenance ?? null,
        result: published,
      };
    },
  },
];
