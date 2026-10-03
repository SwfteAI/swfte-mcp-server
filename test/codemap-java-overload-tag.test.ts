import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { detectProject } from '../src/codemap/detect.js';
import { assignIds } from '../src/codemap/fingerprint.js';
import { tagCallSites } from '../src/codemap/tag.js';
import { project } from './codemap-support.js';

const envFiles = { secret: ['dot-env', 'dot-env.*'], names: ['dot-env.example'] };
const inputs = 'Map.of("question", "hello")';
const oldTag = `com.swfte.sdk.CallSite.of("cs_${'0'.repeat(24)}")`;
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
const source = (call: string, name = 'Caller') => [
  'import com.swfte.sdk.SwfteClient;', 'import com.swfte.sdk.models.AgentChatOptions;', 'import java.util.Map;',
  `class ${name} { void run(SwfteClient client) {`, `  ${call};`, '}}',
].join('\n') + '\n';
async function rows(root: string) {
  const result = await detectProject(root, { envFiles });
  assert.equal(result.truncated, false);
  assert.ok(result.sites.length > 0, 'the actual native detector must admit a managed call');
  assert.ok(result.sites.every(site => site.managed === 'typed-client'));
  return assignIds(result.sites, result.packages, new Uint8Array(32).fill(9), 'r_' + 'b'.repeat(32));
}

const families = [
  { receiver: 'workflows()', method: 'invoke', args: `"wf_overload", ${inputs}`, kind: 'workflow' },
  { receiver: 'workflows()', method: 'invokeVersion', args: `"wf_overload", "release_a", ${inputs}`, kind: 'workflow' },
  { receiver: 'workflows()', method: 'invokeAndWait', args: `"wf_overload", ${inputs}`, kind: 'workflow' },
  { receiver: 'workflows()', method: 'invokeVersionAndWait', args: `"wf_overload", "release_a", ${inputs}`, kind: 'workflow' },
  { receiver: 'workflows()', method: 'execute', args: `"wf_overload", ${inputs}`, kind: 'workflow' },
  { receiver: 'agents()', method: 'chat', args: '"ag_overload", "hello"', kind: 'agent' },
  { receiver: 'chatflows().builder()', method: 'test', args: `"cf_overload", ${inputs}`, kind: 'chatflow' },
  { receiver: 'chatflows()', method: 'startSession', args: `"cf_overload", ${inputs}`, kind: 'chatflow' },
] as const;
const call = (family: typeof families[number], args: string = family.args, receiver: string = family.receiver) =>
  `client.${receiver}.${family.method}(${args})`;

test('four-argument native Java polling preserves timeout and interval while gaining attribution', async () => {
  const initial = source(`client.workflows().invokeAndWait("wf_overload", ${inputs}, 12000L, 250L)`);
  const root = project({ 'Caller.java': initial });
  try {
    const assigned = await rows(root); assert.equal(assigned.length, 1);
    assert.deepEqual(tagCallSites(root, assigned), ['Caller.java']);
    const expected = initial.replace('12000L, 250L)', `12000L, 250L, com.swfte.sdk.CallSite.of("${assigned[0]!.id}"))`);
    assert.equal(read(root, 'Caller.java'), expected);
    const again = await rows(root); assert.equal(again[0]!.id, assigned[0]!.id);
    assert.deepEqual(tagCallSites(root, again), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('all eight genuinely detected Java families gain the final native overload without changing inputs', async () => {
  for (const family of families) {
    const initial = source(call(family)); const root = project({ 'Caller.java': initial });
    try {
      const assigned = await rows(root); assert.equal(assigned.length, 1, family.method);
      assert.equal(assigned[0]!.site.artifact.kind, family.kind);
      assert.deepEqual(tagCallSites(root, assigned), ['Caller.java']);
      const prefix = family.method === 'chat' ? ', null' : '';
      assert.equal(read(root, 'Caller.java'), initial.replace(`${family.args})`,
        `${family.args}${prefix}, com.swfte.sdk.CallSite.of("${assigned[0]!.id}"))`));
      assert.deepEqual(tagCallSites(root, await rows(root)), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('native full polling, pinned int/string revisions, execute boolean and agent options retain every argument', async () => {
  const calls = [
    `client.workflows().invokeAndWait("wf_overload", ${inputs}, 12000L, 250L, true)`,
    `client.workflows().invokeVersionAndWait("wf_overload", 5, ${inputs}, 12000L, 250L, false)`,
    `client.workflows().invokeVersionAndWait("wf_overload", "release_a", ${inputs}, 12000L, 250L, false)`,
    `client.workflows().invokeVersion("wf_overload", 5, ${inputs})`,
    `client.workflows().execute("wf_overload", ${inputs}, false)`,
    'client.agents().chat("ag_overload", "hello", AgentChatOptions.builder().userId("u").build())',
  ];
  for (const native of calls) {
    const initial = source(native); const root = project({ 'Caller.java': initial });
    try {
      const assigned = await rows(root); assert.equal(assigned.length, 1);
      assert.deepEqual(tagCallSites(root, assigned), ['Caller.java']);
      assert.equal(read(root, 'Caller.java'), source(native.slice(0, -1)
        + `, com.swfte.sdk.CallSite.of("${assigned[0]!.id}"))`));
      assert.deepEqual(tagCallSites(root, await rows(root)), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('sole explicit tags are rebound only in the real final native argument positions', async () => {
  const tagged = families.map(family => call(family, family.args + (family.method === 'chat' ? ', null' : '') + `, ${oldTag}`));
  tagged.push(`client.workflows().invokeAndWait("wf_overload", ${inputs}, 12000L, 250L, ${oldTag})`,
    `client.workflows().invokeAndWait("wf_overload", ${inputs}, 12000L, 250L, false, ${oldTag})`,
    `client.workflows().invokeVersionAndWait("wf_overload", 5, ${inputs}, 12000L, 250L, false, ${oldTag})`,
    `client.workflows().execute("wf_overload", ${inputs}, true, ${oldTag})`);
  for (const native of tagged) {
    const initial = source(native); const root = project({ 'Caller.java': initial });
    try {
      const assigned = await rows(root); assert.equal(assigned.length, 1);
      assert.deepEqual(tagCallSites(root, assigned), ['Caller.java']);
      assert.equal(read(root, 'Caller.java'), initial.replace(oldTag, `com.swfte.sdk.CallSite.of("${assigned[0]!.id}")`));
      assert.equal(read(root, 'Caller.java').split('CallSite.of(').length - 1, 1);
      assert.deepEqual(tagCallSites(root, await rows(root)), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('late misplaced, duplicate and unsupported explicit tags refuse every planned source file', async () => {
  for (const family of families) {
    const invalid = [oldTag, `${oldTag}, ${family.args.split(', ').slice(1).join(', ')}`,
      `${family.args}, opaque, opaque, opaque, opaque, ${oldTag}`, `${family.args}, ${oldTag}, ${oldTag}`];
    if (family.method === 'chat') invalid.push(`${family.args}, ${oldTag}`); // No three-argument CallSite overload.
    for (const args of invalid) {
      const initialA = source(call(families[0]), 'A'); const initialB = source(call(family), 'B');
      const root = project({ 'A.java': initialA, 'B.java': initialB });
      try {
        const assigned = await rows(root); assert.equal(assigned.length, 2);
        writeFileSync(join(root, 'B.java'), source(call(family, args), 'B'));
        const before = ['A.java', 'B.java'].map(path => read(root, path));
        assert.throws(() => tagCallSites(root, assigned), /Unknown Java .*overload/);
        assert.deepEqual(['A.java', 'B.java'].map(path => read(root, path)), before);
        writeFileSync(join(root, 'B.java'), initialB);
        assert.deepEqual(tagCallSites(root, assigned).sort(), ['A.java', 'B.java']);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test('late foreign resource receivers with final explicit tags cannot bypass whole-batch admission', async () => {
  for (const family of families) {
    const initialA = source(call(families[0]), 'A'); const initialB = source(call(family), 'B');
    const root = project({ 'A.java': initialA, 'B.java': initialB });
    try {
      const assigned = await rows(root); assert.equal(assigned.length, 2);
      const receiver = family.receiver.startsWith('workflows') ? 'agents()' : 'workflows()';
      const args = family.args + (family.method === 'chat' ? ', null' : '') + `, ${oldTag}`;
      writeFileSync(join(root, 'B.java'), source(call(family, args, receiver), 'B'));
      const before = ['A.java', 'B.java'].map(path => read(root, path));
      assert.throws(() => tagCallSites(root, assigned), /Unknown Java .*receiver/);
      assert.deepEqual(['A.java', 'B.java'].map(path => read(root, path)), before);
      writeFileSync(join(root, 'B.java'), initialB);
      assert.deepEqual(tagCallSites(root, assigned).sort(), ['A.java', 'B.java']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
