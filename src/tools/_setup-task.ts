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
type SetupResolutionRequest={optionId:string;environment:string;value?:{literal?:string;handle?:string}};
function currentChoiceOptions(task:OwnedSetupTaskEntry['task']):string[]{
 const choices=task.options,picks=task.resolutionOptions,pick=picks?.[0];
 if(task.kind!=='choice'||!choices?.length||choices.some(value=>!text.safeParse(value).success)
   ||new Set(choices).size!==choices.length||picks?.length!==1||!pick||pick.id!=='pick'
   ||pick.type!=='PICK_SUGGESTION'||pick.handle!=null)throw new Error('SETUP_CHOICE_DECLARATION_INVALID');
 return choices;
}
export function requireSetupResolutionInput(prior:OwnedSetupTaskEntry,request:SetupResolutionRequest):void{
 const option=prior.task.resolutionOptions?.find(value=>value.id===request.optionId);
 if(!option)throw new Error('SETUP_RESOLUTION_OPTION_UNAVAILABLE');
 if(prior.task.kind==='choice'||option.type==='PICK_SUGGESTION'){
  const choices=currentChoiceOptions(prior.task);
  if(option.id!=='pick'||!request.value||request.value.handle!=null||request.value.literal==null
    ||!choices.includes(request.value.literal))throw new Error('SETUP_CHOICE_VALUE_NOT_ALLOWED');
 }
}
export function resolvedSetupTaskEntry(wire:unknown,artifact:{kind:string;id:string},prior:OwnedSetupTaskEntry,workspaceId?:string,request?:SetupResolutionRequest):OwnedSetupTaskEntry{
 const result=ownedSetupTaskEntries([wire],artifact,workspaceId)[0]!;
 if(result.task.key!==prior.task.key||result.contentHash!==prior.contentHash||result.revision<=prior.revision)throw new Error('SETUP_RESOLVE_RESPONSE_BINDING_MISMATCH');
 if(request?.value?.literal!=null){
  const binding=result.task.values?.[request.environment];
  if(result.task.state!=='RESOLVED'||result.task.kind!==prior.task.kind||result.task.resolvedBy?.option!==request.optionId
    ||binding?.handle!=null||binding?.literal!==request.value.literal)throw new Error('SETUP_RESOLVE_RESPONSE_VALUE_MISMATCH');
 }
 if(prior.task.kind==='choice'){
  const before=currentChoiceOptions(prior.task),after=currentChoiceOptions(result.task);
  if(before.length!==after.length||before.some((choice,index)=>choice!==after[index]))throw new Error('SETUP_RESOLVE_RESPONSE_CHOICE_MISMATCH');
 }
 return result;
}
export function unknownRequiredSetupTasks(entries:OwnedSetupTaskEntry[]):OwnedSetupTaskEntry[]{
 return entries.filter(entry=>entry.task.required&&!['connection','role','record','value','choice'].includes(entry.task.kind));
}
