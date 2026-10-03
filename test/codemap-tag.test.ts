import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tagCallSites } from '../src/codemap/tag.js';
import { assigned, project } from './codemap-support.js';

test('tags real TS/Python/Java parser spans and stays idempotent', () => {
  const files = { 'main.ts': "client.workflows.invoke('wf_a', { question: 'text' }, { timeoutMs: 15 });\n",
    'main.py': "client.workflows.invoke('wf_a', {'question': 'text'})\n",
    'Main.java': 'class Main { void run() { client.workflows().invoke("wf_a", inputs); } }\n' };
  const root = project(files);
  const sites = [assigned('main.ts'), assigned('main.py', 1, 'python'), assigned('Main.java', 1, 'java')];
  try {
    assert.equal(tagCallSites(root, sites).length, 3);
    const ts = readFileSync(join(root, 'main.ts'), 'utf8'); assert.ok(ts.includes('timeoutMs: 15')); assert.ok(ts.includes("callsite: 'cs_"));
    assert.ok(readFileSync(join(root, 'main.py'), 'utf8').includes("callsite='cs_"));
    assert.ok(readFileSync(join(root, 'Main.java'), 'utf8').includes('com.swfte.sdk.CallSite.of('));
    assert.deepEqual(tagCallSites(root, sites), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ambiguous/unsupported shapes leave all planned source bytes untouched', () => {
  const source = "client.workflows.invoke('wf_a', {}); client.workflows.invoke('wf_b', {});\n";
  const root = project({ 'main.ts': source, 'first.ts': "client.workflows.invoke('wf_a', {});\n" });
  try {
    assert.throws(() => tagCallSites(root, [assigned('first.ts'), assigned('main.ts')]), /one supported SDK call/);
    assert.equal(readFileSync(join(root, 'main.ts'), 'utf8'), source);
    assert.equal(readFileSync(join(root, 'first.ts'), 'utf8'), "client.workflows.invoke('wf_a', {});\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
