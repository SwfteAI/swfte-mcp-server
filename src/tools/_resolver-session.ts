import { z } from 'zod';

// Scalar admission mirrors SetupContractValues and ResolverSession; additive wire data is retained.
const javaBlank=(value:string)=>/^[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*$/u.test(value);
export const resolverSessionIdSchema=z.string().min(1).max(4096).refine(value=>!javaBlank(value)&&!/[\u0000-\u001f\u007f]/u.test(value));
export const setupContractText=resolverSessionIdSchema;
const text=setupContractText;
// Exact ISO_INSTANT parser retained from the independently reviewed prove.ts scalar implementation.
const instantValue=(value:string):bigint|null=>{
  const match=/^(\d{4}|-\d{4,10}|\+\d{5,10})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2}(?::\d{2})?)$/.exec(value);
  if(!match)return null;
  const [,ys,ms,ds,hs,mins,secs,fraction='',zone]=match;
  const year=BigInt(ys!),month=Number(ms),day=Number(ds),hour=Number(hs),minute=Number(mins),second=Number(secs);
  if(year< -1000000000n||year>1000000000n||month<1||month>12||minute>59||second>60||hour>24)return null;
  const leap=year%4n===0n&&(year%100n!==0n||year%400n===0n),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(day<1||day>days[month-1]!||second===60&&(hour!==23||minute!==59)||hour===24&&(minute!==0||second!==0||/[1-9]/.test(fraction)))return null;
  const floor=(n:bigint,d:bigint)=>{const q=n/d;return n<0n&&n%d!==0n?q-1n:q;};
  const y=year-(month<=2?1n:0n),era=floor(y,400n),yoe=y-era*400n,m=BigInt(month+(month>2?-3:9));
  const civil=era*146097n+yoe*365n+yoe/4n-yoe/100n+(153n*m+2n)/5n+BigInt(day)-1n-719468n;
  let offset=0;if(!/^[Zz]$/.test(zone!)){const parts=zone!.slice(1).split(':').map(Number);if(parts[0]!>18||parts[1]!>59||(parts[2]??0)>59||parts[0]===18&&(parts[1]!==0||(parts[2]??0)!==0))return null;offset=(parts[0]!*3600+parts[1]!*60+(parts[2]??0))*(zone![0]==='-'?-1:1);}
  const epoch=(civil*86400n+BigInt(hour*3600+minute*60+Math.min(second,59)-offset))*1000000000n+BigInt(fraction.padEnd(9,'0'));
  return epoch< -31557014167219200000000000n||epoch>31556889864403199999999999n?null:epoch;
};

export const setupContractInstant=text.refine(value=>instantValue(value)!==null);
const timestamp=setupContractInstant;
const integer=z.number().int().min(0).max(2147483647);
const budget=z.object({maxSteps:integer,maxWallSeconds:integer,maxSpendUsd:z.number().finite().nonnegative()}).passthrough();
export const resolverSessionSchema=z.object({
  id:text,workspaceId:text,actorId:text,
  artifact:z.object({kind:text,id:text}).passthrough(),
  contentHash:z.string().regex(/^[0-9a-f]{64}$/),intent:z.enum(['PROVE','FIX']),budget,
  state:z.enum(['QUEUED','RUNNING','COMPLETE','NEEDS_USER','CANCELLED']),steps:integer,
  unresolvedTaskKeys:z.array(text).nullish().transform(value=>value??[]),
  startedAt:timestamp.nullish(),finishedAt:timestamp.nullish(),
}).passthrough().refine(value=>value.steps<=value.budget.maxSteps
  &&resolverTerminal(value.state)===(value.finishedAt!=null)
  &&(!['RUNNING','COMPLETE'].includes(value.state)||value.startedAt!=null)
  &&(!(value.startedAt&&value.finishedAt)||instantValue(value.finishedAt)!>=instantValue(value.startedAt)!)
  &&(value.state!=='COMPLETE'||value.unresolvedTaskKeys.length===0));
export type OwnedResolverSession=z.infer<typeof resolverSessionSchema>;
export const resolverTerminal=(state:string)=>['COMPLETE','NEEDS_USER','CANCELLED'].includes(state);
export function ownedResolverSession(wire:unknown,id:string,workspaceId?:string):OwnedResolverSession {
  const session=resolverSessionSchema.parse(wire);
  if(session.id!==id||workspaceId!==undefined&&session.workspaceId!==workspaceId)throw new Error('RESOLVER_SESSION_IDENTITY_MISMATCH');
  return session;
}
export function cancelledResolverSession(wire:unknown,prior:OwnedResolverSession):OwnedResolverSession {
  const current=ownedResolverSession(wire,prior.id,prior.workspaceId);
  if(current.actorId!==prior.actorId||current.artifact.kind!==prior.artifact.kind||current.artifact.id!==prior.artifact.id
    ||current.contentHash!==prior.contentHash||current.intent!==prior.intent
    ||current.budget.maxSteps!==prior.budget.maxSteps||current.budget.maxWallSeconds!==prior.budget.maxWallSeconds
    ||current.budget.maxSpendUsd!==prior.budget.maxSpendUsd||current.steps<prior.steps
    ||prior.startedAt!=null&&(current.startedAt==null||instantValue(current.startedAt)!==instantValue(prior.startedAt)))
    throw new Error('RESOLVER_CANCEL_BINDING_MISMATCH');
  if(!resolverTerminal(current.state))throw new Error('RESOLVER_CANCEL_NOT_TERMINAL');
  return current;
}
