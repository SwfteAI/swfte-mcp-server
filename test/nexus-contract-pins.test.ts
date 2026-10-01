import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const ROOT = '/Users/dejanmaksimovic/Projects/Swfte';
const PINS = [
  ['nexus-devtools/nexus_devtools/gates.py', '68b25486215aec7917b66b01c74595f2a9556d1fb545d876123fe6c56b19f4c7'],
  ['nexus-devtools/nexus_devtools/mcp.py', 'd98d74b80392420cc10fae4ec4ea750e72644813e965c098c213a69fdfc43c5c'],
  ['nexus-devtools/contract/read-api.v1.json', '4e679261ae41be16cc5ca6606685f0fa99da8fa7d509a8e20ec558ac8725dc9c'],
  ['nexus-harness/docs/COLLECTOR-AUTH.md', 'd8d7245991cb33a546dc75ed2de88dd205824e22d509a58587520faf2cd7b939'],
] as const;
function assertFacts(gates: string, mcp: string): void {
  assert(gates.includes('Never executes a check')); assert(gates.includes('fails OPEN on every error path'));
  assert(mcp.includes('There are no mutating tools here'));
  const stop = gates.slice(gates.indexOf('def stop_decision('), gates.indexOf('def _stop_decision('));
  assert(stop.includes('except Exception')); assert(stop.includes('return StopDecision(block=False)'));
  assert(!stop.includes('subprocess.run(')); assert(!stop.includes('subprocess.Popen('));
}
test('immutable read-only Nexus source pins match checked source bytes', async () => {
  for (const [path, expected] of PINS) assert.equal(createHash('sha256').update(await readFile(`${ROOT}/${path}`)).digest('hex'), expected,
    `Nexus source drifted: ${path}. Driver must review and pin a new immutable contract.`);
});
test('Nexus Stop never shells out and MCP stays read-only; temporary-string mutations fail', async () => {
  const gates = await readFile(`${ROOT}/nexus-devtools/nexus_devtools/gates.py`, 'utf8');
  const mcp = await readFile(`${ROOT}/nexus-devtools/nexus_devtools/mcp.py`, 'utf8');
  assertFacts(gates, mcp);
  assert.throws(() => assertFacts(gates.replace('Never executes a check', 'May execute a check'), mcp), assert.AssertionError);
  assert.throws(() => assertFacts(gates, mcp.replace('There are no mutating tools here', 'There are mutating tools here')), assert.AssertionError);
});
test('read activity pins actual verified-turn projection and does not pretend feedback is projected', async () => {
  const spec = JSON.parse(await readFile(`${ROOT}/nexus-devtools/contract/read-api.v1.json`, 'utf8'));
  assert(spec.paths['/v1/sessions/{session_id}/activity']);
  assert(spec.components.schemas.Activity_turn_outcome.properties.verified);
  assert(spec.components.schemas.Activity_file_change);
  assert.equal(spec.components.schemas.Activity_execution_feedback, undefined);
});
