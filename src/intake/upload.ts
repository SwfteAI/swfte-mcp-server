import type { SwfteClient } from '../client.js';
import type { BundleRef, CodeIntakeRequest } from '../contracts/confidence-runtime-v1.js';
import { prepareIntake } from './levels.js';

/** Consent is checked by the actual server. This library never approves or invents a bundle. */
export async function uploadIntake(client:SwfteClient, input:CodeIntakeRequest, approvalActionId?:string):Promise<BundleRef|{local:true;snapshotHash:string}> {
  const request=prepareIntake(input.level,input.manifest,input.files,input.ttlSeconds);
  if (request.snapshotHash!==input.snapshotHash) throw new Error('INTAKE_HASH_MISMATCH');
  if (request.level==='LOCAL') return {local:true,snapshotHash:request.snapshotHash};
  if (!approvalActionId) throw new Error('INTAKE_APPROVAL_REQUIRED');
  return client.request<BundleRef>({method:'POST',path:'/v2/confidence/bundles',body:{...request,approvalActionId},retries:0});
}
export const getIntakeBundle=(client:SwfteClient,id:string)=>client.request<BundleRef>({method:'GET',path:`/v2/confidence/bundles/${encodeURIComponent(id)}`});
export const deleteIntakeBundle=(client:SwfteClient,id:string)=>client.request({method:'DELETE',path:`/v2/confidence/bundles/${encodeURIComponent(id)}`,retries:0});
