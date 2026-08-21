#!/usr/bin/env npx tsx
/**
 * End-to-end harness: drives the tool implementations directly, with no MCP
 * client and no model in the loop.
 *
 * This is the regression gate. If this passes, an attached Claude session using
 * the same tools will work; if it fails, the failure is in the server or the
 * backend rather than in how a model chose to call things.
 *
 *   SWFTE_PAT=pat_… npx tsx scripts/e2e.ts
 *   SWFTE_PAT=pat_… npx tsx scripts/e2e.ts --kinds workflow,agent --run
 *   SWFTE_PAT=pat_… npx tsx scripts/e2e.ts --keep        # skip teardown
 *
 * Exits non-zero if any phase fails, so it can gate CI.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { SwfteClient, SwfteApiError } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { getAdapter, type Kind } from '../src/kinds/index.js';

// --------------------------------------------------------------------------
// Args
// --------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const KEEP = flag('keep');
const DO_RUN = flag('run');
const WAIT_MS = Number(value('wait') ?? 300_000);

/**
 * Prompts are deliberately concrete. A vague prompt produces a vague graph and
 * turns a regression suite into a coin flip.
 */
const SCENARIOS: Record<string, { kind: Kind; prompt: string; runInputs?: Record<string, unknown> }> = {
  workflow: {
    kind: 'workflow',
    prompt:
      'A workflow triggered manually that takes a "topic" input, uses an AI step to write a ' +
      'three-sentence summary of that topic, then stores the summary in a variable named "summary" ' +
      'and returns it. Keep it to three nodes.',
    runInputs: { topic: 'the history of the shipping container' },
  },
  agent: {
    kind: 'agent',
    prompt:
      'A concise research assistant that answers questions about logistics and supply chains. ' +
      'It should introduce itself briefly and say what it can help with.',
  },
  chatflow: {
    kind: 'chatflow',
    prompt:
      'A short intake chatflow for a logistics consultancy that collects the visitor\'s name, ' +
      'company, shipping volume, and email, then thanks them.',
  },
};

const KINDS = (value('kinds') ?? 'workflow,agent')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// --------------------------------------------------------------------------
// Reporting
// --------------------------------------------------------------------------

type PhaseResult = {
  kind: string;
  phase: string;
  ok: boolean;
  ms: number;
  detail?: string;
};

const results: PhaseResult[] = [];
const created: Array<{ kind: Kind; id: string }> = [];

const stamp = (): string => new Date().toISOString().slice(11, 19);
const log = (msg: string): void => console.log(`[${stamp()}] ${msg}`);

async function phase<T>(kind: string, name: string, fn: () => Promise<T>): Promise<T | null> {
  const started = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - started;
    results.push({ kind, phase: name, ok: true, ms });
    log(`  ✓ ${name} (${(ms / 1000).toFixed(1)}s)`);
    return out;
  } catch (err) {
    const ms = Date.now() - started;
    const detail = err instanceof SwfteApiError ? `${err.code}: ${err.message}` : String(err);
    results.push({ kind, phase: name, ok: false, ms, detail });
    log(`  ✗ ${name} (${(ms / 1000).toFixed(1)}s) — ${detail}`);
    return null;
  }
}

// --------------------------------------------------------------------------
// Scenario
// --------------------------------------------------------------------------

async function runScenario(client: SwfteClient, key: string): Promise<void> {
  const scenario = SCENARIOS[key];
  if (!scenario) {
    log(`! no scenario for "${key}" — known: ${Object.keys(SCENARIOS).join(', ')}`);
    return;
  }

  const { kind, prompt } = scenario;
  const adapter = getAdapter(kind);
  log(`\n=== ${kind} ===`);

  // 1. Build.
  const built = await phase(kind, 'build', async () => {
    const { sessionId } = await adapter.build(client, { prompt });
    const { snapshot, timedOut } = await client.pollUntil(
      () => adapter.status(client, sessionId),
      (s) => s.done,
      { timeoutMs: WAIT_MS, intervalMs: 2_000 }
    );
    if (timedOut) throw new Error(`build did not finish within ${WAIT_MS}ms (status=${snapshot.status})`);
    if (snapshot.error) throw new Error(`build failed: ${snapshot.error}`);

    const artifact = adapter.extractArtifact(snapshot);
    if (!artifact) throw new Error('build completed but produced no artifact');
    return { artifact, id: adapter.extractId?.(snapshot) };
  });
  if (!built) return;

  // 2. Validate, where the kind supports it. A validation failure is reported
  //    but does not abort — we want to see whether create rejects it too.
  if (adapter.validate) {
    await phase(kind, 'validate', async () => {
      const report = await adapter.validate!(client, built.artifact);
      if (!report.valid) {
        throw new Error(
          `invalid: ${report.findings.map((f) => f.message).join('; ').slice(0, 300) || 'no detail'}`
        );
      }
      return report;
    });
  }

  // 3. Persist, unless the wizard already did.
  let id = built.id;
  if (!id && adapter.create) {
    const createdOut = await phase(kind, 'create', async () => adapter.create!(client, built.artifact));
    id = createdOut?.id;
  } else if (id) {
    log(`  · create skipped — the wizard persisted it as ${id}`);
  }

  if (!id) {
    log('  ! no id — cannot verify or run');
    return;
  }
  created.push({ kind, id });
  log(`  → ${kind} id: ${id}`);

  // 4. Verify. This is the check that matters: the whole point is catching
  //    artifacts that were accepted by the API but do not actually work.
  await phase(kind, 'verify', async () => {
    const report = await adapter.verify(client, id!, { run: DO_RUN, inputs: scenario.runInputs });
    for (const c of report.checks) {
      const mark = c.ok === true ? '✓' : c.ok === false ? '✗' : '·';
      log(`      ${mark} ${c.id}: ${c.detail}`);
    }
    if (!report.ok) {
      throw new Error(`verify failed: ${report.checks.filter((c) => c.ok === false).map((c) => c.id).join(', ')}`);
    }
    return report;
  });
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SwfteClient(config);

  log(`endpoint: ${config.baseUrl}`);
  log(`credential: ${config.credentialKind}`);
  log(`kinds: ${KINDS.join(', ')}${DO_RUN ? ' (with execution)' : ' (build+verify only)'}`);

  // Fail fast and legibly on a bad credential, rather than reporting N
  // identical auth failures downstream.
  const identity = await phase('_', 'whoami', async () =>
    client.request({ method: 'GET', path: '/v2/workspace/members/me', retries: 1 })
  );
  if (!identity) {
    log('\nCannot authenticate — check SWFTE_PAT. Aborting.');
    process.exitCode = 1;
    return;
  }

  for (const key of KINDS) {
    await runScenario(client, key);
  }

  // Teardown. Best-effort: a failed cleanup should not mask a passing suite,
  // but it must be reported so nothing is silently left behind.
  if (!KEEP && created.length > 0) {
    log('\n=== teardown ===');
    for (const { kind, id } of created) {
      const adapter = getAdapter(kind);
      if (!adapter.remove) {
        log(`  · ${kind}/${id} — no delete for this kind, left in place`);
        continue;
      }
      try {
        await adapter.remove(client, id);
        log(`  ✓ deleted ${kind}/${id}`);
      } catch (err) {
        log(`  ! could not delete ${kind}/${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (KEEP && created.length > 0) {
    log(`\n=== kept (--keep) ===\n${created.map((c) => `  ${c.kind}/${c.id}`).join('\n')}`);
  }

  // Report.
  const failed = results.filter((r) => !r.ok);
  const totalMs = results.reduce((a, r) => a + r.ms, 0);

  log('\n=== summary ===');
  log(`${results.length - failed.length}/${results.length} phases passed in ${(totalMs / 1000).toFixed(1)}s`);
  for (const f of failed) log(`  ✗ ${f.kind}/${f.phase}: ${f.detail}`);

  const outDir = join(process.cwd(), '.e2e');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'report.json');
  writeFileSync(
    outFile,
    JSON.stringify(
      { at: new Date().toISOString(), endpoint: config.baseUrl, kinds: KINDS, ran: DO_RUN, results, created },
      null,
      2
    )
  );
  log(`report: ${outFile}`);

  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
