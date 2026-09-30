// node scripts/check-named-tests.mjs <test-file> --token TOKEN [--require "test name prefix"]...
// Runs the file with node:test, then requires: no failing test, and for every --require a passing test whose
// name starts with that text. Prints TOKEN only when all of it holds (exit 1 otherwise).
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const file = args.shift();
let token = '';
const required = [];
while (args.length) {
  const a = args.shift();
  if (a === '--token') token = args.shift() ?? '';
  else if (a === '--require') required.push(args.shift() ?? '');
}
if (!file || !token) {
  console.error('usage: check-named-tests.mjs <file> --token TOKEN [--require NAME]...');
  process.exit(2);
}
const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = `${r.stdout}\n${r.stderr}`;
const passed = [];
const failed = [];
for (const line of out.split('\n')) {
  const m = /^\s*(not ok|ok) \d+ - (.*?)(?: # .*)?$/.exec(line);
  if (!m) continue;
  (m[1] === 'ok' ? passed : failed).push(m[2]);
}
const problems = [];
if (r.status !== 0) problems.push(`test run exited ${r.status}`);
for (const f of failed) problems.push(`FAILED: ${f}`);
for (const name of required) {
  if (!passed.some((p) => p.startsWith(name))) problems.push(`no passing test named "${name}..."`);
}
if (required.length === 0 && passed.length === 0) problems.push('no tests ran');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`${token} (${passed.length} passed)`);
