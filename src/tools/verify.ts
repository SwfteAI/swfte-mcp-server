import { z } from 'zod';
import { IMPLEMENTED_KINDS, getAdapter, type Kind } from '../kinds/index.js';
import type { ToolDefinition } from './_types.js';

const KindArg = z.enum(IMPLEMENTED_KINDS as [Kind, ...Kind[]]);

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
      timeoutMs: z.number().int().min(5_000).optional(),
    }),
    execute: async (input, { client }) => {
      const adapter = getAdapter(input.kind);
      const report = await adapter.verify(client, input.id, {
        run: input.run,
        inputs: input.inputs,
        timeoutMs: input.timeoutMs,
      });

      const failed = report.checks.filter((c) => c.ok === false);
      const skipped = report.checks.filter((c) => c.ok === null);

      return {
        ...report,
        summary: report.ok
          ? `${report.checks.length - skipped.length}/${report.checks.length - skipped.length} checks passed` +
            (skipped.length ? ` (${skipped.length} skipped)` : '')
          : `${failed.length} check(s) failed: ${failed.map((c) => c.id).join(', ')}`,
      };
    },
  },

  {
    name: 'swfte_verify_batch',
    title: 'Cross-check several artifacts',
    group: 'core',
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
          const adapter = getAdapter(target.kind);
          reports.push(await adapter.verify(client, target.id, { run: input.run, timeoutMs: input.timeoutMs }));
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
