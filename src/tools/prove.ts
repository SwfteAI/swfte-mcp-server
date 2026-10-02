import { z } from 'zod';
import type { ToolDefinition } from './_types.js';
import { CONFIDENCE_ARTIFACT_KINDS, CONFIDENCE_PROFILES, type ConfidenceResult } from '../contracts/confidence-runtime-v1.js';
import { prepareIntake } from '../intake/levels.js';
import { requestIntakeConsent } from '../intake/consent.js';
import { uploadIntake, getIntakeBundle, deleteIntakeBundle } from '../intake/upload.js';

const runInput=z.object({runId:z.string().min(1).max(200)}).strict();
const runPath=(id:string)=>`/v2/confidence/runs/${encodeURIComponent(id)}`;
const terminal=new Set(['COMPLETE','CANCELLED','FAILED','BUDGET_EXHAUSTED']);
export const proveTools: ToolDefinition[]=[
  {name:'swfte_code_intake',title:'Prepare approved code intake',description:'LOCAL sends nothing. MANIFEST sends metadata only. DIFF and TREE are secret-scanned and content-bound; source upload requires an existing person-approved action. TREE expires within24hours; DIFF source is never retained.',inputSchema:z.object({level:z.enum(['LOCAL','MANIFEST','DIFF','TREE']).default('LOCAL'),manifest:z.record(z.unknown()).default({}),files:z.array(z.object({path:z.string(),content:z.string()}).strict()).max(1000).default([]),ttlSeconds:z.number().int().min(1).max(86400).default(86400),approvalActionId:z.string().min(1).max(200).optional()}).strict(),execute:async(input,{client})=>{
    const intake=prepareIntake(input.level,input.manifest,input.files,input.ttlSeconds);
    return input.approvalActionId?uploadIntake(client,intake,input.approvalActionId):requestIntakeConsent(client,intake);
  }},
  {name:'swfte_code_bundle',title:'Read owned code bundle metadata',readOnly:true,description:'Read actual current bundle metadata; foreign, expired and deleted bundles remain unavailable.',inputSchema:z.object({bundleId:z.string().min(1).max(200)}).strict(),execute:(input,{client})=>getIntakeBundle(client,input.bundleId)},
  {name:'swfte_code_bundle_delete',title:'Delete owned code bundle',destructive:true,description:'Delete retained source through the actual owned server store. This does not retain a source copy in MCP.',inputSchema:z.object({bundleId:z.string().min(1).max(200)}).strict(),execute:(input,{client})=>deleteIntakeBundle(client,input.bundleId)},
  {
    name:'swfte_prove', title:'Run the actual sandbox proving ground',
    description:'Create and start actual sandbox confidence for a server-owned current artifact. No URL, client verdict or claimed confidence is accepted. All judged confidence requires versioned calibration; incomplete measurements remain UNKNOWN. This never promotes.',
    inputSchema:z.object({artifactKind:z.enum(CONFIDENCE_ARTIFACT_KINDS),artifactId:z.string().min(1).max(200),profile:z.enum(CONFIDENCE_PROFILES).default('QUICK'),frameworks:z.array(z.string().min(1).max(200)).max(20).default([]),seed:z.number().int().safe().default(1),expectedContentHash:z.string().regex(/^[0-9a-f]{64}$/),budget:z.object({persona:z.number().finite().nonnegative().max(100),systemUnderTest:z.number().finite().nonnegative().max(100),report:z.number().finite().nonnegative().max(20),maxSteps:z.number().int().min(1).max(50000)}).strict().default({persona:1,systemUnderTest:1,report:.1,maxSteps:200}),waitSeconds:z.number().int().min(0).max(120).default(0)}).strict(),
    execute:async(input,{client})=>{
      const {waitSeconds,...body}=input;
      const created=await client.request<ConfidenceResult>({method:'POST',path:'/v2/confidence/runs',body,retries:0});
      const runId=created.run.runId;
      const started=await client.request<ConfidenceResult>({method:'POST',path:`${runPath(runId)}/start`,body:{},retries:0});
      if (!waitSeconds) return {runId,result:started,reportPath:`${runPath(runId)}/report`,next:'Read swfte_prove_status; results are current-content bound.'};
      const progress=await client.pollUntil(()=>client.request<ConfidenceResult>({method:'GET',path:runPath(runId)}),result=>terminal.has(result.run.status),{timeoutMs:waitSeconds*1000,intervalMs:1000});
      return {runId,...progress,reportPath:`${runPath(runId)}/report`};
    },
  },
  {name:'swfte_prove_status',title:'Read actual confidence status',readOnly:true,description:'Read an owned confidence result, including every UNKNOWN reason and current-content binding.',inputSchema:runInput,execute:(input,{client})=>client.request({method:'GET',path:runPath(input.runId)})},
  {name:'swfte_prove_estimate',title:'Read confidence cost estimate',readOnly:true,description:'Estimate an existing queued run before starting it. Unpriced models and dependency gaps remain explicit.',inputSchema:runInput,execute:(input,{client})=>client.request({method:'POST',path:`${runPath(input.runId)}/estimate`,body:{},retries:0})},
  {name:'swfte_prove_findings',title:'Read measured findings',readOnly:true,description:'Read findings linked to actual evidence; gaps remain gaps.',inputSchema:runInput,execute:(input,{client})=>client.request({method:'GET',path:`${runPath(input.runId)}/findings`})},
  {name:'swfte_findings',title:'Read measured findings',readOnly:true,description:'Read canonical proving-ground findings linked to actual evidence. Compatibility swfte_prove_findings remains available.',inputSchema:runInput,execute:(input,{client})=>client.request({method:'GET',path:`${runPath(input.runId)}/findings`})},
  {name:'swfte_prove_report',title:'Read the ten-section report',readOnly:true,description:'Read JSON or Markdown from the authoritative report, with the separate Unknown list and claims boundary.',inputSchema:runInput.extend({format:z.enum(['json','md']).default('json')}),execute:(input,{client})=>client.request({method:'GET',path:`${runPath(input.runId)}/report`,query:{format:input.format}})},
  {name:'swfte_prove_cancel',title:'Cancel confidence execution',description:'Request cancellation; remaining measurements become UNKNOWN. Cancellation does not manufacture a passing report.',inputSchema:runInput,execute:(input,{client})=>client.request({method:'POST',path:`${runPath(input.runId)}/cancel`,body:{},retries:0})},
];
