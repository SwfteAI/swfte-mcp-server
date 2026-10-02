import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {SwfteClient,SwfteApiError} from '../src/client.js';
import {loadConfig} from '../src/config.js';
import {setupTools} from '../src/tools/setup.js';
const hash='a'.repeat(64),artifact={kind:'workflow',id:'owned'};
const input={artifact,version:'native-v3',runs:3,fixtureSetId:'smoke-v1',seed:'seed',expectedContentHash:hash};
function proof(level='NONE'):any{
 const ids=level==='VALIDATED'?['actual-1','actual-2','actual-3']:level==='NONE'?[]:['actual-1'];
 const checks=level==='NONE'?[]:level==='OBSERVED'?['effects-present']:level==='CORROBORATED'?['effects-present','terminal-status','step-claims']:['effects-present','terminal-status','step-claims','output-contract','silent-failures'];
 return{id:'proof-owned',workspaceId:'ws',artifactKind:'workflow',artifactId:'owned',version:'native-v3',contentHash:hash,level,checks:checks.map(id=>({id,verdict:'PASS',evidenceRefs:['persisted://actual-1'],reason:null})),executionIds:ids,evidenceRefs:ids.length?['persisted://actual-1']:[],warnings:[],createdAt:'2026-10-02T12:00:00.123456789Z',future:{preserved:true}};
}
type Call={method:string;path:string;body:any;headers:Record<string,unknown>};
async function fixture(run:(client:SwfteClient,calls:Call[])=>Promise<void>,reply:(call:Call)=>{status?:number;body?:unknown;raw?:string}){
 const calls:Call[]=[];const server=createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=String(chunk);const call={method:req.method!,path:req.url!,body:data?JSON.parse(data):undefined,headers:{...req.headers}};calls.push(call);const result=reply(call);res.writeHead(result.status??200,{'content-type':'application/json'});res.end(result.raw??JSON.stringify(result.body));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const config=loadConfig({SWFTE_PAT:'pat_test',SWFTE_BASE_URL:`http://127.0.0.1:${address.port}`,SWFTE_WORKSPACE_ID:'ws',SWFTE_TELEMETRY:'0'} as never);
 try{await run(new SwfteClient(config),calls);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
async function tool(name:string,client:SwfteClient,request:any=name==='swfte_proof'?input:{artifact}){const tool=setupTools.find(tool=>tool.name===name);assert.ok(tool);return tool.execute(tool.inputSchema.parse(request),{client,config:loadConfig({SWFTE_PAT:'pat_test'} as never)});}

test('actual POST all four admitted levels bind exact request and retain additive data without producer invention',async()=>{
 for(const level of ['NONE','OBSERVED','CORROBORATED','VALIDATED'])await fixture(async(client,calls)=>{const result:any=await tool('swfte_proof',client);assert.equal(result.level,level);assert.deepEqual(result.future,{preserved:true});assert.equal(calls.length,1);assert.equal(calls[0]!.method,'POST');assert.equal(calls[0]!.path,'/v2/proof/workflow/owned');assert.deepEqual(calls[0]!.body,{version:'native-v3',runs:3,fixtureSetId:'smoke-v1',seed:'seed',expectedContentHash:hash});assert.equal(calls[0]!.headers['x-actor-id'],undefined);},()=>({body:proof(level)}));
});
test('current GET null is legitimate missing proof and does not trigger execution',()=>fixture(async(client,calls)=>{assert.equal(await tool('swfte_proof_status',client),null);assert.equal(calls.length,1);assert.equal(calls[0]!.method,'GET');},()=>({body:null})));
test('NONE unknown reason and nullable Java lists preserve uncertainty',()=>fixture(async(client)=>{const result:any=await tool('swfte_proof_status',client);assert.equal(result.level,'NONE');assert.equal(result.checks[0].verdict,'UNKNOWN');assert.equal(result.checks[0].reason,'NATIVE_PROVIDER_UNAVAILABLE');assert.deepEqual(result.executionIds,[]);assert.deepEqual(result.evidenceRefs,[]);},()=>({body:{...proof(),checks:[{id:'effects-present',verdict:'UNKNOWN',reason:'NATIVE_PROVIDER_UNAVAILABLE',evidenceRefs:null,future:true}],executionIds:null,evidenceRefs:null,warnings:null}})));
test('foreign workspace artifact hash or version POST cannot be admitted as current',async()=>{
 for(const mutate of [(p:any)=>p.workspaceId='foreign',(p:any)=>p.artifactKind='agent',(p:any)=>p.artifactId='foreign',(p:any)=>p.contentHash='b'.repeat(64),(p:any)=>p.version='same-content-new-version'])await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_proof',client),/PROOF_RESPONSE_BINDING_MISMATCH/);assert.equal(calls.length,1);},()=>{const p=proof();mutate(p);return{body:p};});
});
test('current GET owned identity is strict across eight kinds while native provider absence remains NONE',async()=>{
 for(const kind of ['workflow','chatflow','agent','widget','application','journey','mcp','finetune'])await fixture(async(client,calls)=>{const result:any=await tool('swfte_proof_status',client,{artifact:{kind,id:'owned'}});assert.equal(result.level,'NONE');assert.equal(result.artifactKind,kind);assert.equal(calls.length,1);},()=>({body:{...proof(),artifactKind:kind}}));
 for(const mutate of [(p:any)=>p.workspaceId='foreign',(p:any)=>p.artifactId='foreign',(p:any)=>p.artifactKind='agent'])await fixture(async(client)=>{await assert.rejects(tool('swfte_proof_status',client));},()=>{const p=proof();mutate(p);return{body:p};});
});
test('v1 VERIFIED and label-only or malformed proof records refuse',async()=>{
 for(const body of [{...proof('VALIDATED'),level:'VERIFIED'},[],{},'PASS',{level:'VALIDATED'},undefined])await fixture(async(client)=>{await assert.rejects(tool('swfte_proof_status',client));},()=>({body,raw:body===undefined?'':undefined}));
});
test('duplicate execution check ids and unlinked readback references fail Java semantics',async()=>{
 for(const mutate of [(p:any)=>p.executionIds.push(p.executionIds[0]),(p:any)=>p.checks.push(p.checks[0]),(p:any)=>p.checks[0].evidenceRefs=['foreign://readback']])await fixture(async(client)=>{await assert.rejects(tool('swfte_proof',client));},()=>{const p=proof('VALIDATED');mutate(p);return{body:p};});
});
test('positive effects and corroboration require canonical executed checks and linked evidence',async()=>{
 for(const [level,mutate] of [['OBSERVED',(p:any)=>p.executionIds=[]],['OBSERVED',(p:any)=>p.evidenceRefs=[]],['OBSERVED',(p:any)=>p.checks=[]],['CORROBORATED',(p:any)=>p.checks=p.checks.filter((c:any)=>c.id!=='terminal-status')],['CORROBORATED',(p:any)=>p.checks=p.checks.filter((c:any)=>c.id!=='step-claims')]] as const)await fixture(async(client)=>{await assert.rejects(tool('swfte_proof',client));},()=>{const p=proof(level);mutate(p);return{body:p};});
});
test('VALIDATED requires three distinct runs no warnings and all checks PASS including output silent failure',async()=>{
 for(const mutate of [(p:any)=>p.executionIds=['actual-1','actual-2'],(p:any)=>p.warnings=['UNVERIFIED_READBACK'],(p:any)=>{p.checks[0].verdict='FAIL';},(p:any)=>{p.checks[0].verdict='UNKNOWN';p.checks[0].reason='NO_VERDICT';},(p:any)=>p.checks=p.checks.filter((c:any)=>c.id!=='output-contract'),(p:any)=>p.checks=p.checks.filter((c:any)=>c.id!=='silent-failures')])await fixture(async(client)=>{await assert.rejects(tool('swfte_proof',client));},()=>{const p=proof('VALIDATED');mutate(p);return{body:p};});
});
test('check UNKNOWN requires reason and exercised PASS FAIL require cited evidence',async()=>{
 for(const check of [{id:'check',verdict:'UNKNOWN',evidenceRefs:[]},{id:'check',verdict:'UNKNOWN',reason:' ',evidenceRefs:[]},{id:'check',verdict:'PASS',evidenceRefs:[]},{id:'check',verdict:'FAIL',evidenceRefs:[]}])await fixture(async(client)=>{await assert.rejects(tool('swfte_proof_status',client));},()=>({body:{...proof(),checks:[check]}}));
});
test('exact Java Instant nanos offsets and extended years remain semantic scalar values',async()=>{
 for(const time of ['2026-10-02T14:00:00.123456789+02:00','-0001-01-01T00:00:00Z','+10000-01-01T00:00:00Z'])await fixture(async(client)=>{const result:any=await tool('swfte_proof_status',client);assert.equal(result.createdAt,time);},()=>({body:{...proof(),createdAt:time}}));
 for(const time of ['2026-02-30T00:00:00Z','2026-10-02','2026-10-02T12:00:00.1234567890Z'])await fixture(async(client)=>{await assert.rejects(tool('swfte_proof_status',client));},()=>({body:{...proof(),createdAt:time}}));
});
test('auth outage malformed JSON and uncertain proof POST never retry or fall back',async()=>{
 for(const name of ['swfte_proof','swfte_proof_status'])for(const status of [401,403,404,503])await fixture(async(client,calls)=>{await assert.rejects(tool(name,client),SwfteApiError);assert.equal(calls.length,1);},()=>({status,body:{error:'UNCONFIRMED'}}));
 await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_proof',client));assert.equal(calls.length,1);},()=>({raw:'{bad'}));
});
