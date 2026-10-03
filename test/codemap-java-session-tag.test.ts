import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { detectProject } from '../src/codemap/detect.js';
import { assignIds } from '../src/codemap/fingerprint.js';
import { tagCallSites } from '../src/codemap/tag.js';
import { project } from './codemap-support.js';

const envFiles = { secret: ['dot-env', 'dot-env.*'], names: ['dot-env.example'] };
const context = 'Map.of("channel", "web")';
const source = (args = `"cf_session", ${context}`, receiver = 'chatflows') => [
  'import com.swfte.sdk.SwfteClient;', 'import java.util.Map;',
  'class Caller { void run(SwfteClient client) {',
  `client.${receiver}().startSession(${args});`, '}}',
].join('\n') + '\n';
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
async function detected(root: string) {
  const result = await detectProject(root, { envFiles });
  assert.equal(result.truncated, false);
  assert.ok(result.sites.length > 0, 'genuine native/parser detection must produce sites');
  return assignIds(result.sites, result.packages, new Uint8Array(32).fill(7), 'r_' + 'a'.repeat(32));
}

test('Java session id/context gain a final native tag and remain idempotent', async () => {
  const root = project({ 'Caller.java': source() });
  try {
    const rows = await detected(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.site.managed, 'typed-client');
    assert.equal(rows[0]!.site.artifact.kind, 'chatflow');
    assert.equal(rows[0]!.site.artifact.id, 'cf_session');
    assert.deepEqual(tagCallSites(root, rows), ['Caller.java']);
    assert.ok(read(root, 'Caller.java').includes(`startSession("cf_session", ${context}, com.swfte.sdk.CallSite.of("${rows[0]!.id}"))`));
    const again = await detected(root);
    assert.equal(again[0]!.id, rows[0]!.id);
    assert.deepEqual(tagCallSites(root, again), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Java explicit final third tag is rebound once without duplication', async () => {
  const root = project({ 'Caller.java': source(`"cf_session", ${context}, com.swfte.sdk.CallSite.of("cs_${'0'.repeat(24)}")`) });
  try {
    const rows = await detected(root);
    assert.deepEqual(tagCallSites(root, rows), ['Caller.java']);
    const text = read(root, 'Caller.java');
    assert.equal(text.split('CallSite.of(').length - 1, 1);
    assert.ok(text.includes(`, com.swfte.sdk.CallSite.of("${rows[0]!.id}"))`));
    assert.deepEqual(tagCallSites(root, await detected(root)), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Unknown session arity and misplaced or opaque tags leave the whole batch untouched', async () => {
  const tag = `com.swfte.sdk.CallSite.of("cs_${'0'.repeat(24)}")`;
  for (const args of ['', '"cf_session"', `"cf_session", ${context}, opaque`,
    `"cf_session", ${context}, opaqueCallSite`, `"cf_session", ${context}, null, ${tag}`,
    `"cf_session", ${tag}`, `"cf_session", ${tag}, opaque`]) {
    const root = project({ 'A.java': source(), 'B.java': source() });
    try {
      const rows = await detected(root); // Real sites precede a late incompatible source edit.
      assert.equal(rows.length, 2);
      writeFileSync(join(root, 'B.java'), source(args));
      const before = ['A.java', 'B.java'].map(path => read(root, path));
      assert.throws(() => tagCallSites(root, rows), /Unknown Java session overload/);
      assert.deepEqual(['A.java', 'B.java'].map(path => read(root, path)), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('Genuinely detected same-line session ambiguity refuses the whole batch', async () => {
  const doubled = source().replace(');\n}}', '); client.chatflows().startSession("cf_second", Map.of());\n}}');
  const root = project({ 'A.java': source(), 'B.java': doubled });
  try {
    const rows = await detected(root);
    assert.equal(rows.length, 3);
    const before = ['A.java', 'B.java'].map(path => read(root, path));
    assert.throws(() => tagCallSites(root, rows), /one supported SDK call/);
    assert.deepEqual(['A.java', 'B.java'].map(path => read(root, path)), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Foreign session receiver or managed authority cannot commit any planned file', async () => {
  for (const foreign of ['receiver', 'managed'] as const) {
    const root = project({ 'A.java': source(), 'B.java': source() });
    try {
      const rows = await detected(root);
      assert.equal(rows.length, 2);
      if (foreign === 'receiver') writeFileSync(join(root, 'B.java'), source(undefined, 'workflows'));
      else rows[1] = { ...rows[1]!, site: { ...rows[1]!.site, managed: 'raw-http' } }; // Negative authority corruption only.
      const before = ['A.java', 'B.java'].map(path => read(root, path));
      assert.throws(() => tagCallSites(root, rows), foreign === 'receiver' ? /Unknown Java session receiver/ : /one supported SDK call/);
      assert.deepEqual(['A.java', 'B.java'].map(path => read(root, path)), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
