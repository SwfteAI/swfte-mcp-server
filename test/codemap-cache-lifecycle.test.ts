import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProject } from '../src/codemap/detect.js';
import { getParsed } from '../src/codemap/detectors/ts/parse.js';
import { DETECTORS as typescriptDetectors } from '../src/codemap/detectors/ts/index.js';
import { children as javaChildren, lookupName as javaLookup, walk as javaWalk, withTree as javaTree } from '../src/codemap/detectors/java/parse.js';
import { children as pythonChildren, lookupName as pythonLookup, walk as pythonWalk, withTree as pythonTree } from '../src/codemap/detectors/py/parse.js';
import type { Node as NativeNode, Tree as NativeTree } from 'web-tree-sitter';
import type { DetectContext, DetectedSite, Detector, SourceFile } from '../src/codemap/types.js';

const text = 'export const target = "wf_lifecycle";';
const file: SourceFile = { relPath: 'main.ts', language: 'typescript', text };
const emptyResult = () => ({ sites: [], implementations: [], envVarNames: [] });

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'codemap-lifecycle-'));
  try { await writeFile(join(root, file.relPath), text); await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('parses are shared inside one detector dispatch and released after a successful scan', async () => {
  await fixture(async root => {
    const parsed = getParsed(file);
    let visits = 0;
    const observer: Detector = { id: 'lifecycle-observer', languages: ['typescript'], detect(source) {
      assert.equal(getParsed(source), parsed, 'the same file must share one parse within its dispatch');
      visits++; return emptyResult();
    } };
    const result = await detectProject(root, { detectors: [observer, observer] });
    assert.equal(visits, 2); assert.equal(result.filesScanned, 1); assert.equal(result.truncated, false);
    assert(getParsed(file) !== parsed, 'a finished scan must release its retained source AST');
  });
});

test('a throwing detector preserves incomplete status and releases its source AST', async () => {
  await fixture(async root => {
    const parsed = getParsed(file);
    const broken: Detector = { id: 'lifecycle-throw', languages: ['typescript'], detect(source) {
      assert.equal(getParsed(source), parsed); throw new Error('intentional detector refusal');
    } };
    const result = await detectProject(root, { detectors: [broken] });
    assert.equal(result.truncated, true); assert.equal(result.sites.length, 0);
    assert(getParsed(file) !== parsed, 'a failed detector must not retain its last source AST');
  });
});

test('aborted preprocessing releases a previously retained AST and still reports the original error', async () => {
  await fixture(async root => {
    const parsed = getParsed(file);
    await assert.rejects(detectProject(root, { preprocess() { throw new Error('intentional preprocessing refusal'); } }),
      /intentional preprocessing refusal/);
    assert(getParsed(file) !== parsed, 'aborting before detector dispatch must release retained source');
  });
});

test('an empty scan releases previous source state without inventing call sites', async () => {
  await fixture(async root => {
    const parsed = getParsed(file); const empty = join(root, 'empty'); await mkdir(empty);
    const result = await detectProject(empty);
    assert.equal(result.filesScanned, 0); assert.equal(result.sites.length, 0);
    assert(getParsed(file) !== parsed, 'an empty scan boundary must release prior source state');
  });
});

test('permanent TypeScript detector functions share their memo only inside the file dispatch', async () => {
  await fixture(async root => {
    const source = `import Swfte from '@swfte/sdk';
import { SwfteChatWidget } from '@swfte/chat-widget';
const client = new Swfte({});
export async function run() {
  await client.workflows.invoke('wf_managed_lifecycle', {});
  await fetch('https://api.swfte.com/agents/v2/workflows/wf_raw_lifecycle/invoke', {method:'POST'});
}
export function mount(){new SwfteChatWidget({agentId:'ag_widget_lifecycle'});}
`;
    await writeFile(join(root, file.relPath), source);
    const detectors = ['ts.managed', 'ts.raw-http', 'ts.widget'].map(id => typescriptDetectors.find(detector => detector.id === id)!);
    let prior: DetectedSite[] = []; let observedFile: SourceFile | undefined; let observedContext: DetectContext | undefined;
    let visits = 0;
    const observer: Detector = { id: 'memo-lifecycle-observer', languages: ['typescript'], detect(input, context) {
      const sites = detectors.map(detector => {
        const result = detector.detect(input, context); assert.equal(result.sites.length, 1); return result.sites[0]!;
      });
      if (visits === 0) { prior = sites; observedFile = input; observedContext = context; }
      else sites.forEach((site, index) => assert.equal(site, prior[index], 'each real analysis must be shared during dispatch'));
      visits++; return emptyResult();
    } };
    const result = await detectProject(root, { detectors: [observer, observer] });
    assert.equal(visits, 2); assert.equal(result.truncated, false);
    assert.deepEqual(prior.map(site => site.artifact.id), ['wf_managed_lifecycle', 'wf_raw_lifecycle', 'ag_widget_lifecycle']);
    detectors.forEach((detector, index) => {
      const next = detector.detect(observedFile!, observedContext!).sites[0]!;
      assert.equal(next.artifact.id, prior[index]!.artifact.id);
      assert(next !== prior[index], 'a completed scan must release the function-keyed source/context/result memo');
    });
  });
});

test('Python reparses the same path with changed bindings and does not resurrect the old tree', async () => {
  await fixture(async root => {
    await rm(join(root, file.relPath));
    for (const id of ['wf_python_first', 'wf_python_second']) {
      await writeFile(join(root, 'main.py'), `from swfte import SwfteClient\nclient = SwfteClient(api_key="fixture")\ndef run():\n    target = "${id}"\n    return client.workflows.invoke(target, {"value": 1})\n`);
      const result = await detectProject(root);
      assert.equal(result.truncated, false); assert.deepEqual(result.sites.map(site => site.artifact.id), [id]);
    }
  });
});

test('Java reparses the same path with changed bindings and does not resurrect the old tree', async () => {
  await fixture(async root => {
    await rm(join(root, file.relPath));
    for (const id of ['wf_java_first', 'wf_java_second']) {
      await writeFile(join(root, 'Main.java'), `import com.swfte.sdk.SwfteClient;\nclass Main {void run(SwfteClient client) {String target="${id}";client.workflows().invoke(target, null);}}\n`);
      const result = await detectProject(root);
      assert.equal(result.truncated, false); assert.deepEqual(result.sites.map(site => site.artifact.id), [id]);
    }
  });
});

test('native trees are released even when an indexed callback throws', () => {
  let javaAddress: object | undefined; let pythonAddress: object | undefined;
  const javaResult = javaTree('class Main {void run(){String target="wf_java";probe(target);}}', root => {
    javaAddress = root.tree;
    javaWalk(root, node => { if (node.type === 'identifier' && node.text === 'target') javaLookup('target', node); });
    throw new Error('intentional Java callback refusal');
  });
  const pythonResult = pythonTree('target = "wf_python"\nprobe(target)\n', root => {
    pythonAddress = root.tree;
    pythonWalk(root, node => { if (node.type === 'identifier' && node.text === 'target') pythonLookup('target', node); });
    throw new Error('intentional Python callback refusal');
  });
  assert.equal(javaResult, null); assert.equal(pythonResult, null);
  assert(javaAddress && pythonAddress, 'real grammars must invoke both callbacks');
  assert.equal(Object.getOwnPropertyDescriptor(javaAddress, '0')?.value, 0, 'Java native resource freed');
  assert.equal(Object.getOwnPropertyDescriptor(pythonAddress, '0')?.value, 0, 'Python native resource freed');
});

for (const grammar of [
  { language: 'Python', tree: pythonTree, walk: pythonWalk, children: pythonChildren, pruneType: 'function_definition',
    source: '# visible comment\nlabel = "wf_first"\ndef run():\n    target = "wf_x"\n    invoke(target)\n' },
  { language: 'Java', tree: javaTree, walk: javaWalk, children: javaChildren, pruneType: 'class_declaration',
    source: '// visible comment\nclass Main {void run(){String target="wf_x";invoke(target);}}\n' },
]) {
  test(`${grammar.language} native named-child vectors reuse wrappers and preserve arrays, comments and pruning`, () => {
    let nativeTree: NativeTree | undefined;
    const observation = grammar.tree(grammar.source, root => {
      nativeTree = root.tree;
      const prototype = Object.getPrototypeOf(root) as { namedChild: (this: NativeNode, index: number) => NativeNode | null };
      const actualAdapter = prototype.namedChild;
      let calls = 0;
      prototype.namedChild = function(index) { calls++; return actualAdapter.call(this, index); };
      try {
        const first: NativeNode[] = []; const second: NativeNode[] = [];
        grammar.walk(root, node => { first.push(node); });
        const firstCalls = calls;
        grammar.walk(root, node => { second.push(node); });
        const secondCalls = calls - firstCalls;
        const mutable = grammar.children(root); const pristine = grammar.children(root);
        mutable.length = 0;
        const afterMutation = grammar.children(root);
        const branch = pristine.find(node => node.type === grammar.pruneType);
        if (!branch) throw new Error('actual grammar must expose the branch used for pruning');
        const branchIds = new Set<number>(); const prunedIds = new Set<number>();
        grammar.walk(branch, node => { branchIds.add(node.id); });
        grammar.walk(root, node => { prunedIds.add(node.id); if (node.id === branch.id) return false; });
        return { firstCalls, secondCalls,
          sameNodes: first.length === second.length && first.every((node, index) => node === second[index]),
          separateArrays: mutable !== pristine && pristine !== afterMutation,
          expectedChildren: pristine.map(node => node.id), actualChildren: afterMutation.map(node => node.id),
          includesComment: first.some(node => /comment/.test(node.type)),
          childIncludesComment: pristine.some(node => /comment/.test(node.type)),
          branchDescendants: branchIds.size - 1, visitsPrunedBranch: prunedIds.has(branch.id),
          visitsPrunedDescendant: [...branchIds].some(id => id !== branch.id && prunedIds.has(id)) };
      } finally {
        prototype.namedChild = actualAdapter;
      }
    });
    assert(observation, 'actual grammar must execute both walks');
    assert(observation.firstCalls > 0, 'the first walk must call the actual native adapter');
    assert.equal(observation.secondCalls, 0, 'repeated native traversal must reuse its child wrappers');
    assert.equal(observation.sameNodes, true, 'a single native tree must retain node identities across helper walks');
    assert.equal(observation.separateArrays, true, 'each caller owns its returned children array');
    assert.deepEqual(observation.actualChildren, observation.expectedChildren, 'caller mutation cannot poison the tree traversal');
    assert.equal(observation.includesComment, true, 'walk must preserve comment visits');
    assert.equal(observation.childIncludesComment, grammar.language === 'Python', 'Java children must still exclude comments');
    assert(observation.branchDescendants > 0); assert.equal(observation.visitsPrunedBranch, true);
    assert.equal(observation.visitsPrunedDescendant, false, 'false-return visitors prune precisely that subtree');
    assert(nativeTree, 'actual grammar must create a native tree');
    assert.equal(Object.getOwnPropertyDescriptor(nativeTree, '0')?.value, 0, 'native tree released after repeated helper walks');
  });
}
