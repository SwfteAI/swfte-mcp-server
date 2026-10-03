import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ToolDefinition } from './_types.js';
import { CONFIDENCE_ARTIFACT_KINDS, CONFIDENCE_PROFILES } from '../contracts/confidence-runtime-v1.js';
import { prepareIntake } from '../intake/levels.js';
import { requestIntakeConsent } from '../intake/consent.js';
import { uploadIntake, getIntakeBundle, deleteIntakeBundle, requestBundleDeletion } from '../intake/upload.js';

const runInput=z.object({runId:z.string().min(1).max(200)}).strict();
const runPath=(id:string)=>`/v2/confidence/runs/${encodeURIComponent(id)}`;
const terminal=new Set(['COMPLETE','CANCELLED','FAILED','BUDGET_EXHAUSTED']);
const javaBlank=(value:string)=>/^[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*$/u.test(value);
const verifiedText=z.string().min(1).refine(value=>!javaBlank(value));
const rawHash=z.string().regex(/^[0-9a-f]{64}$/);
const commandUUID=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const durableBudget=z.object({persona:z.number().finite().nonnegative().max(100),systemUnderTest:z.number().finite().nonnegative().max(100),report:z.number().finite().nonnegative().max(20),maxSteps:z.number().int().min(1).max(50000)}).strict();
const durableInput=z.object({commandId:commandUUID,artifactKind:z.enum(CONFIDENCE_ARTIFACT_KINDS),artifactId:z.string().min(1).max(200).regex(/^[A-Za-z0-9_:@./-]+$/).refine(value=>!value.includes('://')&&!value.startsWith('/')&&!value.includes('..')),profile:z.enum(CONFIDENCE_PROFILES).default('QUICK'),frameworks:z.array(verifiedText.refine(value=>value.length<=200)).max(20).refine(values=>new Set(values).size===values.length).default([]),seed:z.number().int().safe().default(0),expectedContentHash:rawHash,budget:durableBudget.default({persona:1,systemUnderTest:1,report:.1,maxSteps:200})}).strict();
const count=z.number().int().nonnegative().max(2147483647);
const longCount=z.number().int().nonnegative().safe();
const dimension=z.enum(['FUNCTION','COMPLETENESS','ROBUSTNESS','LOAD_COST','SECURITY','PRIVACY','COMPLIANCE','BEHAVIOUR']);
const verdict=z.enum(['PASS','FAIL','UNKNOWN']);
const reason=z.enum(['NOT_EXERCISED','CRASHED','NO_VERDICT','CASSETTE_BROKEN','UNASSESSED_CONTROL','UNCALIBRATED_GRADER','BUDGET','LANE_UNVERIFIED','STALE']);
// ISO_INSTANT scalar parsing with exact nanoseconds; no Date.parse coercion/date-only fallback.
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
const timestamp=verifiedText.refine(value=>instantValue(value)!==null);
const deletionInput=z.object({bundleId:z.string().min(1).max(200).regex(/^[A-Za-z0-9_:@./-]+$/).refine(value=>!value.includes('://')&&!value.startsWith('/')&&!value.includes('..')),commandId:commandUUID,snapshotHash:rawHash}).strict();
const deletionIdentitySchema=z.object({workspaceId:verifiedText,actorId:verifiedText.refine(value=>value!=='system:confidence-intake'),commandId:commandUUID,bundleId:verifiedText,snapshotHash:rawHash,reason:z.literal('USER_REQUEST'),requestDigest:rawHash}).strict();
const deletionReceiptSchema=z.object({identity:deletionIdentitySchema,level:z.enum(['LOCAL','MANIFEST','DIFF','TREE']),expiresAt:timestamp,rowAbsentConfirmedAt:timestamp,canonicalAuditHash:rawHash,scope:z.literal('CODE_BUNDLE_STORAGE_ROW')}).strict();
async function durableDeletion(input:z.infer<typeof deletionInput>,client:import('../client.js').SwfteClient,operation:'deleteOnce'|'readback'){
  const owner=z.object({workspaceId:verifiedText,actorId:verifiedText}).strict().parse(await client.request({method:'GET',path:'/v2/confidence/identity',retries:0}));
  if(client.configuredWorkspaceId!==undefined&&owner.workspaceId!==client.configuredWorkspaceId)throw new Error('DELETION_CONFIGURED_WORKSPACE_MISMATCH');
  const identity=deletionIdentitySchema.parse(await requestBundleDeletion(client,input,'identity'));
  if(identity.workspaceId!==owner.workspaceId||identity.actorId!==owner.actorId||identity.commandId!==input.commandId||identity.bundleId!==input.bundleId||identity.snapshotHash!==input.snapshotHash)throw new Error('DELETION_IDENTITY_MISMATCH');
  const receipt=deletionReceiptSchema.parse(await requestBundleDeletion(client,input,operation));
  if(Object.keys(identity).some(key=>identity[key as keyof typeof identity]!==receipt.identity[key as keyof typeof identity]))throw new Error('DELETION_RECEIPT_MISMATCH');
  return receipt;
}
const wilson=(successes:number,n:number)=>{const z=1.959963984540054,z2=z*z,p=successes/n,denom=1+z2/n,centre=(p+z2/(2*n))/denom,half=z*Math.sqrt(p*(1-p)/n+z2/(4*n*n))/denom;return{low:Math.round(Math.max(0,centre-half)*10000)/10000,high:Math.round(Math.min(1,centre+half)*10000)/10000,successes,n};};
const interval=z.object({n:longCount.positive(),successes:longCount,low:z.number().finite().min(0).max(1),high:z.number().finite().min(0).max(1)}).passthrough().refine(value=>value.successes<=value.n&&value.low===wilson(value.successes,value.n).low&&value.high===wilson(value.successes,value.n).high);
const ref=z.object({kind:z.enum(['CASSETTE','EXEC_LOG','LEDGER','CONTROL_RECORD','CAPTURE']),hash:rawHash}).passthrough();
const claim=z.object({dimension,elementId:verifiedText,verdict,unknownReason:reason.nullish(),statedConfidence:z.number().finite().min(0).max(1).nullish(),interval:interval.nullish(),evidenceRefs:z.array(ref),dependsOn:z.array(verifiedText),stale:z.boolean()}).passthrough().refine(value=>(value.verdict==='UNKNOWN'?value.unknownReason!=null&&value.statedConfidence==null:value.unknownReason==null&&value.evidenceRefs.length>0)&&value.stale===(value.verdict==='UNKNOWN'&&value.unknownReason==='STALE'));
const resultSchema=z.object({schemaVersion:z.literal('1'),run:z.object({runId:verifiedText,workspaceId:verifiedText,artifactKind:z.enum(CONFIDENCE_ARTIFACT_KINDS),artifactId:verifiedText,contentHash:rawHash,environment:z.literal('SANDBOX'),profile:z.enum(CONFIDENCE_PROFILES),frameworks:z.array(verifiedText),seed:z.number().int().safe(),budget:durableBudget,status:z.enum(['QUEUED','RUNNING','COMPLETE','BUDGET_EXHAUSTED','FAILED','CANCELLED']),engineVersion:verifiedText,calibrationVersion:verifiedText.nullish(),modelSnapshot:z.array(z.object({role:verifiedText,modelId:verifiedText,inputUsdPerMTok:z.number().finite().nonnegative().nullish(),outputUsdPerMTok:z.number().finite().nonnegative().nullish(),priced:z.boolean()}).passthrough().refine(value=>value.priced?value.inputUsdPerMTok!=null&&value.outputUsdPerMTok!=null:value.inputUsdPerMTok==null&&value.outputUsdPerMTok==null)),cassetteHead:rawHash.nullish(),startedAt:timestamp.nullish(),finishedAt:timestamp.nullish()}).passthrough(),claims:z.array(claim),completeness:z.object({covered:count,applicable:count,uncovered:z.array(z.object({elementId:verifiedText,dimension,reason}).passthrough()),inapplicable:z.array(z.object({elementId:verifiedText,dimension,reason:verifiedText}).passthrough())}).passthrough().refine(value=>value.covered<=value.applicable&&value.covered+value.uncovered.length===value.applicable),findings:z.array(z.object({fingerprint:rawHash,dimension,elementId:verifiedText,rootCauseKey:verifiedText,severity:z.enum(['CRITICAL','HIGH','MEDIUM','LOW','INFO']),status:z.enum(['OPEN','FIXED']),title:verifiedText,reproduction:z.array(verifiedText),evidenceRefs:z.array(ref),affectedElements:z.array(verifiedText),suggestedFix:z.string().nullish(),rerunCommand:z.string().nullish(),gap:z.boolean()}).passthrough()),summary:z.object({overall:verdict,headline:z.enum(['NOT_RUN','IN_PROGRESS','ALL_MANDATORY_PASSED','FAILURES_FOUND','NOTHING_FAILED_SOME_UNTESTED','RUN_INCOMPLETE','STALE']),dimensions:z.array(z.object({dimension,verdict,passCount:count,failCount:count,unknownCount:count,interval:interval.nullish(),mandatory:z.boolean()}).passthrough()),completenessCovered:count,completenessApplicable:count,unknownCount:count,openCriticalFindings:count,lastRunAt:timestamp.nullish(),evidenceLevel:z.enum(['NONE','OBSERVED','CORROBORATED','VALIDATED','VERIFIED'])}).passthrough()}).passthrough().refine(value=>value.summary.completenessCovered===value.completeness.covered&&value.summary.completenessApplicable===value.completeness.applicable
  &&(!['COMPLETE','FAILED','CANCELLED','BUDGET_EXHAUSTED'].includes(value.run.status)||value.run.finishedAt!=null)
  &&(!['RUNNING','COMPLETE'].includes(value.run.status)||value.run.startedAt!=null));
const identitySchema=z.object({workspaceId:verifiedText,actorId:verifiedText,commandId:commandUUID,requestDigest:rawHash,contentHash:rawHash}).strict();
const receiptSchema=z.object({identity:identitySchema,runId:verifiedText,auditHash:rawHash,result:resultSchema}).strict();
function validProjection(value:z.infer<typeof resultSchema>):boolean {
  const {run,claims,findings,completeness:c,summary:s}=value;
  if(new Set(run.modelSnapshot.map(model=>model.role)).size!==run.modelSnapshot.length)return false;
  for(const finding of findings)if(finding.elementId.includes('\u001f')||finding.rootCauseKey.includes('\u001f')
    ||finding.fingerprint!==createHash('sha256').update([finding.dimension,finding.elementId,finding.rootCauseKey,finding.severity].join('\u001f'),'utf8').digest('hex')||!finding.gap&&!finding.evidenceRefs.length)return false;
  if(terminal.has(run.status)!==(run.finishedAt!=null)||(run.startedAt&&run.finishedAt&&instantValue(run.startedAt)!>instantValue(run.finishedAt)!))return false;
  if(claims.some(claim=>claim.statedConfidence!=null&&claim.interval==null)&&!run.calibrationVersion)return false;
  const dims=dimension.options,key=(element:string,dim:string)=>JSON.stringify([element,dim]);
  const covered=new Set(claims.filter(claim=>claim.elementId!=='*'&&claim.verdict!=='UNKNOWN').map(claim=>key(claim.elementId,claim.dimension)));
  if(covered.size!==c.covered)return false;const applicable=new Set(covered),excluded=new Set<string>();
  for(const cell of c.uncovered){const id=key(cell.elementId,cell.dimension);if(cell.elementId==='*'||applicable.has(id))return false;applicable.add(id);}
  for(const cell of c.inapplicable){const id=key(cell.elementId,cell.dimension);if(cell.elementId==='*'||applicable.has(id)||excluded.has(id))return false;excluded.add(id);}
  if(claims.some(claim=>claim.elementId!=='*'&&!applicable.has(key(claim.elementId,claim.dimension))))return false;
  const unknown=new Set<string>(),counts=new Map(dims.map(dim=>[dim,{pass:0,fail:0,unknown:0}]));let stale=false;
  for(const claim of claims){const n=counts.get(claim.dimension)!;if(claim.verdict==='PASS')n.pass++;else if(claim.verdict==='FAIL')n.fail++;else{n.unknown++;unknown.add(key(claim.elementId,claim.dimension));}stale||=claim.stale;}
  for(const cell of c.uncovered){const id=key(cell.elementId,cell.dimension);if(!unknown.has(id)){unknown.add(id);counts.get(cell.dimension)!.unknown++;}stale||=cell.reason==='STALE';}
  for(const finding of findings)if(finding.gap&&finding.status==='OPEN'){const id=key(finding.elementId,finding.dimension);if(!unknown.has(id)){unknown.add(id);counts.get(finding.dimension)!.unknown++;}}
  for(const dim of dims)if([...unknown].some(id=>{const [element,d]=JSON.parse(id);return d===dim&&element!=='*';}))unknown.delete(key('*',dim));
  if(s.dimensions.length!==dims.length)return false;let anyFail=false,mandatoryOk=true;
  for(let index=0;index<dims.length;index++){
    const dim=dims[index]!,n=counts.get(dim)!,mandatory=run.profile==='QUICK'?!['LOAD_COST','PRIVACY','BEHAVIOUR'].includes(dim):run.profile==='STANDARD'?dim!=='BEHAVIOUR':true;
    const verdict=n.fail?'FAIL':n.unknown||!n.pass?'UNKNOWN':'PASS';anyFail||=n.fail>0;
    if(mandatory&&verdict!=='PASS'){mandatoryOk=false;if(n.pass+n.fail+n.unknown===0&&![...unknown].some(id=>JSON.parse(id)[1]===dim)){unknown.add(key('*',dim));n.unknown=1;}}
    const d=s.dimensions[index]!;if(d.dimension!==dim||d.verdict!==verdict||d.passCount!==n.pass||d.failCount!==n.fail||d.unknownCount!==n.unknown||d.mandatory!==mandatory)return false;
    const elementIntervals=claims.some(claim=>claim.dimension===dim&&claim.interval!=null&&claim.elementId!=='*');
    const distinct=new Map(claims.filter(claim=>claim.dimension===dim&&claim.interval!=null&&(!elementIntervals||claim.elementId!=='*')).map(claim=>[JSON.stringify({dimension:claim.dimension,elementId:claim.elementId,verdict:claim.verdict,statedConfidence:claim.statedConfidence??null,interval:claim.interval?{low:claim.interval.low,high:claim.interval.high,successes:claim.interval.successes,n:claim.interval.n}:null,unknownReason:claim.unknownReason??null,evidenceRefs:claim.evidenceRefs.map(ref=>({kind:ref.kind,hash:ref.hash})),dependsOn:claim.dependsOn,stale:claim.stale}),claim]));let successes=0,total=0;
    for(const claim of distinct.values()){successes+=claim.interval!.successes;total+=claim.interval!.n;}
    const expected=total?wilson(successes,total):null;if((d.interval==null)!==(expected==null)||expected&&d.interval&&(d.interval.low!==expected.low||d.interval.high!==expected.high||d.interval.successes!==expected.successes||d.interval.n!==expected.n))return false;
  }
  const critical=findings.filter(f=>f.severity==='CRITICAL'&&f.status==='OPEN'&&!f.gap).length;
  const overall=anyFail||critical?'FAIL':run.status==='COMPLETE'&&mandatoryOk&&c.applicable>0&&c.covered===c.applicable&&unknown.size===0?'PASS':'UNKNOWN';
  const headline=overall==='FAIL'?'FAILURES_FOUND':run.status!=='COMPLETE'?['QUEUED','RUNNING'].includes(run.status)?'IN_PROGRESS':'RUN_INCOMPLETE':overall==='PASS'?'ALL_MANDATORY_PASSED':stale?'STALE':'NOTHING_FAILED_SOME_UNTESTED';
  const last=run.finishedAt??run.startedAt??null;
  return s.overall===overall&&s.headline===headline&&s.unknownCount===unknown.size&&s.openCriticalFindings===critical&&(last==null?s.lastRunAt==null:s.lastRunAt!=null&&instantValue(s.lastRunAt)===instantValue(last));
}
type AdmittedConfidenceResult=z.infer<typeof resultSchema>;
type AdmittedConfidenceRun=AdmittedConfidenceResult['run'];
const confidenceRunIdentity=(run:AdmittedConfidenceRun)=>JSON.stringify([
  run.runId,run.workspaceId,run.artifactKind,run.artifactId,run.contentHash,run.environment,run.profile,run.frameworks,run.seed,
  [run.budget.persona,run.budget.systemUnderTest,run.budget.report,run.budget.maxSteps],run.engineVersion,
  run.modelSnapshot.map(model=>[model.role,model.modelId,model.priced,model.inputUsdPerMTok??null,model.outputUsdPerMTok??null]),
]);
/** Consumer admission reuses the same Java-parity result projection as durable receipts. */
export function admitConfidenceResult(wire:unknown,client:import('../client.js').SwfteClient,runId?:string,prior?:AdmittedConfidenceRun):AdmittedConfidenceResult {
  const result=resultSchema.parse(wire);
  if(!validProjection(result))throw new Error('CONFIDENCE_RESULT_PROJECTION_INVALID');
  if(client.configuredWorkspaceId!==undefined&&result.run.workspaceId!==client.configuredWorkspaceId
    ||runId!==undefined&&result.run.runId!==runId||prior!==undefined&&confidenceRunIdentity(result.run)!==confidenceRunIdentity(prior))
    throw new Error('CONFIDENCE_RUN_BINDING_MISMATCH');
  return result;
}
function submissionReceipt(value:unknown,input:z.infer<typeof durableInput>,identity:z.infer<typeof identitySchema>){
  const receipt=receiptSchema.parse(value),run=receipt.result.run;
  if(receipt.identity.requestDigest!==identity.requestDigest||receipt.identity.commandId!==input.commandId||receipt.identity.contentHash!==input.expectedContentHash
    ||receipt.identity.workspaceId!==identity.workspaceId||receipt.identity.actorId!==identity.actorId||run.workspaceId!==receipt.identity.workspaceId
    ||receipt.runId!==run.runId||run.contentHash!==input.expectedContentHash||run.artifactKind!==input.artifactKind||run.artifactId!==input.artifactId
    ||run.profile!==input.profile||run.seed!==input.seed||JSON.stringify(run.frameworks)!==JSON.stringify(input.frameworks)
    ||Object.keys(input.budget).some(key=>run.budget[key as keyof typeof run.budget]!==input.budget[key as keyof typeof input.budget]))throw new Error('CONFIDENCE_SUBMISSION_BINDING_MISMATCH');
  if(!validProjection(receipt.result))throw new Error('CONFIDENCE_RESULT_PROJECTION_INVALID');
  return receipt;
}
export const proveTools: ToolDefinition[]=[
  {name:'swfte_prove_submit',title:'Submit one durable confidence command',description:'Persist the canonical command UUID and exact request before calling. Submit once through actual durable admission. On uncertainty use swfte_prove_submission with the same request; never replace the UUID or fall back to legacy create.',inputSchema:durableInput,execute:async(input,{client})=>{
    const {commandId,...body}=input;
    const caller=z.object({workspaceId:verifiedText,actorId:verifiedText}).strict().parse(await client.request({method:'GET',path:'/v2/confidence/identity',retries:0}));
    const identity=identitySchema.parse(await client.request({method:'POST',path:`/v2/confidence/runs/submissions/${commandId}/identity`,body,retries:0}));
    if(identity.workspaceId!==caller.workspaceId||identity.actorId!==caller.actorId||identity.commandId!==commandId||identity.contentHash!==body.expectedContentHash)throw new Error('CONFIDENCE_SUBMISSION_IDENTITY_MISMATCH');
    return submissionReceipt(await client.request({method:'POST',path:`/v2/confidence/runs/submissions/${commandId}`,body,retries:0}),input,identity);
  }},
  {name:'swfte_prove_submission',title:'Read exact durable confidence receipt',readOnly:true,description:'Reconcile the same persisted UUID and exact request only. This never creates, starts, refreshes or recovers a run; returned status is persisted evidence, not a new current calibration attestation.',inputSchema:durableInput,execute:async(input,{client})=>{
    const {commandId,...body}=input;
    const caller=z.object({workspaceId:verifiedText,actorId:verifiedText}).strict().parse(await client.request({method:'GET',path:'/v2/confidence/identity',retries:0}));
    const identity=identitySchema.parse(await client.request({method:'POST',path:`/v2/confidence/runs/submissions/${commandId}/identity`,body,retries:0}));
    if(identity.workspaceId!==caller.workspaceId||identity.actorId!==caller.actorId||identity.commandId!==commandId||identity.contentHash!==body.expectedContentHash)throw new Error('CONFIDENCE_SUBMISSION_IDENTITY_MISMATCH');
    return submissionReceipt(await client.request({method:'POST',path:`/v2/confidence/runs/submissions/${commandId}/readback`,body,retries:0}),input,identity);
  }},
  {name:'swfte_code_intake',title:'Prepare approved code intake',description:'LOCAL sends nothing. MANIFEST sends metadata only. DIFF and TREE are secret-scanned and content-bound; source upload requires an existing person-approved action. TREE expires within24hours; DIFF source is never retained.',inputSchema:z.object({level:z.enum(['LOCAL','MANIFEST','DIFF','TREE']).default('LOCAL'),manifest:z.record(z.unknown()).default({}),files:z.array(z.object({path:z.string(),content:z.string()}).strict()).max(1000).default([]),ttlSeconds:z.number().int().min(1).max(86400).default(86400),approvalActionId:z.string().min(1).max(200).optional()}).strict(),execute:async(input,{client})=>{
    const intake=prepareIntake(input.level,input.manifest,input.files,input.ttlSeconds);
    return input.approvalActionId?uploadIntake(client,intake,input.approvalActionId):requestIntakeConsent(client,intake);
  }},
  {name:'swfte_code_bundle',title:'Read owned code bundle metadata',readOnly:true,description:'Read actual current bundle metadata; foreign, expired and deleted bundles remain unavailable.',inputSchema:z.object({bundleId:z.string().min(1).max(200)}).strict(),execute:(input,{client})=>getIntakeBundle(client,input.bundleId)},
  {name:'swfte_code_bundle_delete_once',title:'Delete one exact owned bundle row',destructive:true,description:'Persist exact caller UUID, bundle and hash before first mutation. Obtain server identity and confirmed canonical audit receipt for CODE_BUNDLE_STORAGE_ROW only. Uncertain responses require exact swfte_code_bundle_deletion readback; never replace UUID or retry mutation. Independent run snapshots and backups are outside this receipt.',inputSchema:deletionInput,execute:(input,{client})=>durableDeletion(input,client,'deleteOnce')},
  {name:'swfte_code_bundle_deletion',title:'Read exact bundle deletion receipt',readOnly:true,description:'Read-only exact original UUID/hash reconciliation. Never deletes, retries mutation or treats a missing bundle as confirmed erasure. Scope is CODE_BUNDLE_STORAGE_ROW only.',inputSchema:deletionInput,execute:(input,{client})=>durableDeletion(input,client,'readback')},
  {name:'swfte_code_bundle_delete',title:'Delete owned code bundle',destructive:true,description:'Legacy server lifecycle request; live bundles refuse without trusted terminal mapping. For user deletion use swfte_code_bundle_delete_once with persisted UUID/hash.',inputSchema:z.object({bundleId:z.string().min(1).max(200)}).strict(),execute:(input,{client})=>deleteIntakeBundle(client,input.bundleId)},
  {
    name:'swfte_prove', title:'Run the actual sandbox proving ground',
    description:'Create and start actual sandbox confidence for a server-owned current artifact. No URL, client verdict or claimed confidence is accepted. All judged confidence requires versioned calibration; incomplete measurements remain UNKNOWN. This never promotes.',
    inputSchema:z.object({artifactKind:z.enum(CONFIDENCE_ARTIFACT_KINDS),artifactId:z.string().min(1).max(200),profile:z.enum(CONFIDENCE_PROFILES).default('QUICK'),frameworks:z.array(z.string().min(1).max(200)).max(20).default([]),seed:z.number().int().safe().default(1),expectedContentHash:z.string().regex(/^[0-9a-f]{64}$/),budget:z.object({persona:z.number().finite().nonnegative().max(100),systemUnderTest:z.number().finite().nonnegative().max(100),report:z.number().finite().nonnegative().max(20),maxSteps:z.number().int().min(1).max(50000)}).strict().default({persona:1,systemUnderTest:1,report:.1,maxSteps:200}),waitSeconds:z.number().int().min(0).max(120).default(0)}).strict(),
    execute:async(input,{client})=>{
      const {waitSeconds,...body}=input;
      const created=admitConfidenceResult(await client.request({method:'POST',path:'/v2/confidence/runs',body,retries:0}),client);
      const run=created.run;
      if(run.artifactKind!==body.artifactKind||run.artifactId!==body.artifactId||run.contentHash!==body.expectedContentHash
        ||run.profile!==body.profile||JSON.stringify(run.frameworks)!==JSON.stringify(body.frameworks)||run.seed!==body.seed
        ||run.budget.persona!==body.budget.persona||run.budget.systemUnderTest!==body.budget.systemUnderTest
        ||run.budget.report!==body.budget.report||run.budget.maxSteps!==body.budget.maxSteps
        ||run.status!=='QUEUED'||run.startedAt!=null||run.finishedAt!=null)throw new Error('CONFIDENCE_CREATE_BINDING_MISMATCH');
      const runId=created.run.runId;
      const started=admitConfidenceResult(await client.request({method:'POST',path:`${runPath(runId)}/start`,body:{},retries:0}),client,runId,run);
      if (!waitSeconds) return {runId,result:started,reportPath:`${runPath(runId)}/report`,next:'Read swfte_prove_status; results are current-content bound.'};
      // pollUntil tolerates transport errors after its first poll; admission failure must instead stop immediately.
      let pollFailure:{error:unknown}|undefined;
      const progress=await client.pollUntil(async()=>{
        try{return admitConfidenceResult(await client.request({method:'GET',path:runPath(runId),retries:0}),client,runId,run);}
        catch(error){pollFailure={error};return started;}
      },result=>pollFailure!==undefined||terminal.has(result.run.status),{timeoutMs:waitSeconds*1000,intervalMs:1000});
      if(pollFailure)throw pollFailure.error;
      return {runId,...progress,reportPath:`${runPath(runId)}/report`};
    },
  },
  {name:'swfte_prove_status',title:'Read actual confidence status',readOnly:true,description:'Read an owned confidence result, including every UNKNOWN reason and current-content binding.',inputSchema:runInput,execute:async(input,{client})=>admitConfidenceResult(await client.request({method:'GET',path:runPath(input.runId),retries:0}),client,input.runId)},
  {name:'swfte_prove_estimate',title:'Read confidence cost estimate',readOnly:true,description:'Estimate an existing queued run before starting it. Unpriced models and dependency gaps remain explicit.',inputSchema:runInput,execute:(input,{client})=>client.request({method:'POST',path:`${runPath(input.runId)}/estimate`,body:{},retries:0})},
  {name:'swfte_prove_findings',title:'Read measured findings',readOnly:true,description:'Read findings linked to actual evidence; gaps remain gaps.',inputSchema:runInput,execute:(input,{client})=>client.request({method:'GET',path:`${runPath(input.runId)}/findings`})},
  {name:'swfte_findings',title:'Read measured findings',readOnly:true,description:'Read canonical proving-ground findings linked to actual evidence. Compatibility swfte_prove_findings remains available.',inputSchema:runInput,execute:(input,{client})=>client.request({method:'GET',path:`${runPath(input.runId)}/findings`})},
  {name:'swfte_prove_report',title:'Read the ten-section report',readOnly:true,description:'Read JSON or Markdown from the authoritative report, with the separate Unknown list and claims boundary.',inputSchema:runInput.extend({format:z.enum(['json','md']).default('json')}),execute:(input,{client})=>client.request({method:'GET',path:`${runPath(input.runId)}/report`,query:{format:input.format}})},
  {name:'swfte_prove_cancel',title:'Cancel confidence execution',description:'Request cancellation; remaining measurements become UNKNOWN. Cancellation does not manufacture a passing report.',inputSchema:runInput,execute:async(input,{client})=>{
    const prior=admitConfidenceResult(await client.request({method:'GET',path:runPath(input.runId),retries:0}),client,input.runId);
    if(terminal.has(prior.run.status))return prior;
    return admitConfidenceResult(await client.request({method:'POST',path:`${runPath(input.runId)}/cancel`,body:{},retries:0}),client,input.runId,prior.run);
  }},
];
