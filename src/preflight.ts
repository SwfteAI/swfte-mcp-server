/**
 * Preflight, as a platform capability.
 *
 * The rule set in `src/preflight/` is the one built across two forward-deployed
 * engagements. It is vendored here byte-identical rather than ported, and this
 * file is a bridge, not a reimplementation: it hands the MCP server's own
 * authenticated GET to the vendored client, builds a snapshot, and runs the
 * rules unchanged.
 *
 * Two things this module is careful about, because both are the failure mode
 * the rules exist to catch:
 *
 *   A rule that SKIPPED is not a rule that PASSED. Skips are counted and
 *   returned separately, and the gate says so in its own summary. The
 *   engagement this came from had gates reporting reachability as passing while
 *   the URL was undefined.
 *
 *   A run that could not be produced is not a clean run. If the snapshot could
 *   not be fetched, `gate` returns `INCONCLUSIVE`, which blocks exactly like a
 *   finding does. A checker that fails open is a checker that lies.
 */
import type { SwfteClient } from './client.js';
import { withTransport } from './preflight/lib/api.mjs';
import { buildSnapshot, type PreflightManifest, type Snapshot } from './preflight/lib/snapshot.mjs';
import { RULES, type Finding, type Rule } from './preflight/lib/rules.mjs';

export type { PreflightManifest, Finding };

export interface RuleResult {
  id: string;
  catalogue: number | null;
  title: string;
  severity: 'block' | 'warn';
  state: 'pass' | 'fail' | 'skip' | 'error';
  reason: string | null;
  findings: Finding[];
}

export interface PreflightReport {
  manifest: string;
  generatedAt: string;
  ruleCount: number;
  blocking: number;
  warnings: number;
  /** Rules that could not run. NOT passes. */
  skipped: string[];
  /** Rules that threw. Also not passes. */
  errored: string[];
  rules: RuleResult[];
  fetchErrors: string[];
  /** Present when the manifest was derived rather than written. */
  provenance: Record<string, unknown> | null;
  summary: string;
}

/**
 * Point the vendored read-only client at this server's credential and base URL.
 *
 * Serialisation still happens inside `api.mjs`: the platform returns "fetch
 * failed" under concurrency, and a preflight that reported a healthy solution
 * as broken because it fanned out would be the exact class of lying check this
 * exists to prevent.
 */
export function withClientTransport<T>(client: SwfteClient, action: () => Promise<T>): Promise<T> {
  return withTransport(
    (path, opts) => client.request({ method: 'GET', path, timeoutMs: opts?.timeoutMs ?? 120_000, retries: 3 }),
    action
  );
}

/** Run every rule over one snapshot. Pure — no I/O, so the mutation harness controls it. */
export function runRules(snapshot: Snapshot): RuleResult[] {
  return RULES.map((r: Rule): RuleResult => {
    const base = { id: r.id, catalogue: r.catalogue, title: r.title, severity: r.severity };
    let produced: ReturnType<Rule['run']>;
    try {
      produced = r.run(snapshot);
    } catch (e) {
      return { ...base, state: 'error', reason: e instanceof Error ? e.message : String(e), findings: [] };
    }
    if (produced && !Array.isArray(produced) && '$skip' in produced) {
      return { ...base, state: 'skip', reason: produced.$skip, findings: [] };
    }
    const findings = (produced ?? []) as Finding[];
    return { ...base, state: findings.length ? 'fail' : 'pass', reason: null, findings };
  });
}

export async function preflight(
  client: SwfteClient,
  manifest: PreflightManifest,
  opts: { executionsPerWorkflow?: number } = {}
): Promise<PreflightReport> {
  const snapshot = await withClientTransport(client, () =>
    buildSnapshot(manifest, { executionsPerWorkflow: opts.executionsPerWorkflow ?? 3 })
  );

  const rules = runRules(snapshot);
  const all = rules.flatMap((r) => r.findings);
  const blocking = all.filter((f) => f.severity === 'block');
  const warnings = all.filter((f) => f.severity !== 'block');
  const skipped = rules.filter((r) => r.state === 'skip');
  const errored = rules.filter((r) => r.state === 'error');

  return {
    manifest: manifest.id ?? 'unnamed',
    generatedAt: new Date().toISOString(),
    ruleCount: RULES.length,
    blocking: blocking.length,
    warnings: warnings.length,
    skipped: skipped.map((r) => `${r.id}: ${r.reason}`),
    errored: errored.map((r) => `${r.id}: ${r.reason}`),
    rules,
    fetchErrors: snapshot.errors ?? [],
    provenance: (manifest.provenance as Record<string, unknown> | undefined) ?? null,
    summary:
      `${blocking.length} blocking · ${warnings.length} warning · ` +
      `${skipped.length} rule(s) skipped for want of input (NOT passes)` +
      (errored.length ? ` · ${errored.length} rule(s) errored` : ''),
  };
}

/* ── the gate ────────────────────────────────────────────────────────────── */

export type GateVerdict = 'PASS' | 'BLOCKED' | 'INCONCLUSIVE';

export interface GateResult {
  verdict: GateVerdict;
  allowed: boolean;
  reason: string;
  blocking: Finding[];
  report: PreflightReport | null;
  /** What the caller must do. Never "retry". */
  nextActions: string[];
}

/**
 * The publish gate.
 *
 * Three verdicts, not two. A run that could not be produced — no manifest, a
 * fetch that failed, a rule that threw — is INCONCLUSIVE and blocks. A gate
 * that treats "I could not check" as "it is fine" is worse than no gate: it
 * launders an unknown into an assurance, which is the single defect that
 * recurs through both engagements.
 *
 * `force` exists because a human sometimes has a reason. It is recorded in the
 * result verbatim so the override is visible in the transcript, and it never
 * changes the verdict — only `allowed`.
 */
export async function gate(
  client: SwfteClient,
  manifest: PreflightManifest,
  opts: { force?: boolean; forceReason?: string; executionsPerWorkflow?: number } = {}
): Promise<GateResult> {
  let report: PreflightReport;
  try {
    report = await preflight(client, manifest, { executionsPerWorkflow: opts.executionsPerWorkflow });
  } catch (e) {
    const reason = `preflight could not be produced: ${e instanceof Error ? e.message : String(e)}`;
    return {
      verdict: 'INCONCLUSIVE',
      allowed: Boolean(opts.force),
      reason: opts.force ? `${reason} — OVERRIDDEN: ${opts.forceReason ?? 'no reason given'}` : reason,
      blocking: [],
      report: null,
      nextActions: ['Fix the reason preflight could not run, then re-gate. Do not publish on an unproduced check.'],
    };
  }

  const blocking = report.rules.flatMap((r) => r.findings).filter((f) => f.severity === 'block');

  // A rule that threw leaves a hole in the sweep. Publishing on a sweep with a
  // hole in it is publishing on a check that could not fail.
  if (report.errored.length) {
    return {
      verdict: 'INCONCLUSIVE',
      allowed: Boolean(opts.force),
      reason:
        `${report.errored.length} rule(s) errored, so the sweep is incomplete: ${report.errored.join('; ')}` +
        (opts.force ? ` — OVERRIDDEN: ${opts.forceReason ?? 'no reason given'}` : ''),
      blocking,
      report,
      nextActions: ['Fix the errored rule(s), then re-gate.'],
    };
  }

  if (blocking.length) {
    return {
      verdict: 'BLOCKED',
      allowed: Boolean(opts.force),
      reason:
        `${blocking.length} blocking finding(s): ${[...new Set(blocking.map((f) => f.rule))].join(', ')}` +
        (opts.force ? ` — OVERRIDDEN: ${opts.forceReason ?? 'no reason given'}` : ''),
      blocking,
      report,
      nextActions: [
        ...new Set(blocking.map((f) => f.fix).filter((x): x is string => Boolean(x))),
      ].slice(0, 12),
    };
  }

  return {
    verdict: 'PASS',
    allowed: true,
    reason:
      report.skipped.length > 0
        ? `no blocking findings, but ${report.skipped.length} rule(s) could not run and are NOT passes: ${report.skipped.join('; ')}`
        : 'no blocking findings, and every rule ran',
    blocking: [],
    report,
    nextActions: report.skipped.length
      ? ['Give the manifest what the skipped rules need (wires, coverage sets) before treating this as a full sweep.']
      : [],
  };
}
