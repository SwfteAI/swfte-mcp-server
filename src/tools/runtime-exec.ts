import {z} from 'zod';
import type {ToolDefinition} from './_types.js';

const instanceId=z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
  .refine(value=>!value.includes('..'),'Invalid instance identity');
const commandId=z.string().uuid().refine(value=>value===value.toLowerCase(),'Command ID must be canonical');
const relativePath=z.string().min(1).max(512).refine(value=>value==='.'||(
  !value.startsWith('/')&&!value.includes('\\')&&!value.includes('%')&&!/[\u0000-\u001f\u007f]/.test(value)
  &&value.split('/').every(segment=>segment!==''&&segment!=='.'&&segment!=='..')),'Path must remain in the instance file jail');
const instance=z.object({instanceId}).strict();
const command=instance.extend({commandId}).strict();
const file=instance.extend({path:relativePath.refine(value=>value!=='.','File path must name a file')}).strict();
const write=file.extend({commandId,content:z.string().refine(value=>Buffer.byteLength(value,'utf8')<=32768,'File exceeds32768 UTF-8 bytes')}).strict();
const base=(id:string)=>`/v2/runtime/instances/${encodeURIComponent(id)}`;
const bounded={retries:0,maxResponseBytes:256*1024,timeoutMs:95_000};
const terminalStates=new Set(['COMPLETED','FAILED','TRUNCATED','UNCONFIRMED']);

/** No tool accepts a host, token, tenant, confinement label or caller-supplied success claim. */
export const runtimeExecTools:ToolDefinition[]=[
  {name:'swfte_runtime_exec',title:'Execute in an owned confined runtime',
    description:'Run bounded argv in an existing server-owned default-deny instance. Requires the actual runtime exec flag and confinement authority. Returned state/evidence comes from the actual command record; no automatic retry or promotion.',
    inputSchema:instance.extend({commandId:commandId.optional(),command:z.string().min(1).max(1024),args:z.array(z.string().max(4096)).max(64).default([]),cwd:relativePath.optional(),timeoutSeconds:z.number().int().min(1).max(30).default(10),maxOutputBytes:z.number().int().min(1).max(65536).default(16384),stream:z.boolean().default(false)}).strict(),
    execute:(input,{client})=>{const {instanceId,...body}=input;return client.request({method:'POST',path:`${base(instanceId)}/exec`,body,...bounded});}},
  {name:'swfte_runtime_exec_status',title:'Read an actual runtime command',readOnly:true,
    description:'Read only the actual owned instance command ID. Missing records and uncertain effects remain unavailable or UNKNOWN.',inputSchema:command,
    execute:(input,{client})=>client.request({method:'GET',path:`${base(input.instanceId)}/exec/${input.commandId}`,...bounded})},
  {name:'swfte_runtime_exec_cancel',title:'Cancel an owned runtime command',
    description:'Request actual cancellation of the recorded command. A signal acknowledgement does not establish termination or cleanup.',inputSchema:command,
    execute:(input,{client})=>client.request({method:'POST',path:`${base(input.instanceId)}/exec/${input.commandId}/cancel`,body:{},...bounded})},
  {name:'swfte_runtime_exec_events',title:'Attach to bounded runtime events',
    description:'Attach to an existing opaque command ID; argv is never placed in a URL. Reads a bounded actual SSE response. Disconnect can request server abort, and only a terminal record establishes an outcome.',
    inputSchema:command.extend({after:z.number().int().min(-1).max(1).default(-1)}).strict(),execute:async(input,{client})=>{
      const result=await client.request<unknown>({method:'GET',path:`${base(input.instanceId)}/exec/stream`,query:{commandId:input.commandId},headers:{Accept:'text/event-stream',...(input.after>=0?{'Last-Event-ID':String(input.after)}:{})},...bounded});
      if(typeof result!=='string')throw new Error('RUNTIME_EVENT_INVALID');
      const events=[];let cursor=input.after;
      for(const frame of result.replaceAll('\r\n','\n').split('\n\n')){
        if(!frame.trim()||frame.trimStart().startsWith(':'))continue;
        const lines=frame.split('\n');const ids=lines.filter(line=>line.startsWith('id:'));
        const names=lines.filter(line=>line.startsWith('event:'));
        if(ids.length!==1||names.length!==1)throw new Error('RUNTIME_EVENT_INVALID');
        const id=Number(ids[0]!.slice(3).trim());const event=names[0]!.slice(6).trim();
        if(!Number.isInteger(id)||id<=cursor||id>1||!['runtime-state','runtime-result'].includes(event))throw new Error('RUNTIME_EVENT_INVALID');
        const data=JSON.parse(lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n'));
        if(!data||data.commandId!==input.commandId||event==='runtime-result'&&data.instanceId!==input.instanceId)throw new Error('RUNTIME_EVENT_IDENTITY_MISMATCH');
        cursor=id;events.push({id,event,data});
      }
      const last=events.at(-1);return {commandId:input.commandId,instanceId:input.instanceId,events,
        terminal:last?.event==='runtime-result'&&terminalStates.has(last.data.state),lastEventId:cursor};
    }},
  {name:'swfte_runtime_files',title:'List the owned instance file jail',readOnly:true,
    description:'Read actual bounded file metadata through the authenticated server jail. Symlinks and paths outside the jail refuse.',inputSchema:instance.extend({path:relativePath.default('.')}).strict(),
    execute:(input,{client})=>client.request({method:'GET',path:`${base(input.instanceId)}/files`,query:{path:input.path},...bounded})},
  {name:'swfte_runtime_file_read',title:'Read a bounded runtime file',readOnly:true,
    description:'Read actual bounded UTF-8 content with server redaction/hash records. Missing confinement, symlink or size proof refuses.',inputSchema:file,
    execute:(input,{client})=>client.request({method:'GET',path:`${base(input.instanceId)}/files/content`,query:{path:input.path},...bounded})},
  {name:'swfte_runtime_file_write',title:'Write and read back a bounded runtime file',
    description:'Write at most32768 UTF-8 bytes using one canonical idempotency command ID. Uses actual raw text bytes and server readback; uncertain mutation is never automatically retried.',inputSchema:write,
    execute:(input,{client})=>client.request({method:'PUT',path:`${base(input.instanceId)}/files/content`,query:{path:input.path},headers:{'Idempotency-Key':input.commandId},textBody:input.content,...bounded})},
  {name:'swfte_runtime_upload',title:'Upload a bounded runtime file',
    description:'Upload at most32768 UTF-8 bytes to the actual owned instance jail. No host, credential, production deployment or passing proof is supplied by the caller.',inputSchema:write,
    execute:(input,{client})=>client.request({method:'POST',path:`${base(input.instanceId)}/upload`,query:{path:input.path},headers:{'Idempotency-Key':input.commandId},textBody:input.content,...bounded})},
];
