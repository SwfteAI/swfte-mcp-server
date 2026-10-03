import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {SwfteClient,SwfteApiError} from '../src/client.js';
import {loadConfig} from '../src/config.js';
import {preflightTools} from '../src/tools/preflight.js';
import {RULES} from '../src/preflight/lib/rules.mjs';
const hash='a'.repeat(64),artifact={kind:'workflow',id:'owned'};
function entry(kind='workflow'):any{return{task:{key:'task-1',kind:'value',title:'Enter value',detail:null,required:true,provider:null,role:null,recordType:null,options:null,placeholder:null,derived:true,status:null,answerLabel:null,scope:'ARTIFACT',artifactKind:kind,artifactId:'owned',solutionId:null,subject:{nodeId:null,field:'/value',label:'Value'},authType:null,capability:null,state:'UNMET',blocksSandbox:true,resolutionOptions:[{id:'enter',type:'ENTER_VALUE',label:'Enter value',handle:null}],values:null,resolvedBy:null,future:{native:true}},contentHash:hash,revision:2,updatedAt:'2026-10-02T12:00:00.123456789Z',future:'retained'};}
type Call={method:string;path:string;body:any};
async function fixture(run:(client:SwfteClient,calls:Call[])=>Promise<void>,reply:(call:Call)=>{body?:unknown;status?:number;raw?:string}){
 const calls:Call[]=[];const server=createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=String(chunk);assert.equal(req.headers.authorization,'Bearer pat_test');const call={method:req.method!,path:req.url!,body:data?JSON.parse(data):undefined};calls.push(call);const result=reply(call);res.writeHead(result.status??200,{'content-type':'application/json'});res.end(result.raw??JSON.stringify(result.body));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const config=loadConfig({SWFTE_PAT:'pat_test',SWFTE_BASE_URL:`http://127.0.0.1:${address.port}`,SWFTE_WORKSPACE_ID:'ws',SWFTE_TELEMETRY:'0'} as never);
 try{await run(new SwfteClient(config),calls);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
async function tool(name:string,input:any,client:SwfteClient){const definition=preflightTools.find(tool=>tool.name===name);assert.ok(definition);return definition.execute(definition.inputSchema.parse(input),{client,config:loadConfig({SWFTE_PAT:'pat_test'} as never)});}

const manifest={id:'native-fixture',workspaceId:'ws',components:[{key:'native',kind:'workflow',id:'owned'}]};
const input={artifact,manifest,executionsPerWorkflow:0};
function localReply(call:Call){return{body:call.path==='/v2/workflows/owned'?{workflowId:'owned',workspaceId:'ws',nodes:{},edges:[]}:[]};}
function setupReply(wire:unknown){return(call:Call)=>call.path.endsWith('/setup')?{body:wire}:localReply(call);}
async function positive(client:SwfteClient,calls:Call[],kind='workflow'){
 const result:any=await tool('swfte_preflight',{...input,artifact:{kind,id:'owned'}},client);
 assert.deepEqual(result.setupTasks,[entry(kind)]);assert.equal(result.setupSource,'server-current-content');assert.equal(result.setupBlocksSandbox,true);
 assert.deepEqual(result.unknownRequiredTaskKeys,[]);assert.equal(result.ruleCount,RULES.length);assert.ok(calls.length>1);assert.equal(calls.filter(call=>call.path.endsWith('/setup')).length,1);assert.ok(calls.every(call=>call.method==='GET'));
}
test('all eight configured artifact HTTP scopes admit native tasks before unchanged local rules',async()=>{
 for(const kind of ['workflow','chatflow','agent','widget','application','journey','mcp','finetune'])await fixture((client,calls)=>positive(client,calls,kind),setupReply([entry(kind)]));
});
test('malformed task reply refuses before any local preflight GET after valid positive',async()=>{
 await fixture(positive,setupReply([entry()]));
 for(const wire of [null,{},[{}],[{task:{}}],[{...entry(),task:{}}]])await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_preflight',input,client));assert.equal(calls.length,1);assert.ok(calls[0]!.path.endsWith('/setup'));},setupReply(wire));
});
test('owned artifact workspace hash revision and timestamp admission is causal before local reads',async()=>{
 await fixture(positive,setupReply([entry()]));
 const mutations=[(e:any)=>e.task.artifactId='foreign',(e:any)=>e.task.artifactKind='agent',(e:any)=>e.workspaceId='foreign',(e:any)=>e.contentHash='raw-hash',(e:any)=>e.revision=0,(e:any)=>e.revision=1.5,(e:any)=>e.updatedAt='2026-02-30T00:00:00Z',(e:any)=>e.task.state='COMPLETE'];
 for(const mutate of mutations)await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_preflight',input,client));assert.equal(calls.length,1);},call=>{const e=entry();mutate(e);return setupReply([e])(call);});
 for(const wire of [[entry(),entry()],[entry(),{...entry(),contentHash:'b'.repeat(64),task:{...entry().task,key:'second'}}]])await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_preflight',input,client));assert.equal(calls.length,1);},setupReply(wire));
});
test('explicit artifact404 including workflow mismatch never falls back across all eight kinds',async()=>{
 await fixture(positive,setupReply([entry()]));
 for(const kind of ['workflow','chatflow','agent','widget','application','journey','mcp','finetune'])await fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_preflight',{...input,workflowId:'different',artifact:{kind,id:'owned'}},client),SwfteApiError);assert.equal(calls.length,1);
 },call=>call.path.endsWith('/setup')?{status:404,body:{code:'NOT_FOUND'}}:localReply(call));
});
test('omitted workflow artifact404 alone retains older server compatibility and explicit data source',async()=>{
 await fixture(async(client,calls)=>{const result:any=await tool('swfte_preflight',{manifest,workflowId:'owned',executionsPerWorkflow:0},client);assert.equal(result.setupSource,'older-server-local-fallback');assert.equal(result.setupTasks,null);assert.equal(result.setupBlocksSandbox,null);assert.ok(calls.length>1);assert.equal(calls.filter(call=>call.path.endsWith('/setup')).length,1);},call=>call.path.endsWith('/setup')?{status:404,body:{code:'NOT_FOUND'}}:localReply(call));
});
test('auth outage malformed JSON never retries setup or enters legacy fallback',async()=>{
 for(const explicit of [true,false])for(const status of [401,403,503])await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_preflight',explicit?input:{manifest,workflowId:'owned'},client),SwfteApiError);assert.equal(calls.length,1);},()=>({status,body:{code:'REFUSED'}}));
 await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_preflight',input,client));assert.equal(calls.length,1);},()=>({raw:'{bad'}));
});
test('unknown required native kind remains visible blocking even with resolved state and false flag',async()=>{
 await fixture(positive,setupReply([entry()]));
 for(const state of ['UNMET','RESOLVED','WAIVED'])await fixture(async(client,calls)=>{const result:any=await tool('swfte_preflight',input,client);assert.equal(result.setupTasks[0].task.kind,'native-future');assert.deepEqual(result.unknownRequiredTaskKeys,['task-1']);assert.equal(result.setupBlocksSandbox,true);assert.equal(result.setupTasks[0].task.future.native,true);assert.ok(calls.length>1);},setupReply([{...entry(),task:{...entry().task,kind:'native-future',blocksSandbox:false,state}}]));
});
test('native current states preserve ordinary blocking and nullable additive metadata',async()=>{
 for(const state of ['UNMET','AUTO_BOUND','NEEDS_USER','RESOLVING','RESOLVED','EXPIRED','FAILED','WAIVED'])await fixture(async(client)=>{const result:any=await tool('swfte_preflight',input,client);assert.equal(result.setupBlocksSandbox,!['AUTO_BOUND','RESOLVED','WAIVED'].includes(state));assert.equal(result.setupTasks[0].future,'retained');assert.equal(result.setupTasks[0].task.detail,null);},setupReply([{...entry(),task:{...entry().task,state}}]));
});
