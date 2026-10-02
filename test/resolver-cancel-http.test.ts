import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {SwfteClient,SwfteApiError} from '../src/client.js';
import {loadConfig} from '../src/config.js';
import {setupTools} from '../src/tools/setup.js';

type Call={method:string;path:string;body:unknown;headers:Record<string,unknown>};
const id='resolver:owned/1';
const path=`/v2/resolver/sessions/${encodeURIComponent(id)}`;
function session():any{return{id,workspaceId:'ws',actorId:'original-creator',artifact:{kind:'workflow',id:'wf'},contentHash:'a'.repeat(64),intent:'PROVE',budget:{maxSteps:10,maxWallSeconds:60,maxSpendUsd:1},state:'RUNNING',steps:2,unresolvedTaskKeys:[],startedAt:'2026-10-01T12:00:00.123456789Z',finishedAt:null,extension:{preserved:true}};}
function cancelled():any{return{...session(),state:'CANCELLED',steps:3,unresolvedTaskKeys:['CANCELLED','CHILD_EXECUTION_CLEANUP_UNVERIFIED'],finishedAt:'2026-10-01T12:00:01Z'};}
async function fixture(run:(client:SwfteClient,calls:Call[])=>Promise<void>,reply:(call:Call)=>{status?:number;body?:unknown;raw?:string},workspaceId='ws'){
 const calls:Call[]=[];
 const server=createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=String(chunk);const call={method:req.method!,path:req.url!,body:data?JSON.parse(data):undefined,headers:{...req.headers}};calls.push(call);const response=reply(call);res.writeHead(response.status??200,{'content-type':'application/json'});res.end(response.raw??JSON.stringify(response.body));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 const config=loadConfig({SWFTE_PAT:'pat_test',SWFTE_BASE_URL:`http://127.0.0.1:${address.port}`,SWFTE_WORKSPACE_ID:workspaceId,SWFTE_TELEMETRY:'0'} as never);
 try{await run(new SwfteClient(config),calls);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
async function cancel(client:SwfteClient,input:unknown={sessionId:id}){const tool=setupTools.find(tool=>tool.name==='swfte_resolver_cancel');assert.ok(tool);return tool.execute(tool.inputSchema.parse(input),{client,config:loadConfig({SWFTE_PAT:'pat_test'} as never)});}
const normal=(call:Call)=>({body:call.method==='GET'?session():cancelled()});

test('actual owned GET and single cancellation POST preserve creator, additive fields and unverified cleanup',()=>fixture(async(client,calls)=>{
 const result:any=await cancel(client);assert.equal(result.actorId,'original-creator');assert.deepEqual(result.extension,{preserved:true});assert.deepEqual(result.unresolvedTaskKeys,['CANCELLED','CHILD_EXECUTION_CLEANUP_UNVERIFIED']);
 assert.deepEqual(calls.map(call=>[call.method,call.path]),[['GET',path],['POST',`${path}/cancel`]]);assert.deepEqual(calls[1]!.body,{});
 for(const call of calls){assert.equal(call.headers.authorization,'Bearer pat_test');assert.equal(call.headers['x-actor-id'],undefined);assert.equal(call.headers['x-workos-user-id'],undefined);}
},normal));
test('all actual terminal states remain readback only including NEEDS_USER cleanup',async()=>{
 for(const state of ['COMPLETE','NEEDS_USER','CANCELLED'])await fixture(async(client,calls)=>{const result:any=await cancel(client);assert.equal(result.state,state);assert.equal(calls.length,1);},()=>({body:{...cancelled(),state,unresolvedTaskKeys:state==='COMPLETE'?[]:['CHILD_EXECUTION_CLEANUP_UNVERIFIED']}}));
});
test('foreign wrong requested id and malformed current rows refuse before any POST',async()=>{
 const mutations=[(s:any)=>s.id='other',(s:any)=>s.workspaceId='foreign',(s:any)=>s.contentHash='A'.repeat(64),(s:any)=>s.actorId=' ',(s:any)=>s.artifact.kind=null,(s:any)=>s.state='WAITING_USER',(s:any)=>s.steps=11,(s:any)=>s.budget.maxSteps=2147483648,(s:any)=>s.startedAt='2026-02-30T00:00:00Z',(s:any)=>s.finishedAt='2026-10-01T13:00:00Z'];
 for(const mutate of mutations)await fixture(async(client,calls)=>{await assert.rejects(cancel(client));assert.equal(calls.length,1);},()=>{const body=session();mutate(body);return{body};});
 for(const body of [null,[],{}, {id}])await fixture(async(client,calls)=>{await assert.rejects(cancel(client));assert.equal(calls.length,1);},()=>({body}));
});
test('current authority and availability failures never trigger cancellation or retry',async()=>{
 for(const status of [401,403,404,503])await fixture(async(client,calls)=>{await assert.rejects(cancel(client),SwfteApiError);assert.equal(calls.length,1);},()=>({status,body:{error:'REFUSED'}}));
});
test('uncertain cancellation 503 is single POST without fallback readback or replay',()=>fixture(async(client,calls)=>{await assert.rejects(cancel(client),SwfteApiError);assert.equal(calls.length,2);assert.equal(calls.filter(call=>call.method==='POST').length,1);},call=>call.method==='GET'?normal(call):{status:503,body:{error:'CANCEL_UNCONFIRMED'}}));
test('malformed JSON current or cancellation response never produces success or replay',async()=>{
 for(const phase of ['GET','POST'])await fixture(async(client,calls)=>{await assert.rejects(cancel(client));assert.equal(calls.length,phase==='GET'?1:2);},call=>call.method===phase?{raw:'{broken'}:normal(call));
});
test('returned immutable identity hash intent and budget substitutions refuse',async()=>{
 const mutations=[(s:any)=>s.id='other',(s:any)=>s.workspaceId='foreign',(s:any)=>s.actorId='caller',(s:any)=>s.artifact.id='other',(s:any)=>s.artifact.kind='agent',(s:any)=>s.contentHash='b'.repeat(64),(s:any)=>s.intent='FIX',(s:any)=>s.budget.maxSteps=11,(s:any)=>s.budget.maxWallSeconds=61,(s:any)=>s.budget.maxSpendUsd=2,(s:any)=>s.steps=1,(s:any)=>s.startedAt='2026-10-01T12:00:00.123456788Z'];
 for(const mutate of mutations)await fixture(async(client,calls)=>{await assert.rejects(cancel(client),/RESOLVER_CANCEL_BINDING_MISMATCH|RESOLVER_SESSION_IDENTITY_MISMATCH/);assert.equal(calls.length,2);},call=>{if(call.method==='GET')return normal(call);const body=cancelled();mutate(body);return{body};});
});
test('concurrent COMPLETE or NEEDS_USER terminal response retains actual state',async()=>{
 for(const state of ['COMPLETE','NEEDS_USER'])await fixture(async(client,calls)=>{const result:any=await cancel(client);assert.equal(result.state,state);assert.equal(calls.length,2);},call=>call.method==='GET'?normal(call):{body:{...cancelled(),state,unresolvedTaskKeys:state==='COMPLETE'?[]:['MODEL_PROVIDER_UNAVAILABLE']}});
});
test('exact nanosecond and offset semantic equality plus nullable queued start match Java',async()=>{
 await fixture(async(client)=>{const result:any=await cancel(client);assert.equal(result.startedAt,'2026-10-01T14:00:00.123456789+02:00');},call=>call.method==='GET'?normal(call):{body:{...cancelled(),startedAt:'2026-10-01T14:00:00.123456789+02:00'}});
 await fixture(async(client)=>{const result:any=await cancel(client);assert.equal(result.startedAt,null);assert.deepEqual(result.unresolvedTaskKeys,[]);},call=>({body:call.method==='GET'?{...session(),state:'QUEUED',steps:0,startedAt:null,unresolvedTaskKeys:null}:{...cancelled(),steps:0,startedAt:null,unresolvedTaskKeys:null}}));
});
test('nonterminal cancellation and impossible chronology cannot report successful stop',async()=>{
 for(const mutate of [(s:any)=>{s.state='RUNNING';s.finishedAt=null;},(s:any)=>s.finishedAt='2026-10-01T12:00:00.123456788Z',(s:any)=>{s.state='COMPLETE';s.unresolvedTaskKeys=['missing'];}])await fixture(async(client,calls)=>{await assert.rejects(cancel(client));assert.equal(calls.length,2);},call=>{if(call.method==='GET')return normal(call);const body=cancelled();mutate(body);return{body};});
});
test('caller supplied actor workspace or hash never enters authority or HTTP',()=>fixture(async(client,calls)=>{for(const extra of [{actorId:'caller'},{workspaceId:'foreign'},{contentHash:'b'.repeat(64)}])await assert.rejects(cancel(client,{sessionId:id,...extra}));assert.equal(calls.length,0);},normal));

test('future artifact vocabulary on an owned terminal session stays visible without invented execution',()=>fixture(async(client,calls)=>{const result:any=await cancel(client);assert.equal(result.artifact.kind,'future-kind');assert.equal(calls.length,1);},()=>({body:{...cancelled(),artifact:{kind:'future-kind',id:'future-id'}}})));
