/** Real detector scaling probe; source stays local, no package installs or transport. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { detectProject } from '../src/codemap/detect.js';

function sourceFingerprint(): { sha256: string; files: number } {
  const root = new URL('../src/codemap/', import.meta.url);
  const hashes: string[][] = [];
  function walk(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:ts|wasm)$/u.test(entry.name)) hashes.push([relative(root.pathname, file), createHash('sha256').update(readFileSync(file)).digest('hex')]);
    }
  }
  walk(root.pathname);
  return { sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), files: hashes.length };
}
const before = sourceFingerprint();
console.log('CODEMAP_SOURCE_BEFORE ' + JSON.stringify(before));
if (process.argv.includes('--fingerprint-only')) process.exit(0);

function fixture(language: 'ts' | 'python' | 'java', count: number): { path: string; source: string } {
  if (language === 'ts') return { path: 'scope.ts', source: "import Swfte from '@swfte/sdk';\nconst client = new Swfte({apiKey:'fixture'});\nasync function run() {\n"
    + Array.from({length:count}, (_, i) => `const workflow_${i} = 'wf_perf_${i}'; await client.workflows.invoke(workflow_${i}, {value:${i}});`).join('\n') + '\n}\n' };
  if (language === 'python') return { path: 'scope.py', source: "from swfte import SwfteClient\nclient = SwfteClient(api_key='fixture')\ndef run():\n"
    + Array.from({length:count}, (_, i) => `    workflow_${i} = 'wf_perf_${i}'\n    client.workflows.invoke(workflow_${i}, {'value':${i}})`).join('\n') + '\n' };
  return { path: 'ScopePerf.java', source: 'import com.swfte.sdk.SwfteClient;\nclass ScopePerf { void run(SwfteClient client) {\n'
    + Array.from({length:count}, (_, i) => `String workflow_${i} = "wf_perf_${i}"; client.workflows().invoke(workflow_${i}, null);`).join('\n') + '\n}}\n' };
}

const root = mkdtempSync(join(tmpdir(), 'swfte-codemap-perf-'));
const measurements: Array<{language:string; calls:number; elapsedMs:number; rssMiB:number; heapMiB:number; sites:number; truncated:boolean}> = [];
const failures: string[] = [];
const bound = (holds: boolean, message: string): void => { if (!holds) failures.push(message); };
try {
  for (const language of ['ts','python','java'] as const) {
    for (const count of [1000,4000]) {
      const directory = join(root, `${language}-${count}`); mkdirSync(directory);
      const file = fixture(language, count); writeFileSync(join(directory, file.path), file.source);
      const times: number[] = []; let observed: Awaited<ReturnType<typeof detectProject>> | undefined;
      for (let iteration = 0; iteration < 2; iteration++) {
        const start = performance.now(); observed = await detectProject(directory); times.push(performance.now() - start);
        assert.equal(observed.truncated, false, `${language} ${count}: incomplete scan`);
        assert.equal(observed.sites.length, count, `${language} ${count}: wrong measured site count`);
        assert(observed.sites.every(site => site.artifact.id?.startsWith('wf_perf_') && !site.artifact.unresolved), `${language}: guessed or lost identity`);
      }
      const memory = process.memoryUsage();
      const result = {language,calls:count,elapsedMs:Math.min(...times),rssMiB:memory.rss/1048576,
        heapMiB:memory.heapUsed/1048576,sites:observed!.sites.length,truncated:observed!.truncated};
      measurements.push(result); console.log('CODEMAP_PERF_MEASUREMENT ' + JSON.stringify(result));
      if (count === 4000) {
        bound(result.elapsedMs < 10000, `${language}: 4000 calls exceeded 10s bound`);
        const small = measurements.find(item => item.language === language && item.calls === 1000)!;
        bound(result.elapsedMs / Math.max(1, small.elapsedMs) <= 6, `${language}: measured growth exceeds declared ratio6`);
      }
      bound(result.rssMiB < 512, `${language}: RSS exceeds declared512MiB (${result.rssMiB.toFixed(2)}MiB)`);
    }
  }
  if (failures.length) {
    console.log('CODEMAP_PERF_FAIL ' + JSON.stringify(failures));
    process.exitCode = 1;
  } else console.log('CODEMAP_PERF_OK');
} finally {
  rmSync(root, {recursive:true,force:true});
  const after = sourceFingerprint(); console.log('CODEMAP_SOURCE_AFTER ' + JSON.stringify(after));
  assert.deepEqual(after, before, 'Scanner source changed while measured; this result has no immutable acceptance');
}
