import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, readFileSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SwfteClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { effectiveContractHash } from '../src/catalog.js';
import { runCli } from '../src/cli.js';
import { scaffoldTools } from '../src/tools/scaffold.js';
import { NativeFilesystem, NativeFilesystemError } from '../src/native-filesystem.js';
import { project } from './codemap-support.js';
import { ConfinedWriter, PathConfinementError } from '../src/fsguard.js';
import { loadLock } from '../src/lock.js';

test('mounted native scaffold propagates selected legacy lock safety size and IO errors before transport', async () => {
  const cwd=process.cwd(),read=NativeFilesystem.prototype.read,close=NativeFilesystem.prototype.close;
  const tool=scaffoldTools.find(t=>t.name==='swfte_scaffold_client')!;
  for(const defect of ['hardlink','symlink','size','io']) {
    const root=project({'swfte.json':'{"version":1,"baseUrl":"https://api.swfte.com/agents","artifacts":[]}' });
    const outside=project({'lock.json':'{}'}); mkdirSync(join(root,'src/swfte'),{recursive:true});
    const path=join(root,'src/swfte/swfte.json'); let calls=0,closes=0;
    NativeFilesystem.prototype.close=function() { closes++; return close.call(this); };
    if(defect==='hardlink') linkSync(join(outside,'lock.json'),path);
    if(defect==='symlink') symlinkSync(join(outside,'lock.json'),path);
    if(defect==='size') writeFileSync(path,Buffer.alloc(2*1024*1024+1,32));
    NativeFilesystem.prototype.read=function(rel,max) { if(defect==='io' && rel==='src/swfte/swfte.json') throw new NativeFilesystemError('IO_ERROR'); return read.call(this,rel,max); };
    process.chdir(root);
    try {
      const expected={hardlink:'HARDLINK_REFUSED',symlink:'SYMLINK_REFUSED',size:'SIZE_LIMIT',io:'IO_ERROR'}[defect as 'hardlink'|'symlink'|'size'|'io'];
      await assert.rejects(tool.execute({catalogRef:'workflow:wf_owned',framework:'plain-ts'},
        {client:{request:async()=>{calls++;throw new Error('unexpected backend');}},config:{credential:'fixture_credential_123',baseUrl:'https://api.swfte.com/agents'},localFilesystem:true} as never),new RegExp(expected));
      assert.equal(calls,0); assert.equal(closes,1); assert.equal(existsSync(join(root,'.env.example')),false);
      assert.equal(readFileSync(join(outside,'lock.json'),'utf8'),'{}');
    } finally { process.chdir(cwd); NativeFilesystem.prototype.read=read; NativeFilesystem.prototype.close=close; rmSync(root,{recursive:true,force:true}); rmSync(outside,{recursive:true,force:true}); }
  }
});

test('native legacy migration remains positive and malformed JSON fallback remains compatible', () => {
  const lock='{"version":1,"baseUrl":"https://api.swfte.com/agents","artifacts":[]}';
  const root=project({'legacy/swfte.json':lock,'broken/swfte.json':'not json','shape/swfte.json':'[]'}),writer=new ConfinedWriter({root,native:true});
  try {
    const loaded=loadLock(writer,{baseUrl:'https://api.swfte.com/agents'},{legacyDirs:['legacy','broken','shape']});
    assert.equal(loaded.migrated,true); assert.deepEqual(loaded.legacySources,['legacy/swfte.json']);
    assert.deepEqual(loaded.lock.artifacts,[]); assert.equal(readFileSync(join(root,'broken/swfte.json'),'utf8'),'not json');
  } finally { writer.close(); rmSync(root,{recursive:true,force:true}); }
});

test('native legacy read confinement error propagates while default legacy malformed fallback stays', () => {
  const root=project({'broken/swfte.json':'not json'}),native=new ConfinedWriter({root,native:true}),legacy=new ConfinedWriter({root});
  const read=ConfinedWriter.prototype.readText;
  try {
    assert.deepEqual(loadLock(legacy,{baseUrl:''},{legacyDirs:['broken']}).legacySources,[]);
    ConfinedWriter.prototype.readText=function(path,max) { if(this.native && path.endsWith('/blocked/swfte.json')) throw new PathConfinementError('injected legacy confinement refusal'); return read.call(this,path,max); };
    assert.throws(()=>loadLock(native,{baseUrl:''},{legacyDirs:['blocked']}),PathConfinementError);
  } finally { ConfinedWriter.prototype.readText=read; native.close(); legacy.close(); rmSync(root,{recursive:true,force:true}); }
});

// Drive mounted consumers; only backend transport and fault injection are controlled.
test('selected CLI peek propagates native admission failure before backend/default-base use', async () => {
  const root = project({}); const open = NativeFilesystem.openRoot, fetch = globalThis.fetch;
  let calls = 0; globalThis.fetch = (async () => { calls++; throw new Error('unexpected transport'); }) as typeof fetch;
  NativeFilesystem.openRoot = () => { throw new NativeFilesystemError('NATIVE_ARTIFACT_MISSING_OR_INVALID'); };
  try {
    for (const argv of [['add', 'workflow:wf_owned'], ['sync'], ['upgrade', 'owned']]) {
      const errors: string[] = [], output: string[] = [];
      const code = await runCli(argv, { cwd: root, env: { SWFTE_PAT: 'pat_fixture_credential_123', SWFTE_TELEMETRY: '0' }, out: line => output.push(line), err: line => errors.push(line) });
      assert.notEqual(code, 0); assert.match(errors.join('\n'), /NATIVE_ARTIFACT_MISSING_OR_INVALID/);
      assert.equal(output.length, 0);
    }
    assert.equal(calls, 0); assert.equal(existsSync(join(root, 'swfte.json')), false);
  } finally { NativeFilesystem.openRoot = open; globalThis.fetch = fetch; rmSync(root, { recursive: true, force: true }); }
});

test('actual local embed refuses hardlink and closes its admitted capability on failure', async () => {
  const root = project({}), outside = project({ 'owned.html': 'external' });
  linkSync(join(outside, 'owned.html'), join(root, 'linked.html'));
  const cwd = process.cwd(), close = NativeFilesystem.prototype.close; let closes = 0;
  NativeFilesystem.prototype.close = function() { closes++; return close.call(this); }; process.chdir(root);
  try {
    const tool = scaffoldTools.find(tool => tool.name === 'swfte_embed_widget')!;
    await assert.rejects(tool.execute({ catalogRef: 'widget:wd_owned', targetFile: 'linked.html', force: true },
      { client: { request: async () => ({ embed: { html: '<p>new</p>' } }) }, config: { credential: 'fixture_credential_123' }, localFilesystem: true } as never), /HARDLINK_REFUSED/);
    assert.equal(readFileSync(join(outside, 'owned.html'), 'utf8'), 'external'); assert.equal(closes, 1);
    assert.equal(existsSync(join(root, '.swfte/codemap/provenance.json')), false);
  } finally { process.chdir(cwd); NativeFilesystem.prototype.close = close; rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('mounted scaffold/sync reject missing producer; render-only and hosted embed never admit it', async () => {
  const root = project({}), cwd = process.cwd(), open = NativeFilesystem.openRoot; let opens = 0;
  NativeFilesystem.openRoot = () => { opens++; throw new NativeFilesystemError('NATIVE_ARTIFACT_MISSING_OR_INVALID'); }; process.chdir(root);
  const context = { client: { request: async () => ({ embed: { html: '<p>render</p>' } }) }, config: { credential: 'fixture_credential_123' }, localFilesystem: true };
  try {
    await assert.rejects(scaffoldTools.find(t => t.name === 'swfte_sync')!.execute({}, context as never), /NATIVE_ARTIFACT_MISSING_OR_INVALID/);
    await assert.rejects(scaffoldTools.find(t => t.name === 'swfte_scaffold_client')!.execute({ catalogRef: 'workflow:wf_owned' }, context as never), /NATIVE_ARTIFACT_MISSING_OR_INVALID/);
    const count = opens;
    const embed = scaffoldTools.find(t => t.name === 'swfte_embed_widget')!;
    await embed.execute({ catalogRef: 'widget:wd_owned' }, context as never);
    await embed.execute({ catalogRef: 'widget:wd_owned', targetFile: 'inline.html' }, { ...context, localFilesystem: false } as never);
    assert.equal(opens, count); assert.equal(existsSync(join(root, 'inline.html')), false);
  } finally { process.chdir(cwd); NativeFilesystem.openRoot = open; rmSync(root, { recursive: true, force: true }); }
});

test('mounted CLI add/sync/upgrade and scaffold/sync use genuine native publications and close once', async () => {
  const root = project({ 'package.json': '{"name":"native-fixture"}' }), cwd = process.cwd();
  const fetch = globalThis.fetch, close = NativeFilesystem.prototype.close, replace = NativeFilesystem.prototype.replace;
  let closes = 0; const publications: string[] = []; const seen: string[] = [];
  let contract: any = { catalogRef: 'workflow:wf_owned', invoke: { method: 'POST', path: '/v2/workflows/wf_owned/invoke', auth: 'api_key', async: true, statusPath: '/v2/workflows/executions/{executionId}/status' },
    inputSchema: { type: 'object', properties: { question: { type: 'string' } } }, outputSchema: { type: 'object', properties: { answer: { type: 'string' } } }, snippets: {}, embed: null, version: null };
  globalThis.fetch = (async (url) => {
    const request = new URL(String(url)), path = request.pathname.replace(/^\/agents/, ''); seen.push(path);
    if (path === '/v2/catalog/workflow/wf_owned/contract') return Response.json(contract);
    if (path === '/v2/catalog/workflow/wf_owned') return Response.json({ id: 'wf_owned', catalogRef: 'workflow:wf_owned', kind: 'workflow', name: 'Owned', description: 'fixture', facets: [], evidence: { level: 'unmeasured' } });
    if (path === '/v2/catalog/upgrades') return Response.json({ items: [{ catalogRef: 'workflow:wf_owned', currentHash: request.searchParams.get('refs')?.split(':').pop(), latestHash: effectiveContractHash(contract as never).hash, breaking: false, capabilityChanges: [], requiresReapproval: false }] });
    throw new Error('Unexpected backend route ' + path);
  }) as typeof fetch;
  NativeFilesystem.prototype.close = function() { closes++; return close.call(this); };
  NativeFilesystem.prototype.replace = function(input) { const result = replace.call(this, input); if (result.action !== 'unchanged') publications.push(input.rel); return result; };
  process.chdir(root);
  const env = { SWFTE_PAT: 'pat_fixture_credential_123', SWFTE_TELEMETRY: '0' }, config = loadConfig(env);
  const io = { cwd: root, env, out: (_: string) => {}, err: (_: string) => {} };
  try {
    assert.equal(await runCli(['add', 'workflow:wf_owned', '--alias', 'owned', '--framework', 'plain-ts', '--no-pin', '--no-compliance'], io), 0);
    assert.equal(closes, 1); assert.ok(publications.includes('swfte.json')); assert.ok(publications.some(path => path.endsWith('owned.ts')));
    const sourcePath = publications.find(path => path.endsWith('owned.ts'))!;
    const original = readFileSync(join(root, sourcePath), 'utf8');
    contract = { ...contract, inputSchema: { ...contract.inputSchema, properties: { ...contract.inputSchema.properties, extra: { type: 'string' } } } };
    assert.equal(await runCli(['sync'], io), 0); assert.equal(closes, 2);
    assert.notEqual(readFileSync(join(root, sourcePath), 'utf8'), original);
    assert.equal(await runCli(['upgrade', 'owned', '--no-pin'], io), 0); assert.equal(closes, 3);
    const context = { client: new SwfteClient(config), config, localFilesystem: true };
    await scaffoldTools.find(tool => tool.name === 'swfte_scaffold_client')!.execute({ catalogRef: 'workflow:wf_owned', alias: 'second', framework: 'plain-ts', pin: false, complianceScan: false }, context);
    assert.equal(closes, 4);
    const count = publications.length;
    await scaffoldTools.find(tool => tool.name === 'swfte_sync')!.execute({ dryRun: true }, context);
    assert.equal(closes, 5); assert.equal(publications.length, count);
    assert.ok(seen.includes('/v2/catalog/upgrades'));
    const rows = JSON.parse(readFileSync(join(root, '.swfte/codemap/provenance.json'), 'utf8'));
    assert.ok(rows.some((row: { path: string }) => row.path === sourcePath));
  } finally { process.chdir(cwd); globalThis.fetch = fetch; NativeFilesystem.prototype.close = close; NativeFilesystem.prototype.replace = replace; rmSync(root, { recursive: true, force: true }); }
});
