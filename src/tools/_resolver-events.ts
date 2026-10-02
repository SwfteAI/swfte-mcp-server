/** Parse the actual redacted canonical LedgerEvent SSE wire, preserving every additive field. */
export function resolverEvents(wire:unknown,sessionId:string,after:number,expectedWorkspace?:string){
  if(typeof wire!=='string')throw new Error('RESOLVER_EVENT_INVALID');
  const normalized=wire.replaceAll('\r\n','\n');
  if(normalized && !normalized.endsWith('\n\n'))throw new Error('RESOLVER_EVENT_INCOMPLETE');
  const events:Array<{id:number;event:'resolver';data:Record<string,unknown>}>=[];
  let cursor=after;
  let workspace=expectedWorkspace;
  for(const frame of normalized.split('\n\n')){
    const lines=frame.split('\n').filter(line=>line&&!line.startsWith(':'));
    if(!lines.length)continue;
    const ids=lines.filter(line=>line.startsWith('id:'));
    const names=lines.filter(line=>line.startsWith('event:'));
    const payload=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
    const raw=ids[0]?.slice(3).trim();
    if(ids.length!==1||names.length!==1||names[0]!.slice(6).trim()!=='resolver'||!raw||!/^(0|[1-9][0-9]*)$/.test(raw))throw new Error('RESOLVER_EVENT_INVALID');
    const id=Number(raw);
    if(!Number.isSafeInteger(id)||id!==cursor+1||events.length>=128)throw new Error('RESOLVER_EVENT_SEQUENCE_INVALID');
    let data:unknown;try{data=JSON.parse(payload);}catch{throw new Error('RESOLVER_EVENT_INVALID');}
    if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('RESOLVER_EVENT_INVALID');
    const row=data as Record<string,unknown>;
    if(row.runId!==`resolver:${sessionId}`||row.seq!==id||typeof row.workspaceId!=='string'||!row.workspaceId||typeof row.type!=='string'||!row.type)throw new Error('RESOLVER_EVENT_IDENTITY_MISMATCH');
    if(workspace!==undefined&&row.workspaceId!==workspace)throw new Error('RESOLVER_EVENT_IDENTITY_MISMATCH');
    workspace=row.workspaceId;
    if(row.type==='RESOLVER_ACTION'){
      const action=row.data;
      if(!action||typeof action!=='object'||Array.isArray(action)||(action as Record<string,unknown>).session!==sessionId)throw new Error('RESOLVER_EVENT_IDENTITY_MISMATCH');
    }
    events.push({id,event:'resolver',data:row});cursor=id;
  }
  return {sessionId,events,lastEventId:cursor};
}
