import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { twinTools } from '../src/tools/twin.js';
import type { ToolContext } from '../src/tools/_types.js';

const push = twinTools.find(t => t.name === 'swfte_twin_push')!;
const status = twinTools.find(t => t.name === 'swfte_twin_status')!;
const args = { repoPath: '/must-not-read-source', repoId: 'repo', consentRecordId: 'consent' };
function context(readiness: unknown, opts: { hosted?: boolean; configured?: string; config?: string; baseUrl?: string; uploadReply?: (form: FormData) => unknown | Promise<unknown> } = {}) {
  const requests: unknown[] = []; const uploads: unknown[] = [];
  const ctx = { localFilesystem: !opts.hosted, config: { workspaceId: opts.config }, client: {
    configuredWorkspaceId: opts.configured, baseUrl: opts.baseUrl ?? apiBase,
    request: async (request: unknown) => { requests.push(request); return readiness; },
    postMultipart: async (...input: unknown[]) => { uploads.push(input); if (opts.uploadReply) return opts.uploadReply(input[1] as FormData); throw new Error('upload must not occur'); },
  } } as unknown as ToolContext;
  return { ctx, requests, uploads };
}
test('hosted push refuses before any disk or API effect', async () => {
  const c = context({}, { hosted: true }); await assert.rejects(push.execute(args, c.ctx), /hosted MCP server/); assert.deepEqual(c.requests, []); assert.deepEqual(c.uploads, []);
});
test('input workspace cannot override authenticated configured identity', async () => {
  const c = context({}, { configured: 'authenticated', config: 'fallback' }); await assert.rejects(push.execute({ ...args, workspaceId: 'other' }, c.ctx), /WORKSPACE_MISMATCH/); assert.deepEqual(c.requests, []); assert.deepEqual(c.uploads, []);
});
test('missing shared intake refuses before source packing or upload', async () => {
  const c = context({ workspaceId: 'w', sourcePolicy: 'synthetic-reference-only', dependencies: ['07.consent'] }, { configured: 'w' });
  await assert.rejects(push.execute(args, c.ctx), /TWIN_INTAKE_DEPENDENCY_GAP/); assert.equal(c.requests.length, 1); assert.deepEqual(c.uploads, []);
});
test('readiness identity substitution refuses before source access', async () => {
  const c = context({ workspaceId: 'other', sourcePolicy: 'synthetic-reference-only', dependencies: [] }, { configured: 'w' });
  await assert.rejects(push.execute(args, c.ctx), /TWIN_INTAKE_DEPENDENCY_GAP/); assert.deepEqual(c.uploads, []);
});
test('status reads the configured workspace and cannot select another tenant', async () => {
  const c = context(twin(), { configured: 'w' }); assert.deepEqual(await status.execute({ twinId: 'twin' }, c.ctx), twin());
  assert.deepEqual(c.requests, [{ method: 'GET', path: '/v2/twins/twin', workspaceId: 'w' }]);
  await assert.rejects(status.execute({ twinId: 'twin', workspaceId: 'other' }, c.ctx), /WORKSPACE_MISMATCH/); assert.equal(c.requests.length, 1);
});
const apiBase = 'https://api.example.invalid/agents';
const intakeDestination = apiBase + '/v2/twins/intake';
const hash = 'sha256:' + 'a'.repeat(64);
const instant = new Date('2026-10-01T12:00:00Z');
function twin() { return { twinId: 'twin', workspaceId: 'w', creatorId: 'creator', changeAuthorId: 'author', snapshotId: 'snapshot',
  snapshotHash: hash, twinSpecHash: hash, phase: 'IDLE', hostHandle: 'host', surInstanceId: 'sur', confidenceRunId: null,
  createdAt: instant.toISOString(), hardExpiresAt: new Date(instant.getTime() + 2700000).toISOString(), idleExpiresAt: new Date(instant.getTime() + 1800000).toISOString() }; }
function readiness() { return { workspaceId: 'w', sourcePolicy: 'synthetic-reference-only', dependencies: [], consent: {
  recordId: 'consent', workspaceId: 'w', repoId: 'repo', level: 'tree', destination: intakeDestination, retentionSeconds: 86400,
  principalId: 'owner', expiresAt: new Date(Date.now() + 60000).toISOString(), revoked: false } }; }
async function gitFixture(run: (root: string, commit: string) => Promise<void>) {
  const previous = process.cwd(); const root = realpathSync(mkdtempSync(join(tmpdir(), 'twin-tool-intake-')));
  const git = (argv: string[]) => execFileSync('git', ['-C', root, ...argv], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    process.chdir(root); git(['init', '-q']); git(['config', 'user.name', 'Twin Test']); git(['config', 'user.email', 'twin@example.invalid']);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'reference', license: 'MIT' }));
    writeFileSync(join(root, 'app.js'), 'export const reference = true;\n'); git(['add', '.']); git(['commit', '-qm', 'synthetic reference']);
    await run(root, git(['rev-parse', 'HEAD']).toString().trim());
  } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
}
function proposal(form: FormData, commit: string) { const now = new Date(); return {
  snapshot: { snapshotId: 'snapshot', workspaceId: 'w', repoId: 'repo', snapshotHash: form.get('expectedHash'), commitShas: [commit],
    consentRecordId: 'consent', bundleId: 'bundle', receivedAt: now.toISOString(), codeExpiresAt: new Date(now.getTime() + 86400000).toISOString(), synthetic: true },
  proposalId: 'proposal', proposalHash: hash, requiredConfirmations: ['services', 'build', 'test', 'seed', 'fidelity'] }; }
test('generic capabilities never authorize source packing or upload', async () => {
  const c = context({ workspaceId: 'w', sourcePolicy: 'synthetic-reference-only', dependencies: [] }, { configured: 'w' });
  await assert.rejects(push.execute(args, c.ctx), /TWIN_TREE_CONSENT_REQUIRED/);
  assert.deepEqual(c.uploads, []);
  assert.deepEqual(c.requests, [{ method: 'GET', path: '/v2/twins/intake/readiness', query: { channel: 'mcp', repoId: 'repo', consentId: 'consent' }, workspaceId: 'w' }]);
});
test('missing revoked expired non-tree foreign and malformed consent refuse before reading the source path', async () => {
  const valid = readiness();
  const variants = [null, { ...valid.consent, revoked: true }, { ...valid.consent, level: 'manifest' },
    { ...valid.consent, expiresAt: new Date(Date.now() - 1).toISOString() }, { ...valid.consent, expiresAt: 'not-an-instant' },
    { ...valid.consent, workspaceId: 'other' }, { ...valid.consent, repoId: 'other' }, { ...valid.consent, recordId: 'other' },
    { ...valid.consent, destination: '' }, { ...valid.consent, principalId: null }, { ...valid.consent, retentionSeconds: 90000 }];
  for (const consent of variants) {
    const c = context({ ...valid, consent }, { configured: 'w' });
    await assert.rejects(push.execute(args, c.ctx), /TWIN_TREE_CONSENT_REQUIRED/);
    assert.equal(c.requests.length, 1); assert.deepEqual(c.uploads, []);
  }
});
test('actual clean Git source uploads only after targeted current consent and returns exact owned snapshot binding', async () => gitFixture(async (root, commit) => {
  const c = context(readiness(), { configured: 'w', uploadReply: async form => {
    const bytes = Buffer.from(await (form.get('archive') as Blob).arrayBuffer());
    assert.equal(form.get('expectedHash'), 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
    assert.equal(bytes.subarray(0, 16).toString(), '# v2 git bundle\n');
    assert.equal(form.get('repoId'), 'repo'); assert.equal(form.get('consentRecordId'), 'consent');
    return proposal(form, commit);
  } });
  const result = await push.execute({ ...args, repoPath: root }, c.ctx);
  assert.equal(c.requests.length, 2); assert.equal(c.uploads.length, 1);
  assert.deepEqual(c.uploads[0] && (c.uploads[0] as unknown[])[2], { workspaceId: 'w' });
  assert.equal((result as { snapshotId: string }).snapshotId, 'snapshot');
  assert.deepEqual((result as { commitShas: string[] }).commitShas, [commit]);
}));
test('consent revoked between packing and outbound effect has zero uploads', async () => gitFixture(async root => {
  const valid = readiness(); const c = context(valid, { configured: 'w' }); let requests = 0;
  c.ctx.client.request = async () => (++requests === 1 ? valid : { ...valid, consent: { ...valid.consent, revoked: true } }) as never;
  await assert.rejects(push.execute({ ...args, repoPath: root }, c.ctx), /TWIN_TREE_CONSENT_REQUIRED/);
  assert.equal(requests, 2); assert.deepEqual(c.uploads, []);
}));
test('the exact approved destination bytes cannot change between packaging and upload', async () => gitFixture(async root => {
  const valid = readiness(); const c = context(valid, { configured: 'w' }); let requests = 0;
  c.ctx.client.request = async () => (++requests === 1 ? valid : { ...valid, consent: { ...valid.consent, destination: valid.consent.destination + ' ' } }) as never;
  await assert.rejects(push.execute({ ...args, repoPath: root }, c.ctx), /TWIN_TREE_CONSENT_REQUIRED/);
  assert.equal(requests, 2); assert.deepEqual(c.uploads, []);
}));
test('status preserves actual fractional Instant order without silently rounding TTLs', async () => {
  const value = { ...twin(), phase: 'BUILD', hostHandle: null, surInstanceId: null,
    createdAt: '2026-10-01T12:00:00.000000001Z', hardExpiresAt: '2026-10-01T12:00:00.000000003Z', idleExpiresAt: '2026-10-01T12:00:00.000000002Z' };
  const c = context(value, { configured: 'w' }); assert.deepEqual(await status.execute({ twinId: 'twin' }, c.ctx), value);
});
test('hash-only or foreign upload success cannot become a valid owned snapshot proposal', async () => gitFixture(async (root, commit) => {
  for (const alter of [
    (value: ReturnType<typeof proposal>) => ({ snapshot: { snapshotHash: value.snapshot.snapshotHash } }),
    (value: ReturnType<typeof proposal>) => ({ ...value, snapshot: { ...value.snapshot, workspaceId: 'other' } }),
    (value: ReturnType<typeof proposal>) => ({ ...value, snapshot: { ...value.snapshot, consentRecordId: 'other' } }),
    (value: ReturnType<typeof proposal>) => ({ ...value, snapshot: { ...value.snapshot, commitShas: ['b'.repeat(40)] } }),
    (value: ReturnType<typeof proposal>) => ({ ...value, proposalHash: 'positive-label' }),
    (value: ReturnType<typeof proposal>) => ({ ...value, requiredConfirmations: ['proven'] }),
  ]) {
    const c = context(readiness(), { configured: 'w', uploadReply: form => alter(proposal(form, commit)) });
    await assert.rejects(push.execute({ ...args, repoPath: root }, c.ctx), /INVALID_TWIN_RESPONSE/); assert.equal(c.uploads.length, 1);
  }
}));
test('malformed and substituted status records fail closed without accepting a positive label', async () => {
  for (const value of [{ phase: 'IDLE' }, { ...twin(), workspaceId: 'other' }, { ...twin(), twinId: 'other' },
    { ...twin(), snapshotHash: 'pass' }, { ...twin(), phase: 'PASSED' }, { ...twin(), hardExpiresAt: 'not-an-instant' },
    { ...twin(), hostHandle: null }, { ...twin(), confidenceRunId: {} }]) {
    const c = context(value, { configured: 'w' }); await assert.rejects(status.execute({ twinId: 'twin' }, c.ctx), /INVALID_TWIN_RESPONSE/);
  }
});
test('schemas refuse positive proof labels and unknown request members', () => {
  assert.equal(push.inputSchema.safeParse({ ...args, proven: true }).success, false); assert.equal(status.inputSchema.safeParse({ twinId: '../../other' }).success, false);
});

// These controls bind source effects, not merely a displayed destination label.
test('foreign symbolic malformed and ambiguous destination grants refuse before source access', async () => {
  const valid=readiness();
  for(const destination of ['owner-approved-intake','https://foreign.invalid/agents/v2/twins/intake',
    apiBase+'/v2/twins/other','https://user:password@api.example.invalid/agents/v2/twins/intake',
    intakeDestination+'?upload=true',intakeDestination+'?',intakeDestination+'#source',intakeDestination+'#',
    ' '+intakeDestination,intakeDestination+' ', 'not a URL','file:///v2/twins/intake',
    'https://api.example.invalid/v2/twins/intake',intakeDestination+'/']) {
    const c=context({...valid,consent:{...valid.consent,destination}},{configured:'w'});
    await assert.rejects(push.execute(args,c.ctx),/TWIN_TREE_CONSENT_REQUIRED/);
    assert.equal(c.requests.length,1);assert.deepEqual(c.uploads,[]);
  }
});
test('changed actual receiver after readiness recheck cannot receive source under the old grant', async()=>gitFixture(async root=>{
  const valid=readiness();const c=context(valid,{configured:'w'});let calls=0;
  c.ctx.client.request=async()=>{if(++calls===2)Object.defineProperty(c.ctx.client,'baseUrl',{value:'https://foreign.invalid/agents',configurable:true});return valid as never;};
  await assert.rejects(push.execute({...args,repoPath:root},c.ctx),/TWIN_TREE_CONSENT_REQUIRED/);
  assert.equal(calls,2);assert.deepEqual(c.uploads,[]);
}));
test('changing both receiver and grant during packaging cannot substitute a new destination',async()=>gitFixture(async root=>{
  const valid=readiness();const c=context(valid,{configured:'w'});let calls=0;
  c.ctx.client.request=async()=>{if(++calls===1)return valid as never;
    Object.defineProperty(c.ctx.client,'baseUrl',{value:'https://foreign.invalid/agents',configurable:true});
    return {...valid,consent:{...valid.consent,destination:'https://foreign.invalid/agents/v2/twins/intake'}} as never;};
  await assert.rejects(push.execute({...args,repoPath:root},c.ctx),/TWIN_TREE_CONSENT_REQUIRED/);
  assert.equal(calls,2);assert.deepEqual(c.uploads,[]);
}));
test('real client positive retains configured base path and posts bundle to exactly consented full URL',async()=>gitFixture(async(root,commit)=>{
  const config=loadConfig({SWFTE_API_KEY:'sk_test_twin_destination',SWFTE_BASE_URL:apiBase,SWFTE_WORKSPACE_ID:'w'});
  const client=new SwfteClient(config);const originalFetch=globalThis.fetch;const effects:Array<{url:string;method:string}>=[];
  globalThis.fetch=async(input,init)=>{
    const url=String(input);const method=init?.method??'GET';effects.push({url,method});
    if(method==='GET'){
      assert.equal(new URL(url).pathname,'/agents/v2/twins/intake/readiness');
      assert.equal(new URL(url).searchParams.get('consentId'),'consent');
      return new Response(JSON.stringify(readiness()),{status:200});
    }
    assert.equal(method,'POST');assert.equal(url,intakeDestination);
    const form=init?.body as FormData;const bytes=Buffer.from(await(form.get('archive') as Blob).arrayBuffer());
    assert.equal(form.get('expectedHash'),'sha256:'+createHash('sha256').update(bytes).digest('hex'));
    return new Response(JSON.stringify(proposal(form,commit)),{status:200});
  };
  try{const c=context(readiness(),{configured:'w'});c.ctx.client=client;
    const result=await push.execute({...args,repoPath:root},c.ctx);
    assert.equal((result as {snapshotId:string}).snapshotId,'snapshot');
    assert.deepEqual(effects.map(e=>e.method),['GET','GET','POST']);
  }finally{globalThis.fetch=originalFetch;}
}));

test('invalid configured receivers refuse without reading source or uploading',async()=>{
  for(const baseUrl of ['https://user:password@api.example.invalid/agents','https://@api.example.invalid/agents',
    'https://api.example.invalid/agents?target=other','https://api.example.invalid/agents#target',
    'https://api.example.invalid/agen\nts','file:///agents','http://api.example.invalid/agents','not a URL']){
    const c=context(readiness(),{configured:'w',baseUrl});
    await assert.rejects(push.execute(args,c.ctx),/TWIN_TREE_CONSENT_REQUIRED/);assert.deepEqual(c.uploads,[]);
  }
});
