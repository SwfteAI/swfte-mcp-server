import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type ServerResponse} from 'node:http';
import {SwfteClient,SwfteApiError} from '../src/client.js';
import {loadConfig} from '../src/config.js';
import {setupTools} from '../src/tools/setup.js';

const session='resolver-session-1';
type Call={method:string;url:string;headers:Record<string,string|string[]|undefined>};
const row=(seq:number,extra:Record<string,unknown>={})=>({runId:`resolver:${session}`,workspaceId:'workspace-1',seq,type:'RESOLVER_ACTION',data:{session,step:seq,success:false,verification:'UNKNOWN'},...extra});
const frame=(seq:number,data:unknown=row(seq))=>`id:${seq}\nevent:resolver\ndata:${JSON.stringify(data)}\n\n`;
async function local(wire:string|Buffer|((response:ServerResponse)=>void),run:(client:SwfteClient,calls:Call[])=>Promise<void>){
  const calls:Call[]=[];
  const server=createServer((request,response)=>{
    calls.push({method:request.method!,url:request.url!,headers:request.headers});
    response.writeHead(200,{'Content-Type':'text/event-stream'});
    if(typeof wire==='function')wire(response);else response.end(wire);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const config=loadConfig({SWFTE_PAT:'pat_test',SWFTE_BASE_URL:`http://127.0.0.1:${address.port}`,SWFTE_WORKSPACE_ID:'workspace-1',SWFTE_TELEMETRY:'0'} as never);
  try{await run(new SwfteClient(config),calls);}
  finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
async function invoke(client:SwfteClient,patch:Record<string,unknown>={}){
  const tool=setupTools.find(candidate=>candidate.name==='swfte_resolver_status');assert.ok(tool);
  return tool.execute(tool.inputSchema.parse({sessionId:session,events:true,...patch}),{client,config:loadConfig({SWFTE_PAT:'pat_test'} as never)}) as Promise<any>;
}

test('resolver actual journal resumes authenticated contiguous canonical records and preserves additive data',()=>local(
  ': heartbeat\r\n\r\n'+frame(8,row(8,{future:{schema:'next',nested:[1,2]}})).replaceAll('\n','\r\n')+frame(9),
  async(client,calls)=>{
    const result=await invoke(client,{after:7});
    assert.equal(calls.length,1);assert.equal(calls[0]!.method,'GET');
    assert.equal(calls[0]!.url,`/v2/resolver/sessions/${session}/events`);
    assert.equal(calls[0]!.headers.authorization,'Bearer pat_test');
    assert.equal(calls[0]!.headers.accept,'text/event-stream');assert.equal(calls[0]!.headers['last-event-id'],'7');
    assert.equal(result.lastEventId,9);assert.deepEqual(result.events[0].data.future,{schema:'next',nested:[1,2]});
    assert.equal(result.events[0].data.data.success,false);assert.equal(result.events[0].data.data.verification,'UNKNOWN');
  }));
test('resolver journal begins at actual sequence zero without a fabricated cursor',()=>local(frame(0),async(client,calls)=>{
  const result=await invoke(client);assert.equal(calls[0]!.headers['last-event-id'],undefined);
  assert.equal(result.events[0].id,0);assert.equal(result.lastEventId,0);
}));
test('resolver empty bounded journal preserves the existing cursor',()=>local('',async(client,calls)=>{
  const result=await invoke(client,{after:4});assert.equal(calls.length,1);assert.deepEqual(result,{sessionId:session,events:[],lastEventId:4});
}));
for(const [label,wire,error] of [
  ['foreign run',frame(0,row(0,{runId:'resolver:foreign'})),'EVENT_IDENTITY_MISMATCH'],
  ['foreign action',frame(0,row(0,{data:{session:'foreign'}})),'EVENT_IDENTITY_MISMATCH'],
  ['missing workspace',frame(0,row(0,{workspaceId:''})),'EVENT_IDENTITY_MISMATCH'],
  ['foreign workspace',frame(0,row(0,{workspaceId:'foreign-workspace'})),'EVENT_IDENTITY_MISMATCH'],
  ['row sequence mismatch',frame(0,row(1)),'EVENT_IDENTITY_MISMATCH'],
  ['sequence gap',frame(0)+frame(2),'EVENT_SEQUENCE_INVALID'],
  ['duplicate sequence',frame(0)+frame(0),'EVENT_SEQUENCE_INVALID'],
  ['duplicate event id','id:0\n'+frame(0),'EVENT_INVALID'],
  ['wrong event name',frame(0).replace('event:resolver','event:proving'),'EVENT_INVALID'],
  ['malformed JSON','id:0\nevent:resolver\ndata:{\n\n','EVENT_INVALID'],
  ['truncated final frame',frame(0).slice(0,-1),'EVENT_INCOMPLETE'],
  ['noncanonical cursor',frame(0).replace('id:0','id:00'),'EVENT_INVALID'],
] as const)test(`resolver journal rejects ${label} from actual HTTP`,()=>local(wire,async(client,calls)=>{
  await assert.rejects(invoke(client),new RegExp(`RESOLVER_${error}`));assert.equal(calls.length,1);
}));
test('resolver journal rejects invalid UTF-8 bytes instead of accepting replacement text',()=>local(Buffer.concat([
  Buffer.from('id:0\nevent:resolver\ndata:{"invalid":"'),Buffer.from([0xc3,0x28]),Buffer.from('"}\n\n')
]),async(client,calls)=>{await assert.rejects(invoke(client));assert.equal(calls.length,1);}));
test('resolver journal rejects a chunked response over its actual byte cap',()=>local(response=>{
  response.write(frame(0));response.end(': '+'x'.repeat(256*1024)+'\n\n');
},async(client,calls)=>{
  await assert.rejects(invoke(client),error=>error instanceof SwfteApiError&&error.code==='RESPONSE_LIMIT_EXCEEDED');assert.equal(calls.length,1);
}));
test('resolver journal enforces its 128-record window at the actual response boundary',()=>local(
  Array.from({length:129},(_,seq)=>frame(seq)).join(''),async(client,calls)=>{
    await assert.rejects(invoke(client),/RESOLVER_EVENT_SEQUENCE_INVALID/);assert.equal(calls.length,1);
  }));
test('resolver invalid resume cursors refuse before HTTP dispatch',()=>local('',async(client,calls)=>{
  for(const after of [-2,0.5,Number.MAX_SAFE_INTEGER,Number.NaN])await assert.rejects(invoke(client,{after}));
  assert.equal(calls.length,0);
}));
