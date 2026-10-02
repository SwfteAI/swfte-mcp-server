import { z } from 'zod';
import type { ToolDefinition } from './_types.js';
import type { ResolverSession } from '../contracts/setup-proof-v1.js';
import {ownedSetupTaskEntries,resolvedSetupTaskEntry} from './_setup-task.js';
import {ownedProofRecord,currentProofRecord} from './_proof-record.js';
import {resolverEvents} from './_resolver-events.js';
import {ownedResolverSession,cancelledResolverSession,resolverTerminal,resolverSessionIdSchema} from './_resolver-session.js';

export const SetupArtifactSchema = z.object({
  kind: z.enum(['workflow','chatflow','agent','widget','application','journey','mcp','finetune']),
  id: z.string().min(1).max(200),
}).strict();
const artifactPath = (artifact: { kind: string; id: string }) => `/v2/artifacts/${encodeURIComponent(artifact.kind)}/${encodeURIComponent(artifact.id)}`;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const value = z.union([z.object({ handle: z.string().min(1).max(400) }).strict(), z.object({ literal: z.string().min(1).max(4096) }).strict()]);

export const setupTools: ToolDefinition[] = [
  {
    name:'swfte_resolver_cancel', title:'Cancel an owned resolver session',
    description:'Read the current owned session, then cancel once through the server. Terminal readbacks and cleanup warnings retain their actual state; unavailable or uncertain cancellation is never replayed.',
    inputSchema:z.object({sessionId:resolverSessionIdSchema}).strict(),
    execute:async(input,{client})=>{
      const path=`/v2/resolver/sessions/${encodeURIComponent(input.sessionId)}`;
      const prior=ownedResolverSession(await client.request({method:'GET',path,retries:0}),input.sessionId,client.configuredWorkspaceId);
      if(resolverTerminal(prior.state))return prior;
      return cancelledResolverSession(await client.request({method:'POST',path:`${path}/cancel`,body:{},retries:0}),prior);
    },
  },
  {
    name:'swfte_setup', title:'Read current setup tasks', readOnly:true,
    description:'Read server-owned, current-content setup tasks for any supported artifact. Entries include authoritative content hash and revision. Missing runtime and authorization failures remain explicit.',
    inputSchema:z.object({ artifact:SetupArtifactSchema }).strict(),
    execute: async(input,{client}) => ownedSetupTaskEntries(await client.request({method:'GET',path:`${artifactPath(input.artifact)}/setup`,retries:0}),input.artifact,client.configuredWorkspaceId),
  },
  {
    name:'swfte_resolve_setup_task', title:'Resolve one current setup task',
    description:'Resolve through one advertised server option, with current hash and revision CAS. Secret values must already be server-owned handles. This cannot waive missing probe evidence or promote anything.',
    inputSchema:z.object({ artifact:SetupArtifactSchema, taskKey:z.string().min(1).max(400), optionId:z.string().min(1).max(200), environment:z.string().regex(/^(SANDBOX|LIVE:[A-Za-z0-9_.:-]+)$/), value:value.optional(), expectedContentHash:hash, expectedRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
    execute:async(input,{client}) => {
      const entries=ownedSetupTaskEntries(await client.request({method:'GET',path:`${artifactPath(input.artifact)}/setup`,retries:0}),input.artifact,client.configuredWorkspaceId);
      if (!Array.isArray(entries)) throw new Error('SETUP_RESPONSE_INVALID');
      const matches=entries.filter(entry=>entry?.task?.key===input.taskKey);
      if(matches.length>1)throw new Error('SETUP_RESPONSE_INVALID');
      const task=matches[0];
      if(task&&(task.task.artifactKind!==input.artifact.kind||task.task.artifactId!==input.artifact.id
        ||!Number.isSafeInteger(task.revision)||task.revision<1||!hash.safeParse(task.contentHash).success))throw new Error('SETUP_RESPONSE_INVALID');
      const option=task?.task.resolutionOptions?.find(candidate=>candidate.id===input.optionId);
      if (!task || !option) throw new Error('The current task does not advertise that resolution option.');
      if (task.contentHash!==input.expectedContentHash || task.revision!==input.expectedRevision) throw new Error('STALE_CONTENT: read current tasks before resolving.');
      if (option.type==='API_KEY' && input.value && 'literal' in input.value) throw new Error('Secret values require a server-owned handle.');
      if(task.task.capability==='managed_database.read.provision'&&(input.artifact.kind!=='workflow'||input.environment!=='SANDBOX'
        ||option.id!=='provision-read'||option.type!=='PROVISION'||!input.value||!('handle' in input.value)
        ||!/^managed:action:act_[0-9a-f]{32}$/.test(input.value.handle)))throw new Error('MANAGED_READ_APPROVED_ACTION_REQUIRED');
      return resolvedSetupTaskEntry(await client.request({method:'POST',path:`${artifactPath(input.artifact)}/setup/${encodeURIComponent(input.taskKey)}/resolve`,body:{optionId:input.optionId,environment:input.environment,value:input.value,expectedContentHash:input.expectedContentHash,expectedRevision:input.expectedRevision},retries:0}),input.artifact,task,client.configuredWorkspaceId);
    },
  },
  {
    name:'swfte_proof', title:'Execute artifact proof',
    description:'Run actual server proof checks against the current sandbox definition. Evidence levels derive from hash-bound execution records and readbacks; a run label alone never passes.',
    inputSchema:z.object({ artifact:SetupArtifactSchema, version:z.string().min(1).max(200), runs:z.number().int().min(1).max(20).default(3), fixtureSetId:z.string().min(1).max(200), seed:z.string().min(1).max(200), expectedContentHash:hash }).strict(),
    execute:async(input,{client})=>ownedProofRecord(await client.request({method:'POST',path:`/v2/proof/${encodeURIComponent(input.artifact.kind)}/${encodeURIComponent(input.artifact.id)}`,body:{version:input.version,runs:input.runs,fixtureSetId:input.fixtureSetId,seed:input.seed,expectedContentHash:input.expectedContentHash},retries:0,timeoutMs:180000}),input.artifact,client.configuredWorkspaceId,{version:input.version,contentHash:input.expectedContentHash}),
  },
  {
    name:'swfte_proof_status', title:'Read current artifact proof', readOnly:true,
    description:'Read latest owned proof for the actual current content. Stale or missing records are not relabeled as current.',
    inputSchema:z.object({ artifact:SetupArtifactSchema }).strict(),
    execute:async(input,{client})=>currentProofRecord(await client.request({method:'GET',path:`/v2/proof/${encodeURIComponent(input.artifact.kind)}/${encodeURIComponent(input.artifact.id)}`,retries:0}),input.artifact,client.configuredWorkspaceId),
  },
  {
    name:'swfte_resolve', title:'Start governed prove or fix resolver',
    description:'Start the bounded server resolver using current content and existing tool/model guards. Unavailable governed execution returns NEEDS_USER; no client planner replaces it.',
    inputSchema:z.object({ artifact:SetupArtifactSchema, intent:z.enum(['prove','fix']), expectedContentHash:hash, budget:z.object({maxSteps:z.number().int().min(1).max(40),maxWallSeconds:z.number().int().min(1).max(600),maxSpendUsd:z.number().finite().min(0).max(50)}).strict().optional() }).strict(),
    execute:(input,{client})=>client.request<ResolverSession>({method:'POST',path:'/v2/resolver/sessions',body:input,retries:0}),
  },
  {
    name:'swfte_resolver_status', title:'Read resolver execution records', readOnly:true,
    description:'Read the actual owned resolver session or a bounded window of its redacted canonical journal. Events resume after the actual Last-Event-ID; reported tool success does not substitute for verification.',
    inputSchema:z.object({ sessionId:z.string().min(1).max(200), events:z.boolean().default(false),after:z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER-128).default(-1) }).strict(),
    execute:async(input,{client})=>{
      if(!input.events)return client.request({method:'GET',path:`/v2/resolver/sessions/${encodeURIComponent(input.sessionId)}`});
      const wire=await client.request<unknown>({method:'GET',path:`/v2/resolver/sessions/${encodeURIComponent(input.sessionId)}/events`,
        headers:{Accept:'text/event-stream',...(input.after>=0?{'Last-Event-ID':String(input.after)}:{})},retries:0,maxResponseBytes:256*1024,timeoutMs:35_000});
      return resolverEvents(wire===undefined?'':wire,input.sessionId,input.after,client.configuredWorkspaceId);
    },
  },
];
