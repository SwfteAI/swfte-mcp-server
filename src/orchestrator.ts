/**
 * Driving several wizards into one coherent solution.
 *
 * Every per-kind wizard works. Twelve of them were driven separately on
 * workspace 271 and nine of the ten verifiable components passed their own
 * sweep — while sixteen solution-level assertions failed. Nothing was wrong
 * with any wizard. What was missing was the layer above them: something that
 * knows a widget cannot bind to a chatflow that does not exist yet, that the
 * same nineteen mandatory fields have to reach three different components, and
 * that a reference has to be written into the field the runtime reads.
 *
 * This is that layer. It orchestrates; it does not generate. Every artifact is
 * still produced by its own wizard through the existing adapters.
 *
 *   1  ORDER   — topological sort over the wiring graph
 *   2  BUILD   — per-kind wizard, in order, shared context in every prompt
 *   3  WIRE    — effective fields only, each write post-verified
 *   4  INPUTS  — unresolved {{TODO}} stubs collected as required inputs
 *   5  REVIEW  — solution-level verification against live state
 *
 * The terminal verdict is the solution's, never the components'. A run whose
 * every component built cleanly and whose wires do not resolve is a failure,
 * and reporting it as one is the entire point.
 */

import { OperationDeadlineError, type SwfteClient } from './client.js';

export const MAX_ORCHESTRATION_MS = 600_000;
import { getAdapter, type BuildSnapshot, type Kind, type KindAdapter } from './kinds/index.js';
import {
  findPlaceholders,
  verifySolution,
  type CoverageAssertion,
  type Requirement,
  type SolutionKind,
  type SolutionVerifyReport,
} from './solution.js';
import { buildKnowledge, type BuildKnowledgeInput, type BuildKnowledgeReport } from './knowledge.js';
import { writeWire, type WriteResult } from './wiring.js';

/* ------------------------------------------------------------------ *
 * Plan
 *
 * Deliberately the same shape swfte_solution_verify already consumes, so the
 * thing that gets built and the thing that gets checked are one document. A
 * plan that drifts from its own spec is how "the chatflow exists" came to
 * stand in for "the chatflow covers the scheme".
 * ------------------------------------------------------------------ */

export interface PlanComponent {
  key: string;
  kind: SolutionKind;
  /** Adopt an artifact that already exists instead of building one. */
  id?: string;
  /** What to build. Required unless `id` is given. */
  prompt?: string;
  /** For kind: 'dataset' — documents to create and index. */
  knowledge?: Omit<BuildKnowledgeInput, 'workspaceId'>;
  /** Extra body merged into the wizard request (e.g. widget attach). */
  options?: Record<string, unknown>;
  requires?: Requirement[];
  covers?: CoverageAssertion[];
  entry?: boolean;
  terminal?: boolean;
}

export interface PlanWire {
  from: string;
  to: string;
  relation: string;
  note?: string;
  externalReason?: string;
}

export interface SolutionPlan {
  name: string;
  workspaceId?: string;
  /**
   * Facts every component must agree on. Injected verbatim into every build
   * prompt, so a set stated once reaches the widget, the chatflow and the
   * agent identically. This is the fix for a form asking nineteen questions
   * while the chatflow asks four.
   */
  sharedContext?: string;
  components: PlanComponent[];
  wiring?: PlanWire[];
}

export interface OrchestrateOpts {
  /** Plan and report without creating or writing anything. */
  dryRun?: boolean;
  /** Per-component build budget. */
  waitMs?: number;
  /** One total budget including all components, wiring and verification. */
  totalWaitMs?: number;
  /** Also run each component's own kind sweep in the review pass. */
  includeComponentVerify?: boolean;
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

export interface ComponentOutcome {
  key: string;
  kind: SolutionKind;
  id?: string;
  state: 'adopted' | 'built' | 'planned' | 'failed' | 'skipped' | 'pending';
  sessionId?: string;
  detail: string;
  knowledge?: BuildKnowledgeReport;
}

export interface RequiredInput {
  component: string;
  path: string;
  label: string;
  value: string;
}

export interface OrchestrateReport {
  ok: boolean;
  status: 'READY' | 'NEEDS_INPUT' | 'BROKEN' | 'PLANNED' | 'PARTIAL';
  solution: string;
  order: string[];
  components: ComponentOutcome[];
  wires: WriteResult[];
  /** Unresolved generated configuration. Never shipped, always surfaced. */
  requiredInputs: RequiredInput[];
  verification?: SolutionVerifyReport;
  nextActions: string[];
  summary: string;
}

/* ------------------------------------------------------------------ *
 * 1 — Ordering
 * ------------------------------------------------------------------ */

/**
 * Relations where the source cannot be created until the target exists.
 *
 * `reads`, `writes` and `exports-to` are not here: a workflow can be built
 * before the thing it will read, because the reference lives in node config
 * that we cannot rewrite anyway.
 */
const BLOCKING_RELATIONS = new Set(['binds', 'grounds', 'hands-off-to', 'invokes']);

export function orderComponents(plan: SolutionPlan): { order: string[]; cycle?: string[] } {
  const keys = plan.components.map((c) => c.key);
  const known = new Set(keys);

  // `from` depends on `to`: you cannot bind a widget to a chatflow that is not
  // there yet. So the edge points from dependent to dependency.
  const deps = new Map<string, Set<string>>(keys.map((k) => [k, new Set<string>()]));
  for (const w of plan.wiring ?? []) {
    if (!BLOCKING_RELATIONS.has(w.relation)) continue;
    if (!known.has(w.from) || !known.has(w.to) || w.from === w.to) continue;
    deps.get(w.from)!.add(w.to);
  }

  const order: string[] = [];
  const done = new Set<string>();
  let progressed = true;
  while (order.length < keys.length && progressed) {
    progressed = false;
    for (const k of keys) {
      if (done.has(k)) continue;
      const pending = [...deps.get(k)!].filter((d) => !done.has(d));
      if (pending.length === 0) {
        order.push(k);
        done.add(k);
        progressed = true;
      }
    }
  }

  if (order.length < keys.length) {
    // A cycle is a planning error. Failing here beats producing a half-wired
    // build and calling the leftovers "known issues".
    return { order, cycle: keys.filter((k) => !done.has(k)) };
  }
  return { order };
}

/* ------------------------------------------------------------------ *
 * 2 — Build
 * ------------------------------------------------------------------ */

/** Shared context first, so it frames the request rather than trailing it. */
function composePrompt(plan: SolutionPlan, component: PlanComponent): string {
  const parts: string[] = [];
  if (plan.sharedContext?.trim()) {
    parts.push(
      'SHARED SOLUTION CONTEXT — every component of this solution must agree with the following. ' +
        'Do not paraphrase, reduce or reorder any set given here.\n' +
        plan.sharedContext.trim()
    );
  }
  parts.push(component.prompt ?? '');
  return parts.filter(Boolean).join('\n\n---\n\n');
}

async function pollBuild(
  client: SwfteClient,
  adapter: KindAdapter,
  sessionId: string,
  waitMs: number
): Promise<BuildSnapshot> {
  const status = adapter.status;
  if (!status) throw new Error(`${adapter.kind} has no build status to poll.`);
  const { snapshot, timedOut } = await client.pollUntil<BuildSnapshot>(
    () => status.call(adapter, client, sessionId),
    (s) => s.done,
    { timeoutMs: waitMs, intervalMs: 2_000 }
  );
  if (timedOut) {
    throw new OperationDeadlineError();
  }
  if (snapshot.error) throw new Error(String(snapshot.error).slice(0, 300));
  return snapshot;
}

async function buildComponent(
  client: SwfteClient,
  plan: SolutionPlan,
  component: PlanComponent,
  waitMs: number
): Promise<ComponentOutcome> {
  let sessionId: string | undefined;
  let id: string | undefined;
  try {
    client.assertDeadline();
    if (component.kind === 'dataset') {
      if (!component.knowledge) {
        return {
          key: component.key,
          kind: component.kind,
          state: 'failed',
          detail: 'A dataset component needs a `knowledge` block (documents to create and index).',
        };
      }
      const report = await buildKnowledge(client, { ...component.knowledge, waitMs: Math.min(component.knowledge.waitMs ?? waitMs, waitMs), workspaceId: plan.workspaceId }, (createdId) => { id = createdId; });
      return {
        key: component.key,
        kind: component.kind,
        id: report.datasetId,
        // A dataset that indexed nothing is not a built component. Saying
        // otherwise is how knowledge came to be "attached but dead".
        state: report.ok ? 'built' : 'failed',
        detail: report.summary,
        knowledge: report,
      };
    }

    const adapter = getAdapter(component.kind as Kind);
    if (typeof adapter.build !== 'function') {
      return {
        key: component.key,
        kind: component.kind,
        state: 'failed',
        detail: `${component.kind} has no generator on this server — supply an existing id instead.`,
      };
    }

    ({ sessionId } = await adapter.build(client, {
      prompt: composePrompt(plan, component),
      options: component.options,
    }));
    const snapshot = await pollBuild(client, adapter, sessionId, Math.min(waitMs, Math.max(0, client.remainingMs())));

    // Some kinds persist during generation (chatflow, widget); the rest need a
    // separate create. The adapter knows which, so this does not.
    id = adapter.extractId?.(snapshot);
    if (!id && typeof adapter.create === 'function') {
      const artifact = adapter.extractArtifact?.(snapshot);
      if (!artifact) {
        return {
          key: component.key,
          kind: component.kind,
          state: 'failed',
          detail: 'Build finished but produced no artifact to persist.',
        };
      }
      client.assertDeadline();
      const created = await adapter.create(client, artifact);
      id = created.id;
    }

    if (!id) {
      return {
        key: component.key,
        kind: component.kind,
        state: 'failed',
        detail:
          component.kind === 'application'
            ? 'The application blueprint wizard persists nothing — it returns a blueprint for a human to ' +
              'materialise. Supply an existing application id instead.'
            : 'Build finished but no id could be recovered.',
      };
    }

    return { key: component.key, kind: component.kind, id, sessionId, state: 'built', detail: `${component.kind} ${id}` };
  } catch (error) {
    if (!(error instanceof OperationDeadlineError) && client.remainingMs() > 0) {
      return { key: component.key, kind: component.kind, id, sessionId, state: 'failed',
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    }
    return { key: component.key, kind: component.kind, id, sessionId, state: 'pending',
      detail: 'Time budget ended. Generation or persistence may still have committed. Inspect this session and any artifact ID; do not restart generation or repeat create blindly.' };
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export async function orchestrateSolution(
  client: SwfteClient,
  plan: SolutionPlan,
  opts: OrchestrateOpts = {},
  services: { verify?: typeof verifySolution; wire?: typeof writeWire } = {}
): Promise<OrchestrateReport> {
  for (const value of [opts.waitMs, opts.totalWaitMs]) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0 || value > MAX_ORCHESTRATION_MS)) {
      throw new Error(`Build budgets must be positive integer milliseconds, at most ${MAX_ORCHESTRATION_MS}.`);
    }
  }
  return client.withDeadline(Date.now() + (opts.totalWaitMs ?? MAX_ORCHESTRATION_MS), async () => {
    const waitMs = opts.waitMs ?? MAX_ORCHESTRATION_MS;
    const nextActions: string[] = [];
    const byKey = new Map(plan.components.map((c) => [c.key, c]));

    // --- 1  Order --------------------------------------------------------
    const { order, cycle } = orderComponents(plan);
    if (cycle?.length) {
      return {
        ok: false,
        status: 'BROKEN',
        solution: plan.name,
        order,
        components: [],
        wires: [],
        requiredInputs: [],
        nextActions: [`Break the dependency cycle among: ${cycle.join(', ')}.`],
        summary: `Cannot order the solution: ${cycle.join(' → ')} form a cycle. Nothing was built.`,
      };
    }

    if (opts.dryRun) {
      const planned: ComponentOutcome[] = order.map((k) => {
        const c = byKey.get(k)!;
        return {
          key: k,
          kind: c.kind,
          id: c.id,
          state: c.id ? 'adopted' : 'planned',
          detail: c.id ? `adopt existing ${c.kind} ${c.id}` : `build ${c.kind}`,
        };
      });
      const wires: WriteResult[] = [];
      for (const w of plan.wiring ?? []) {
        const from = byKey.get(w.from);
        const to = byKey.get(w.to);
        if (!from || !to) continue;
        wires.push(
          await (services.wire ?? writeWire)(client, {
            from: { key: w.from, kind: from.kind, id: from.id ?? '(to be built)' },
            to: { key: w.to, kind: to.kind, id: to.id ?? '(to be built)' },
            relation: w.relation,
            dryRun: true,
          })
        );
      }
      return {
        ok: true,
        status: 'PLANNED',
        solution: plan.name,
        order,
        components: planned,
        wires,
        requiredInputs: [],
        nextActions: ['Re-run without dryRun to build and wire.'],
        summary: `Plan holds: ${order.length} component(s) in dependency order, ${wires.length} wire(s) resolvable to a writer.`,
      };
    }

    // --- 2  Build --------------------------------------------------------
    const components: ComponentOutcome[] = [];
    const ids = new Map<string, string>();
    const wires: WriteResult[] = [];
    const requiredInputs: RequiredInput[] = [];
    const partial = (): OrchestrateReport => ({
      ok: false, status: 'PARTIAL', solution: plan.name, order,
      components: [...components, ...order.filter((key) => !components.some((c) => c.key === key)).map((key): ComponentOutcome => ({
        key, kind: byKey.get(key)!.kind, id: byKey.get(key)!.id,
        state: byKey.get(key)!.id ? 'adopted' : 'skipped', detail: 'Not processed: operation time budget ended.',
      }))], wires, requiredInputs,
      nextActions: ['Inspect pending session IDs with swfte_build_status. Adopt committed artifact IDs in the plan before continuing; do not rerun the original creation plan blindly. Wiring and verification may be incomplete.'],
      summary: 'Operation time budget ended with partial results. This report is process-local and does not provide automatic resume.',
    });
    try {

    for (const key of order) {
      client.assertDeadline();
      const c = byKey.get(key)!;
      if (c.id) {
        components.push({ key, kind: c.kind, id: c.id, state: 'adopted', detail: `adopted ${c.kind} ${c.id}` });
        ids.set(key, c.id);
        continue;
      }

      // Building in dependency order is only useful if a failed dependency stops
      // its dependents. A widget built against a chatflow that failed is a widget
      // with no brain — the exact artifact this exists to prevent.
      const unmet = (plan.wiring ?? [])
        .filter((w) => w.from === key && BLOCKING_RELATIONS.has(w.relation) && byKey.has(w.to) && !ids.has(w.to))
        .map((w) => w.to);
      if (unmet.length) {
        components.push({
          key,
          kind: c.kind,
          state: 'skipped',
          detail: `Not built: depends on ${unmet.join(', ')}, which did not produce an id.`,
        });
        nextActions.push(`Fix ${unmet.join(', ')} before rebuilding ${key}.`);
        continue;
      }

      try {
        const outcome = await client.withDeadline(Date.now() + waitMs, () => buildComponent(client, plan, c, waitMs));
        components.push(outcome);
        if (outcome.state === 'pending') return partial();
        if (outcome.id && outcome.state === 'built') ids.set(key, outcome.id);
        // A dataset that indexed nothing keeps its id but does not count as a
        // dependency being met.
        else if (outcome.id) ids.delete(key);
      } catch (err) {
        components.push({
          key,
          kind: c.kind,
          state: 'failed',
          detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        });
      }
    }

    // --- 3  Wire ---------------------------------------------------------
    for (const w of plan.wiring ?? []) {
      client.assertDeadline();
      const from = byKey.get(w.from);
      const to = byKey.get(w.to);
      if (!from || !to) {
        wires.push({
          from: w.from,
          to: w.to,
          relation: w.relation,
          state: 'failed',
          ok: false,
          detail: 'Wire names a component that is not in the plan.',
        });
        continue;
      }
      if (w.externalReason) {
        wires.push({
          from: w.from,
          to: w.to,
          relation: w.relation,
          state: 'needs-backend',
          ok: true,
          detail: `Declared external: ${w.externalReason}`,
        });
        continue;
      }
      const fromId = ids.get(w.from) ?? from.id;
      const toId = ids.get(w.to) ?? to.id;
      if (!fromId || !toId) {
        wires.push({
          from: w.from,
          to: w.to,
          relation: w.relation,
          state: 'target-missing',
          ok: false,
          detail: `Cannot wire: ${!fromId ? w.from : w.to} has no id.`,
        });
        continue;
      }
      try {
        wires.push(
          await (services.wire ?? writeWire)(client, {
            from: { key: w.from, kind: from.kind, id: fromId },
            to: { key: w.to, kind: to.kind, id: toId },
            relation: w.relation,
          })
        );
      } catch (error) {
        client.assertDeadline();
        if (error instanceof OperationDeadlineError) throw error;
        wires.push({ from: w.from, to: w.to, relation: w.relation, state: 'failed', ok: false,
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          nextAction: 'Inspect the existing component IDs and wire before retrying; a failed response may follow a committed update.' });
      }
    }

    // --- 4  Required inputs ----------------------------------------------
    //
    // A {{TODO}} is a guaranteed first-execution failure, so it is an input the
    // solution still needs — not a defect in a finished artifact. Attributing it
    // to the component and path that carries it is what makes the report
    // actionable; blaming a wire for a stub in an unrelated node is not.
    for (const outcome of components) {
      client.assertDeadline();
      if (!outcome.id || outcome.kind === 'dataset') continue;
      try {
        const adapter = getAdapter(outcome.kind as Kind);
        if (typeof adapter.get !== 'function') continue;
        const body = await adapter.get(client, outcome.id);
        for (const hit of findPlaceholders(body)) {
          requiredInputs.push({ component: outcome.key, path: hit.path, label: hit.label, value: hit.value });
        }
      } catch {
        client.assertDeadline();
        // A component that cannot be re-read is already reported by the review pass.
      }
    }

    // --- 5  Review -------------------------------------------------------
    //
    // Against live state, not against what we believe we wrote. This is the only
    // pass that can catch a build where every step looked fine.
    client.assertDeadline();
    const verifiable = components.filter((c) => c.id);
    let verification: SolutionVerifyReport | undefined;
    if (verifiable.length) {
      try {
        verification = await (services.verify ?? verifySolution)(
          client,
          {
            id: plan.name,
            name: plan.name,
            workspaceId: plan.workspaceId,
            components: verifiable.map((c) => {
              const src = byKey.get(c.key)!;
              return {
                key: c.key,
                kind: c.kind,
                id: c.id!,
                requires: src.requires,
                covers: src.covers,
                entry: src.entry,
                terminal: src.terminal,
              };
            }),
            wiring: (plan.wiring ?? [])
              .filter((w) => ids.has(w.from) || byKey.get(w.from)?.id)
              .map((w) => ({ from: w.from, to: w.to, relation: w.relation, note: w.note, externalReason: w.externalReason })),
          },
          { includeComponentVerify: opts.includeComponentVerify }
        );
      } catch (err) {
        client.assertDeadline();
        nextActions.push(
          `Solution verification could not run (${(err instanceof Error ? err.message : String(err)).slice(0, 160)}) — ` +
            'do not report this solution as delivered until it does.'
        );
      }
    }

    // --- Verdict ---------------------------------------------------------
    client.assertDeadline();
    const buildFailed = components.some((c) => c.state === 'failed' || c.state === 'skipped');
    const wireFailed = wires.some((w) => !w.ok);
    const verifyFailed = verification ? !verification.ok : verifiable.length > 0;

    for (const w of wires.filter((x) => !x.ok && x.nextAction)) nextActions.push(w.nextAction!);
    if (requiredInputs.length) {
      nextActions.push(
        `Supply ${requiredInputs.length} unresolved value(s) before any customer-facing deploy — each one fails on first execution.`
      );
    }

    const ok = !buildFailed && !wireFailed && !verifyFailed && requiredInputs.length === 0;
    const status: OrchestrateReport['status'] = ok
      ? 'READY'
      : !buildFailed && !wireFailed && !verifyFailed
        ? 'NEEDS_INPUT'
        : 'BROKEN';

    return {
      ok,
      status,
      solution: plan.name,
      order,
      components,
      wires,
      requiredInputs,
      verification,
      nextActions: [...new Set(nextActions)],
      summary:
        `${components.filter((c) => c.id).length}/${plan.components.length} components live, ` +
        `${wires.filter((w) => w.ok).length}/${wires.length} wires connected, ` +
        `${requiredInputs.length} unresolved input(s)` +
        (verification ? `, solution verification ${verification.ok ? 'passed' : 'FAILED'}` : ', solution verification did not run') +
        `. Status: ${status}.`,
    };
    } catch (error) {
      if (error instanceof OperationDeadlineError || client.remainingMs() <= 0) return partial();
      throw error;
    }
  });
}
