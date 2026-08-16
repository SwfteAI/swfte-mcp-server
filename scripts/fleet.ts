#!/usr/bin/env npx tsx
/**
 * Volume harness for the full loop: prompt → artifact → verify → run → deploy →
 * publicly reachable URL → teardown.
 *
 * Scale is a parameter, not a rewrite. `--count 1` is a smoke test and
 * `--count 1000` is a soak; the code path is identical. That matters because
 * the interesting failures at volume are not the ones you find at N=1 — they
 * are rate limits, quota exhaustion, partial provisions, and resources leaked
 * by a run that died between create and teardown.
 *
 *   SWFTE_PAT=pat_… npx tsx scripts/fleet.ts --count 5
 *   SWFTE_PAT=pat_… npx tsx scripts/fleet.ts --count 1000 --concurrency 8 --deploy
 *
 * Deploys are OFF by default. Turning them on provisions billable capacity per
 * run, so it needs both --deploy and SWFTE_ALLOW_DEPLOY=1 — the same two gates
 * swfte_deploy uses, for the same reason.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { SwfteClient, SwfteApiError, sleep } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { getAdapter, type Kind } from '../src/kinds/index.js';

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const val = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

const COUNT = Number(val('count', '3'));
const CONCURRENCY = Number(val('concurrency', '3'));
const KIND = (val('kind', 'workflow') ?? 'workflow') as Kind;
const DO_DEPLOY = flag('deploy');
const KEEP = flag('keep');
const WAIT_MS = Number(val('wait', '300000'));

/**
 * Prompt variety matters at volume: a thousand identical prompts exercise one
 * code path a thousand times and prove far less than a hundred different ones.
 */
const SUBJECTS = [
  'new leads from a Google Sheet', 'failed payments in Stripe', 'support tickets tagged urgent',
  'daily sales figures', 'expiring subscriptions', 'inbound webhook events',
  'nightly database backups', 'customer churn signals', 'shipment tracking updates',
  'security alerts from the SIEM', 'onboarding survey responses', 'abandoned carts',
];
const ACTIONS = [
  'summarise each with an AI step', 'classify each by severity', 'enrich each with a web lookup',
  'score each against a rubric', 'extract the key fields as JSON', 'translate each to Spanish',
];
const SINKS = [
  'post the result to Slack', 'email a digest', 'write the result to a variable and return it',
  'store the result in a dataset', 'send it to a webhook',
];

const pick = <T,>(xs: T[], i: number): T => xs[i % xs.length]!;

function promptFor(i: number): string {
  // Deterministic per index, so a failing run number is reproducible.
  return (
    `A manually triggered workflow that reads ${pick(SUBJECTS, i)}, ` +
    `${pick(ACTIONS, Math.floor(i / SUBJECTS.length) + i)}, then ` +
    `${pick(SINKS, i * 3 + 1)}. Keep it under six nodes.`
  );
}

type Phase = 'build' | 'create' | 'verify' | 'run' | 'deploy' | 'probe' | 'teardown';

interface RunResult {
  index: number;
  ok: boolean;
  id?: string;
  deploymentId?: string;
  url?: string;
  /** Where it stopped, if it stopped. */
  failedAt?: Phase;
  /** `blocked` = a product gate (quota, billing) rather than a defect. */
  outcome: 'ok' | 'failed' | 'blocked';
  code?: string;
  message?: string;
  timings: Partial<Record<Phase, number>>;
  /**
   * The failing verify checks WITH their detail. At volume the check id alone
   * ("executes") is not actionable — the detail is the whole diagnosis, and
   * without it a 1000-run report tells you only that something is wrong.
   */
  failedChecks?: Array<{ id: string; detail: string }>;
  /** Set when teardown failed — these are leaked and cost money. */
  leaked?: boolean;
}

const BLOCKING_CODES = new Set([
  'PAYMENT_METHOD_REQUIRED',
  'SUBSCRIPTION_REQUIRED',
  'QUOTA_EXCEEDED',
]);

async function timed<T>(
  timings: Partial<Record<Phase, number>>,
  phase: Phase,
  fn: () => Promise<T>
): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    timings[phase] = Date.now() - t0;
  }
}

async function runOne(client: SwfteClient, index: number, allowDeploy: boolean): Promise<RunResult> {
  const adapter = getAdapter(KIND);
  const timings: Partial<Record<Phase, number>> = {};
  const result: RunResult = { index, ok: false, outcome: 'failed', timings };
  let phase: Phase = 'build';

  try {
    // 1. Build.
    const artifact = await timed(timings, 'build', async () => {
      const { sessionId } = await adapter.build!(client, { prompt: promptFor(index) });
      const { snapshot, timedOut } = await client.pollUntil(
        () => adapter.status!(client, sessionId),
        (s) => s.done,
        { timeoutMs: WAIT_MS, intervalMs: 2_500 }
      );
      if (timedOut) throw new Error(`build did not finish in ${WAIT_MS}ms`);
      if (snapshot.error) throw new Error(snapshot.error);
      const a = adapter.extractArtifact!(snapshot);
      if (!a) throw new Error('build produced no artifact');
      return { artifact: a, id: adapter.extractId?.(snapshot) };
    });

    // 2. Persist, unless the wizard already did.
    phase = 'create';
    result.id =
      artifact.id ?? (await timed(timings, 'create', () => adapter.create!(client, artifact.artifact))).id;

    // 3. Verify — including a real execution.
    phase = 'verify';
    const report = await timed(timings, 'verify', () =>
      adapter.verify(client, result.id!, { run: true, timeoutMs: 180_000 })
    );
    if (!report.ok) {
      const bad = report.checks.filter((c) => c.ok === false);
      result.failedChecks = bad.map((c) => ({ id: c.id, detail: c.detail }));
      throw new Error(`verify failed — ${bad.map((c) => `${c.id}: ${c.detail}`).join(' | ')}`);
    }

    // 4. Deploy and confirm the URL actually answers. A deployment record
    //    reaching READY is not the same as a public endpoint serving.
    if (allowDeploy && adapter.deploy) {
      phase = 'deploy';
      const dep = await timed(timings, 'deploy', () =>
        adapter.deploy!(client, result.id!, { timeoutMs: 900_000 })
      );
      result.deploymentId = dep.deploymentId;
      result.url = dep.url ?? dep.endpoint;
      if (dep.phase !== 'READY' && dep.phase !== 'RUNNING') {
        throw new Error(`deploy reached ${dep.phase}`);
      }

      if (result.url) {
        phase = 'probe';
        await timed(timings, 'probe', async () => {
          const res = await fetch(result.url!, { method: 'GET', signal: AbortSignal.timeout(30_000) });
          if (!res.ok) throw new Error(`public URL returned ${res.status}`);
        });
      }
    }

    result.ok = true;
    result.outcome = 'ok';
  } catch (err) {
    result.failedAt = phase;
    if (err instanceof SwfteApiError) {
      result.code = err.code;
      result.message = err.message;
      // A product gate is not a defect. Conflating the two makes a soak run
      // look broken when it is merely out of quota.
      result.outcome = BLOCKING_CODES.has(err.code) ? 'blocked' : 'failed';
    } else {
      result.message = err instanceof Error ? err.message : String(err);
    }
  }

  // 5. Teardown, always attempted — a leaked deployment bills indefinitely.
  if (!KEEP && result.id) {
    try {
      await timed(timings, 'teardown', async () => {
        if (result.deploymentId && adapter.teardown) {
          await adapter.teardown(client, result.id!, result.deploymentId);
        }
        if (adapter.remove) await adapter.remove(client, result.id!);
      });
    } catch {
      result.leaked = true;
    }
  }

  return result;
}

/** Fixed-size worker pool. Keeps concurrency flat rather than spiky. */
async function pool<T>(items: number[], size: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SwfteClient(config);

  const allowDeploy = DO_DEPLOY && config.allowDeploy;
  if (DO_DEPLOY && !config.allowDeploy) {
    console.error('--deploy given but SWFTE_ALLOW_DEPLOY=1 is not set. Running without deploys.\n');
  }

  console.log(`fleet: ${COUNT} × ${KIND}, concurrency ${CONCURRENCY}, deploy=${allowDeploy}`);
  console.log(`endpoint ${config.baseUrl}\n`);

  const started = Date.now();
  let done = 0;

  const results = await pool(
    Array.from({ length: COUNT }, (_, i) => i),
    CONCURRENCY,
    async (i) => {
      const r = await runOne(client, i, allowDeploy);
      done++;
      const mark = r.outcome === 'ok' ? '✓' : r.outcome === 'blocked' ? '·' : '✗';
      console.log(
        `${mark} [${done}/${COUNT}] run ${r.index}` +
          (r.id ? ` ${r.id}` : '') +
          (r.outcome === 'ok'
            ? ` (${Object.values(r.timings).reduce((a, b) => a + b, 0) / 1000 | 0}s)`
            : ` ${r.failedAt}: ${r.code ?? ''} ${(r.message ?? '').slice(0, 90)}`) +
          (r.leaked ? '  ** LEAKED **' : '')
      );
      // A brief stagger stops N workers from hammering the wizard in lockstep.
      await sleep(250);
      return r;
    }
  );

  const ok = results.filter((r) => r.outcome === 'ok');
  const blocked = results.filter((r) => r.outcome === 'blocked');
  const failed = results.filter((r) => r.outcome === 'failed');
  const leaked = results.filter((r) => r.leaked);

  console.log(`\n=== ${COUNT} runs in ${((Date.now() - started) / 1000).toFixed(0)}s ===`);
  console.log(`ok ${ok.length}  blocked ${blocked.length}  failed ${failed.length}`);

  if (ok.length > 0) {
    for (const phase of ['build', 'create', 'verify', 'run', 'deploy', 'probe'] as Phase[]) {
      const xs = ok.map((r) => r.timings[phase]).filter((x): x is number => x !== undefined);
      if (xs.length === 0) continue;
      console.log(
        `  ${phase.padEnd(9)} p50 ${(percentile(xs, 50) / 1000).toFixed(1)}s  ` +
          `p95 ${(percentile(xs, 95) / 1000).toFixed(1)}s  max ${(Math.max(...xs) / 1000).toFixed(1)}s`
      );
    }
  }

  if (failed.length > 0) {
    console.log('\nfailures by phase:');
    const byPhase = new Map<string, number>();
    for (const f of failed) byPhase.set(f.failedAt ?? '?', (byPhase.get(f.failedAt ?? '?') ?? 0) + 1);
    for (const [p, n] of [...byPhase].sort((a, b) => b[1] - a[1])) console.log(`  ${p}: ${n}`);

    console.log('\nfailures by code:');
    const byCode = new Map<string, number>();
    for (const f of failed) byCode.set(f.code ?? 'UNKNOWN', (byCode.get(f.code ?? 'UNKNOWN') ?? 0) + 1);
    for (const [c, n] of [...byCode].sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
  }

  if (blocked.length > 0) {
    console.log(`\n${blocked.length} run(s) blocked by a product gate (${[...new Set(blocked.map((b) => b.code))].join(', ')}).`);
    console.log('These are quota/billing limits, not defects.');
  }

  if (leaked.length > 0) {
    // The loudest thing in the report on purpose: these bill until removed.
    console.log(`\n!! ${leaked.length} run(s) LEAKED resources that teardown could not remove:`);
    for (const l of leaked) console.log(`   ${KIND} ${l.id}${l.deploymentId ? ` deployment ${l.deploymentId}` : ''}`);
  }

  const outDir = join(process.cwd(), '.e2e');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `fleet-${COUNT}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), count: COUNT, kind: KIND, deploy: allowDeploy, results }, null, 2));
  console.log(`\nreport: ${file}`);

  process.exitCode = failed.length > 0 || leaked.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
