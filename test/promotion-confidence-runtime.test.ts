import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SwfteClient,SwfteApiError } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { setupTools } from '../src/tools/setup.js';
import { proveTools } from '../src/tools/prove.js';
import { promotionTools } from '../src/tools/promotion.js';
import { cloudLinkTools } from '../src/tools/cloud-link.js';
import { connectTools } from '../src/tools/connect.js';
import { prepareIntake,canonicalJson } from '../src/intake/levels.js';
import { requestIntakeConsent } from '../src/intake/consent.js';
import { uploadIntake } from '../src/intake/upload.js';
import type { ToolDefinition } from '../src/tools/_types.js';

const hash='a'.repeat(64);
type Call={method:string;path:string;body:any;authorization:string|undefined};
async function fixture<T>(run:(client:SwfteClient,calls:Call[])=>Promise<T>,reply:(call:Call)=>{status?:number;body:unknown}=()=>({body:[]})) {
  const calls:Call[]=[];
  const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=String(chunk);const call={method:req.method!,path:req.url!,body:text?JSON.parse(text):undefined,authorization:req.headers.authorization};calls.push(call);const response=reply(call);res.writeHead(response.status??200,{'content-type':'application/json'});res.end(JSON.stringify(response.body))});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('Loopback bind failed');
  const config=loadConfig({SWFTE_PAT:'pat_test',SWFTE_BASE_URL:`http://127.0.0.1:${address.port}`,SWFTE_TELEMETRY:'0'} as never);
  try{return await run(new SwfteClient(config),calls)}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
}
async function tool(name:string,input:unknown,client:SwfteClient){const definition=[...setupTools,...proveTools,...promotionTools,...cloudLinkTools,...connectTools].find(candidate=>candidate.name===name) as ToolDefinition;assert.ok(definition);return definition.execute(definition.inputSchema.parse(input),{client,config:loadConfig({SWFTE_PAT:'pat_test'} as never)})}
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
const entry={task:{key:'node-key',blocksSandbox:true,state:'NEEDS_USER',resolutionOptions:[{id:'key',type:'API_KEY',label:'Choose existing key'}]},contentHash:hash,revision:2,updatedAt:'2026-10-01T00:00:00Z'};
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
}));
test('proving starts the actual returned run and retains UNKNOWN',()=>fixture(async(client,calls)=>{
  const result:any=await tool('swfte_prove',{artifactKind:'WORKFLOW',artifactId:'owned',expectedContentHash:hash},client);
  assert.equal(calls.length,2);assert.equal(calls[1]!.path,'/v2/confidence/runs/server-run/start');assert.equal(result.result.summary.overall,'UNKNOWN');
},()=>({body:{run:{runId:'server-run',status:'QUEUED'},summary:{overall:'UNKNOWN'}}})));
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
