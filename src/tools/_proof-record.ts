import {z} from 'zod';
import {setupContractText as text,setupContractInstant as instant} from './_resolver-session.js';
const strings=z.array(text).nullish().transform(value=>value??[]);
const check=z.object({id:text,verdict:z.enum(['PASS','FAIL','UNKNOWN']),evidenceRefs:strings,reason:text.nullish()}).passthrough().refine(value=>value.verdict==='UNKNOWN'?value.reason!=null:value.evidenceRefs.length>0);
export const proofRecordSchema=z.object({
 id:text,workspaceId:text,artifactKind:text,artifactId:text,version:text,contentHash:z.string().regex(/^[0-9a-f]{64}$/),
 level:z.enum(['NONE','OBSERVED','CORROBORATED','VALIDATED']),checks:z.array(check).nullish().transform(value=>value??[]),
 executionIds:strings,evidenceRefs:strings,warnings:strings,createdAt:instant,
}).passthrough().refine(proof=>{
 const ids=new Set(proof.executionIds),refs=new Set(proof.evidenceRefs);
 if(ids.size!==proof.executionIds.length||new Set(proof.checks.map(check=>check.id)).size!==proof.checks.length
   ||proof.checks.some(check=>check.evidenceRefs.some(ref=>!refs.has(ref))))return false;
 const passed=(id:string)=>proof.checks.some(check=>check.id===id&&check.verdict==='PASS');
 if(proof.level!=='NONE'&&(!ids.size||!refs.size||!passed('effects-present')))return false;
 if(['CORROBORATED','VALIDATED'].includes(proof.level)&&(!passed('terminal-status')||!passed('step-claims')))return false;
 if(proof.level==='VALIDATED'&&(ids.size<3||proof.warnings.length||proof.checks.some(check=>check.verdict!=='PASS')
   ||!passed('output-contract')||!passed('silent-failures')))return false;
 return true;
});
export type AdmittedProofRecord=z.infer<typeof proofRecordSchema>;
/** Structural consumer admission; the native producer and server currentness checks own readback authority. */
export function ownedProofRecord(wire:unknown,artifact:{kind:string;id:string},workspaceId?:string,expected?:{contentHash:string;version:string}):AdmittedProofRecord{
 const proof=proofRecordSchema.parse(wire);
 if(proof.artifactKind!==artifact.kind||proof.artifactId!==artifact.id||workspaceId!==undefined&&proof.workspaceId!==workspaceId
   ||expected!==undefined&&(proof.contentHash!==expected.contentHash||proof.version!==expected.version))throw new Error('PROOF_RESPONSE_BINDING_MISMATCH');
 return proof;
}
export function currentProofRecord(wire:unknown,artifact:{kind:string;id:string},workspaceId?:string):AdmittedProofRecord|null{
 return wire===null?null:ownedProofRecord(wire,artifact,workspaceId);
}
