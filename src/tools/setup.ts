import { z } from 'zod';
import type { ToolDefinition } from './_types.js';
import type { SetupTaskEntry, ProofRecord, ResolverSession } from '../contracts/setup-proof-v1.js';

export const SetupArtifactSchema = z.object({
  kind: z.enum(['workflow','chatflow','agent','widget','application','journey','mcp','finetune']),
  id: z.string().min(1).max(200),
}).strict();
const artifactPath = (artifact: { kind: string; id: string }) => `/v2/artifacts/${encodeURIComponent(artifact.kind)}/${encodeURIComponent(artifact.id)}`;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const value = z.union([z.object({ handle: z.string().min(1).max(400) }).strict(), z.object({ literal: z.string().min(1).max(4096) }).strict()]);

export const setupTools: ToolDefinition[] = [
  {
    name:'swfte_setup', title:'Read current setup tasks', readOnly:true,
    description:'Read server-owned, current-content setup tasks for any supported artifact. Entries include authoritative content hash and revision. Missing runtime and authorization failures remain explicit.',
    inputSchema:z.object({ artifact:SetupArtifactSchema }).strict(),
    execute: (input,{client}) => client.request<SetupTaskEntry[]>({method:'GET',path:`${artifactPath(input.artifact)}/setup`}),
  },
  {
    name:'swfte_resolve_setup_task', title:'Resolve one current setup task',
    description:'Resolve through one advertised server option, with current hash and revision CAS. Secret values must already be server-owned handles. This cannot waive missing probe evidence or promote anything.',
    inputSchema:z.object({ artifact:SetupArtifactSchema, taskKey:z.string().min(1).max(400), optionId:z.string().min(1).max(200), environment:z.string().regex(/^(SANDBOX|LIVE:[A-Za-z0-9_.:-]+)$/), value:value.optional(), expectedContentHash:hash, expectedRevision:z.number().int().nonnegative() }).strict(),
    execute:async(input,{client}) => {
      const entries=await client.request<SetupTaskEntry[]>({method:'GET',path:`${artifactPath(input.artifact)}/setup`});
      const task=entries.find(entry=>entry.task.key===input.taskKey);
      const option=task?.task.resolutionOptions?.find(candidate=>candidate.id===input.optionId);
      if (!task || !option) throw new Error('The current task does not advertise that resolution option.');
      if (task.contentHash!==input.expectedContentHash || task.revision!==input.expectedRevision) throw new Error('STALE_CONTENT: read current tasks before resolving.');
      if (option.type==='API_KEY' && input.value && 'literal' in input.value) throw new Error('Secret values require a server-owned handle.');
      return client.request<SetupTaskEntry>({method:'POST',path:`${artifactPath(input.artifact)}/setup/${encodeURIComponent(input.taskKey)}/resolve`,body:{optionId:input.optionId,environment:input.environment,value:input.value,expectedContentHash:input.expectedContentHash,expectedRevision:input.expectedRevision},retries:0});
    },
  },
  {
    name:'swfte_proof', title:'Execute artifact proof',
    description:'Run actual server proof checks against the current sandbox definition. Evidence levels derive from hash-bound execution records and readbacks; a run label alone never passes.',
    inputSchema:z.object({ artifact:SetupArtifactSchema, version:z.string().min(1).max(200), runs:z.number().int().min(1).max(20).default(3), fixtureSetId:z.string().min(1).max(200), seed:z.string().min(1).max(200), expectedContentHash:hash }).strict(),
    execute:(input,{client})=>client.request<ProofRecord>({method:'POST',path:`/v2/proof/${encodeURIComponent(input.artifact.kind)}/${encodeURIComponent(input.artifact.id)}`,body:{version:input.version,runs:input.runs,fixtureSetId:input.fixtureSetId,seed:input.seed,expectedContentHash:input.expectedContentHash},retries:0,timeoutMs:180000}),
  },
  {
    name:'swfte_proof_status', title:'Read current artifact proof', readOnly:true,
    description:'Read latest owned proof for the actual current content. Stale or missing records are not relabeled as current.',
    inputSchema:z.object({ artifact:SetupArtifactSchema }).strict(),
    execute:(input,{client})=>client.request<ProofRecord>({method:'GET',path:`/v2/proof/${encodeURIComponent(input.artifact.kind)}/${encodeURIComponent(input.artifact.id)}`}),
  },
  {
    name:'swfte_resolve', title:'Start governed prove or fix resolver',
    description:'Start the bounded server resolver using current content and existing tool/model guards. Unavailable governed execution returns NEEDS_USER; no client planner replaces it.',
    inputSchema:z.object({ artifact:SetupArtifactSchema, intent:z.enum(['prove','fix']), expectedContentHash:hash, budget:z.object({maxSteps:z.number().int().min(1).max(40),maxWallSeconds:z.number().int().min(1).max(600),maxSpendUsd:z.number().finite().min(0).max(50)}).strict().optional() }).strict(),
    execute:(input,{client})=>client.request<ResolverSession>({method:'POST',path:'/v2/resolver/sessions',body:input,retries:0}),
  },
  {
    name:'swfte_resolver_status', title:'Read resolver execution records', readOnly:true,
    description:'Read the actual owned resolver session or its redacted verified tool records.',
    inputSchema:z.object({ sessionId:z.string().min(1).max(200), events:z.boolean().default(false) }).strict(),
    execute:(input,{client})=>client.request({method:'GET',path:`/v2/resolver/sessions/${encodeURIComponent(input.sessionId)}${input.events?'/events':''}`}),
  },
];
