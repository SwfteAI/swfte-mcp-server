import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { SwfteClient,SwfteApiError } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { setupTools } from '../src/tools/setup.js';
import { proveTools } from '../src/tools/prove.js';
import { promotionTools } from '../src/tools/promotion.js';
import { cloudLinkTools } from '../src/tools/cloud-link.js';
import { connectTools } from '../src/tools/connect.js';
import { actionTools } from '../src/tools/actions.js';
import { prepareIntake,canonicalJson } from '../src/intake/levels.js';
import { requestIntakeConsent } from '../src/intake/consent.js';
import { uploadIntake } from '../src/intake/upload.js';
import type { ToolDefinition } from '../src/tools/_types.js';

const hash='a'.repeat(64);
const durableCommand='12345678-1234-1234-1234-123456789abc';
const durableRequest={artifactKind:'WORKFLOW',artifactId:'owned',profile:'QUICK',frameworks:[],seed:0,expectedContentHash:hash,budget:{persona:1,systemUnderTest:1,report:.1,maxSteps:200}};
// Full result derived from the unchanged backend contracts/running.json golden. Transport fixture only.
const durableGolden={"schemaVersion":"1","run":{"runId":"server-run","workspaceId":"ws","artifactKind":"WORKFLOW","artifactId":"owned","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","environment":"SANDBOX","profile":"QUICK","frameworks":[],"seed":0,"budget":{"persona":1,"systemUnderTest":1,"report":0.1,"maxSteps":200},"status":"RUNNING","engineVersion":"confidence-contract-fixture-v1","modelSnapshot":[{"role":"REPORT","modelId":"synthetic-unpriced-model","priced":false}],"cassetteHead":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","startedAt":"2026-10-01T12:00:00Z"},"claims":[{"dimension":"FUNCTION","elementId":"node:article","verdict":"PASS","evidenceRefs":[{"kind":"CAPTURE","hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"dependsOn":["node:article"],"stale":false},{"dimension":"COMPLETENESS","elementId":"node:article","verdict":"PASS","evidenceRefs":[{"kind":"CAPTURE","hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"dependsOn":["node:article"],"stale":false},{"dimension":"ROBUSTNESS","elementId":"node:article","verdict":"PASS","evidenceRefs":[{"kind":"CAPTURE","hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"dependsOn":["node:article"],"stale":false},{"dimension":"SECURITY","elementId":"node:article","verdict":"PASS","evidenceRefs":[{"kind":"CAPTURE","hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"dependsOn":["node:article"],"stale":false},{"dimension":"COMPLIANCE","elementId":"node:article","verdict":"PASS","evidenceRefs":[{"kind":"CAPTURE","hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"dependsOn":["node:article"],"stale":false}],"completeness":{"covered":5,"applicable":5,"uncovered":[],"inapplicable":[{"elementId":"iface:browser","dimension":"LOAD_COST","reason":"No browser interface in this synthetic artifact"}]},"findings":[],"summary":{"overall":"UNKNOWN","headline":"IN_PROGRESS","dimensions":[{"dimension":"FUNCTION","verdict":"PASS","passCount":1,"failCount":0,"unknownCount":0,"mandatory":true},{"dimension":"COMPLETENESS","verdict":"PASS","passCount":1,"failCount":0,"unknownCount":0,"mandatory":true},{"dimension":"ROBUSTNESS","verdict":"PASS","passCount":1,"failCount":0,"unknownCount":0,"mandatory":true},{"dimension":"LOAD_COST","verdict":"UNKNOWN","passCount":0,"failCount":0,"unknownCount":0,"mandatory":false},{"dimension":"SECURITY","verdict":"PASS","passCount":1,"failCount":0,"unknownCount":0,"mandatory":true},{"dimension":"PRIVACY","verdict":"UNKNOWN","passCount":0,"failCount":0,"unknownCount":0,"mandatory":false},{"dimension":"COMPLIANCE","verdict":"PASS","passCount":1,"failCount":0,"unknownCount":0,"mandatory":true},{"dimension":"BEHAVIOUR","verdict":"UNKNOWN","passCount":0,"failCount":0,"unknownCount":0,"mandatory":false}],"completenessCovered":5,"completenessApplicable":5,"unknownCount":0,"openCriticalFindings":0,"lastRunAt":"2026-10-01T12:00:00Z","evidenceLevel":"OBSERVED"}};
function durableReceipt(){return {identity:{workspaceId:'ws',actorId:'actor',commandId:durableCommand,requestDigest:'b'.repeat(64),contentHash:hash},runId:'server-run',auditHash:'c'.repeat(64),result:structuredClone(durableGolden)};}
function durableReply(call:Call){return {body:call.path==='/v2/confidence/identity'?{workspaceId:'ws',actorId:'actor'}:call.path.endsWith('/identity')?durableReceipt().identity:durableReceipt()};}

type Call={method:string;path:string;body:any;authorization:string|undefined};
async function fixture<T>(run:(client:SwfteClient,calls:Call[])=>Promise<T>,reply:(call:Call)=>{status?:number;body:unknown;rawBody?:string}=()=>({body:[]}),workspaceId?:string) {
  const calls:Call[]=[];
  const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=String(chunk);const call={method:req.method!,path:req.url!,body:text?JSON.parse(text):undefined,authorization:req.headers.authorization};calls.push(call);const response=reply(call);res.writeHead(response.status??200,{'content-type':'application/json'});res.end(response.rawBody??JSON.stringify(response.body))});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('Loopback bind failed');
  const config=loadConfig({SWFTE_PAT:'pat_test',SWFTE_BASE_URL:`http://127.0.0.1:${address.port}`,SWFTE_TELEMETRY:'0',...(workspaceId?{SWFTE_WORKSPACE_ID:workspaceId}:{})} as never);
  try{return await run(new SwfteClient(config),calls)}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
}
async function tool(name:string,input:unknown,client:SwfteClient){const definition=[...setupTools,...proveTools,...promotionTools,...cloudLinkTools,...connectTools,...actionTools].find(candidate=>candidate.name===name) as ToolDefinition;assert.ok(definition);return definition.execute(definition.inputSchema.parse(input),{client,config:loadConfig({SWFTE_PAT:'pat_test'} as never)})}
test('durable confidence submit binds actual identity and exact single admission request',()=>fixture(async(client,calls)=>{
  const receipt:any=await tool('swfte_prove_submit',{commandId:durableCommand,...durableRequest},client);
  assert.equal(receipt.runId,'server-run');assert.equal(calls.length,3);assert.equal(calls[0]!.path,'/v2/confidence/identity');
  assert.equal(calls[2]!.path,`/v2/confidence/runs/submissions/${durableCommand}`);assert.equal(calls[2]!.method,'POST');assert.deepEqual(calls[2]!.body,durableRequest);
  assert.equal('actorId' in calls[2]!.body,false);assert.equal('workspaceId' in calls[2]!.body,false);
},durableReply));
test('durable confidence readback never calls create or start',()=>fixture(async(client,calls)=>{
  const definition=proveTools.find(value=>value.name==='swfte_prove_submission');assert.equal(definition?.readOnly,true);
  await tool('swfte_prove_submission',{commandId:durableCommand,...durableRequest},client);
  assert.deepEqual(calls.map(call=>call.path),['/v2/confidence/identity',`/v2/confidence/runs/submissions/${durableCommand}/identity`,`/v2/confidence/runs/submissions/${durableCommand}/readback`]);assert.deepEqual(calls[2]!.body,durableRequest);
},durableReply));
test('uncertain durable confidence503 never retries replaces UUID or falls back',()=>fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_prove_submit',{commandId:durableCommand,...durableRequest},client),SwfteApiError);
  assert.equal(calls.length,3);assert.equal(calls.filter(call=>call.method==='POST'&&!call.path.endsWith('/identity')).length,1);assert.equal(calls[2]!.path,`/v2/confidence/runs/submissions/${durableCommand}`);
},call=>call.path.endsWith('/identity')?durableReply(call):{status:503,body:{error:'SUBMISSION_UNCONFIRMED'}}));
test('durable confidence wrong server canonical digest refuses exact readback',()=>fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client),/CONFIDENCE_SUBMISSION_BINDING_MISMATCH/);
  assert.equal(calls.length,3);assert.deepEqual(calls[1]!.body,durableRequest);assert.equal(calls[2]!.path.endsWith('/readback'),true);
},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt=durableReceipt();receipt.identity.requestDigest='e'.repeat(64);return{body:receipt}}));
function observedUnknownReceipt():any {
  const receipt=durableReceipt();const result:any=receipt.result;
  // Actual shared CatalogEvidenceLadder.wilson(7,10), also retained in quick-statistical.json.
  // This measures pass rate; no verdict probability or runtime calibration is invented.
  result.claims[0]={...result.claims[0],verdict:'UNKNOWN',unknownReason:'NO_VERDICT',statedConfidence:null,interval:{low:.3968,high:.8922,successes:7,n:10},stale:false};
  result.completeness.covered=4;result.completeness.uncovered=[{elementId:result.claims[0].elementId,dimension:'FUNCTION',reason:'NO_VERDICT'}];
  result.summary.completenessCovered=4;result.summary.unknownCount=1;
  result.summary.dimensions[0]={...result.summary.dimensions[0],verdict:'UNKNOWN',passCount:0,unknownCount:1,interval:{low:.3968,high:.8922,successes:7,n:10}};
  return receipt;
}
test('durable confidence actual UNKNOWN measured Wilson interval survives without verdict confidence',()=>fixture(async(client,calls)=>{
  const receipt:any=await tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client);
  assert.equal(receipt.result.claims[0].verdict,'UNKNOWN');assert.equal(receipt.result.claims[0].unknownReason,'NO_VERDICT');
  assert.equal(receipt.result.claims[0].statedConfidence,null);assert.deepEqual(receipt.result.claims[0].interval,{low:.3968,high:.8922,successes:7,n:10});assert.equal(calls.length,3);
},call=>call.path.endsWith('/identity')?durableReply(call):{body:observedUnknownReceipt()}));
test('durable confidence legacy statistical confidence and null point preserve v1 compatibility',async()=>{
  for(const point of [.7,null])await fixture(async(client)=>{const receipt:any=await tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client);assert.equal(receipt.result.claims[0].statedConfidence,point);assert.equal(receipt.result.run.calibrationVersion,undefined)},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt:any=durableReceipt();const interval={low:.3968,high:.8922,successes:7,n:10};receipt.result.claims[0].interval=interval;receipt.result.claims[0].statedConfidence=point;receipt.result.summary.dimensions[0].interval=interval;return{body:receipt}});
});
test('durable confidence forged summary timestamps and Wilson bounds refuse',async()=>{
  const mutations=[(r:any)=>r.result.summary.overall='PASS',(r:any)=>r.result.summary.unknownCount=99,(r:any)=>r.result.summary.dimensions[0].passCount=99,(r:any)=>r.result.summary.dimensions[0].mandatory=false,(r:any)=>r.result.run.startedAt='2026-10-01',(r:any)=>r.result.run.finishedAt='2026-10-01T12:01:00Z',(r:any)=>{r.result.run.status='COMPLETE';r.result.run.finishedAt='2026-10-01T11:59:59.999999999Z'},(r:any)=>{r.result.claims[0].interval={low:.4,high:.9,successes:7,n:10}}];
  for(const mutation of mutations)await fixture(async(client)=>{await assert.rejects(tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client))},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt:any=durableReceipt();mutation(receipt);return{body:receipt}});
});
test('durable confidence exact Instant fractions offsets and calendar preserve Java time semantics',async()=>{
  await fixture(async(client)=>{const receipt:any=await tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client);assert.equal(receipt.result.run.startedAt,'2026-10-01T14:00:00.123456789+02:00')},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt:any=durableReceipt();receipt.result.run.startedAt='2026-10-01T14:00:00.123456789+02:00';receipt.result.summary.lastRunAt='2026-10-01T12:00:00.123456789Z';return{body:receipt}});
  for(const time of ['2026-02-30T12:00:00Z','2026-10-01T12:00:00.1234567890Z','2026-10-01T12:00:00+19:00','2026-10-01T12:60:00Z'])await fixture(async(client)=>{await assert.rejects(tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client))},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt:any=durableReceipt();receipt.result.run.startedAt=time;receipt.result.summary.lastRunAt=time;return{body:receipt}});
});
test('durable confidence unpriced model prices and duplicate roles refuse',async()=>{
  for(const mutate of [(r:any)=>r.result.run.modelSnapshot[0].inputUsdPerMTok=0,(r:any)=>r.result.run.modelSnapshot.push({...r.result.run.modelSnapshot[0]})])await fixture(async(client)=>{await assert.rejects(tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client))},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt:any=durableReceipt();mutate(receipt);return{body:receipt}});
});
test('durable confidence exact finding fingerprint and failure evidence remain domain bound',async()=>{
  const finding=()=>({fingerprint:createHash('sha256').update(['FUNCTION','node:article','source-gap','INFO'].join('\u001f'),'utf8').digest('hex'),dimension:'FUNCTION',elementId:'node:article',rootCauseKey:'source-gap',severity:'INFO',status:'FIXED',title:'Recorded finding',reproduction:['Inspect recorded input'],evidenceRefs:[{kind:'CAPTURE',hash:'b'.repeat(64)}],affectedElements:['node:article'],gap:false});
  await fixture(async(client)=>{const receipt:any=await tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client);assert.equal(receipt.result.findings[0].fingerprint,finding().fingerprint)},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt:any=durableReceipt();receipt.result.findings=[finding()];return{body:receipt}});
  for(const mutate of [(f:any)=>f.fingerprint='a'.repeat(64),(f:any)=>f.evidenceRefs=[],(f:any)=>f.reproduction=[' '],(f:any)=>f.rootCauseKey='source\u001fgap'])await fixture(async(client)=>{await assert.rejects(tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client))},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt:any=durableReceipt();const value=finding();mutate(value);receipt.result.findings=[value];return{body:receipt}});
});
test('durable confidence pooled intervals deduplicate actual typed claims despite additive fields',()=>fixture(async(client)=>{
  const receipt:any=await tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client);assert.equal(receipt.result.summary.dimensions[0].interval.n,10);
},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt=observedUnknownReceipt();const duplicate={...receipt.result.claims[0],futureField:'additive',interval:{...receipt.result.claims[0].interval,futureBound:'ignored'}};delete duplicate.statedConfidence;receipt.result.claims.push(duplicate);receipt.result.summary.dimensions[0].unknownCount=2;return{body:receipt}}));
test('durable confidence normalized Instant boundary refuses offset and midnight overflow',async()=>{
  for(const time of ['+1000000000-12-31T24:00:00Z','+1000000000-12-31T23:59:59-00:01','-1000000000-01-01T00:00:00+00:01'])await fixture(async(client)=>{await assert.rejects(tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client))},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt:any=durableReceipt();receipt.result.run.startedAt=time;receipt.result.summary.lastRunAt=time;return{body:receipt}});
});
test('durable confidence actual Java negative four digit Instant preserves complete result',async()=>{
  await fixture(async(client)=>{const receipt:any=await tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client);assert.equal(receipt.result.run.startedAt,'-0001-01-01T00:00:00Z');assert.equal(receipt.result.summary.lastRunAt,'-0001-01-01T00:00:00Z')},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt:any=durableReceipt();receipt.result.run.startedAt='-0001-01-01T00:00:00Z';receipt.result.summary.lastRunAt='-0001-01-01T00:00:00Z';return{body:receipt}});
  for(const time of ['-0001-02-29T00:00:00Z','-1000000000-01-01T00:00:00.000000000+00:01'])await fixture(async(client)=>{await assert.rejects(tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client))},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt:any=durableReceipt();receipt.result.run.startedAt=time;receipt.result.summary.lastRunAt=time;return{body:receipt}});
});
test('durable confidence Java nonblank Unicode preserves NBSP figure and narrow spaces',async()=>{
  for(const title of ['\u00a0','\u2007','\u202f'])await fixture(async(client)=>{const receipt:any=await tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client);assert.equal(receipt.result.run.engineVersion,title)},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt:any=durableReceipt();receipt.result.run.engineVersion=title;return{body:receipt}});
  for(const title of [' ','\u2000','\u001c','\u3000'])await fixture(async(client)=>{await assert.rejects(tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client))},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt:any=durableReceipt();receipt.result.run.engineVersion=title;return{body:receipt}});
});
test('durable confidence stale flag exactly matches UNKNOWN STALE reason',async()=>{
  for(const mutate of [(r:any)=>r.result.claims[0].stale=true,(r:any)=>r.result.claims[0].unknownReason='STALE',(r:any)=>{r.result.claims[0].verdict='PASS';r.result.claims[0].unknownReason=null;r.result.claims[0].stale=true}])
    await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client));assert.equal(calls.length,3)},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt=observedUnknownReceipt();mutate(receipt);return{body:receipt}});
  await fixture(async(client)=>{const receipt:any=await tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client);assert.equal(receipt.result.claims[0].stale,true)},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt=observedUnknownReceipt();receipt.result.claims[0].unknownReason='STALE';receipt.result.claims[0].stale=true;receipt.result.completeness.uncovered[0].reason='STALE';return{body:receipt}});
});
test('durable confidence every required result field and malformed claim finding coverage summary refuse',async()=>{
  const changes=[(r:any)=>delete r.result.run.engineVersion,(r:any)=>delete r.result.run.modelSnapshot,(r:any)=>delete r.result.summary.headline,(r:any)=>delete r.result.summary.dimensions,(r:any)=>delete r.result.summary.evidenceLevel,(r:any)=>r.result.claims=[{}],(r:any)=>r.result.findings=[{}],(r:any)=>r.result.completeness.uncovered=[{}],(r:any)=>r.result.summary.dimensions=[{}]];
  for(const change of changes)await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client));assert.equal(calls.length,3)},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt=durableReceipt();change(receipt);return{body:receipt}});
});
test('durable confidence malformed HTTP JSON never retries mutation or creates fallback',()=>fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_prove_submit',{...durableRequest,commandId:durableCommand},client));assert.equal(calls.length,3);
  assert.equal(calls.filter(call=>call.method==='POST'&&!call.path.endsWith('/identity')).length,1);
},call=>call.path.endsWith('/identity')?durableReply(call):{body:null,rawBody:'{"identity":'}));
test('durable confidence invalid UUID missing hash and caller identity refuse before HTTP',()=>fixture(async(client,calls)=>{
  for(const input of [{...durableRequest,commandId:durableCommand.toUpperCase()},{...durableRequest,commandId:durableCommand,expectedContentHash:undefined},{...durableRequest,commandId:durableCommand,actorId:'forged'},{...durableRequest,commandId:durableCommand,workspaceId:'foreign'}])await assert.rejects(tool('swfte_prove_submit',input,client));
  assert.equal(calls.length,0);
}));
test('durable confidence Java opaque identifier parity refuses before HTTP',()=>fixture(async(client,calls)=>{
  for(const artifactId of ['/owned','a..b','https://owned','owned?x','owned#x','owned value'])await assert.rejects(tool('swfte_prove_submit',{...durableRequest,commandId:durableCommand,artifactId},client));
  assert.equal(calls.length,0);
}));
test('foreign durable confidence workspace actor command hash and run refuse',async()=>{
  const changes=[(r:any)=>r.identity.workspaceId='foreign',(r:any)=>r.identity.actorId='foreign',(r:any)=>r.identity.commandId='87654321-1234-1234-1234-123456789abc',(r:any)=>r.identity.contentHash='d'.repeat(64),(r:any)=>r.result.run.runId='other',(r:any)=>r.result.run.workspaceId='foreign',(r:any)=>r.result.run.profile='DEEP',(r:any)=>r.result.run.budget.persona=2,(r:any)=>r.result.run.seed=9,(r:any)=>r.result.run.frameworks=['other'],(r:any)=>r.result.run.artifactId='other'];
  for(const change of changes)await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_prove_submission',{...durableRequest,commandId:durableCommand},client),/CONFIDENCE_SUBMISSION_BINDING_MISMATCH/);assert.equal(calls.length,3)},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt=durableReceipt();change(receipt);return{body:receipt}});
});
test('malformed durable confidence receipt and unavailable verified identity refuse',async()=>{
  for(const mutation of [(r:any)=>r.auditHash='unverified',(r:any)=>r.identity.requestDigest='bad',(r:any)=>r.result.run.environment='LIVE',(r:any)=>r.result.summary.overall='MADE_UP',(r:any)=>delete r.result.claims])await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_prove_submit',{...durableRequest,commandId:durableCommand},client));assert.equal(calls.length,3)},call=>{if(call.path.endsWith('/identity'))return durableReply(call);const receipt=durableReceipt();mutation(receipt);return{body:receipt}});
  await fixture(async(client,calls)=>{await assert.rejects(tool('swfte_prove_submit',{...durableRequest,commandId:durableCommand},client));assert.equal(calls.length,1)},()=>({status:503,body:{error:'IDENTITY_UNAVAILABLE'}}));
});
for(const kind of ['workflow','agent','chatflow','widget','application','journey','mcp','finetune']) {
  test(`setup reads actual ${kind} server route with session credential`,()=>fixture(async(client,calls)=>{await tool('swfte_setup',{artifact:{kind,id:'owned'}},client);assert.equal(calls.length,1);assert.equal(calls[0]!.path,`/v2/artifacts/${kind}/owned/setup`);assert.equal(calls[0]!.authorization,'Bearer pat_test')}));
}
test('LOCAL sends neither source nor a consent request',()=>fixture(async(client,calls)=>{const intake=prepareIntake();assert.deepEqual(await requestIntakeConsent(client,intake),{local:true,snapshotHash:intake.snapshotHash});assert.equal(calls.length,0)}));
test('metadata cannot smuggle source, secret paths or non-JSON values',()=>{
  assert.throws(()=>prepareIntake('MANIFEST',{source:'print(1)'}),/MANIFEST_SOURCE_REFUSED/);
  assert.throws(()=>prepareIntake('TREE',{},[{path:'.env',content:'value'}]),/SOURCE_PATH_REFUSED/);
  assert.throws(()=>canonicalJson({count:Infinity}),/NON_JSON_VALUE/);
  assert.throws(()=>canonicalJson({count:undefined}),/NON_JSON_VALUE/);
});
test('TREE consent contains only the exact content hash/level/TTL',()=>fixture(async(client,calls)=>{
  const intake=prepareIntake('TREE',{},[{path:'src/main.ts',content:'export const answer=42'}],3600);
  await requestIntakeConsent(client,intake);
  assert.equal(calls.length,1);assert.equal(calls[0]!.path,'/v2/actions');
  assert.deepEqual(calls[0]!.body.params,{snapshotHash:intake.snapshotHash,level:'TREE',ttlSeconds:'3600'});
  assert.equal(JSON.stringify(calls[0]!.body).includes('answer'),false);
},()=>({body:{id:'approval',status:'PROPOSED',capability:'confidence.upload_code',target:{kind:'code-bundle',id:hash},environment:'development',requiresApproval:true}})));
test('upload refuses missing approval and a changed body before HTTP',()=>fixture(async(client,calls)=>{
  const intake=prepareIntake('DIFF',{},[{path:'src/main.ts',content:'const value=1'}]);
  await assert.rejects(uploadIntake(client,intake),/INTAKE_APPROVAL_REQUIRED/);
  await assert.rejects(uploadIntake(client,{...intake,snapshotHash:hash},'approved'),/INTAKE_HASH_MISMATCH/);
  assert.equal(calls.length,0);
}));
test('approved TREE upload uses exactly one actual source request',()=>fixture(async(client,calls)=>{
  const intake=prepareIntake('TREE',{},[{path:'src/main.ts',content:'const value=1'}],300);
  await uploadIntake(client,intake,'person-approved');
  assert.equal(calls.length,1);assert.equal(calls[0]!.path,'/v2/confidence/bundles');assert.deepEqual(calls[0]!.body,{...intake,approvalActionId:'person-approved'});
},()=>({status:201,body:{id:'bundle'}})));
const entry={task:{key:'node-key',kind:'record',required:true,derived:true,artifactKind:'workflow',artifactId:'owned',blocksSandbox:true,state:'NEEDS_USER',resolutionOptions:[{id:'key',type:'API_KEY',label:'Choose existing key'}]},contentHash:hash,revision:2,updatedAt:'2026-10-01T00:00:00Z'};
test('stale task revision cannot produce a resolve effect',()=>fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_resolve_setup_task',{artifact:{kind:'workflow',id:'owned'},taskKey:'node-key',optionId:'key',environment:'SANDBOX',value:{handle:'secret-handle'},expectedContentHash:hash,expectedRevision:1},client),/STALE_CONTENT/);
  assert.equal(calls.length,1);assert.equal(calls[0]!.method,'GET');
},()=>({body:[entry]})));
test('literal API key cannot enter the resolution request',()=>fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_resolve_setup_task',{artifact:{kind:'workflow',id:'owned'},taskKey:'node-key',optionId:'key',environment:'SANDBOX',value:{literal:'private-value'},expectedContentHash:hash,expectedRevision:2},client),/server-owned handle/);assert.equal(calls.length,1);
},()=>({body:[entry]})));
test('proof submits content binding and never caller identity',()=>fixture(async(client,calls)=>{
  await tool('swfte_proof',{artifact:{kind:'workflow',id:'owned'},version:'3',fixtureSetId:'smoke-v1',seed:'1',expectedContentHash:hash},client);
  assert.equal(calls.length,1);assert.equal(calls[0]!.path,'/v2/proof/workflow/owned');assert.equal(calls[0]!.body.expectedContentHash,hash);assert.equal(calls[0]!.body.runs,3);assert.equal('workspaceId' in calls[0]!.body,false);assert.equal('actorId' in calls[0]!.body,false);
},()=>({body:{id:'proof-none',workspaceId:'ws',artifactKind:'workflow',artifactId:'owned',version:'3',contentHash:hash,level:'NONE',checks:[],executionIds:[],evidenceRefs:[],warnings:[],createdAt:'2026-10-02T12:00:00Z'}})));
test('proving starts the actual returned run and retains UNKNOWN',()=>fixture(async(client,calls)=>{
  const result:any=await tool('swfte_prove',{artifactKind:'WORKFLOW',artifactId:'owned',expectedContentHash:hash},client);
  assert.equal(calls.length,2);assert.equal(calls[1]!.path,'/v2/confidence/runs/server-run/start');assert.equal(result.result.summary.overall,'UNKNOWN');
},call=>{const dims=['FUNCTION','COMPLETENESS','ROBUSTNESS','LOAD_COST','SECURITY','PRIVACY','COMPLIANCE','BEHAVIOUR'];
function legacyResult(status='QUEUED'):any{
 const terminal=['COMPLETE','FAILED','CANCELLED','BUDGET_EXHAUSTED'].includes(status),start=status==='QUEUED'?null:'2026-10-02T12:00:00.123456789Z',finish=terminal?'2026-10-02T12:00:01Z':null;
 return{schemaVersion:'1',run:{runId:'server-run',workspaceId:'ws',artifactKind:'WORKFLOW',artifactId:'owned',contentHash:hash,environment:'SANDBOX',profile:'QUICK',frameworks:[],seed:1,budget:{persona:1,systemUnderTest:1,report:.1,maxSteps:200},status,engineVersion:'actual-engine-v1',calibrationVersion:null,modelSnapshot:[],cassetteHead:null,startedAt:start,finishedAt:finish},claims:[],completeness:{covered:0,applicable:1,uncovered:[{elementId:'native-node',dimension:'FUNCTION',reason:'NOT_EXERCISED'}],inapplicable:[]},findings:[],summary:{overall:'UNKNOWN',headline:status==='COMPLETE'?'NOTHING_FAILED_SOME_UNTESTED':terminal?'RUN_INCOMPLETE':'IN_PROGRESS',dimensions:dims.map(dimension=>({dimension,verdict:'UNKNOWN',passCount:0,failCount:0,unknownCount:['LOAD_COST','PRIVACY','BEHAVIOUR'].includes(dimension)?0:1,mandatory:!['LOAD_COST','PRIVACY','BEHAVIOUR'].includes(dimension)})),completenessCovered:0,completenessApplicable:1,unknownCount:5,openCriticalFindings:0,lastRunAt:finish??start,evidenceLevel:'NONE'},future:{preserved:true}};
}
return{body:legacyResult(call.path.endsWith('/start')?'RUNNING':'QUEUED')};}));
test('a failed mutation is never automatically retried or followed by start',()=>fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_prove',{artifactKind:'WORKFLOW',artifactId:'owned',expectedContentHash:hash},client),SwfteApiError);assert.equal(calls.length,1);
},()=>({status:503,body:{code:'DEPENDENCY_UNAVAILABLE'}})));
const promotion={idempotencyKey:'request-one',scope:'ARTIFACT',artifacts:[{kind:'workflow',id:'owned',contentHash:hash}],target:{targetId:'target',kind:'SWFTE_CLOUD',region:'eu-west-1'}};
test('blocked promotion creates no approval or deployment client call',()=>fixture(async(client,calls)=>{
  const result:any=await tool('swfte_promote',promotion,client);assert.equal(result.promotion.state,'FAILED');assert.equal(calls.length,1);assert.equal(calls[0]!.path,'/v2/promotions');assert.equal(calls[0]!.body.keepSandboxCopy,true);
},()=>({body:{id:'promotion',state:'FAILED'}})));
test('MCP exposes no tool that can approve its own action',()=>{for(const definition of [...setupTools,...proveTools,...promotionTools,...cloudLinkTools])assert.equal(/approve.*action|action.*approve/.test(definition.name),false)});
test('connections consult actual server tasks before legacy provider lookup',()=>fixture(async(client,calls)=>{
  const result:any=await tool('swfte_connections_check',{workflowId:'owned'},client);assert.equal(result.source,'server-setup');assert.equal(result.ok,false);assert.equal(calls.length,1);assert.equal(calls[0]!.path,'/v2/artifacts/workflow/owned/setup');
},()=>({body:[{...entry,task:{...entry.task,kind:'connection',provider:'slack'}}]})));
test('server task authorization failure does not fall through to legacy connections',()=>fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_connections_check',{workflowId:'owned'},client),SwfteApiError);assert.equal(calls.length,1);assert.equal(calls[0]!.path,'/v2/artifacts/workflow/owned/setup');
},()=>({status:403,body:{code:'FORBIDDEN'}})));

const managedEntry={...entry,task:{...entry.task,capability:'managed_database.read.provision',recordType:'managed_postgresql_read_role',resolutionOptions:[{id:'provision-read',type:'PROVISION',label:'Provision restricted read role'}]}};
const managedResolve={artifact:{kind:'workflow',id:'owned'},taskKey:'node-key',optionId:'provision-read',environment:'SANDBOX',value:{handle:`managed:action:act_${'1'.repeat(32)}`},expectedContentHash:hash,expectedRevision:2};
test('managed READ uses the existing approval capability and exact task revision, never a role password',()=>fixture(async(client,calls)=>{
  await tool('swfte_request_approval',{capability:'managed_database.read.provision',target:'workflow:owned',environment:'development',params:{taskKey:'node-key',expectedRevision:'2'}},client);
  assert.equal(calls.length,1);assert.equal(calls[0]!.path,'/v2/actions');
  assert.deepEqual(calls[0]!.body,{capability:'managed_database.read.provision',target:{kind:'workflow',id:'owned'},environment:'development',params:{taskKey:'node-key',expectedRevision:'2'}});
},()=>({body:{id:`act_${'1'.repeat(32)}`,status:'PROPOSED',capability:'managed_database.read.provision',target:{kind:'workflow',id:'owned'},environment:'development',requiresApproval:true}})));
test('managed READ resolves through the actual approved action handle after current task read',()=>fixture(async(client,calls)=>{
  await tool('swfte_resolve_setup_task',managedResolve,client);
  assert.equal(calls.length,2);assert.equal(calls[0]!.method,'GET');assert.equal(calls[1]!.method,'POST');
  assert.equal(calls[1]!.path,'/v2/artifacts/workflow/owned/setup/node-key/resolve');
  assert.deepEqual(calls[1]!.body,{optionId:'provision-read',environment:'SANDBOX',value:managedResolve.value,expectedContentHash:hash,expectedRevision:2});
},call=>({body:call.method==='GET'?[managedEntry]:{...managedEntry,revision:managedEntry.revision+1,task:{...managedEntry.task,state:'RESOLVED'}}})));
test('a resolve response that does not advance the task revision is refused (negative control for the advance rule)',()=>fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_resolve_setup_task',managedResolve,client),/^Error: SETUP_RESOLVE_RESPONSE_BINDING_MISMATCH$/);
  assert.equal(calls.length,2);assert.equal(calls[1]!.method,'POST');
},call=>({body:call.method==='GET'?[managedEntry]:managedEntry})));
test('managed READ cannot resolve using owner credentials, literal SQL, Live or client action labels',()=>fixture(async(client,calls)=>{
  for(const change of [{value:{handle:'secret://managed_db_owner'}},{value:{literal:'password'}},{environment:'LIVE:target'},{value:{handle:'managed:action:client-label'}}])
    await assert.rejects(tool('swfte_resolve_setup_task',{...managedResolve,...change},client),/MANAGED_READ_APPROVED_ACTION_REQUIRED/);
  assert.equal(calls.length,4);assert.ok(calls.every(call=>call.method==='GET'));
},()=>({body:[managedEntry]})));
test('foreign and duplicate current task rows refuse before resolution effects',()=>fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_resolve_setup_task',managedResolve,client),/^Error: SETUP_RESPONSE_IDENTITY_MISMATCH$/);
  assert.equal(calls.length,1);assert.equal(calls[0]!.method,'GET');
},()=>({body:[{...managedEntry,task:{...managedEntry.task,artifactId:'foreign'}}]})));
test('duplicate task keys never pick the first advertised managed READ option',()=>fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_resolve_setup_task',managedResolve,client),/^Error: SETUP_RESPONSE_IDENTITY_MISMATCH$/);assert.equal(calls.length,1);
},()=>({body:[managedEntry,managedEntry]})));
test('zero and unsafe setup revisions refuse before any server request',()=>fixture(async(client,calls)=>{
  for(const expectedRevision of [0,-1,Number.MAX_SAFE_INTEGER+1])await assert.rejects(tool('swfte_resolve_setup_task',{...managedResolve,expectedRevision},client));
  assert.equal(calls.length,0);
}));
test('uncertain managed READ approval is not automatically retried or resolved',()=>fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_request_approval',{capability:'managed_database.read.provision',target:'workflow:owned',environment:'development',params:{taskKey:'node-key',expectedRevision:'2'}},client),SwfteApiError);
  assert.equal(calls.length,1);assert.equal(calls[0]!.path,'/v2/actions');
},()=>({status:503,body:{error:'UNCONFIRMED'}})));

const deletionRequest={bundleId:'bundle-a',commandId:durableCommand,snapshotHash:hash};
function deletionReceipt(){return {identity:{workspaceId:'ws',actorId:'actor',commandId:durableCommand,bundleId:'bundle-a',snapshotHash:hash,reason:'USER_REQUEST',requestDigest:'d'.repeat(64)},level:'TREE',expiresAt:'2026-10-02T15:00:00.123456789Z',rowAbsentConfirmedAt:'2026-10-02T14:00:00Z',canonicalAuditHash:'b'.repeat(64),scope:'CODE_BUNDLE_STORAGE_ROW'};}
function deletionReply(call:Call){return {body:call.path==='/v2/confidence/identity'?{workspaceId:'ws',actorId:'actor'}:call.path.endsWith('/identity')?deletionReceipt().identity:deletionReceipt()};}
test('durable bundle deletion binds verified server identity exact request and scoped receipt',()=>fixture(async(client,calls)=>{
 const receipt:any=await tool('swfte_code_bundle_delete_once',deletionRequest,client);
 assert.deepEqual(receipt,deletionReceipt());assert.equal(calls.length,3);
 assert.deepEqual(calls.map(c=>c.path),['/v2/confidence/identity',`/v2/confidence/bundles/bundle-a/deletions/${durableCommand}/identity`,`/v2/confidence/bundles/bundle-a/deletions/${durableCommand}`]);
 for(const c of calls.slice(1)){assert.equal(c.method,'POST');assert.deepEqual(c.body,{snapshotHash:hash});}
},deletionReply));
test('durable bundle deletion readback is read only with no mutation fallback',()=>fixture(async(client,calls)=>{
 assert.equal(proveTools.find(t=>t.name==='swfte_code_bundle_deletion')?.readOnly,true);
 assert.equal(proveTools.find(t=>t.name==='swfte_code_bundle_delete_once')?.destructive,true);
 await tool('swfte_code_bundle_deletion',deletionRequest,client);
 assert.equal(calls.length,3);assert.ok(calls[2]!.path.endsWith('/readback'));
},deletionReply));
test('durable bundle deletion invalid UUID hash authority and reason refuse before HTTP',()=>fixture(async(client,calls)=>{
 for(const input of [{...deletionRequest,commandId:'bad'},{...deletionRequest,commandId:durableCommand.toUpperCase()},{...deletionRequest,snapshotHash:'sha256:'+hash},{...deletionRequest,bundleId:'../foreign'},{...deletionRequest,actorId:'forged'},{...deletionRequest,workspaceId:'foreign'},{...deletionRequest,reason:'TERMINAL_RUN'}])await assert.rejects(tool('swfte_code_bundle_delete_once',input,client));
 assert.equal(calls.length,0);
}));
test('durable bundle deletion foreign pure identity never reaches producer',async()=>{
 for(const [field,value] of Object.entries({workspaceId:'foreign',actorId:'foreign',commandId:'00000000-0000-0000-0000-000000000000',bundleId:'other',snapshotHash:'f'.repeat(64),reason:'TERMINAL_RUN'}))await fixture(async(client,calls)=>{
 await assert.rejects(tool('swfte_code_bundle_delete_once',deletionRequest,client));assert.equal(calls.length,2);
 },call=>call.path.endsWith('/identity')&&call.path!=='/v2/confidence/identity'?{body:{...deletionReceipt().identity,[field]:value}}:deletionReply(call));
});
test('durable bundle deletion every foreign receipt identity field refuses',async()=>{
 for(const [field,value] of Object.entries({workspaceId:'foreign',actorId:'foreign',commandId:'00000000-0000-0000-0000-000000000000',bundleId:'other',snapshotHash:'f'.repeat(64),requestDigest:'e'.repeat(64),reason:'RETENTION_EXPIRED'}))await fixture(async(client,calls)=>{
 await assert.rejects(tool('swfte_code_bundle_deletion',deletionRequest,client));assert.equal(calls.length,3);assert.ok(calls[2]!.path.endsWith('/readback'));
 },call=>call.path.endsWith('/readback')?{body:{...deletionReceipt(),identity:{...deletionReceipt().identity,[field]:value}}}:deletionReply(call));
});
test('durable bundle deletion full receipt refuses malformed scope audit level and Java Instant',async()=>{
 for(const patch of [{scope:'ALL_SOURCE'},{canonicalAuditHash:'wrong'},{level:'UNKNOWN'},{expiresAt:'2026-02-30T00:00:00Z'},{rowAbsentConfirmedAt:'2026-10-02'},{rowAbsentConfirmedAt:'2026-10-02T14:00:00.1234567890Z'}])await fixture(async(client,calls)=>{
 await assert.rejects(tool('swfte_code_bundle_deletion',deletionRequest,client));assert.equal(calls.length,3);
 },call=>call.path.endsWith('/readback')?{body:{...deletionReceipt(),...patch}}:deletionReply(call));
 for(const field of Object.keys(deletionReceipt()))await fixture(async(client)=>{
 await assert.rejects(tool('swfte_code_bundle_deletion',deletionRequest,client));
 },call=>{if(!call.path.endsWith('/readback'))return deletionReply(call);const receipt:Record<string,unknown>={...deletionReceipt()};delete receipt[field];return {body:receipt};});
});
test('durable bundle deletion uncertain mutation never retries or allocates fallback',()=>fixture(async(client,calls)=>{
 await assert.rejects(tool('swfte_code_bundle_delete_once',deletionRequest,client));assert.equal(calls.length,3);
 assert.ok(!calls.some(c=>c.method==='DELETE'||c.path==='/v2/confidence/bundles'));
},call=>call.path.endsWith('/identity')?deletionReply(call):{status:503,body:{error:'DELETION_UNCONFIRMED'}}));
test('durable bundle deletion absent pending malformed readback never deletes',async()=>{
 for(const reply of [{status:404,body:{error:'DELETION_NOT_FOUND'}},{status:503,body:{error:'DELETION_UNCONFIRMED'}},{body:null},{body:{},rawBody:'{broken'}])await fixture(async(client,calls)=>{
 await assert.rejects(tool('swfte_code_bundle_deletion',deletionRequest,client));assert.equal(calls.length,3);assert.ok(calls[2]!.path.endsWith('/readback'));
 },call=>call.path.endsWith('/readback')?reply:deletionReply(call));
});

test('durable bundle deletion missing verified owner and reserved actor refuse without mutation',async()=>{
 for(const owner of [{workspaceId:'ws'},{workspaceId:'ws',actorId:'system:confidence-intake'},{workspaceId:'other',actorId:'actor'}])await fixture(async(client,calls)=>{
 await assert.rejects(tool('swfte_code_bundle_delete_once',deletionRequest,client));assert.ok(calls.length<=2);
 },call=>call.path==='/v2/confidence/identity'?{body:owner}:call.path.endsWith('/identity')?{body:{...deletionReceipt().identity,actorId:owner.actorId}}:deletionReply(call));
});
test('durable bundle deletion Java Instant nanoseconds extended year and offset preserve full receipt',async()=>{
 for(const time of ['-0001-01-01T00:00:00.123456789Z','+10000-01-01T00:00:00Z','2026-10-02T14:00:00+01:00:30'])await fixture(async(client)=>{
 const receipt:any=await tool('swfte_code_bundle_deletion',deletionRequest,client);assert.equal(receipt.expiresAt,time);
 },call=>call.path.endsWith('/readback')?{body:{...deletionReceipt(),expiresAt:time}}:deletionReply(call));
});

// Local HTTP transport controls only: no actual provider mutation or erasure acceptance.
test('durable bundle deletion consistently foreign configured workspace refuses before any POST',()=>fixture(async(client,calls)=>{
 assert.equal(client.configuredWorkspaceId,'configured-ws');
 await assert.rejects(tool('swfte_code_bundle_delete_once',deletionRequest,client),/DELETION_CONFIGURED_WORKSPACE_MISMATCH/);
 assert.equal(calls.length,1);assert.equal(calls[0]!.method,'GET');assert.equal(calls[0]!.path,'/v2/confidence/identity');
},deletionReply,'configured-ws'));
test('durable bundle deletion matching configured workspace retains server actor and exact receipt',()=>fixture(async(client,calls)=>{
 assert.equal(client.configuredWorkspaceId,'ws');
 const receipt:any=await tool('swfte_code_bundle_delete_once',deletionRequest,client);
 assert.equal(receipt.identity.workspaceId,'ws');assert.equal(receipt.identity.actorId,'actor');assert.deepEqual(receipt,deletionReceipt());
 assert.equal(calls.length,3);assert.deepEqual(calls[2]!.body,{snapshotHash:hash});
},deletionReply,'ws'));

// Actual client HTTP artifact refusal controls; no legacy provider lookup may replace explicit identity.
for(const kind of ['workflow','agent','chatflow','widget','application','journey','mcp','finetune'])
  test(`explicit ${kind} setup404 cannot fallback to a different workflow`,()=>fixture(async(client,calls)=>{
    await assert.rejects(tool('swfte_connections_check',{workflowId:'different-workflow',artifact:{kind,id:'owned/artifact'},connect:true},client),error=>error instanceof SwfteApiError&&error.status===404);
    assert.equal(calls.length,1);assert.equal(calls[0]!.method,'GET');assert.equal(calls[0]!.path,`/v2/artifacts/${kind}/owned%2Fartifact/setup`);assert.equal(calls[0]!.authorization,'Bearer pat_test');assert.equal(calls[0]!.body,undefined);
  },()=>({status:404,body:{code:'CURRENT_ARTIFACT_UNAVAILABLE'}})));
test('explicit same workflow setup404 stays a refusal rather than legacy readiness',()=>fixture(async(client,calls)=>{
  await assert.rejects(tool('swfte_connections_check',{workflowId:'owned',artifact:{kind:'workflow',id:'owned'}},client),error=>error instanceof SwfteApiError&&error.status===404);
  assert.equal(calls.length,1);assert.equal(calls[0]!.path,'/v2/artifacts/workflow/owned/setup');
},()=>({status:404,body:{code:'SETUP_DISABLED'}})));
test('omitted legacy defaultworkflow fallback retains actual native workflow catalog and connection reads',()=>fixture(async(client,calls)=>{
  const result:any=await tool('swfte_connections_check',{workflowId:'legacy'},client);
  assert.equal(result.source,'older-server-local-fallback');assert.equal(result.workflowId,'legacy');assert.equal(result.ok,true);assert.deepEqual(result.missing,[]);assert.equal(result.requires[0].provider,'slack');
  assert.equal(calls.length,4);assert.equal(calls[0]!.path,'/v2/artifacts/workflow/legacy/setup');assert.equal(calls[1]!.path,'/v2/workflows/legacy');
  assert.ok(calls.some(c=>c.path==='/v2/workflows/nodes/catalog'));assert.ok(calls.some(c=>c.path==='/v1/secrets/oauth/integrations'));assert.ok(calls.every(c=>c.method==='GET'&&c.authorization==='Bearer pat_test'&&c.body===undefined));
},call=>{
  if(call.path.endsWith('/setup'))return{status:404,body:{code:'OLDER_SERVER_SETUP_ABSENT'}};
  if(call.path==='/v2/workflows/legacy')return{body:{workflowId:'legacy',nodes:[{id:'node',type:'SLACK'}]}};
  if(call.path==='/v2/workflows/nodes/catalog')return{body:[{type:'SLACK',oauthProvider:'slack'}]};
  if(call.path==='/v1/secrets/oauth/integrations')return{body:{integrations:{Slack:[{provider:'slack'}]}}};
  throw new Error(`Unexpected fallback effect or route ${call.path}`);
}));
test('actual setup authentication and outage refusals never fallback or replay',async()=>{
  for(const status of [401,403,503])for(const explicit of [false,true])await fixture(async(client,calls)=>{
    await assert.rejects(tool('swfte_connections_check',{workflowId:'owned',...(explicit?{artifact:{kind:'workflow',id:'owned'}}:{})},client),error=>error instanceof SwfteApiError&&error.status===status);
    assert.equal(calls.length,1);assert.equal(calls[0]!.path,'/v2/artifacts/workflow/owned/setup');assert.equal(calls[0]!.method,'GET');
  },()=>({status,body:{code:'SETUP_AUTHORITY_OR_PROVIDER_UNAVAILABLE'}}));
});
test('actual setup unresolved connection and additive Task data remain explicit without OAuth effects',()=>{
  const entries=[{task:{key:'native-task',kind:'connection',required:true,derived:true,blocksSandbox:true,artifactKind:'workflow',artifactId:'owned',state:'NEEDS_USER',provider:'slack',resolutionOptions:[],future:{source:'actual-server-additive'}},contentHash:hash,revision:4,updatedAt:'2026-10-02T12:00:00Z'}];
  return fixture(async(client,calls)=>{
    const result:any=await tool('swfte_connections_check',{workflowId:'owned',artifact:{kind:'workflow',id:'owned'},connect:true},client);
    assert.equal(result.source,'server-setup');assert.equal(result.ok,false);assert.deepEqual(result.missing,['slack']);assert.deepEqual(result.setupTasks,entries);assert.equal(result.requires[0].connected,false);assert.equal(calls.length,1);
  },()=>({body:entries}));
});
