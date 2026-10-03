import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type ServerResponse} from 'node:http';
import {SwfteClient,SwfteApiError} from '../src/client.js';
import {loadConfig} from '../src/config.js';
import {runtimeExecTools} from '../src/tools/runtime-exec.js';
import {proveTools} from '../src/tools/prove.js';

const id='123e4567-e89b-42d3-a456-426614174000';
type Call={method:string;url:string;body:Buffer;headers:Record<string,string|string[]|undefined>};
async function local(run:(client:SwfteClient,calls:Call[])=>Promise<void>,respond?:(call:Call,response:ServerResponse)=>void){
  const calls:Call[]=[];
  const server=createServer(async(request,response)=>{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const call={method:request.method!,url:request.url!,body:Buffer.concat(chunks),headers:request.headers};calls.push(call);
    if(respond){respond(call,response);return;}
    response.writeHead(200,{'Content-Type':'application/json'});
    response.end(JSON.stringify({commandId:id,instanceId:'instance-1',state:'UNCONFIRMED',successful:false,code:'NATIVE_AUTHORITY_UNAVAILABLE'}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const config=loadConfig({SWFTE_PAT:'pat_test',SWFTE_BASE_URL:`http://127.0.0.1:${address.port}`,SWFTE_TELEMETRY:'0'} as never);
  try{await run(new SwfteClient(config),calls);}
  finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
async function invoke(name:string,raw:unknown,client:SwfteClient){
  const definition=[...runtimeExecTools,...proveTools].find(tool=>tool.name===name);assert.ok(definition);
  return definition.execute(definition.inputSchema.parse(raw),{client,config:loadConfig({SWFTE_PAT:'pat_test'} as never)});
}

test('exec sends actual bounded argv once with bearer authority and no URL argv',()=>local(async(client,calls)=>{
  const result:any=await invoke('swfte_runtime_exec',{instanceId:'instance-1',commandId:id,command:'python3',args:['-c','print(42)'],timeoutSeconds:5,maxOutputBytes:32,stream:true},client);
  assert.equal(calls.length,1);assert.equal(calls[0]!.url,'/v2/runtime/instances/instance-1/exec');
  assert.equal(calls[0]!.headers.authorization,'Bearer pat_test');
  const body=JSON.parse(calls[0]!.body.toString('utf8'));assert.equal(body.command,'python3');assert.equal(body.commandId,id);
  for(const field of ['workspaceId','actorId','host','token','defaultDeny'])assert.equal(field in body,false);
  assert.equal(result.state,'UNCONFIRMED');assert.equal(result.successful,false);
}));
for(const [name,method,suffix,input] of [
  ['swfte_runtime_exec_status','GET',`/exec/${id}`,{commandId:id}],
  ['swfte_runtime_exec_cancel','POST',`/exec/${id}/cancel`,{commandId:id}],
  ['swfte_runtime_files','GET','/files?path=.',{}],
  ['swfte_runtime_file_read','GET','/files/content?path=src%2Fmain.py',{path:'src/main.py'}],
] as const)test(`${name} consumes its exact owned server route`,()=>local(async(client,calls)=>{
  await invoke(name,{instanceId:'instance-1',...input},client);assert.equal(calls.length,1);
  assert.equal(calls[0]!.method,method);assert.equal(calls[0]!.url,`/v2/runtime/instances/instance-1${suffix}`);
}));
for(const [name,method,suffix] of [['swfte_runtime_file_write','PUT','/files/content'],['swfte_runtime_upload','POST','/upload']] as const){
  test(`${name} sends exact UTF-8 bytes and immutable command header`,()=>local(async(client,calls)=>{
    const content='print("héllo 🌍")\n';await invoke(name,{instanceId:'instance-1',commandId:id,path:'src/main.py',content},client);
    assert.equal(calls.length,1);const call=calls[0]!;assert.equal(call.method,method);
    assert.equal(call.url,`/v2/runtime/instances/instance-1${suffix}?path=src%2Fmain.py`);
    assert.deepEqual(call.body,Buffer.from(content,'utf8'));assert.equal(call.headers['idempotency-key'],id);
    assert.equal(call.headers['content-length'],String(Buffer.byteLength(content,'utf8')));
    assert.match(String(call.headers['content-type']),/^text\/plain/);
  }));
}
test('raw and JSON body ambiguity refuses before HTTP',()=>local(async(client,calls)=>{
  await assert.rejects(client.request({method:'POST',path:'/v2/runtime/instances/instance-1/upload',body:{},textBody:'code',retries:0}),/REQUEST_BODY_AMBIGUOUS/);
  assert.equal(calls.length,0);
}));
for(const patch of [{host:'outside.example'},{workspaceId:'foreign'},{token:'client-token'},{actorId:'foreign'},{defaultDeny:true},{instanceId:'../other'}]){
  test(`exec rejects untrusted identity field ${Object.keys(patch)[0]}`,()=>local(async(client,calls)=>{
    await assert.rejects(invoke('swfte_runtime_exec',{instanceId:'instance-1',command:'python3',...patch},client));assert.equal(calls.length,0);
  }));
}
for(const path of ['../private','/etc/passwd','src/../private','%2e%2e/private','src\\private','src/\u0000private']){
  test(`file traversal refuses before dispatch: ${JSON.stringify(path)}`,()=>local(async(client,calls)=>{
    await assert.rejects(invoke('swfte_runtime_file_write',{instanceId:'instance-1',commandId:id,path,content:'code'},client));assert.equal(calls.length,0);
  }));
}
test('UTF-8 byte count refuses oversized multibyte and ASCII uploads before dispatch',()=>local(async(client,calls)=>{
  for(const content of ['a'.repeat(32769),'🌍'.repeat(8193)])await assert.rejects(invoke('swfte_runtime_upload',{instanceId:'instance-1',commandId:id,path:'src/main.py',content},client));
  assert.equal(calls.length,0);
}));
test('uncertain mutation never retries actual HTTP503',()=>local(async(client,calls)=>{
  await assert.rejects(invoke('swfte_runtime_exec',{instanceId:'instance-1',command:'python3'},client),SwfteApiError);assert.equal(calls.length,1);
},(_call,response)=>{response.writeHead(503,{'Content-Type':'application/json'});response.end('{"error":"ACTUAL_RUNTIME_UNAVAILABLE"}');}));
test('actual bounded SSE attaches only by command ID and preserves UNCONFIRMED',()=>local(async(client,calls)=>{
  const result:any=await invoke('swfte_runtime_exec_events',{instanceId:'instance-1',commandId:id,after:0},client);
  assert.equal(calls.length,1);assert.equal(calls[0]!.url,`/v2/runtime/instances/instance-1/exec/stream?commandId=${id}`);
  assert.equal(calls[0]!.headers['last-event-id'],'0');assert.equal(calls[0]!.headers.accept,'text/event-stream');
  assert.equal(result.events.length,1);assert.equal(result.events[0].data.successful,false);assert.equal(result.terminal,true);
},(_call,response)=>{response.writeHead(200,{'Content-Type':'text/event-stream'});response.end(`id:1\nevent:runtime-result\ndata:${JSON.stringify({commandId:id,instanceId:'instance-1',state:'UNCONFIRMED',successful:false})}\n\n`);}));
test('foreign SSE command cannot be attached as the requested record',()=>local(async(client,calls)=>{
  await assert.rejects(invoke('swfte_runtime_exec_events',{instanceId:'instance-1',commandId:id},client),/RUNTIME_EVENT_IDENTITY_MISMATCH/);assert.equal(calls.length,1);
},(_call,response)=>{response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('id:0\nevent:runtime-state\ndata:{"commandId":"foreign"}\n\n');}));
test('chunked oversized response aborts without accepting a partial result',()=>local(async(client,calls)=>{
  await assert.rejects(client.request({method:'GET',path:'/v2/runtime/instances/instance-1/files',maxResponseBytes:64,retries:0}),error=>error instanceof SwfteApiError&&error.code==='RESPONSE_LIMIT_EXCEEDED');assert.equal(calls.length,1);
},(_call,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.write('a'.repeat(40));response.end('b'.repeat(40));}));
test('response exactly at byte limit remains a valid positive control',()=>local(async(client,calls)=>{
  const body=JSON.stringify({state:'UNCONFIRMED'});const result:any=await client.request({method:'GET',path:'/v2/runtime/instances/instance-1/files',maxResponseBytes:Buffer.byteLength(body),retries:0});
  assert.equal(result.state,'UNCONFIRMED');assert.equal(calls.length,1);
},(_call,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({state:'UNCONFIRMED'}));}));
test('canonical findings alias reads the actual evidence query route',()=>local(async(client,calls)=>{
  await invoke('swfte_findings',{runId:'run-1'},client);assert.equal(calls[0]!.url,'/v2/confidence/runs/run-1/findings');assert.equal(calls.length,1);
}));
