import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {SwfteClient,SwfteApiError} from '../src/client.js';
import {loadConfig} from '../src/config.js';
import {setupTools} from '../src/tools/setup.js';
const hash='a'.repeat(64),id='resolver_owned/1',artifact={kind:'workflow',id:'owned'};
const input={artifact,intent:'prove',expectedContentHash:hash};
function session():any{return{id,workspaceId:'ws',actorId:'server-creator',artifact,contentHash:hash,intent:'PROVE',budget:{maxSteps:3,maxWallSeconds:120,maxSpendUsd:0},state:'QUEUED',steps:0,unresolvedTaskKeys:[],startedAt:'2026-10-02T12:00:00.123456789Z',finishedAt:null,future:{preserved:true}};}
type Call={method:string;path:string;body:any;headers:Record<string,unknown>};
async function fixture(run:(client:SwfteClient,calls:Call[])=>Promise<void>,reply:(call:Call)=>{body?:unknown;status?:number;raw?:string}){
 const calls:Call[]=[];const server=createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=String(chunk);const call={method:req.method!,path:req.url!,body:data?JSON.parse(data):undefined,headers:{...req.headers}};calls.push(call);const result=reply(call);res.writeHead(result.status??200,{'content-type':'application/json'});res.end(result.raw??JSON.stringify(result.body));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const config=loadConfig({SWFTE_PAT:'pat_test',SWFTE_BASE_URL:`http://127.0.0.1:${address.port}`,SWFTE_WORKSPACE_ID:'ws',SWFTE_TELEMETRY:'0'} as never);
 try{await run(new SwfteClient(config),calls);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
async function tool(name:string,client:SwfteClient,request:any=name==='swfte_resolve'?input:{sessionId:id}){const definition=setupTools.find(tool=>tool.name===name);assert.ok(definition);return definition.execute(definition.inputSchema.parse(request),{client,config:loadConfig({SWFTE_PAT:'pat_test'} as never)});}

test('native start defaults and actual creator additive data bind single POST without identity labels',()=>fixture(async(client,calls)=>{const result:any=await tool('swfte_resolve',client);assert.equal(result.actorId,'server-creator');assert.deepEqual(result.future,{preserved:true});assert.equal(calls.length,1);assert.equal(calls[0]!.method,'POST');assert.equal(calls[0]!.path,'/v2/resolver/sessions');assert.deepEqual(calls[0]!.body,input);assert.equal(calls[0]!.headers['x-actor-id'],undefined);assert.equal(calls[0]!.headers['x-workos-user-id'],undefined);},()=>({body:session()})));
test('effective budget binds native caps and lower requested limits without pretending supplied limits are effective',async()=>{
 for(const asked of [{maxSteps:40,maxWallSeconds:600,maxSpendUsd:50},{maxSteps:2,maxWallSeconds:20,maxSpendUsd:.25}])await fixture(async(client)=>{const result:any=await tool('swfte_resolve',client,{...input,budget:asked});assert.deepEqual(result.budget,{maxSteps:Math.min(12,asked.maxSteps),maxWallSeconds:Math.min(120,asked.maxWallSeconds),maxSpendUsd:Math.min(1,asked.maxSpendUsd)});},()=>({body:{...session(),budget:{maxSteps:Math.min(12,asked.maxSteps),maxWallSeconds:Math.min(120,asked.maxWallSeconds),maxSpendUsd:Math.min(1,asked.maxSpendUsd)}}}));
});
test('start authentic terminal races retain COMPLETE NEEDS_USER CANCELLED and cleanup reasons',async()=>{
 for(const state of ['RUNNING','COMPLETE','NEEDS_USER','CANCELLED'])await fixture(async(client)=>{const result:any=await tool('swfte_resolve',client);assert.equal(result.state,state);assert.deepEqual(result.unresolvedTaskKeys,state==='NEEDS_USER'?['GOVERNED_MODEL_UNAVAILABLE']:[]);},()=>({body:{...session(),state,steps:1,finishedAt:state==='RUNNING'?null:'2026-10-02T12:00:01Z',unresolvedTaskKeys:state==='NEEDS_USER'?['GOVERNED_MODEL_UNAVAILABLE']:[]}}));
});
test('all eight requested kinds and FIX intent are actual wire bindings without invented native proof',async()=>{
 for(const kind of ['workflow','chatflow','agent','widget','application','journey','mcp','finetune'])await fixture(async(client)=>{const result:any=await tool('swfte_resolve',client,{...input,artifact:{kind,id:'owned'},intent:'fix'});assert.equal(result.intent,'FIX');assert.equal(result.state,'NEEDS_USER');assert.equal(result.artifact.kind,kind);},()=>({body:{...session(),artifact:{kind,id:'owned'},intent:'FIX',state:'NEEDS_USER',finishedAt:'2026-10-02T12:00:01Z',unresolvedTaskKeys:['GOVERNED_RESOLVER_MODEL_SEAM_UNAVAILABLE']}}));
});
test('foreign start artifact workspace content intent effective budget and absent native start refuse',async()=>{
 for(const mutate of [(s:any)=>s.workspaceId='foreign',(s:any)=>s.artifact={kind:'agent',id:'owned'},(s:any)=>s.artifact={kind:'workflow',id:'foreign'},(s:any)=>s.contentHash='b'.repeat(64),(s:any)=>s.intent='FIX',(s:any)=>s.budget.maxSteps=4,(s:any)=>s.budget.maxWallSeconds=119,(s:any)=>s.budget.maxSpendUsd=1,(s:any)=>s.startedAt=null])await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_resolve',client),/RESOLVER_START_RESPONSE_BINDING_MISMATCH/);assert.equal(calls.length,1);},()=>{const body=session();mutate(body);return{body};});
});
test('owned status exact requested id and workspace preserves real state and open artifact vocabulary',()=>fixture(async(client,calls)=>{const result:any=await tool('swfte_resolver_status',client);assert.equal(result.artifact.kind,'future-kind');assert.equal(result.state,'NEEDS_USER');assert.equal(result.actorId,'server-creator');assert.equal(calls.length,1);assert.equal(calls[0]!.path,`/v2/resolver/sessions/${encodeURIComponent(id)}`);assert.equal(calls[0]!.method,'GET');},()=>({body:{...session(),artifact:{kind:'future-kind',id:'future-owned'},state:'NEEDS_USER',finishedAt:'2026-10-02T12:00:01Z',unresolvedTaskKeys:['PROVIDER_UNAVAILABLE']}})));
test('status requested identity substitution refuses with zero mutation',async()=>{
 for(const mutate of [(s:any)=>s.id='other',(s:any)=>s.workspaceId='foreign'])await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_resolver_status',client),/RESOLVER_SESSION_IDENTITY_MISMATCH/);assert.equal(calls.length,1);assert.equal(calls[0]!.method,'GET');},()=>{const body=session();mutate(body);return{body};});
});
test('unknown states malformed creator hash budget chronology and terminal shape refuse on both routes',async()=>{
 for(const name of ['swfte_resolve','swfte_resolver_status'])for(const mutate of [(s:any)=>s.state='UNKNOWN',(s:any)=>s.actorId=' ',(s:any)=>s.contentHash='A'.repeat(64),(s:any)=>s.budget.maxSteps=-1,(s:any)=>s.steps=4,(s:any)=>s.startedAt='2026-02-30T00:00:00Z',(s:any)=>{s.state='COMPLETE';s.finishedAt='2026-10-02T12:00:00.123456788Z';},(s:any)=>{s.state='COMPLETE';s.finishedAt='2026-10-02T12:00:01Z';s.unresolvedTaskKeys=['missing'];}])await fixture(async(client)=>{await assert.rejects(tool(name,client));},()=>{const body=session();mutate(body);return{body};});
});
test('null empty and label-only responses cannot claim a started or owned resolver',async()=>{
 for(const name of ['swfte_resolve','swfte_resolver_status'])for(const body of [null,{},[],{state:'COMPLETE'}])await fixture(async(client,calls)=>{await assert.rejects(tool(name,client));assert.equal(calls.length,1);},()=>({body}));
});
test('auth unavailable and uncertain POST never retry fallback or dispatch followup',async()=>{
 for(const name of ['swfte_resolve','swfte_resolver_status'])for(const status of [401,403,404,503])await fixture(async(client,calls)=>{await assert.rejects(tool(name,client),SwfteApiError);assert.equal(calls.length,1);},()=>({status,body:{code:'RESOLVER_UNAVAILABLE'}}));
 for(const name of ['swfte_resolve','swfte_resolver_status'])await fixture(async(client,calls)=>{await assert.rejects(tool(name,client));assert.equal(calls.length,1);},()=>({raw:'{bad'}));
});
test('status nullable queued timestamps retain Java shape and extended native instant stays exact',async()=>{
 await fixture(async(client)=>{const result:any=await tool('swfte_resolver_status',client);assert.equal(result.startedAt,null);assert.deepEqual(result.unresolvedTaskKeys,[]);},()=>({body:{...session(),startedAt:null,unresolvedTaskKeys:null}}));
 await fixture(async(client)=>{const result:any=await tool('swfte_resolve',client);assert.equal(result.startedAt,'-0001-01-01T00:00:00.123456789Z');},()=>({body:{...session(),startedAt:'-0001-01-01T00:00:00.123456789Z'}}));
});
