import type { SwfteClient } from '../client.js';
import { presentAction, type ActionRequest } from '../actions.js';
import type { CodeIntakeRequest } from '../contracts/confidence-runtime-v1.js';

/** Shared07/14/15 consent: metadata only before a person approves, no source in the action queue. */
export async function requestIntakeConsent(client:SwfteClient, intake:CodeIntakeRequest) {
  if (intake.level==='LOCAL') return {local:true as const, snapshotHash:intake.snapshotHash};
  const action=await client.request<ActionRequest>({method:'POST',path:'/v2/actions',retries:0,body:{
    capability:'confidence.upload_code',target:{kind:'code-bundle',id:intake.snapshotHash},
    params:{snapshotHash:intake.snapshotHash,level:intake.level,ttlSeconds:String(intake.ttlSeconds)},environment:'development',
  }});
  return presentAction(action);
}
