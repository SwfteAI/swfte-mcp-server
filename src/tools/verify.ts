import { z } from 'zod';
import { IMPLEMENTED_KINDS, getAdapter, type Kind } from '../kinds/index.js';
import { requiredConnections } from '../connections.js';
import type { VerifyCheck } from '../kinds/_adapter.js';
import type { ToolDefinition } from './_types.js';

const KindArg = z.enum(IMPLEMENTED_KINDS as [Kind, ...Kind[]]);

/**
 * A workflow whose integration nodes have no stored credential publishes and
 * verifies clean, then fails at execution — the credential is only consulted
 * when the node runs. That is the most common way a built workflow turns out
 * not to work, and no other check here can see it, so verify folds it in rather
 * than leaving it to a tool the caller has to already know to call.
 *
 * Best-effort by design: a missing catalog reports a skip, not a failure. A
 * false "you are missing credentials" is worse than staying quiet.
 */
async function connectionCheck(
  client: Parameters<typeof requiredConnections>[0],
  kind: Kind,
  id: string
): Promise<{ check: VerifyCheck; nextActions: string[] }> {
  const skip = (detail: string) => ({
    check: { id: 'connections', ok: null, detail } as VerifyCheck,
    nextActions: [] as string[],
  });

  if (kind !== 'workflow') return skip('Only workflows carry integration-node credentials.');

  let required: Awaited<ReturnType<typeof requiredConnections>>;
  try {
    const workflow = await getAdapter('workflow').get!(client as never, id);
    required = await requiredConnections(client, workflow);
  } catch {
    return skip('Connection catalog unavailable — credentials not checked.');
  }

  if (required.length === 0) return skip('No node in this workflow needs a third-party credential.');

  const missing = required.filter((r) => !r.connected);
  if (missing.length === 0) {
    return {
      check: {
        id: 'connections',
        ok: true,
        detail: `Connected: ${required.map((r) => r.provider).join(', ')}.`,
      },
      nextActions: [],
    };
  }

  const named = missing
    .map((m) => `${m.provider} (${m.nodeIds.filter(Boolean).join(', ') || 'unknown node'})`)
    .join('; ');

  return {
    check: {
      id: 'connections',
      ok: false,
      detail: `Missing ${missing.length} OAuth connection(s): ${named}. These nodes will fail at execution.`,
    },
    nextActions: [
      `Call swfte_connect_start with provider "${missing[0]!.provider}" to open sign-in for the user` +
        (missing.length > 1
          ? `, then repeat for: ${missing.slice(1).map((m) => m.provider).join(', ')}.`
          : '.'),
    ],
  };
}

async function verifyArtifact(client: Parameters<typeof connectionCheck>[0], input: {
  kind: Kind; id: string; run?: boolean; inputs?: Record<string, unknown>;
  requirePublished?: boolean; timeoutMs?: number;
}) {
  const adapter = getAdapter(input.kind);
  const report = await adapter.verify(client, input.id, {
    run: input.run,
    inputs: input.inputs,
    requirePublished: input.requirePublished,
    timeoutMs: input.timeoutMs,
  });

  const connections = await connectionCheck(client, input.kind, input.id);
  const checks = [...report.checks, connections.check];
  // A missing credential is a real failure of "does this actually work?",
  // so it lowers ok rather than sitting in the report as a note nobody acts on.
  const ok = report.ok && connections.check.ok !== false;

  const failed = checks.filter((c) => c.ok === false);
  const skipped = checks.filter((c) => c.ok === null);

  return {
    ...report,
    ok,
    checks,
    nextActions: [...report.nextActions, ...connections.nextActions],
    summary: ok
      ? `${checks.length - skipped.length}/${checks.length - skipped.length} checks passed` +
        (skipped.length ? ` (${skipped.length} skipped)` : '')
      : `${failed.length} check(s) failed: ${failed.map((c) => c.id).join(', ')}`,
  };
}

export const verifyTools: ToolDefinition[] = [
  {
    name: 'swfte_verify',
    title: 'Cross-check an artifact',
    group: 'core',
    description:
      'Run a kind-appropriate assertion sweep over a persisted artifact and return a pass/fail ' +
      'report with per-check evidence and concrete next actions. This answers "does this actually ' +
      'work?", which is a different question from "did the API return 200?" — it catches unwired ' +
      'nodes, dangling edges, plaintext credentials, unpublished drafts, capability tiers that ' +
      'silently disable tool use, and nodes that report success while producing nothing. Call it ' +
      'after every build and after every refine. Pass run:true to also execute the artifact.',
    inputSchema: z.object({
      kind: KindArg,
      id: z.string(),
      run: z
        .boolean()
        .optional()
        .describe('Also execute the artifact as part of the sweep. Costs time and tokens; off by default.'),
      inputs: z.record(z.unknown()).optional().describe('Inputs for the execution check, when run:true.'),
      requirePublished: z
        .boolean()
        .optional()
        .describe(
          'Fail if the artifact is still a draft. Off by default — a freshly built artifact is ' +
          'legitimately unpublished. Turn on when checking something that should already be live.'
        ),
      timeoutMs: z.number().int().min(5_000).optional(),
    }),
    execute: async (input, { client }) => {
      return verifyArtifact(client, input);
    },
  },

  {
    name: 'swfte_verify_batch',
    title: 'Cross-check several artifacts',
    // A loop over swfte_verify, which stays advertised.
    // Redundant with a default tool (see 'extras' in src/config.ts); opt in with SWFTE_TOOLS=…,extras.
    group: 'extras',
    description:
      'Run swfte_verify over a list of artifacts and return one consolidated report. Use after a ' +
      'multi-artifact build session, or as a regression sweep over things you shipped earlier.',
    inputSchema: z.object({
      targets: z
        .array(z.object({ kind: KindArg, id: z.string() }))
        .min(1)
        .max(25),
      run: z.boolean().optional(),
      timeoutMs: z.number().int().min(5_000).optional(),
    }),
    execute: async (input, { client }) => {
      // Sequential on purpose: a parallel sweep with run:true would fire N
      // concurrent executions at a backend that already sheds load under
      // pressure, turning a verification pass into the thing that breaks.
      const reports = [];
      for (const target of input.targets) {
        try {
          reports.push(await verifyArtifact(client, { ...target, run: input.run, timeoutMs: input.timeoutMs }));
        } catch (err) {
          reports.push({
            ok: false,
            kind: target.kind,
            id: target.id,
            checks: [{ id: 'verify', ok: false, detail: err instanceof Error ? err.message : String(err) }],
            nextActions: [],
          });
        }
      }

      const failing = reports.filter((r) => !r.ok);
      return {
        ok: failing.length === 0,
        total: reports.length,
        passed: reports.length - failing.length,
        failed: failing.length,
        summary: failing.length === 0 ? 'All artifacts passed.' : `Failing: ${failing.map((r) => `${r.kind}/${r.id}`).join(', ')}`,
        reports,
      };
    },
  },
];
