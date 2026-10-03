import { z } from 'zod';
import type { ToolDefinition } from './_types.js';
import { getAction, presentAction } from '../actions.js';

const id=z.string().min(1).max(200);
const promotion=z.object({
  idempotencyKey:id, scope:z.enum(['ARTIFACT','SOLUTION']),
  artifacts:z.array(z.object({kind:z.string().min(1).max(40),id,version:id.optional(),contentHash:z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/).optional()}).strict()).min(1).max(100),
  solutionId:id.optional(),
  target:z.object({targetId:id,kind:z.enum(['SWFTE_CLOUD','AWS_RESOURCES','DIGITALOCEAN','RUNPOD']),region:z.string().min(1).max(80)}).strict(),
  strategy:z.literal('IMMEDIATE').default('IMMEDIATE'), keepSandboxCopy:z.boolean().default(true),
}).strict();
export const promotionTools:ToolDefinition[]=[
  {name:'swfte_promotion_targets',title:'Read available promotion targets',readOnly:true,description:'Read actual configured target capabilities and explicit unavailable runtime details. Availability does not grant deployment permission.',inputSchema:z.object({}).strict(),execute:(_input,{client})=>client.request({method:'GET',path:'/v2/promotions/targets'})},
  {name:'swfte_promotion_preview',title:'Read server promotion preflight',readOnly:true,description:'Evaluate current owned content, proof, binding and policy on the server. UNKNOWN blocks promotion; no effect or approval is created.',inputSchema:promotion,execute:(input,{client})=>client.request({method:'POST',path:'/v2/promotions/preview',body:input,retries:0})},
  {name:'swfte_promote',title:'Propose content-bound promotion',description:'Create an idempotent server promotion record. Only actual passing server preflight can produce an action proposal. A person approves that action in Studio; this tool never approves or deploys itself.',inputSchema:promotion,execute:async(input,{client})=>{
    const record=await client.request<{id:string;state:string;approvalRef?:string}>({method:'POST',path:'/v2/promotions',body:input,retries:0});
    return {promotion:record,...(record.approvalRef?{action:presentAction(await getAction(client,record.approvalRef))}:{})};
  }},
  {name:'swfte_promotion_status',title:'Read actual promotion state',readOnly:true,description:'Read the durable owned promotion journal projection, including verified deployment, preflight gaps and rollback state.',inputSchema:z.object({promotionId:id}).strict(),execute:(input,{client})=>client.request({method:'GET',path:`/v2/promotions/${encodeURIComponent(input.promotionId)}`})},
  {name:'swfte_promotion_rollback',title:'Roll back the current live pointer',destructive:true,description:'Request conditional rollback of this owned promotion. The server refuses to overwrite a newer promotion and reads back the actual target; no unconditional pointer reset is exposed.',inputSchema:z.object({promotionId:id}).strict(),execute:(input,{client})=>client.request({method:'POST',path:`/v2/promotions/${encodeURIComponent(input.promotionId)}/rollback`,body:{},retries:0})},
];
