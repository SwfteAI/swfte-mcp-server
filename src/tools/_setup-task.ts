import {z} from 'zod';
import {setupContractText as text,setupContractInstant as instant} from './_resolver-session.js';
const hash=z.string().regex(/^[0-9a-f]{64}$/);
const nullableText=z.string().nullish();
const handle=text.refine(value=>/^(?:conn_[A-Za-z0-9_-]+|secret:\/\/[A-Za-z0-9_./:-]+|storage:[A-Za-z0-9_-]+|managed:[A-Za-z0-9_./:-]+)$/.test(value));
const literal=text.refine(value=>!/\b(?:AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/.test(value));
const option=z.object({id:text,type:z.enum(['REUSE_CONNECTION','OAUTH_CONNECT','API_KEY','AWS_ROLE_LINK','MANAGED_DEFAULT','PROVISION','ENTER_VALUE','PICK_SUGGESTION','SKIP_BRANCH']),label:text,handle:handle.nullish()}).passthrough();
const binding=z.object({handle:handle.nullish(),literal:literal.nullish()}).passthrough().refine(value=>(value.handle!=null)!==(value.literal!=null));
const evidence=z.object({probeId:text,outcome:z.enum(['PASS','FAIL','UNKNOWN']),evidenceRefs:z.array(text).nullish().transform(value=>value??[])}).passthrough().refine(value=>value.outcome!=='PASS'||value.evidenceRefs.length>0);
const task=z.object({
 key:text,kind:text,title:nullableText,detail:nullableText,required:z.boolean(),provider:nullableText,role:nullableText,recordType:nullableText,
 options:z.array(z.string()).nullish(),placeholder:nullableText,derived:z.boolean(),status:nullableText,answerLabel:nullableText,
 scope:z.enum(['LISTING','ARTIFACT','SOLUTION']).nullish(),artifactKind:text,artifactId:text,solutionId:nullableText,
 subject:z.object({nodeId:nullableText,field:nullableText,label:text}).passthrough().nullish(),authType:nullableText,capability:nullableText,
 state:z.enum(['UNMET','AUTO_BOUND','NEEDS_USER','RESOLVING','RESOLVED','EXPIRED','FAILED','WAIVED']).nullish(),blocksSandbox:z.boolean(),
 resolutionOptions:z.array(option).refine(values=>new Set(values.map(value=>value.id)).size===values.length).nullish(),values:z.record(binding).refine(values=>Object.keys(values).every(key=>/^(?:SANDBOX|LIVE:[A-Za-z0-9_-]+)$/.test(key))).nullish(),
 resolvedBy:z.object({option:text,actor:text,at:instant,evidence}).passthrough().refine(value=>value.evidence.outcome==='PASS').nullish(),
}).passthrough();
export const setupTaskEntrySchema=z.object({task,contentHash:hash,revision:z.number().int().positive().safe(),updatedAt:instant}).passthrough();
export type OwnedSetupTaskEntry=z.infer<typeof setupTaskEntrySchema>;
export function ownedSetupTaskEntries(wire:unknown,artifact:{kind:string;id:string},workspaceId?:string):OwnedSetupTaskEntry[]{
 const entries=z.array(setupTaskEntrySchema).parse(wire),keys=new Set<string>();
 for(const entry of entries){
  if(entry.task.artifactKind!==artifact.kind||entry.task.artifactId!==artifact.id||keys.has(entry.task.key)
    ||workspaceId!==undefined&&entry.workspaceId!==undefined&&entry.workspaceId!==workspaceId)throw new Error('SETUP_RESPONSE_IDENTITY_MISMATCH');
  keys.add(entry.task.key);
 }
 if(new Set(entries.map(entry=>entry.contentHash)).size>1)throw new Error('SETUP_RESPONSE_HASH_MISMATCH');
 return entries;
}
export function resolvedSetupTaskEntry(wire:unknown,artifact:{kind:string;id:string},prior:OwnedSetupTaskEntry,workspaceId?:string):OwnedSetupTaskEntry{
 const result=ownedSetupTaskEntries([wire],artifact,workspaceId)[0]!;
 if(result.task.key!==prior.task.key||result.contentHash!==prior.contentHash||result.revision<=prior.revision)throw new Error('SETUP_RESOLVE_RESPONSE_BINDING_MISMATCH');
 return result;
}
export function unknownRequiredSetupTasks(entries:OwnedSetupTaskEntry[]):OwnedSetupTaskEntry[]{
 return entries.filter(entry=>entry.task.required&&!['connection','role','record','value','choice'].includes(entry.task.kind));
}
