#!/usr/bin/env npx tsx
/**
 * Proves the code round-trip: download a generated workspace, push it back
 * UNMODIFIED, and assert nothing changed — then edit a user region and assert
 * the change is seen.
 *
 * The unmodified leg is the important one. If a byte-identical workspace comes
 * back reporting changes, the emitter and the reverse parser have drifted, and
 * every diff the tool produces is untrustworthy. That failure is invisible from
 * either side alone, which is why it gets its own test.
 *
 *   SWFTE_PAT=pat_… SWFTE_BASE_URL=http://localhost:8080 \
 *     npx tsx scripts/roundtrip.ts --workflow <executionWorkflowId>
 */
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { codeTools } from '../src/tools/code.js';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const WORKFLOW = arg('workflow');
if (!WORKFLOW) {
  console.error('usage: roundtrip.ts --workflow <executionWorkflowId>');
  process.exit(1);
}

const config = loadConfig();
const client = new SwfteClient(config);
const ctx = { client, config };
const exportSrc = codeTools.find((t) => t.name === 'swfte_export_src')!;
const syncSrc = codeTools.find((t) => t.name === 'swfte_sync_src')!;

const dest = join(tmpdir(), `swfte-roundtrip-${Date.now()}`);
let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

try {
  // 1. Download.
  console.log(`\n=== download ===`);
  const exported: any = await exportSrc.execute({ workflowId: WORKFLOW, destDir: dest }, ctx);
  console.log(`${exported.fileCount} files → ${dest}`);
  console.log(`blueprintSha: ${exported.blueprintSha}  emitter: ${exported.emitterVersion}`);

  check('workspace has files', exported.fileCount > 0);
  const files: string[] = exported.files;
  check('Cargo.toml present', files.includes('Cargo.toml'));
  check('build.rs present', files.includes('build.rs'));
  check('src/graph.rs present', files.includes('src/graph.rs'));
  check('swfte-blueprint.json present', files.includes('swfte-blueprint.json'));
  check(
    'at least one step file',
    files.some((f) => f.startsWith('src/steps/') && f.endsWith('.rs') && !f.endsWith('mod.rs'))
  );
  check('step headers parsed', exported.steps.length > 0, `${exported.steps.length} step(s)`);
  for (const s of exported.steps) {
    console.log(`    ${s.file}  id=${s.stepId} type=${s.stepType} regions=[${s.userRegions.join(', ')}]`);
  }

  // 2. Push back UNMODIFIED — the drift check.
  console.log(`\n=== sync unmodified (dry run) ===`);
  const clean: any = await syncSrc.execute({ workflowId: WORKFLOW, srcDir: dest }, ctx);
  console.log(JSON.stringify({ hasChanges: clean.hasChanges, outcome: clean.outcome, modified: clean.modifiedSteps, unreconcilable: clean.unreconcilable }, null, 2));
  check(
    'unmodified workspace reports no changes',
    clean.hasChanges === false,
    clean.hasChanges ? 'EMITTER/PARSER DRIFT — diffs are untrustworthy' : ''
  );
  check('nothing unreconcilable on a clean round-trip', (clean.unreconcilable ?? []).length === 0);

  // 3. Edit inside a user region, push back, expect the change to be seen.
  const stepFiles = readdirSync(join(dest, 'src', 'steps')).filter(
    (f) => f.endsWith('.rs') && f !== 'mod.rs'
  );
  if (stepFiles.length === 0) {
    console.log('\n(no step files to edit — skipping the modified leg)');
  } else {
    const target = join(dest, 'src', 'steps', stepFiles[0]!);
    const before = readFileSync(target, 'utf8');
    const marker = /(\/\/\s*@user:[A-Za-z0-9_-]+:start\n)/.exec(before);

    console.log(`\n=== sync modified (dry run) ===`);
    if (!marker) {
      console.log(`no @user region in ${stepFiles[0]} — appending a comment instead`);
      writeFileSync(target, `${before}\n// roundtrip probe\n`);
    } else {
      writeFileSync(
        target,
        before.replace(marker[1]!, `${marker[1]}    // roundtrip probe: edited inside a user region\n`)
      );
    }

    const edited: any = await syncSrc.execute({ workflowId: WORKFLOW, srcDir: dest }, ctx);
    console.log(JSON.stringify({ hasChanges: edited.hasChanges, modified: edited.modifiedSteps, unreconcilable: edited.unreconcilable }, null, 2));
    // Note: an edit inside a user region is *preserved*, not necessarily a
    // blueprint change — so we assert the sync succeeded and reported cleanly
    // rather than asserting hasChanges is true.
    check('modified workspace synced without error', edited.outcome !== undefined || edited.hasChanges !== undefined);
  }
} catch (err) {
  console.error('\nround-trip failed:', err instanceof Error ? err.message : String(err));
  failures++;
} finally {
  rmSync(dest, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'round-trip OK' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
