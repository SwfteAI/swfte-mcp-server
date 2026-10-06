/**
 * Regenerate src/guidance/tour-sandbox-first.json from Studio's walkthrough track.
 *
 *   npx tsx scripts/extract-tour.ts <path to studio>/app/components/studio/walkthrough/tracks/sandbox-first.ts
 *
 * The track file is imported (it only has type imports, so tsx runs it as-is) with every
 * feature flag on, so the table lists all steps. The result is checked in; this repo never
 * imports across repos at runtime.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('usage: tsx scripts/extract-tour.ts <path to sandbox-first.ts>');
  process.exit(2);
}

const mod = await import(pathToFileURL(resolve(src)).href);
const track = mod.buildSandboxFirstTrack(mod.ALL_SANDBOX_FIRST_FLAGS);

let chapter = 0;
let chapterTitle = '';
const steps = track.steps.map((s: any) => {
  const m = /^(\d+) · (.*)$/.exec(s.title);
  if (m) { chapter = Number(m[1]); chapterTitle = m[2]; }
  const eq = s.agentEquivalent;
  return {
    id: s.id,
    chapter,
    chapterTitle,
    title: s.title,
    route: s.route ?? null,
    enterprise: Boolean(s.variantWhenLocked),
    mcp: eq ? { tool: eq.tool, args: eq.args ?? {}, prompt: eq.prompt } : null,
  };
});

const out = { track: track.id, title: track.title, summary: track.summary, steps };
const dest = new URL('../src/guidance/tour-sandbox-first.json', import.meta.url);
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${steps.length} steps over ${chapter} chapters`);
