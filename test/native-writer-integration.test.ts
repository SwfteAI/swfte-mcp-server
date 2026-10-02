import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, fstatSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfinedWriter, NativeWriterCommitError } from '../src/fsguard.js';
import { NativeFilesystem, NativeFilesystemError } from '../src/native-filesystem.js';
import { recordNativeWrittenFiles } from '../src/codemap/provenance.js';
import { loadLock } from '../src/lock.js';
import { project } from './codemap-support.js';

test('native unchanged env preserves CRLF raw inode and provenance without mkdir', () => {
  const root=project({ '.env.example':'KEEP=developer\r\nOTHER=value\r\n' }), writer=new ConfinedWriter({root,native:true});
  const mkdir=NativeFilesystem.prototype.mkdir; let mkdirCalls=0;
  NativeFilesystem.prototype.mkdir=function(rel) { mkdirCalls++; return mkdir.call(this,rel); };
  try {
    const path=writer.resolve('.env.example'), before=readFileSync(path), ino=statSync(path).ino, mode=statSync(path).mode;
    assert.deepEqual(writer.mergeEnv(path,[{key:'KEEP',value:'different'},{key:'OTHER',value:'different'}]),{added:[],kept:['KEEP','OTHER'],changed:[]});
    const writes=writer.commit(); assert.equal(writes[0]!.action,'unchanged'); assert.equal(mkdirCalls,0);
    assert.deepEqual(readFileSync(path),before); assert.equal(statSync(path).ino,ino); assert.equal(statSync(path).mode,mode);
    assert.equal(writer.nativeReceipt(writes[0]!)?.hash,createHash('sha256').update(before).digest('hex'));
    recordNativeWrittenFiles(writer,writes,'human','cli'); assert.equal(existsSync(join(root,'.swfte/codemap/provenance.json')),false);
    assert.deepEqual(writer.commit(),[]);
  } finally { NativeFilesystem.prototype.mkdir=mkdir; writer.close(); rmSync(root,{recursive:true,force:true}); }
});

test('native absent nested unchanged env has no file parent publication or fabricated receipt', () => {
  const root=project({}),writer=new ConfinedWriter({root,native:true});
  const mkdir=NativeFilesystem.prototype.mkdir,replace=NativeFilesystem.prototype.replace; let effects=0;
  NativeFilesystem.prototype.mkdir=function(rel) { effects++; return mkdir.call(this,rel); };
  NativeFilesystem.prototype.replace=function(input) { effects++; return replace.call(this,input); };
  try {
    writer.mergeEnv(writer.resolve('never-created/.env.example'),[]);
    const writes=writer.commit(); assert.equal(effects,0); assert.equal(writes[0]!.action,'unchanged'); assert.equal(writes[0]!.bytes,0);
    assert.equal(writer.nativeReceipt(writes[0]!),null); assert.equal(existsSync(join(root,'never-created')),false);
    recordNativeWrittenFiles(writer,writes,'human','cli'); assert.equal(existsSync(join(root,'.swfte/codemap/provenance.json')),false);
  } finally { NativeFilesystem.prototype.mkdir=mkdir; NativeFilesystem.prototype.replace=replace; writer.close(); rmSync(root,{recursive:true,force:true}); }
});

test('native explicit unchanged preserves invalid UTF8 raw bytes and later no-op preserves planned merge', () => {
  const root=project({}),writer=new ConfinedWriter({root,native:true});
  try {
    const raw=Buffer.from([0x61,0xff,0x62]),path=writer.resolve('raw.ts'); writeFileSync(path,raw);
    const ino=statSync(path).ino; writer.create(path,writer.readText(path)!);
    const writes=writer.commit(); assert.equal(writes[0]!.action,'unchanged'); assert.equal(writes[0]!.bytes,raw.length);
    assert.deepEqual(readFileSync(path),raw); assert.equal(statSync(path).ino,ino);
    assert.equal(writer.nativeReceipt(writes[0]!)?.hash,createHash('sha256').update(raw).digest('hex'));
    recordNativeWrittenFiles(writer,writes,'human','cli'); assert.equal(existsSync(join(root,'.swfte/codemap/provenance.json')),false);
    const env=writer.resolve('.env.example');
    writer.mergeEnv(env,[{key:'FIRST',value:'one'}]); writer.mergeEnv(env,[{key:'FIRST',value:'different'}]);
    writer.mergeEnv(env,[]); writer.commit(); assert.match(readFileSync(env,'utf8'),/^FIRST=one\n$/);
  } finally { writer.close(); rmSync(root,{recursive:true,force:true}); }
});

test('stale unchanged preimage rejects the whole native plan before earlier effects', () => {
  const root=project({'same.ts':'same'}),writer=new ConfinedWriter({root,native:true});
  try {
    writer.create(writer.resolve('new-parent/earlier.ts'),'earlier'); writer.create(writer.resolve('same.ts'),'same');
    writeFileSync(join(root,'same.ts'),'foreign');
    assert.throws(()=>writer.commit(),(error:unknown)=>error instanceof NativeWriterCommitError
      && error.code==='STALE_CONTENT' && error.confirmedFiles.length===0 && !error.directoriesMayExist);
    assert.equal(existsSync(join(root,'new-parent')),false); assert.equal(readFileSync(join(root,'same.ts'),'utf8'),'foreign');
  } finally { writer.close(); rmSync(root,{recursive:true,force:true}); }
});

test('native unchanged missing ancestor after whole-plan preflight refuses without recreating it', () => {
  const root=project({'owned/same.ts':'same'}),writer=new ConfinedWriter({root,native:true}),replace=NativeFilesystem.prototype.replace;
  NativeFilesystem.prototype.replace=function(input) {
    if(input.rel==='owned/same.ts') rmSync(join(root,'owned'),{recursive:true,force:true});
    return replace.call(this,input);
  };
  try {
    writer.create(writer.resolve('owned/same.ts'),'same');
    assert.throws(()=>writer.commit(),(error:unknown)=>error instanceof NativeWriterCommitError && !error.directoriesMayExist);
    assert.equal(existsSync(join(root,'owned')),false);
  } finally { NativeFilesystem.prototype.replace=replace; writer.close(); rmSync(root,{recursive:true,force:true}); }
});

test('generic metadata failure after genuine native publication reports uncertain physical current path', () => {
  const root=project({}),writer=new ConfinedWriter({root,native:true});
  const set=WeakMap.prototype.set,replace=NativeFilesystem.prototype.replace; let published=false;
  NativeFilesystem.prototype.replace=function(input) { const result=replace.call(this,input); if(input.rel==='published.ts' && result.action==='create') published=true; return result; };
  WeakMap.prototype.set=function(key,value) {
    if(published && value && typeof value==='object' && 'path' in value && value.path==='published.ts') throw new Error('injected receipt metadata failure');
    return set.call(this,key,value);
  };
  try {
    writer.create(writer.resolve('published.ts'),'actual physical bytes');
    assert.throws(()=>writer.commit(),(error:unknown)=>error instanceof NativeWriterCommitError
      && error.code==='IO_ERROR' && error.uncertainPaths.includes('published.ts'));
    assert.equal(published,true); assert.equal(readFileSync(join(root,'published.ts'),'utf8'),'actual physical bytes');
    assert.throws(()=>writer.commit(),/consumed|failed/i);
  } finally { WeakMap.prototype.set=set; NativeFilesystem.prototype.replace=replace; writer.close(); rmSync(root,{recursive:true,force:true}); }
});

// Requires the genuine packaged producer. Absence is a failure, never a skip or fake store.
test('native first preimage survives repeated JSON/env merges and later foreign changes refuse', () => {
  const root = project({ 'state.json': '{"old":1}', '.env.example': 'KEEP=developer\n' });
  const writer = new ConfinedWriter({ root, native: true });
  try {
    const json = writer.resolve('state.json');
    writer.mergeJson(json, old => ({ ...old, first: 2 }));
    writer.mergeJson(json, old => ({ ...old, second: 3 }));
    const env = writer.resolve('.env.example');
    writer.mergeEnv(env, [{ key: 'KEEP', value: 'different' }, { key: 'FIRST', value: 'one' }]);
    writer.mergeEnv(env, [{ key: 'SECOND', value: 'two' }]);
    const writes = writer.commit();
    assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), { old: 1, first: 2, second: 3 });
    assert.match(readFileSync(env, 'utf8'), /KEEP=developer/);
    assert.match(readFileSync(env, 'utf8'), /FIRST=one[\s\S]*SECOND=two/);
    assert.equal(writes.length, 2); assert.deepEqual(writer.commit(), []);
    writer.mergeJson(json, old => ({ ...old, third: 4 }));
    writeFileSync(json, '{"foreign":true}');
    assert.throws(() => writer.commit(), (err: unknown) => err instanceof NativeWriterCommitError && err.confirmedFiles.length === 0);
    assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), { foreign: true });
  } finally { writer.close(); rmSync(root, { recursive: true, force: true }); }
});

test('native readback receipt is sealed to actual write identity and ledger does not replay source', () => {
  const root = project({}); const writer = new ConfinedWriter({ root, native: true });
  const original = NativeFilesystem.prototype.replace; const published: string[] = [];
  NativeFilesystem.prototype.replace = function(input) { published.push(input.rel); return original.call(this, input); };
  try {
    writer.create(writer.resolve('new.ts'), 'export const value = 1;\n');
    const writes = writer.commit(), receipt = writer.nativeReceipt(writes[0]!);
    assert.ok(receipt); assert.equal(receipt.hash, createHash('sha256').update('export const value = 1;\n').digest('hex'));
    assert.equal(writer.nativeReceipt({ ...writes[0]! }), null);
    const saved = writes[0]!.path; writes[0]!.path = 'foreign.ts'; assert.equal(writer.nativeReceipt(writes[0]!), null); writes[0]!.path = saved;
    recordNativeWrittenFiles(writer, writes, 'human', 'cli');
    const ledger = JSON.parse(readFileSync(join(root, '.swfte/codemap/provenance.json'), 'utf8'));
    assert.equal(ledger[0].hash, receipt.hash); assert.equal(ledger[0].path, 'new.ts');
    assert.deepEqual(published, ['new.ts', '.swfte/codemap/provenance.json']);
    assert.deepEqual(writer.commit(), []);
  } finally { NativeFilesystem.prototype.replace = original; writer.close(); rmSync(root, { recursive: true, force: true }); }
});

test('partial native plan keeps confirmed files and uncertain current path without rollback', () => {
  const root = project({}); const writer = new ConfinedWriter({ root, native: true });
  const original = NativeFilesystem.prototype.replace;
  NativeFilesystem.prototype.replace = function(input) {
    if (input.rel === 'second.ts') throw new NativeFilesystemError('PARTIAL_COMMIT', true);
    return original.call(this, input);
  };
  try {
    writer.create(writer.resolve('first.ts'), 'first'); writer.create(writer.resolve('second.ts'), 'second');
    assert.throws(() => writer.commit(), (err: unknown) => {
      assert.ok(err instanceof NativeWriterCommitError);
      assert.deepEqual(err.confirmedFiles.map(file => file.path), ['first.ts']);
      assert.deepEqual(err.uncertainPaths, ['second.ts']); return true;
    });
    assert.equal(readFileSync(join(root, 'first.ts'), 'utf8'), 'first');
    assert.throws(() => writer.commit(), /consumed|failed/i);
  } finally { NativeFilesystem.prototype.replace = original; writer.close(); rmSync(root, { recursive: true, force: true }); }
});

test('lazy native lifecycle, inline absence, borrowed lock and secrets are fail closed', () => {
  const root = project({ 'swfte.json': '{"version":1,"baseUrl":"https://api.swfte.com/agents","artifacts":[]}' });
  const open = NativeFilesystem.openRoot; let opens = 0; let closes = 0;
  const close = NativeFilesystem.prototype.close;
  NativeFilesystem.openRoot = function(root) { opens++; return open.call(this, root); };
  NativeFilesystem.prototype.close = function() { closes++; return close.call(this); };
  try {
    const unused = new ConfinedWriter({ root, native: true }); unused.close(); unused.close(); assert.equal(opens, 0);
    const inline = new ConfinedWriter({ native: true, inline: true });
    inline.create(inline.resolve('virtual.ts'), 'virtual'); const files = inline.commit();
    assert.equal(inline.nativeReceipt(files[0]!), null); inline.close(); assert.equal(opens, 0);
    const writer = new ConfinedWriter({ root, native: true, forbidden: ['credential_value_123'] });
    try {
      assert.equal(loadLock(writer, { baseUrl: '' }).exists, true); assert.equal(opens, 1); assert.equal(closes, 0);
      writer.create(writer.resolve('bad.ts'), 'credential_value_123'); assert.throws(() => writer.commit(), /credential/);
    } finally { writer.close(); }
    assert.equal(closes, 1);
  } finally { NativeFilesystem.openRoot = open; NativeFilesystem.prototype.close = close; rmSync(root, { recursive: true, force: true }); }
});

test('fresh current observations do not replace first planning preimage; moved root stays inode-bound', () => {
  const root = project({ 'existing.ts': 'initial' }), moved = root + '-moved';
  const writer = new ConfinedWriter({ root, native: true });
  try {
    assert.equal(writer.readText(writer.resolve('existing.ts')), 'initial');
    writeFileSync(join(root, 'existing.ts'), 'foreign');
    assert.equal(writer.readCurrentSnapshot(writer.resolve('existing.ts'))?.bytes.toString(), 'foreign');
    writer.create(writer.resolve('existing.ts'), 'ours', true);
    assert.throws(() => writer.commit(), /STALE_CONTENT/);
  } finally { writer.close(); }
  const moving = new ConfinedWriter({ root, native: true });
  try {
    moving.create(moving.resolve('new.ts'), 'capability-bound');
    renameSync(root, moved);
    moving.commit();
    assert.equal(readFileSync(join(moved, 'new.ts'), 'utf8'), 'capability-bound');
    assert.equal(existsSync(root), false);
  } finally { moving.close(); rmSync(root, { recursive: true, force: true }); rmSync(moved, { recursive: true, force: true }); }
});

test('native symlink and secret refusal leave no physical receipt or file', () => {
  const root = project({}), outside = project({ 'other.ts': 'foreign' });
  const writer = new ConfinedWriter({ root, native: true });
  try {
    symlinkSync(join(outside, 'other.ts'), join(root, 'linked.ts'));
    assert.throws(() => writer.create(writer.resolve('linked.ts'), 'new', true), /SYMLINK_REFUSED/);
    assert.equal(readFileSync(join(outside, 'other.ts'), 'utf8'), 'foreign');
    writer.create(writer.resolve('safe.ts'), 'safe');
    writer.create(writer.resolve('secret.ts'), 'pat_fixturecredential123');
    assert.throws(() => writer.commit(), /secret/);
    assert.equal(existsSync(join(root, 'safe.ts')), false);
    assert.equal(writer.nativeReceipt({ path: 'safe.ts', action: 'create', bytes: 4 }), null);
  } finally { writer.close(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('stale later preimage refuses entire native plan before earlier file or directory effects', () => {
  const root = project({ 'later.ts': 'initial' }), writer = new ConfinedWriter({ root, native: true });
  try {
    writer.create(writer.resolve('new-parent/earlier.ts'), 'first');
    writer.create(writer.resolve('later.ts'), 'second', true);
    writeFileSync(join(root, 'later.ts'), 'foreign');
    assert.throws(() => writer.commit(), (err: unknown) => err instanceof NativeWriterCommitError
      && err.code === 'STALE_CONTENT' && err.confirmedFiles.length === 0 && !err.directoriesMayExist);
    assert.equal(existsSync(join(root, 'new-parent')), false);
    assert.equal(readFileSync(join(root, 'later.ts'), 'utf8'), 'foreign');
  } finally { writer.close(); rmSync(root, { recursive: true, force: true }); }
});

test('descriptor current provenance validation skips an externally changed committed source', () => {
  const root = project({}), writer = new ConfinedWriter({ root, native: true });
  try {
    writer.create(writer.resolve('new.ts'), 'committed'); const writes = writer.commit();
    writeFileSync(join(root, 'new.ts'), 'later foreign bytes');
    recordNativeWrittenFiles(writer, writes, 'human', 'cli');
    assert.equal(existsSync(join(root, '.swfte/codemap/provenance.json')), false);
    assert.equal(readFileSync(join(root, 'new.ts'), 'utf8'), 'later foreign bytes');
  } finally { writer.close(); rmSync(root, { recursive: true, force: true }); }
});

test('native writer overwrite preserves restrictive mode and old open inode without truncation', () => {
  const root = project({ 'owned.ts': 'old bytes' }); chmodSync(join(root, 'owned.ts'), 0o600);
  const old = openSync(join(root, 'owned.ts'), 'r'), writer = new ConfinedWriter({ root, native: true });
  try {
    writer.create(writer.resolve('owned.ts'), 'new bytes', true); const first = writer.commit();
    assert.equal(statSync(join(root, 'owned.ts')).mode & 0o777, 0o600);
    assert.equal(readFileSync(old, 'utf8'), 'old bytes');
    assert.notEqual(statSync(join(root, 'owned.ts')).ino, fstatSync(old).ino);
    assert.equal(writer.nativeReceipt(first[0]!)?.action, 'overwrite');
    writer.create(writer.resolve('owned.ts'), 'new bytes'); const unchanged = writer.commit();
    assert.equal(unchanged[0]!.action, 'unchanged');
    writer.close(); writer.close();
    assert.throws(() => writer.readText(writer.resolve('owned.ts')), /ROOT_CLOSED/);
  } finally { writer.close(); closeSync(old); rmSync(root, { recursive: true, force: true }); }
});
