#!/usr/bin/env npx tsx
/**
 * Measures the claim: is shipping through the MCP server actually faster than
 * building the same thing by hand in Studio?
 *
 * The MCP number is measured here for real. The manual baseline is NOT measured
 * — it is read from `scripts/baselines.json`, which holds observed wall-clock
 * times for the equivalent UI journeys. Anyone can disagree with a baseline by
 * editing that file; nothing here invents one, and with no baselines present the
 * MCP numbers are reported on their own rather than dressed up as a speedup.
 *
 *   SWFTE_PAT=pat_… npx tsx scripts/bench.ts
 *   SWFTE_PAT=pat_… npx tsx scripts/bench.ts --kinds workflow --repeat 3
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { getAdapter, type Kind } from '../src/kinds/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const value = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const REPEAT = Number(value('repeat') ?? 1);
const KINDS = (value('kinds') ?? 'workflow,agent').split(',').map((s) => s.trim()) as Kind[];

const PROMPTS: Partial<Record<Kind, string>> = {
  workflow:
    'A workflow triggered manually that takes a "topic" input, uses an AI step to write a ' +
    'three-sentence summary, stores it in a variable named "summary", and returns it.',
  agent: 'A concise research assistant that answers questions about logistics and supply chains.',
  chatflow: "A short intake chatflow that collects the visitor's name, company, shipping volume, and email.",
};

type Baseline = { manualSeconds: number; manualSteps: number; source: string };

function loadBaselines(): Record<string, Baseline> {
  try {
    return JSON.parse(readFileSync(join(HERE, 'baselines.json'), 'utf8'));
  } catch {
    return {};
  }
}

type Sample = { kind: Kind; seconds: number; toolCalls: number; id?: string; ok: boolean };

async function benchOne(client: SwfteClient, kind: Kind): Promise<Sample> {
  const adapter = getAdapter(kind);
  const prompt = PROMPTS[kind];
  if (!prompt) throw new Error(`No bench prompt for kind "${kind}"`);

  const started = Date.now();
  // Count the tool calls a user would actually make — build, create where the
  // wizard doesn't persist, verify. That is the honest "how many turns" number.
  let toolCalls = 0;

  try {
    const { sessionId } = await adapter.build(client, { prompt });
    toolCalls += 1;

    const { snapshot, timedOut } = await client.pollUntil(
      () => adapter.status(client, sessionId),
      (s) => s.done,
      { timeoutMs: 300_000, intervalMs: 2_000 }
    );
    if (timedOut || snapshot.error) {
      return { kind, seconds: (Date.now() - started) / 1000, toolCalls, ok: false };
    }

    let id = adapter.extractId?.(snapshot);
    if (!id && adapter.create) {
      id = (await adapter.create(client, adapter.extractArtifact(snapshot))).id;
      toolCalls += 1;
    }

    if (id) {
      await adapter.verify(client, id, { run: false });
      toolCalls += 1;
    }

    return { kind, seconds: (Date.now() - started) / 1000, toolCalls, id, ok: Boolean(id) };
  } catch {
    return { kind, seconds: (Date.now() - started) / 1000, toolCalls, ok: false };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SwfteClient(config);
  const baselines = loadBaselines();

  const samples: Sample[] = [];
  const createdIds: Array<{ kind: Kind; id: string }> = [];

  for (const kind of KINDS) {
    for (let i = 0; i < REPEAT; i++) {
      process.stdout.write(`benchmarking ${kind} (${i + 1}/${REPEAT})… `);
      const sample = await benchOne(client, kind);
      samples.push(sample);
      if (sample.id) createdIds.push({ kind, id: sample.id });
      console.log(sample.ok ? `${sample.seconds.toFixed(1)}s, ${sample.toolCalls} tool calls` : 'FAILED');
    }
  }

  console.log('\n=== results ===');
  console.log('kind        | MCP                  | manual (baseline) | speedup');
  console.log('------------|----------------------|-------------------|--------');

  const rows = [];
  for (const kind of KINDS) {
    const ok = samples.filter((s) => s.kind === kind && s.ok);
    if (ok.length === 0) {
      console.log(`${kind.padEnd(11)} | all runs failed`);
      continue;
    }
    const mcpSeconds = ok.reduce((a, s) => a + s.seconds, 0) / ok.length;
    const mcpCalls = ok.reduce((a, s) => a + s.toolCalls, 0) / ok.length;
    const base = baselines[kind];

    const speedup = base ? `${(base.manualSeconds / mcpSeconds).toFixed(1)}×` : 'no baseline';
    const manual = base ? `${base.manualSeconds}s / ${base.manualSteps} steps` : '—';
    console.log(
      `${kind.padEnd(11)} | ${`${mcpSeconds.toFixed(0)}s / ${mcpCalls} calls`.padEnd(20)} | ${manual.padEnd(17)} | ${speedup}`
    );
    rows.push({ kind, mcpSeconds, mcpCalls, baseline: base ?? null, samples: ok.length });
  }

  if (Object.keys(baselines).length === 0) {
    console.log(
      '\nNo baselines in scripts/baselines.json — the MCP numbers above stand on their own.\n' +
        'A speedup claim needs a measured manual baseline; do not infer one.'
    );
  }

  // Clean up, so repeated benchmarking doesn't accumulate junk in the workspace.
  console.log('\ncleaning up…');
  for (const { kind, id } of createdIds) {
    const adapter = getAdapter(kind);
    if (!adapter.remove) continue;
    try {
      await adapter.remove(client, id);
    } catch {
      console.log(`  ! could not delete ${kind}/${id}`);
    }
  }

  const outDir = join(process.cwd(), '.e2e');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'bench.json'),
    JSON.stringify({ at: new Date().toISOString(), endpoint: config.baseUrl, rows, samples }, null, 2)
  );
  console.log(`report: ${join(outDir, 'bench.json')}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
