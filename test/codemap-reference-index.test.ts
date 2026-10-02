import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DETECTORS as TS, releaseAnalysis as releaseTS } from '../src/codemap/detectors/ts/index.js';
import { DETECTORS as PY, releaseAnalysis as releasePY } from '../src/codemap/detectors/py/index.js';
import { DETECTORS as JAVA, releaseAnalysis as releaseJava } from '../src/codemap/detectors/java/index.js';
import { releaseParsedSource } from '../src/codemap/detectors/ts/parse.js';
import { detectProject } from '../src/codemap/detect.js';
import type { Detector, DetectedSite, SourceLanguage } from '../src/codemap/types.js';
import typescript from 'typescript';
import { parseSource } from '../src/codemap/detectors/ts/common.js';
import { inputKeysOf, outputKeysOf } from '../src/codemap/detectors/ts/keys.js';
import { withTree as withPythonTree, walk as walkPython, children as pythonChildren } from '../src/codemap/detectors/py/parse.js';
import { inputKeys as pythonInput, outputKeys as pythonOutput } from '../src/codemap/detectors/py/keys.js';
import { withTree as withJavaTree, walk as walkJava, argsOf as javaArgs } from '../src/codemap/detectors/java/parse.js';
import { inputKeys as javaInput, outputKeys as javaOutput } from '../src/codemap/detectors/java/keys.js';

function scan(language: SourceLanguage, text: string): DetectedSite[] {
 const detectors: Detector[] = language === 'typescript' ? TS : language === 'python' ? PY : JAVA;
 try {
  const file = {relPath: language === 'typescript' ? 'caller.ts' : language === 'python' ? 'caller.py' : 'Caller.java', language, text};
  const ctx = {locks: [], lockDir: null};
  return detectors.flatMap(d => d.detect(file, ctx).sites).sort((a,b) => a.line-b.line);
 } finally { releaseTS(); releasePY(); releaseJava(); releaseParsedSource(); }
}
const ts = (body: string) => "import Swfte from '@swfte/sdk'; const client = new Swfte({});\nfunction run() {\n"+body+'\n}';
const py = (body: string) => 'from swfte import SwfteClient\nclient = SwfteClient()\ndef run():\n'+body+'\n';
const java = (body: string) => 'import com.swfte.sdk.SwfteClient; import java.util.*; class Caller { SwfteClient client; void run() {\n'+body+'\n}}';

test('actual three-language detectors keep many independent named input/result paths', () => {
 const count = 48;
 const source = {
  typescript: ts(Array.from({length:count},(_,i)=>`const input_${i}={key_${i}:1}; const result_${i}=client.workflows.invoke('wf_${i}',input_${i}); console.log(result_${i}.outputs.path_${i});`).join('\n')),
  python: py(Array.from({length:count},(_,i)=>`    input_${i}={'key_${i}':1}\n    result_${i}=client.workflows.invoke('wf_${i}',input_${i})\n    print(result_${i}.outputs['path_${i}'])`).join('\n')),
  java: java(Array.from({length:count},(_,i)=>`var input_${i}=Map.of("key_${i}",1); var result_${i}=client.workflows().invoke("wf_${i}",input_${i}); sink(result_${i}.getOutputs().get("path_${i}"));`).join('\n')),
 };
 for (const [language,text] of Object.entries(source)) {
  const rows=scan(language as SourceLanguage,text);
  assert.equal(rows.length,count,language+' real parser must recognize every call');
  assert.deepEqual(rows.map(row=>[row.artifact.id,row.inputKeys,row.outputKeys]),Array.from({length:count},(_,i)=>[`wf_${i}`,[`key_${i}`],[`path_${i}`]]));
 }
});

test('TypeScript lexical shadow, aliases, destructuring, closures and assignments retain key semantics', () => {
 const rows=scan('typescript',ts(`
 const input={good:1}; const a=client.workflows.invoke('wf_a',input);
 const alias=a.outputs; console.log(alias.alpha); const {outputs:{beta}}=a;
 function inner(a: any) {console.log(a.outputs.foreign);} const closure=()=>a.outputs.closed;
 try {throw 1;} catch(a) {console.log(a.outputs.caught);}
 const b=client.workflows.invoke('wf_b',{}); sink(b.outputs);
 let changed={before:1}; changed={after:2}; client.workflows.invoke('wf_c',changed);
 const input2={other:1}; client.workflows.invoke('wf_d',input2);
 const {outputs:{name:renamed}}=client.workflows.invoke('wf_e',{}); console.log(renamed);
 client.workflows.invoke('wf_f',unknownInput);
 `));
 assert.deepEqual(rows.map(r=>r.inputKeys),[['good'],[],['*'],['other'],[],['*']]);
 assert.deepEqual(rows.map(r=>r.outputKeys),[['alpha','beta','closed'],['*'],[],[],['name'],[]]);
});

test('Python reassignment cutoffs, aliases, ignored envelope and unknown input preserve current walk semantics', () => {
 const rows=scan('python',py(`    a=client.workflows.invoke('wf_a',{'one':1})
    alias=a.outputs
    print(alias['alpha'])
    print(a.execution_id)
    a=other
    print(a.outputs['after'])
    b=client.workflows.invoke('wf_b',{})
    sink(b.outputs)
    c=client.workflows.invoke('wf_c',unknown_input)
    print(c.outputs['gamma'])
    def closure():
        print(c.outputs['closed'])
    d=client.workflows.invoke('wf_d',{})
    d=other
    print(d.outputs['excluded'])`));
 assert.deepEqual(rows.map(r=>r.inputKeys),[['one'],[],['*'],[]]);
 assert.deepEqual(rows.map(r=>r.outputKeys),[['alpha'],['*'],['closed','gamma'],[]]);
});

test('Java assignment cutoffs, output aliases, map mutation and unknown input preserve current walk semantics', () => {
 const rows=scan('java',java(`
 var a=client.workflows().invoke("wf_a",Map.of("one",1));
 var alias=a.getOutputs(); sink(alias.get("alpha")); sink(a.getExecutionId());
 a=other; sink(a.getOutputs().get("after"));
 var b=client.workflows().invoke("wf_b",Map.of()); sink(b.getOutputs());
 var c=client.workflows().invoke("wf_c",unknownInput); sink(c.getOutputs().get("gamma"));
 Runnable closure=()->sink(c.getOutputs().get("closed"));
 var input=new HashMap<String,Object>(); input.put("known",1); client.workflows().invoke("wf_d",input);
 var unsafe=new HashMap<String,Object>(); sink(unsafe); client.workflows().invoke("wf_e",unsafe);
 `));
 assert.deepEqual(rows.map(r=>r.inputKeys),[['one'],[],['*'],['known'],['*']]);
 assert.deepEqual(rows.map(r=>r.outputKeys),[['alpha'],['*'],['closed','gamma'],[],[]]);
});

test('same positions in distinct real trees cannot reuse previous input/output identities', () => {
 for (const language of ['typescript','python','java'] as const) {
  const make=(suffix:string)=>language==='typescript'?ts(`const arg={key_${suffix}:1}; const r=client.workflows.invoke('wf_${suffix}',arg); console.log(r.outputs.out_${suffix});`):language==='python'?py(`    arg={'key_${suffix}':1}\n    r=client.workflows.invoke('wf_${suffix}',arg)\n    print(r.outputs['out_${suffix}'])`):java(`var arg=Map.of("key_${suffix}",1); var r=client.workflows().invoke("wf_${suffix}",arg); sink(r.getOutputs().get("out_${suffix}"));`);
  const first=scan(language,make('one')); const second=scan(language,make('two'));
  assert.equal(first.length,1); assert.equal(second.length,1);
  assert.deepEqual([first[0]!.inputKeys,first[0]!.outputKeys],[['key_one'],['out_one']]);
  assert.deepEqual([second[0]!.inputKeys,second[0]!.outputKeys],[['key_two'],['out_two']]);
 }
});

test('actual project failed/empty dispatch resets caches before next same-file result', async () => {
 const root=mkdtempSync(join(tmpdir(),'swfte-reference-lifecycle-'));
 try {
  const file=join(root,'caller.ts'); writeFileSync(file,ts("const a=client.workflows.invoke('wf_old',{old:1}); console.log(a.outputs.old);"));
  const old=await detectProject(root); assert.equal(old.sites.length,1);
  await assert.rejects(detectProject(root,{preprocess(){throw new Error('controlled preprocessing failure');}}),/controlled preprocessing failure/);
  writeFileSync(file,''); assert.deepEqual((await detectProject(root)).sites,[]);
  writeFileSync(file,ts("const a=client.workflows.invoke('wf_new',{newKey:1}); console.log(a.outputs.newKey);"));
  const fresh=await detectProject(root); assert.equal(fresh.sites.length,1);
  assert.deepEqual([fresh.sites[0]!.artifact.id,fresh.sites[0]!.inputKeys,fresh.sites[0]!.outputKeys],['wf_new',['newKey'],['newKey']]);
  assert.deepEqual([old.sites[0]!.artifact.id,old.sites[0]!.inputKeys,old.sites[0]!.outputKeys],['wf_old',['old'],['old']]);
 } finally {rmSync(root,{recursive:true,force:true});}
});


test('parameter/default/pattern-bound inputs stay unknown across actual language scopes', () => {
 const sources = {
  typescript: ts("function nested({input}: {input: unknown}={input:{secret:1}}) { const r=client.workflows.invoke('wf_param',input); console.log(r.outputs.visible); }"),
  python: py("    def nested(input={'secret':1}):\n        r=client.workflows.invoke('wf_param',input)\n        print(r.outputs['visible'])"),
  java: java('class Nested {void nested(Map<String,Object> input) {var r=client.workflows().invoke("wf_param",input); sink(r.getOutputs().get("visible"));}}'),
 };
 for(const [language,text] of Object.entries(sources)) {
  const rows=scan(language as SourceLanguage,text); assert.equal(rows.length,1,language);
  assert.deepEqual([rows[0]!.inputKeys,rows[0]!.outputKeys],[['*'],['visible']],language);
 }
});

test('indexed references preserve the existing 64-key limit', () => {
 const names=Array.from({length:70},(_,i)=>'field_'+String(i).padStart(2,'0'));
 const sources={
  typescript: ts("const r=client.workflows.invoke('wf_many',{});\n"+names.map(n=>`console.log(r.outputs.${n});`).join('\n')),
  python: py("    r=client.workflows.invoke('wf_many',{})\n"+names.map(n=>`    print(r.outputs['${n}'])`).join('\n')),
  java: java('var r=client.workflows().invoke("wf_many",Map.of());\n'+names.map(n=>`sink(r.getOutputs().get("${n}"));`).join('\n')),
 };
 for(const [language,text] of Object.entries(sources)) {
  const rows=scan(language as SourceLanguage,text); assert.equal(rows.length,1,language);
  assert.deepEqual(rows[0]!.outputKeys,names.slice(0,64),language);
 }
});

// Keep both actual trees alive: scan() deliberately releases indexes, so it cannot cover this case.
test('public keys distinguish simultaneous same-position trees and requery the first tree', () => {
 const body=(language:SourceLanguage, suffix:string)=>language==='typescript'
  ?ts(`const arg={key_${suffix}:1}; const r=client.workflows.invoke('wf_same',arg); console.log(r.outputs.out_${suffix});`)
  :language==='python'?py(`    arg={'key_${suffix}':1}\n    r=client.workflows.invoke('wf_same',arg)\n    print(r.outputs['out_${suffix}'])`)
  :java(`var arg=Map.of("key_${suffix}",1); var r=client.workflows().invoke("wf_same",arg); sink(r.getOutputs().get("out_${suffix}"));`);
 const expected=(suffix:string)=>[[`key_${suffix}`],[`out_${suffix}`]];
 try {
  const first=parseSource('caller.ts',body('typescript','one'));
  const second=parseSource('caller.ts',body('typescript','two'));
  const locate=(root:typescript.Node):typescript.CallExpression=>{
   let found:typescript.CallExpression|undefined;
   const visit=(n:typescript.Node):void=>{if(typescript.isCallExpression(n)&&n.expression.getText()==='client.workflows.invoke')found=n;typescript.forEachChild(n,visit);};
   visit(root); assert.ok(found); return found;
  };
  const a=locate(first), b=locate(second);
  assert.equal(a.pos,b.pos); assert.notEqual(a.getSourceFile(),b.getSourceFile());
  const answer=(c:typescript.CallExpression)=>[inputKeysOf(c.arguments[1]),outputKeysOf(c)];
  const old=answer(a); assert.deepEqual(old,expected('one'));
  assert.deepEqual(answer(b),expected('two')); assert.deepEqual(answer(a),expected('one'));
  assert.deepEqual(old,expected('one'));
  // Nested withTree callbacks keep the first native Tree alive until after the second requery.
  const python=withPythonTree(body('python','one'), firstRoot=>withPythonTree(body('python','two'),secondRoot=>{
   const locate=(root:typeof firstRoot)=>{
    let found:typeof firstRoot|undefined;
    walkPython(root,n=>{if(n.type==='call'&&n.childForFieldName('function')?.text==='client.workflows.invoke')found=n;});
    assert.ok(found); return found;
   };
   const a=locate(firstRoot),b=locate(secondRoot);
   const answer=(c:typeof a)=>[pythonInput(pythonChildren(c.childForFieldName('arguments')!)[1]??null),pythonOutput(c)];
   const old=answer(a), fresh=answer(b), again=answer(a);
   return {samePosition:a.startIndex===b.startIndex,differentTree:a.tree!==b.tree,old,fresh,again};
  }));
  assert.ok(python,'both actual Python parses and callbacks must complete');
  assert.equal(python.samePosition,true);assert.equal(python.differentTree,true);
  assert.deepEqual(python.old,expected('one'));assert.deepEqual(python.fresh,expected('two'));assert.deepEqual(python.again,expected('one'));
  const j=withJavaTree(body('java','one'),firstRoot=>withJavaTree(body('java','two'),secondRoot=>{
   const locate=(root:typeof firstRoot)=>{
    let found:typeof firstRoot|undefined;
    walkJava(root,n=>{if(n.type==='method_invocation'&&n.childForFieldName('name')?.text==='invoke')found=n;});
    assert.ok(found);return found;
   };
   const a=locate(firstRoot),b=locate(secondRoot);
   const answer=(c:typeof a)=>[javaInput(javaArgs(c)[1]??null),javaOutput(c)];
   const old=answer(a),fresh=answer(b),again=answer(a);
   return {samePosition:a.startIndex===b.startIndex,differentTree:a.tree!==b.tree,old,fresh,again};
  }));
  assert.ok(j,'both actual Java parses and callbacks must complete');
  assert.equal(j.samePosition,true);assert.equal(j.differentTree,true);
  assert.deepEqual(j.old,expected('one'));assert.deepEqual(j.fresh,expected('two'));assert.deepEqual(j.again,expected('one'));
 } finally {releaseTS();releasePY();releaseJava();releaseParsedSource();}
});

test('project detector failure after real key analysis truncates and next dispatch has fresh answers', async () => {
 const root=mkdtempSync(join(tmpdir(),'swfte-populated-reference-failure-'));
 try {
  for(const language of ['typescript','python','java'] as const) {
   const file=join(root,language==='typescript'?'caller.ts':language==='python'?'caller.py':'Caller.java');
   const source=(suffix:string)=>language==='typescript'
    ?ts(`const arg={key_${suffix}:1}; const r=client.workflows.invoke('wf_${suffix}',arg); console.log(r.outputs.out_${suffix});`)
    :language==='python'?py(`    arg={'key_${suffix}':1}\n    r=client.workflows.invoke('wf_${suffix}',arg)\n    print(r.outputs['out_${suffix}'])`)
    :java(`var arg=Map.of("key_${suffix}",1); var r=client.workflows().invoke("wf_${suffix}",arg); sink(r.getOutputs().get("out_${suffix}"));`);
   writeFileSync(file,source('old'));
   const real=(language==='typescript'?TS:language==='python'?PY:JAVA)[0]!;
   let observed:DetectedSite[]=[];let populated=0;
   const failing:Detector={id:'controlled-after-real-analysis',languages:[language],detect(f,c){
    const actual=real.detect(f,c);observed=actual.sites;populated++;throw new Error('after real indexed analysis');
   }};
   const failed=await detectProject(root,{detectors:[failing]});
   assert.equal(populated,1,language);assert.equal(failed.truncated,true,language);assert.deepEqual(failed.sites,[]);
   assert.equal(observed.length,1,language);
   assert.deepEqual([observed[0]!.inputKeys,observed[0]!.outputKeys],[['key_old'],['out_old']],language);
   writeFileSync(file,source('new'));
   const fresh=await detectProject(root,{detectors:[real]});
   assert.equal(fresh.truncated,false,language);assert.equal(fresh.sites.length,1,language);
   assert.deepEqual([fresh.sites[0]!.artifact.id,fresh.sites[0]!.inputKeys,fresh.sites[0]!.outputKeys],['wf_new',['key_new'],['out_new']],language);
   assert.deepEqual([observed[0]!.inputKeys,observed[0]!.outputKeys],[['key_old'],['out_old']],language);
  }
 } finally {rmSync(root,{recursive:true,force:true});releaseTS();releasePY();releaseJava();releaseParsedSource();}
});
