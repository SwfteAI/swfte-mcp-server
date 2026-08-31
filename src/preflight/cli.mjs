#!/usr/bin/env node
/**
 * preflight — the failure modes that report success, caught before they ship.
 *
 *   export SWFTE_PAT=…
 *   npm run preflight -- --manifest <path.json>
 *   npm run preflight -- --manifest … --json out.json
 *   npm run preflight -- --manifest … --static             # no platform calls
 *
 * Derive the manifest rather than writing one:
 *   npm run preflight:derive -- --state <state.json> --out m.json
 *
 * Exit codes
 *   0  no blocking findings
 *   1  the check could not be produced (no PAT, unreadable manifest, transport)
 *   2  blocking findings
 *
 * Every rule in `lib/rules.mjs` has been shown to fire under a deliberate
 * mutation by `node preflight/mutation.mjs`. A rule that no mutation can kill
 * is reported there as BROKEN rather than as passing: a check that cannot fail
 * is worse than no check, which is the whole lesson this tool encodes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RULES } from './lib/rules.mjs';
import { buildSnapshot } from './lib/snapshot.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const C = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n, s) => (C ? `[${n}m${s}[0m` : String(s));
const red = (s) => c(31, s);
const green = (s) => c(32, s);
const yellow = (s) => c(33, s);
const dim = (s) => c(2, s);
const bold = (s) => c(1, s);
const pad = (s, n) => String(s ?? '').padEnd(n);

async function main() {
  const manifestPath = opt('manifest');
  if (!manifestPath) {
    console.error('usage: cli.mjs --manifest <path.json> [--json out.json] [--static]  (derive one with derive.mjs)');
    process.exitCode = 1;
    return;
  }
  const abs = resolve(manifestPath);
  const manifest = JSON.parse(readFileSync(abs, 'utf8'));
  manifest.$dir = manifest.baseDir ? resolve(dirname(abs), manifest.baseDir) : dirname(dirname(dirname(abs)));

  console.log('');
  console.log(bold(`PREFLIGHT — ${manifest.name ?? manifest.id}`));
  console.log(dim(`workspace ${manifest.workspaceId} · ${(manifest.components ?? []).length} components · ${RULES.length} rules · read-only`));
  console.log('');

  // A derived manifest is not the same evidence as a hand-written one: some
  // rule branches go vacuous because the value they check against was derived
  // from the thing being checked. Naming them is the same discipline as
  // mutation.mjs — a branch that cannot fire is reported, never counted.
  if (manifest.provenance) {
    console.log(bold('DERIVED MANIFEST') + dim(` — ${manifest.provenance.source}`));
    for (const [k, v] of Object.entries(manifest.provenance.fields ?? {})) console.log(`  ${dim(pad(k, 20))} ${v}`);
    for (const u of manifest.provenance.unexercised ?? []) console.log(`  ${yellow('unexercised')}  ${u}`);
    for (const d of manifest.provenance.droppedWires ?? []) console.log(`  ${yellow('wire dropped')} ${d}`);
    for (const e of manifest.provenance.fetchErrors ?? []) console.log(`  ${red('fetch error')}  ${e}`);
    for (const h of manifest.provenance.humanMustConfirm ?? []) console.log(`  ${red('confirm')}      ${h}`);
    console.log('');
  }

  let snap;
  if (flag('static')) {
    snap = { manifest, components: (manifest.components ?? []).map((x) => ({ ...x, record: null })), workflows: [], errors: [] };
  } else {
    if (!process.env.SWFTE_PAT) { console.error(red('SWFTE_PAT is not set')); process.exitCode = 1; return; }
    console.log(dim('fetching live state (serial — the platform fails under concurrency)'));
    snap = await buildSnapshot(manifest, { log: (m) => console.log(dim(m)) });
    console.log('');
  }

  const results = [];
  for (const r of RULES) {
    let produced;
    try {
      produced = r.run(snap);
    } catch (e) {
      results.push({ rule: r, state: 'error', findings: [], reason: e.message });
      continue;
    }
    if (produced && !Array.isArray(produced) && produced.$skip) {
      results.push({ rule: r, state: 'skip', findings: [], reason: produced.$skip });
      continue;
    }
    const findings = produced ?? [];
    results.push({ rule: r, state: findings.length ? 'fail' : 'pass', findings });
  }

  const blocking = results.flatMap((r) => r.findings).filter((f) => f.severity === 'block');
  const warnings = results.flatMap((r) => r.findings).filter((f) => f.severity !== 'block');

  console.log(bold('RULES'));
  for (const r of results) {
    const mark =
      r.state === 'pass' ? green('pass ')
        : r.state === 'fail' ? (r.findings.some((f) => f.severity === 'block') ? red('FAIL ') : yellow('WARN '))
          : r.state === 'skip' ? dim('skip ') : red('ERROR');
    const cat = r.rule.catalogue ? dim(`[#${r.rule.catalogue}]`) : dim('[  ]');
    const tail = r.state === 'skip' ? dim(` — ${r.reason}`) : r.state === 'error' ? red(` — ${r.reason}`) : r.findings.length ? ` — ${r.findings.length} finding(s)` : '';
    console.log(`  ${mark} ${pad(cat, C ? 14 : 5)} ${pad(r.rule.id, 30)}${tail}`);
  }

  const withFindings = results.filter((r) => r.findings.length);
  if (withFindings.length) {
    console.log('');
    console.log(bold('FINDINGS'));
    for (const r of withFindings) {
      console.log('');
      console.log(`  ${r.rule.findings ? '' : ''}${bold(r.rule.id)} ${dim(r.rule.title)}`);
      for (const f of r.findings) {
        const sev = f.severity === 'block' ? red('BLOCK') : yellow('warn ');
        console.log(`    ${sev} ${bold(f.where)}`);
        console.log(`      ${f.detail}`);
        if (f.fix) console.log(`      ${green('fix:')} ${f.fix}`);
      }
    }
  }

  if (snap.errors?.length) {
    console.log('');
    console.log(bold('FETCH ERRORS') + dim(' (recorded, not swallowed)'));
    for (const e of snap.errors) console.log(`  ${red('!')} ${e}`);
  }

  const skipped = results.filter((r) => r.state === 'skip');
  console.log('');
  console.log(bold('SUMMARY'));
  console.log(
    `  ${blocking.length ? red(`${blocking.length} blocking`) : green('0 blocking')} · ` +
      `${warnings.length ? yellow(`${warnings.length} warning`) : '0 warning'} · ` +
      `${dim(`${skipped.length} rule(s) skipped for want of input`)}`
  );
  if (skipped.length) console.log(dim(`  skipped: ${skipped.map((r) => r.rule.id).join(', ')}`));
  console.log('');

  const json = opt('json');
  if (json) {
    writeFileSync(json, JSON.stringify({
      manifest: manifest.id,
      generatedAt: new Date().toISOString(),
      blocking: blocking.length,
      warnings: warnings.length,
      rules: results.map((r) => ({ id: r.rule.id, catalogue: r.rule.catalogue, title: r.rule.title, state: r.state, reason: r.reason ?? null, findings: r.findings })),
      fetchErrors: snap.errors ?? [],
    }, null, 2) + '\n');
    console.log(dim(`  report written to ${json}`));
  }

  process.exitCode = blocking.length ? 2 : 0;
}

main().catch((e) => {
  console.error(red(`preflight could not run: ${e.stack ?? e.message}`));
  process.exitCode = 1;
});
