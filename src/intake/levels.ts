import { createHash } from 'node:crypto';
import type { CodeIntakeRequest, CodeLevel, SourceFile } from '../contracts/confidence-runtime-v1.js';

export const INTAKE_SCANNER_VERSION='code-secret-v1';
const refusedKeys=new Set(['source','sourcecode','content','text','diff','hunks','password','secret','token']);
const secret=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:ghp_|github_pat_|sk_live_|xox[baprs]-)[A-Za-z0-9_-]{12,}|(?:password|api[_-]?key|secret|token)\s*[:=]\s*["'][^"']{12,}["']/i;
export function canonicalJson(value:unknown):string {
  if (value===null) return 'null';
  if (typeof value==='number' && !Number.isFinite(value)) throw new Error('NON_JSON_VALUE');
  if (typeof value!=='object') {
    const encoded=JSON.stringify(value);
    if (encoded===undefined) throw new Error('NON_JSON_VALUE');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson((value as Record<string,unknown>)[key])}`).join(',')}}`;
}
export function intakeHash(manifest:Record<string,unknown>, files:SourceFile[], level:CodeLevel):string {
  return createHash('sha256').update(canonicalJson({files,manifest:level==='TREE'?{}:manifest}),'utf8').digest('hex');
}
export function assertMetadataOnly(value:unknown):void {
  if (Array.isArray(value)) { value.forEach(assertMetadataOnly); return; }
  if (value && typeof value==='object') {
    for (const [key,member] of Object.entries(value)) {
      if (refusedKeys.has(key.toLowerCase())) throw new Error('MANIFEST_SOURCE_REFUSED');
      assertMetadataOnly(member);
    }
  } else if (typeof value==='string' && (value.includes('\n') || secret.test(value))) throw new Error('MANIFEST_SOURCE_REFUSED');
}
export function prepareIntake(level:CodeLevel='LOCAL', manifest:Record<string,unknown>={}, files:SourceFile[]=[], ttlSeconds=86400):CodeIntakeRequest {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds<1 || ttlSeconds>86400) throw new Error('TREE_TTL_EXCEEDS_24H');
  if ((level==='LOCAL'||level==='MANIFEST')&&files.length) throw new Error('SOURCE_CONSENT_REQUIRED');
  if (level==='LOCAL'&&Object.keys(manifest).length) throw new Error('LOCAL_SENDS_NO_DATA');
  if (level==='MANIFEST') assertMetadataOnly(manifest);
  if ((level==='DIFF'||level==='TREE')&&!files.length) throw new Error('SOURCE_REQUIRED');
  if (files.length>1000||new Set(files.map(file=>file.path)).size!==files.length) throw new Error('SOURCE_BOUND_EXCEEDED');
  for (const file of files) {
    if (!file.path||file.path.length>400||file.path.startsWith('/')||file.path.includes('\\')||file.path.split('/').some(part=>!part||part==='.'||part==='..')||/(^|\/)\.env(?:\.|$)|(?:^|\/)(?:id_rsa|id_ed25519|credentials|\.aws)(?:\/|$)/i.test(file.path)) throw new Error('SOURCE_PATH_REFUSED');
    if (secret.test(file.content)) throw new Error('SOURCE_SECRET_REFUSED');
  }
  if (Buffer.byteLength(canonicalJson({manifest,files}),'utf8')>300000) throw new Error('CODE_BUNDLE_TOO_LARGE');
  return {level,manifest,files,ttlSeconds,snapshotHash:intakeHash(manifest,files,level)};
}
