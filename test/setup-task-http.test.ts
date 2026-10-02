import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {SwfteClient,SwfteApiError} from '../src/client.js';
import {loadConfig} from '../src/config.js';
import {setupTools} from '../src/tools/setup.js';
import {connectTools} from '../src/tools/connect.js';
const hash='a'.repeat(64),artifact={kind:'workflow',id:'owned'};
function entry(kind='workflow'):any{return{task:{key:'task-1',kind:'value',title:'Enter value',detail:null,required:true,provider:null,role:null,recordType:null,options:null,placeholder:null,derived:true,status:null,answerLabel:null,scope:'ARTIFACT',artifactKind:kind,artifactId:'owned',solutionId:null,subject:{nodeId:null,field:'/value',label:'Value'},authType:null,capability:null,state:'UNMET',blocksSandbox:true,resolutionOptions:[{id:'enter',type:'ENTER_VALUE',label:'Enter value',handle:null}],values:null,resolvedBy:null,future:{native:true}},contentHash:hash,revision:2,updatedAt:'2026-10-02T12:00:00.123456789Z',future:'retained'};}
type Call={method:string;path:string;body:any};
async function fixture(run:(client:SwfteClient,calls:Call[])=>Promise<void>,reply:(call:Call)=>{body?:unknown;status?:number;raw?:string}){
 const calls:Call[]=[];const server=createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=String(chunk);const call={method:req.method!,path:req.url!,body:data?JSON.parse(data):undefined};calls.push(call);const result=reply(call);res.writeHead(result.status??200,{'content-type':'application/json'});res.end(result.raw??JSON.stringify(result.body));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const config=loadConfig({SWFTE_PAT:'pat_test',SWFTE_BASE_URL:`http://127.0.0.1:${address.port}`,SWFTE_WORKSPACE_ID:'ws',SWFTE_TELEMETRY:'0'} as never);
 try{await run(new SwfteClient(config),calls);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
async function tool(name:string,input:any,client:SwfteClient){const definition=[...setupTools,...connectTools].find(tool=>tool.name===name);assert.ok(definition);return definition.execute(definition.inputSchema.parse(input),{client,config:loadConfig({SWFTE_PAT:'pat_test'} as never)});}
const resolveInput={artifact,taskKey:'task-1',optionId:'enter',environment:'SANDBOX',value:{literal:'selected'},expectedContentHash:hash,expectedRevision:2};
function resolved():any{return{...entry(),revision:4,task:{...entry().task,state:'RESOLVED',values:{SANDBOX:{literal:'selected',handle:null}},resolvedBy:{option:'enter',actor:'actual-actor',at:'2026-10-02T12:01:00Z',evidence:{probeId:'literal-binding',outcome:'PASS',evidenceRefs:['persisted://task-1']}}}};}

test('all eight actual artifact setup scopes preserve native nullable and additive records',async()=>{
 for(const kind of ['workflow','chatflow','agent','widget','application','journey','mcp','finetune'])await fixture(async(client,calls)=>{const result=await tool('swfte_setup',{artifact:{kind,id:'owned'}},client);assert.deepEqual(result,[entry(kind)]);assert.equal(calls.length,1);assert.equal(calls[0]!.path,`/v2/artifacts/${kind}/owned/setup`);},()=>({body:[entry(kind)]}));
});
test('malformed empty task responses cannot yield setup or connect green',async()=>{
 for(const wire of [null,{},[{}],[{task:{}}],[{...entry(),task:{}}]])for(const name of ['swfte_setup','swfte_connections_check'])await fixture(async(client,calls)=>{await assert.rejects(tool(name,name==='swfte_setup'?{artifact}:{workflowId:'owned',artifact,connect:true},client));assert.equal(calls.length,1);},()=>({body:wire}));
});
test('foreign artifact workspace duplicate key and mixed hash refuse before effects',async()=>{
 const wires=[[{...entry(),task:{...entry().task,artifactId:'foreign'}}],[{...entry(),task:{...entry().task,artifactKind:'agent'}}],[{...entry(),workspaceId:'foreign'}],[entry(),entry()],[entry(),{...entry(),contentHash:'b'.repeat(64),task:{...entry().task,key:'task-2'}}]];
 for(const wire of wires)await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_resolve_setup_task',resolveInput,client));assert.equal(calls.length,1);},()=>({body:wire}));
});
test('invalid revision hash state timestamp and nested proof shapes refuse actual HTTP rows',async()=>{
 const mutations=[(e:any)=>e.revision=0,(e:any)=>e.revision=9007199254740992,(e:any)=>e.contentHash='A'.repeat(64),(e:any)=>e.updatedAt='2026-02-30T00:00:00Z',(e:any)=>e.task.state='UNKNOWN',(e:any)=>e.task.required='true',(e:any)=>e.task.values={SANDBOX:{handle:'conn_x',literal:'x'}},(e:any)=>e.task.resolutionOptions.push(e.task.resolutionOptions[0]),(e:any)=>e.task.resolvedBy={option:'enter',actor:'actor',at:'2026-10-02T12:00:00Z',evidence:{probeId:'probe',outcome:'PASS',evidenceRefs:[]}}];
 for(const mutate of mutations)await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_setup',{artifact},client));assert.equal(calls.length,1);},()=>{const e=entry();mutate(e);return{body:[e]};});
});
test('real current resolution preflight and advancing persisted response bind exact task',()=>fixture(async(client,calls)=>{const result:any=await tool('swfte_resolve_setup_task',resolveInput,client);assert.equal(result.revision,4);assert.equal(result.task.resolvedBy.evidence.outcome,'PASS');assert.deepEqual(calls.map(c=>c.method),['GET','POST']);assert.deepEqual(calls[1]!.body,{optionId:'enter',environment:'SANDBOX',value:{literal:'selected'},expectedContentHash:hash,expectedRevision:2});},call=>({body:call.method==='GET'?[entry()]:resolved()})));
test('stale requested hash revision and unavailable option cannot POST',async()=>{
 for(const extra of [{expectedRevision:1},{expectedContentHash:'b'.repeat(64)},{optionId:'missing'}])await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_resolve_setup_task',{...resolveInput,...extra},client));assert.equal(calls.length,1);},()=>({body:[entry()]}));
});
test('substituted resolution row identity hash or nonadvancing revision refuses after one POST',async()=>{
 for(const mutate of [(e:any)=>e.task.key='other',(e:any)=>e.task.artifactId='foreign',(e:any)=>e.contentHash='b'.repeat(64),(e:any)=>e.revision=2,(e:any)=>e.workspaceId='foreign'])await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_resolve_setup_task',resolveInput,client));assert.equal(calls.length,2);},call=>{if(call.method==='GET')return{body:[entry()]};const e=resolved();mutate(e);return{body:e};});
});
test('required unknown task kind remains visible and never green even nominally resolved',async()=>{
 for(const state of ['UNMET','RESOLVED','WAIVED'])await fixture(async(client,calls)=>{const result:any=await tool('swfte_connections_check',{workflowId:'owned',artifact,connect:true},client);assert.equal(result.ok,false);assert.deepEqual(result.unknownRequiredTaskKeys,['task-1']);assert.equal(result.setupTasks[0].task.kind,'future-kind');assert.equal(calls.length,1);},()=>({body:[{...entry(),task:{...entry().task,kind:'future-kind',state}}]}));
});
test('Open UNKNOWN legacy status and optional null metadata remain visible without success upgrade',()=>fixture(async(client)=>{const result:any=await tool('swfte_setup',{artifact},client);assert.equal(result[0].task.resolvedBy,null);assert.equal(result[0].task.state,null);assert.equal(result[0].task.status,'UNKNOWN');assert.equal(result[0].task.future.native,true);},()=>({body:[{...entry(),task:{...entry().task,status:'UNKNOWN',state:null,resolutionOptions:null,values:null,resolvedBy:null}}]})));
test('actual resolved connection positive and needs-user negative do not invoke OAuth',async()=>{
 for(const state of ['RESOLVED','AUTO_BOUND','NEEDS_USER'])await fixture(async(client,calls)=>{const result:any=await tool('swfte_connections_check',{workflowId:'owned',artifact,connect:true},client);assert.equal(result.ok,state!=='NEEDS_USER');assert.equal(calls.length,1);},()=>({body:[{...entry(),task:{...entry().task,kind:'connection',provider:'slack',state}}]}));
});
test('auth outage and uncertain resolution response are never retried or fallback',async()=>{
 for(const status of [401,403,503])await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_setup',{artifact},client),SwfteApiError);assert.equal(calls.length,1);},()=>({status,body:{error:'REFUSED'}}));
 await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_resolve_setup_task',resolveInput,client),SwfteApiError);assert.equal(calls.length,2);},call=>call.method==='GET'?{body:[entry()]}:{status:503,body:{error:'UNCONFIRMED'}});
});
test('malformed JSON cannot pass task admission or uncertain POST replay',async()=>{
 for(const phase of ['GET','POST'])await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_resolve_setup_task',resolveInput,client));assert.equal(calls.length,phase==='GET'?1:2);},call=>call.method===phase?{raw:'{bad'}:{body:[entry()]});
});
test('all actual TaskState values are admitted without reinterpreting legacy status',async()=>{
 for(const state of ['UNMET','AUTO_BOUND','NEEDS_USER','RESOLVING','RESOLVED','EXPIRED','FAILED','WAIVED'])await fixture(async(client)=>{const result:any=await tool('swfte_setup',{artifact},client);assert.equal(result[0].task.state,state);assert.equal(result[0].task.status,'future-status');},()=>({body:[{...entry(),task:{...entry().task,state,status:'future-status'}}]}));
});
test('native binding handle environment and successful evidence invariants cannot be coerced',async()=>{
 const mutations=[(e:any)=>e.task.values={SANDBOX:{handle:'caller-secret'}},(e:any)=>e.task.values={'LIVE:target.with.dot':{literal:'selected'}},(e:any)=>e.task.values={SANDBOX:{literal:'AK'+'IA'+'1234567890ABCDEF'}},(e:any)=>e.task.resolutionOptions[0].handle='caller-secret',(e:any)=>e.task.resolvedBy={option:'enter',actor:'actor',at:'2026-10-02T12:00:00Z',evidence:{probeId:'probe',outcome:'UNKNOWN',evidenceRefs:[]}}];
 for(const mutate of mutations)await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_setup',{artifact},client));assert.equal(calls.length,1);},()=>{const e=entry();mutate(e);return{body:[e]};});
 await fixture(async(client)=>{const result:any=await tool('swfte_setup',{artifact},client);assert.equal(result[0].task.values.SANDBOX.handle,'secret://owned/key');},()=>({body:[{...entry(),task:{...entry().task,values:{SANDBOX:{handle:'secret://owned/key',literal:null}}}}]}));
});
