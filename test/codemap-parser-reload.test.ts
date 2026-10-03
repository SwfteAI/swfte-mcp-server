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
    const deletionAttempts = new Map<Parser,number>(), created: Parser[] = [];
    const actuallyFreed = new Set<Parser>(), retainedBeforeFree = new Set<Parser>();
    let refuseCandidateBeforeFree = false, beforeFreeFailure: Parser | undefined;
    let active: Parser | undefined, setupFailure = false, disposalFailure: Parser | undefined;
    let unblock: (() => void) | undefined;
    let parseFailure = false;
    Parser.prototype.parse = function(...args: Parameters<typeof actualParse>) { active = this; if (parseFailure) { parseFailure = false; throw new Error('controlled native parse adapter failure'); } return actualParse.apply(this,args); };
    Parser.prototype.setLanguage = function(language) { created.push(this); if (setupFailure) { setupFailure = false; if(refuseCandidateBeforeFree){refuseCandidateBeforeFree=false;beforeFreeFailure=this;} throw new Error('controlled setup failure'); } return actualSet.call(this,language); };
    Parser.prototype.delete = function() {
      deletionAttempts.set(this,(deletionAttempts.get(this) ?? 0) + 1);
      assert.equal(deletionAttempts.get(this),1,'production ownership must attempt disposal only once');
      if(this === beforeFreeFailure){beforeFreeFailure=undefined;retainedBeforeFree.add(this);throw new Error('controlled disposal refusal before native free');}
      actualDelete.call(this); actuallyFreed.add(this);
      if (this === disposalFailure) { disposalFailure = undefined; throw new Error('controlled disposal failure after real free'); }
    };
    const ctx: DetectContext = { locks: [], lockDir: null };
    const sites = () => grammar.detectors.flatMap(detector => detector.detect(grammar.file,ctx).sites);
    const parse = () => { assert(grammar.module.withTree(grammar.file.text,root => root.type),'real native grammar must parse'); assert(active); return active!; };
    try {
      const first = parse(), start = grammar.module.grammarGeneration;
      const baseline = sites(); assert(baseline.some(site => site.artifact.id === 'wf_reload'),'real managed positive');
      assert.equal(await grammar.init(),true); assert.equal(deletionAttempts.get(first),1); assert.equal(grammar.module.grammarGeneration,start+1);
      const second = parse(); assert.notEqual(second,first); assert.deepEqual(sites(),baseline);
      assert.equal(await grammar.init('/missing/codemap-grammar-r7.wasm'),false);
      assert.equal(deletionAttempts.get(second),1); assert.equal(grammar.module.grammarGeneration,start+2);
      assert.equal(grammar.module.withTree(grammar.file.text,() => true),null); assert.deepEqual(sites(),[],'generation invalidates same-file positive cache');
      assert.equal(await grammar.init('/missing/codemap-grammar-r7.wasm'),false); assert.equal(grammar.module.grammarGeneration,start+3);
      assert.equal(await grammar.init(),true); assert.deepEqual(sites(),baseline); const prior = parse();
      setupFailure = true; const count = created.length; const generation = grammar.module.grammarGeneration;
      assert.equal(await grammar.init(),false); assert.equal(created.length,count+1);
      assert.equal(deletionAttempts.get(created[count]!),1,'setLanguage failure frees actual fresh candidate'); assert.equal(deletionAttempts.get(prior),1);
      assert.equal(grammar.module.grammarGeneration,generation+1); assert.equal(grammar.module.withTree(grammar.file.text,() => true),null);
      assert.equal(await grammar.init(),true);

      const beforeRefusal = parse(), refusalGeneration = grammar.module.grammarGeneration, refusalCount = created.length;
      setupFailure=true;refuseCandidateBeforeFree=true;
      const refusedSetup=grammar.init();
      await assert.rejects(refusedSetup,/controlled disposal refusal before native free/);
      const retainedCandidate=created[refusalCount]!;
      assert.equal(created.length,refusalCount+1);assert.equal(deletionAttempts.get(retainedCandidate),1,'candidate disposal was attempted');
      assert.equal(actuallyFreed.has(retainedCandidate),false,'pre-free refusal is never certified as native free');
      assert.equal(retainedBeforeFree.has(retainedCandidate),true);
      assert.equal(deletionAttempts.get(beforeRefusal),1,'old parser disposal must still be attempted after candidate refusal');
      assert.equal(actuallyFreed.has(beforeRefusal),true,'old parser really freed independently');
      assert.equal(grammar.module.grammarGeneration,refusalGeneration+1);
      assert.equal(grammar.module.withTree(grammar.file.text,()=>true),null,'failed setup has no live parser');
      assert.equal(await grammar.init(),true);assert.deepEqual(sites(),baseline);
      assert.equal(deletionAttempts.get(retainedCandidate),1,'recovery cannot retry the detached refused candidate');

      // A rejected real Language.load path is setup refusal, not a deletion rejection.
      const beforeLoadRefusal=parse(), loadRefusalGeneration=grammar.module.grammarGeneration;let rejectNextLoad=true;
      Language.load=async function(input){if(rejectNextLoad){rejectNextLoad=false;throw new Error('controlled Language.load rejection');}return actualLoad.call(Language,input);};
      const refusedLoad=grammar.init(), recoveredLoad=grammar.init();
      assert.deepEqual(await Promise.all([refusedLoad,recoveredLoad]),[false,true]);
      assert.equal(deletionAttempts.get(beforeLoadRefusal),1);assert.equal(actuallyFreed.has(beforeLoadRefusal),true);
      assert.equal(grammar.module.grammarGeneration,loadRefusalGeneration+2);assert.deepEqual(sites(),baseline);
      Language.load=actualLoad;
      const beforeMissing=parse(), missingGeneration=grammar.module.grammarGeneration;
      const missingQueued=grammar.init('/missing/codemap-grammar-vector-r7.wasm'), afterMissing=grammar.init();
      assert.deepEqual(await Promise.all([missingQueued,afterMissing]),[false,true]);
      assert.equal(deletionAttempts.get(beforeMissing),1);assert.equal(actuallyFreed.has(beforeMissing),true);
      assert.equal(grammar.module.grammarGeneration,missingGeneration+2);assert.deepEqual(sites(),baseline);

      const entered = deferred(), release = deferred(); unblock = release.resolve; let loads = 0;
      Language.load = async function(input) { loads++; if (loads === 1) { entered.resolve(); await release.promise; } return actualLoad.call(Language,input); };
      const beforeQueue = parse(), queueGeneration = grammar.module.grammarGeneration, queuedCreated = created.length;
      const one = grammar.init(); await entered.promise;
      const two = grammar.init('/missing/codemap-grammar-r7.wasm'), three = grammar.init();
      assert.equal(parse(),beforeQueue,'old parser remains usable while load pending');
      assert.equal(deletionAttempts.get(beforeQueue),undefined); assert.equal(grammar.module.grammarGeneration,queueGeneration); assert.equal(loads,1);
      release.resolve(); assert.deepEqual(await Promise.all([one,two,three]),[true,false,true]);
      assert.equal(loads,2,'missing file failure occurs before Language.load'); assert.equal(grammar.module.grammarGeneration,queueGeneration+3);
      assert.equal(deletionAttempts.get(beforeQueue),1); assert.equal(deletionAttempts.get(created[queuedCreated]!),1,'middle failed attempt retires prior successful candidate'); assert.deepEqual(sites(),baseline);
      Language.load = actualLoad;

      let callbackParser: Parser | undefined, callbackTree: Tree | undefined, pending: Promise<boolean> | undefined;
      let callbackAlive = false, callbackContent = false;
      const callbackGeneration = grammar.module.grammarGeneration;
      grammar.module.withTree(grammar.file.text,root => { callbackParser = active; callbackTree = root.tree; pending = grammar.init();
        callbackAlive = deletionAttempts.get(callbackParser!) === undefined; callbackContent = root.text.includes('wf_reload'); throw new Error('controlled visitor failure'); });
      assert(callbackAlive,'queued reload cannot dispose during synchronous callback'); assert(callbackContent,'native AST remains readable during callback');
      assert(callbackTree); assert.equal(Object.getOwnPropertyDescriptor(callbackTree,'0')?.value,0,'native tree freed even after visitor error');
      assert.equal(deletionAttempts.get(callbackParser!),undefined); assert.equal(await pending,true); assert.equal(deletionAttempts.get(callbackParser!),1);
      assert.equal(grammar.module.grammarGeneration,callbackGeneration+1); assert.deepEqual(sites(),baseline);

      const parseErrorGeneration = grammar.module.grammarGeneration; let visited = false;
      parseFailure = true;
      assert.equal(grammar.module.withTree(grammar.file.text,() => { visited = true; return true; }),null);
      assert.equal(visited,false); assert.equal(grammar.module.grammarGeneration,parseErrorGeneration);
      parse(); assert.deepEqual(sites(),baseline,'native parse refusal does not invalidate healthy parser');

      const faulted = parse(); disposalFailure = faulted; const faultGeneration = grammar.module.grammarGeneration;
      const failed = grammar.init(); const recovery = grammar.init();
      await assert.rejects(failed,/controlled disposal failure/); assert.equal(await recovery,true);
      assert.equal(deletionAttempts.get(faulted),1); assert.equal(grammar.module.grammarGeneration,faultGeneration+2); assert.deepEqual(sites(),baseline);
      for (const value of deletionAttempts.values()) assert.equal(value,1);
    } finally {
      unblock?.();
      Language.load = actualLoad; Parser.prototype.delete = actualDelete; Parser.prototype.parse = actualParse; Parser.prototype.setLanguage = actualSet;
      // Test-owned pre-free refusals are known retained allocations; restore native disposal first.
      for(const resource of retainedBeforeFree){
        assert.equal(actuallyFreed.has(resource),false);actualDelete.call(resource);actuallyFreed.add(resource);
        assert.equal(Object.getOwnPropertyDescriptor(resource,'0')?.value,0,'test retained parser genuinely freed after hook restoration');
      }
      retainedBeforeFree.clear();
      grammar.release(); await grammar.init();
    }
  });
}
