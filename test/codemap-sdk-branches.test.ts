import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectProject } from '../src/codemap/detect.js';
import { tagCallSites } from '../src/codemap/tag.js';
import { project, assigned } from './codemap-support.js';
import { DEFAULT_ENV_FILES } from '../src/codemap/walk.js';
const envFiles = { secret: DEFAULT_ENV_FILES.secret, names: DEFAULT_ENV_FILES.names };
// Hand-authored from the three immutable SDK public signatures; expected answers never use scanner output.
const sources = {
  'src/callers.ts': [
    "import Swfte from '@swfte/sdk';",
    'const client = new Swfte({});',
    "client.workflows.invokeVersion('wf_pinned', 3, { first: 1 });",
    "client.workflows.invokeVersionAndWait('wf_wait', 4, { second: 2 }, { timeoutMs: 1000 });",
    "client.chatflows.builder.test('cf_builder', { question: 'hello' }, { callsite: undefined });",
    "client.workflows.invokeVersion('wf_dynamic', requestedVersion, { third: 3 });",
    "client.workflows.invokeVersion('wf_invalid', 0, { fourth: 4 });",
    "client.workflows.invokeVersion('wf_string', '5', { fifth: 5 });",
    "client.workflows.invokeVersion('wf_empty', '', { sixth: 6 });",
  ].join('\n') + '\n',
  'src/callers.py': [
    'from swfte import Swfte',
    'client = Swfte()',
    "client.workflows.invoke_version('wf_pinned', 3, {'first': 1})",
    "client.workflows.invoke_version_and_wait(workflow_id='wf_wait', version=4, inputs={'second': 2})",
    "client.chatflows.test(chatflow_id='cf_builder', input={'question': 'hello'})",
    "client.workflows.invoke_version('wf_dynamic', requested_version, {'third': 3})",
    "client.workflows.invoke_version('wf_invalid', 0, {'fourth': 4})",
    "client.workflows.invoke_version('wf_string', '5', {'fifth': 5})",
    "client.workflows.invoke_version('wf_empty', '', {'sixth': 6})",
  ].join('\n') + '\n',
  'src/Callers.java': [
    'import com.swfte.sdk.SwfteClient;',
    'import java.util.Map;',
    'class Callers { void run(SwfteClient client, int requestedVersion) {',
    'client.workflows().invokeVersion("wf_pinned", 3, Map.of("first", 1));',
    'client.workflows().invokeVersionAndWait("wf_wait", 4, Map.of("second", 2), 1000, 10, false);',
    'client.chatflows().builder().test("cf_builder", Map.of("question", "hello"));',
    'client.workflows().invokeVersion("wf_dynamic", requestedVersion, Map.of("third", 3));',
    'client.workflows().invokeVersion("wf_invalid", 0, Map.of("fourth", 4));',
    'client.workflows().invokeVersion("wf_string", "5", Map.of("fifth", 5));',
    'client.workflows().invokeVersion("wf_empty", "", Map.of("sixth", 6));',
    '} }',
  ].join('\n') + '\n',
};

test('all three SDK version/wait/builder branches have correct pins, inputs and unknown-version refusal', async () => {
  const root = project(sources);
  try {
    const result = await detectProject(root, { envFiles });
    const expected = [
      ['wf_pinned', '3', 'workflow', 'run', ['first']],
      ['wf_wait', '4', 'workflow', 'run', ['second']],
      ['cf_builder', null, 'chatflow', 'chat', ['question']],
      [null, null, 'workflow', 'run', ['third']],
      [null, null, 'workflow', 'run', ['fourth']],
      ['wf_string', '5', 'workflow', 'run', ['fifth']],
      [null, null, 'workflow', 'run', ['sixth']],
    ];
    for (const path of Object.keys(sources)) {
      const sites = result.sites.filter(site => site.relPath === path).sort((a, b) => a.line - b.line);
      assert.equal(sites.length, 7, path);
      assert.deepEqual(sites.map(site => [site.artifact.id, site.artifact.pinnedVersion, site.artifact.kind, site.op, site.inputKeys]), expected, path);
      assert.deepEqual(sites.map(site => site.artifact.unresolved), [false, false, false, true, true, false, true], path);
      assert.deepEqual(sites.map(site => site.category), ['managed', 'managed', 'managed', 'dynamic', 'dynamic', 'managed', 'dynamic'], path);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('builder-shaped decoys on other resources and fork imports do not create call sites', async () => {
  const root = project({
    'src/fork.ts': "import Fork from '@acme/swfte-fork';\nconst client = new Fork();\nclient.chatflows.builder.test('cf_foreign', {q:1});\n",
    'src/other.ts': "import Swfte from '@swfte/sdk';\nclient.workflows.builder.test('wf_wrong', {q:1});\nclient.chatflows.test('cf_wrong', {q:1});\n",
    'src/Other.java': 'import com.swfte.sdk.SwfteClient;\nclass Other { void run(SwfteClient c) { c.workflows().builder().test("wf_wrong", java.util.Map.of()); } }\n',
  });
  try { assert.deepEqual((await detectProject(root, { envFiles })).sites, []); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('tagging Node builder and pinned invoke preserves the actual input and options positions', () => {
  const root = project({
    'builder.ts': "client.chatflows.builder.test('cf_builder', {question:'hello'}, {timeoutMs:1000});\n",
    'pinned.ts': "client.workflows.invokeVersionAndWait('wf_pinned', 3, {question:'hello'}, {timeoutMs:1000});\n",
  });
  try {
    const builder = assigned('builder.ts'); builder.site.artifact = { ...builder.site.artifact, kind: 'chatflow', id: 'cf_builder' };
    assert.equal(tagCallSites(root, [builder, assigned('pinned.ts')]).length, 2);
    for (const path of ['builder.ts', 'pinned.ts']) {
      const text = readFileSync(join(root, path), 'utf8');
      assert.match(text, /\{question:'hello'\}, \{timeoutMs:1000, callsite:/u, path);
      assert(!/question:'hello', callsite:/u.test(text), path);
    }
    assert.deepEqual(tagCallSites(root, [builder, assigned('pinned.ts')]), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
