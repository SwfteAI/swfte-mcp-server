import test from 'node:test';
import assert from 'node:assert/strict';
import { Parser, Language, type Tree } from 'web-tree-sitter';
import * as python from '../src/codemap/detectors/py/parse.js';
import * as java from '../src/codemap/detectors/java/parse.js';
import { DETECTORS as pythonDetectors, releaseAnalysis as releasePython } from '../src/codemap/detectors/py/index.js';
import { DETECTORS as javaDetectors, releaseAnalysis as releaseJava } from '../src/codemap/detectors/java/index.js';
import type { DetectContext, SourceFile } from '../src/codemap/types.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

// The wrappers observe real installed native Parser instances; no substitute parser/store is used.
for (const grammar of [
  { name: 'Python', module: python, init: python.initPythonParser, detectors: pythonDetectors, release: releasePython,
    file: { relPath: 'caller.py', language: 'python', text: "from swfte import SwfteClient\nclient = SwfteClient(api_key='fixture')\nclient.workflows.invoke('wf_reload', {})\n" } as SourceFile },
  { name: 'Java', module: java, init: java.initJavaParser, detectors: javaDetectors, release: releaseJava,
    file: { relPath: 'Caller.java', language: 'java', text: 'import com.swfte.sdk.SwfteClient; class Caller {void run(SwfteClient client){client.workflows().invoke("wf_reload",null);}}' } as SourceFile },
]) {
  test(`${grammar.name} real parser reload ownership, ordered failures and generation-bound sites`, { concurrency: false }, async () => {
    const actualDelete = Parser.prototype.delete, actualParse = Parser.prototype.parse;
    const actualSet = Parser.prototype.setLanguage, actualLoad = Language.load;
    const deleted = new Map<Parser,number>(), created: Parser[] = [];
    let active: Parser | undefined, setupFailure = false, disposalFailure: Parser | undefined;
    let unblock: (() => void) | undefined;
    let parseFailure = false;
    Parser.prototype.parse = function(...args: Parameters<typeof actualParse>) { active = this; if (parseFailure) { parseFailure = false; throw new Error('controlled native parse adapter failure'); } return actualParse.apply(this,args); };
    Parser.prototype.setLanguage = function(language) { created.push(this); if (setupFailure) { setupFailure = false; throw new Error('controlled setup failure'); } return actualSet.call(this,language); };
    Parser.prototype.delete = function() {
      deleted.set(this,(deleted.get(this) ?? 0) + 1);
      assert.equal(deleted.get(this),1,'owned real Parser must never be double deleted');
      actualDelete.call(this);
      if (this === disposalFailure) { disposalFailure = undefined; throw new Error('controlled disposal failure after real free'); }
    };
    const ctx: DetectContext = { locks: [], lockDir: null };
    const sites = () => grammar.detectors.flatMap(detector => detector.detect(grammar.file,ctx).sites);
    const parse = () => { assert(grammar.module.withTree(grammar.file.text,root => root.type),'real native grammar must parse'); assert(active); return active!; };
    try {
      const first = parse(), start = grammar.module.grammarGeneration;
      const baseline = sites(); assert(baseline.some(site => site.artifact.id === 'wf_reload'),'real managed positive');
      assert.equal(await grammar.init(),true); assert.equal(deleted.get(first),1); assert.equal(grammar.module.grammarGeneration,start+1);
      const second = parse(); assert.notEqual(second,first); assert.deepEqual(sites(),baseline);
      assert.equal(await grammar.init('/missing/codemap-grammar-r7.wasm'),false);
      assert.equal(deleted.get(second),1); assert.equal(grammar.module.grammarGeneration,start+2);
      assert.equal(grammar.module.withTree(grammar.file.text,() => true),null); assert.deepEqual(sites(),[],'generation invalidates same-file positive cache');
      assert.equal(await grammar.init('/missing/codemap-grammar-r7.wasm'),false); assert.equal(grammar.module.grammarGeneration,start+3);
      assert.equal(await grammar.init(),true); assert.deepEqual(sites(),baseline); const prior = parse();
      setupFailure = true; const count = created.length; const generation = grammar.module.grammarGeneration;
      assert.equal(await grammar.init(),false); assert.equal(created.length,count+1);
      assert.equal(deleted.get(created[count]!),1,'setLanguage failure frees actual fresh candidate'); assert.equal(deleted.get(prior),1);
      assert.equal(grammar.module.grammarGeneration,generation+1); assert.equal(grammar.module.withTree(grammar.file.text,() => true),null);
      assert.equal(await grammar.init(),true);

      const entered = deferred(), release = deferred(); unblock = release.resolve; let loads = 0;
      Language.load = async function(input) { loads++; if (loads === 1) { entered.resolve(); await release.promise; } return actualLoad.call(Language,input); };
      const beforeQueue = parse(), queueGeneration = grammar.module.grammarGeneration, queuedCreated = created.length;
      const one = grammar.init(); await entered.promise;
      const two = grammar.init('/missing/codemap-grammar-r7.wasm'), three = grammar.init();
      assert.equal(parse(),beforeQueue,'old parser remains usable while load pending');
      assert.equal(deleted.get(beforeQueue),undefined); assert.equal(grammar.module.grammarGeneration,queueGeneration); assert.equal(loads,1);
      release.resolve(); assert.deepEqual(await Promise.all([one,two,three]),[true,false,true]);
      assert.equal(loads,2,'missing file failure occurs before Language.load'); assert.equal(grammar.module.grammarGeneration,queueGeneration+3);
      assert.equal(deleted.get(beforeQueue),1); assert.equal(deleted.get(created[queuedCreated]!),1,'middle failed attempt retires prior successful candidate'); assert.deepEqual(sites(),baseline);
      Language.load = actualLoad;

      let callbackParser: Parser | undefined, callbackTree: Tree | undefined, pending: Promise<boolean> | undefined;
      let callbackAlive = false, callbackContent = false;
      const callbackGeneration = grammar.module.grammarGeneration;
      grammar.module.withTree(grammar.file.text,root => { callbackParser = active; callbackTree = root.tree; pending = grammar.init();
        callbackAlive = deleted.get(callbackParser!) === undefined; callbackContent = root.text.includes('wf_reload'); throw new Error('controlled visitor failure'); });
      assert(callbackAlive,'queued reload cannot dispose during synchronous callback'); assert(callbackContent,'native AST remains readable during callback');
      assert(callbackTree); assert.equal(Object.getOwnPropertyDescriptor(callbackTree,'0')?.value,0,'native tree freed even after visitor error');
      assert.equal(deleted.get(callbackParser!),undefined); assert.equal(await pending,true); assert.equal(deleted.get(callbackParser!),1);
      assert.equal(grammar.module.grammarGeneration,callbackGeneration+1); assert.deepEqual(sites(),baseline);

      const parseErrorGeneration = grammar.module.grammarGeneration; let visited = false;
      parseFailure = true;
      assert.equal(grammar.module.withTree(grammar.file.text,() => { visited = true; return true; }),null);
      assert.equal(visited,false); assert.equal(grammar.module.grammarGeneration,parseErrorGeneration);
      parse(); assert.deepEqual(sites(),baseline,'native parse refusal does not invalidate healthy parser');

      const faulted = parse(); disposalFailure = faulted; const faultGeneration = grammar.module.grammarGeneration;
      const failed = grammar.init(); const recovery = grammar.init();
      await assert.rejects(failed,/controlled disposal failure/); assert.equal(await recovery,true);
      assert.equal(deleted.get(faulted),1); assert.equal(grammar.module.grammarGeneration,faultGeneration+2); assert.deepEqual(sites(),baseline);
      for (const value of deleted.values()) assert.equal(value,1);
    } finally {
      unblock?.();
      Language.load = actualLoad; Parser.prototype.delete = actualDelete; Parser.prototype.parse = actualParse; Parser.prototype.setLanguage = actualSet;
      grammar.release(); await grammar.init();
    }
  });
}
