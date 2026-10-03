import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NativeFilesystem, NativeFilesystemError, nativeArtifactPaths, NATIVE_FILE_LIMIT } from '../src/native-filesystem.js';
import type { NativeSnapshot } from '../src/native-filesystem.js';

function fixture(run: (root: string, outside: string) => void): void {
 const base=mkdtempSync(join(tmpdir(),'native-tree-control-')), root=join(base,'project'), outside=join(base,'outside');
 mkdirSync(root); mkdirSync(outside);
 try {run(root,outside);} finally {rmSync(base,{recursive:true,force:true});}
}
const refused=(code:string,committed=false)=>(error:unknown)=>error instanceof NativeFilesystemError && error.code===code && error.committed===committed;

function request(root: string, op: number, rel: string, tail=Buffer.alloc(0)): Buffer {
 const fd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try {
  const st=fstatSync(fd,{bigint:true}), header=Buffer.alloc(34);
  header.write('SWFTECF1'); header.writeUInt32BE(1,8); header[12]=op;
  header.writeBigUInt64BE(st.dev,16); header.writeBigUInt64BE(st.ino,24);
  const parts=rel?rel.split('/').map(x=>Buffer.from(x)):[];header.writeUInt16BE(parts.length,32);
  return Buffer.concat([header,...parts.flatMap(p=>{const n=Buffer.alloc(2);n.writeUInt16BE(p.length);return[n,p];}),tail]);
 } finally {closeSync(fd);}
}
function actual(root:string,input:Buffer):Buffer {
 const fd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try {
  const result=spawnSync(nativeArtifactPaths().executable,[],{input,stdio:['pipe','pipe','pipe',fd],timeout:10000,maxBuffer:NATIVE_FILE_LIMIT+4096});
  assert.equal(result.error,undefined);assert.equal(result.status,0);assert.equal(result.stdout.subarray(0,8).toString(),'SWFTECF1');
  assert.equal(result.stdout.readUInt32BE(12),result.stdout.length-16);return result.stdout;
 } finally {closeSync(fd);}
}
const caps=(entries:number,bytes:number)=>{const b=Buffer.alloc(8);b.writeUInt32BE(entries);b.writeUInt32BE(bytes,4);return b;};

test('actual native root/nested/empty/missing list repeats independently and freezes sorted nofollow metadata',()=>fixture((root,outside)=>{
 writeFileSync(join(root,'a'),'inside');mkdirSync(join(root,'nested'));mkdirSync(join(root,'empty'));
 writeFileSync(join(root,'nested','child'),'child');writeFileSync(join(outside,'victim'),'outside');
 symlinkSync(outside,join(root,'linked'));linkSync(join(outside,'victim'),join(root,'hard'));
 for(const name of ['.hidden','é','\uE000','😀'])writeFileSync(join(root,name),name);
 const fs=NativeFilesystem.openRoot(root);
 try {
  const expected=readdirSync(root).sort((a,b)=>a<b?-1:a>b?1:0);
  for(let i=0;i<4;i++) {
   const listed=fs.list()!;assert.deepEqual(listed.entries.map(e=>e.name),expected);
   assert.equal(listed.identity.dev,fs.identity.dev);assert.equal(listed.identity.ino,fs.identity.ino);
   assert(Object.isFrozen(listed));assert(Object.isFrozen(listed.entries));assert(listed.entries.every(e=>Object.isFrozen(e)&&Object.isFrozen(e.identity)));
   assert.equal(listed.entries.find(e=>e.name==='linked')!.kind,'symlink');
   assert.equal(listed.entries.find(e=>e.name==='hard')!.identity.nlink,'2');
   assert.throws(()=>fs.read('hard'),refused('HARDLINK_REFUSED'));
   assert.throws(()=>fs.list('linked'),refused('SYMLINK_REFUSED'));
  }
  assert.deepEqual(fs.list('nested')!.entries.map(e=>[e.name,e.kind]),[['child','file']]);
  assert.deepEqual(fs.list('empty',{maxEntries:1,maxBytes:65})!.entries,[]);assert.equal(fs.list('missing',{maxBytes:1}),null);
  assert.equal(readFileSync(join(outside,'victim'),'utf8'),'outside');
 }finally{fs.close();}
 assert.throws(()=>fs.list(),refused('ROOT_CLOSED'));
}));

test('actual list caps and invalid component names refuse read-only without manufacturing partial lists',()=>fixture(root=>{
 writeFileSync(join(root,'one'),'one');writeFileSync(join(root,'two'),'two');const fs=NativeFilesystem.openRoot(root);
 try {
  assert.throws(()=>fs.list('',{maxEntries:1}),refused('SIZE_LIMIT'));
  assert.throws(()=>fs.list('',{maxBytes:65}),refused('SIZE_LIMIT'));
  for(const limits of [{maxEntries:0},{maxEntries:20001},{maxEntries:1.5},{maxBytes:0},{maxBytes:NATIVE_FILE_LIMIT+1}])assert.throws(()=>fs.list('',limits),refused('SIZE_LIMIT'));
  for(const rel of ['.','..','a/../b','a//b','a\\b','\0bad'])assert.throws(()=>fs.list(rel),refused('PATH_REFUSED'));
  assert.deepEqual(fs.list('',{maxEntries:2,maxBytes:197})!.entries.map(e=>e.name),['one','two']);
  // POSIX allows bytes the producer refuses rather than silently decoding or skipping.
  writeFileSync(join(root,'bad\nname'),'unchanged');assert.throws(()=>fs.list(),refused('PATH_REFUSED'));
  assert.equal(readFileSync(join(root,'bad\nname'),'utf8'),'unchanged');
 }finally{fs.close();}
}));

// APFS (macOS) refuses to create a non-UTF-8 filename (EILSEQ), so the fixture cannot exist there; Linux runs it.
test('native enumeration rejects malformed UTF8 filename bytes on the actual filesystem',{skip:process.platform==='darwin'?'APFS refuses non-UTF-8 filenames (EILSEQ)':false},()=>fixture(root=>{
 const path=Buffer.concat([Buffer.from(root+'/'),Buffer.from([0xc0,0xaf])]);writeFileSync(path,'unchanged');
 const fs=NativeFilesystem.openRoot(root);try {assert.throws(()=>fs.list(),refused('PATH_REFUSED'));assert.equal(readFileSync(path,'utf8'),'unchanged');}finally{fs.close();}
}));

test('actual expected snapshot unlink succeeds only for regular singlylinked matching bytes and identity',()=>fixture(root=>{
 writeFileSync(join(root,'queue'),'manifest');const fs=NativeFilesystem.openRoot(root);
 try {
  const expected=fs.read('queue')!;assert.deepEqual(fs.unlink({rel:'queue',expected}),{removed:true});assert.equal(existsSync(join(root,'queue')),false);
  assert.deepEqual(fs.unlink({rel:'queue',expected}),{removed:false});
  assert.deepEqual(fs.unlink({rel:'missing-parent/queue',expected}),{removed:false});
  writeFileSync(join(root,'changed'),'old');const old=fs.read('changed')!;writeFileSync(join(root,'changed'),'new');
  assert.throws(()=>fs.unlink({rel:'changed',expected:old}),refused('STALE_CONTENT'));assert.equal(readFileSync(join(root,'changed'),'utf8'),'new');
  writeFileSync(join(root,'same'),'same');const before=fs.read('same')!;renameSync(join(root,'same'),join(root,'retired'));writeFileSync(join(root,'same'),'same');
  assert.throws(()=>fs.unlink({rel:'same',expected:before}),refused('STALE_CONTENT'));assert.equal(readFileSync(join(root,'same'),'utf8'),'same');
  const mode=fs.read('same')!;chmodSync(join(root,'same'),(mode.mode&0o777)^0o100);assert.throws(()=>fs.unlink({rel:'same',expected:mode}),refused('STALE_CONTENT'));
 }finally{fs.close();}
}));

test('native unlink refuses links directories traversal and malformed authorization, preserving outside victim',()=>fixture((root,outside)=>{
 writeFileSync(join(root,'owned'),'owned');writeFileSync(join(outside,'victim'),'outside');
 symlinkSync(outside,join(root,'ancestor'));symlinkSync(join(outside,'victim'),join(root,'leaf'));linkSync(join(outside,'victim'),join(root,'hard'));mkdirSync(join(root,'dir'));
 const fs=NativeFilesystem.openRoot(root);
 try {
  const expected=fs.read('owned')!;
  for(const rel of ['ancestor/victim','leaf'])assert.throws(()=>fs.unlink({rel,expected}),refused('SYMLINK_REFUSED'));
  assert.throws(()=>fs.unlink({rel:'hard',expected}),refused('HARDLINK_REFUSED'));assert.throws(()=>fs.unlink({rel:'dir',expected}),refused('PATH_REFUSED'));
  for(const rel of ['', '.', '..', '../victim'])assert.throws(()=>fs.unlink({rel,expected}),refused('PATH_REFUSED'));
  for(const wrong of [null,undefined,{...expected,nlink:'2'},{...expected,size:'999'},{...expected,mode:0o040700},{...expected,bytes:'not bytes'}])assert.throws(()=>fs.unlink({rel:'owned',expected:wrong as NativeSnapshot}),refused('PROTOCOL_INVALID'));
  assert.equal(readFileSync(join(outside,'victim'),'utf8'),'outside');assert.equal(readFileSync(join(root,'owned'),'utf8'),'owned');
 }finally{fs.close();}
}));

test('list/read/unlink stay bound to moved directory inode without claiming current pathname ancestry',()=>fixture((root,outside)=>{
 writeFileSync(join(root,'queue'),'owned');const fs=NativeFilesystem.openRoot(root),expected=fs.read('queue')!,moved=join(outside,'moved');
 renameSync(root,moved);symlinkSync(outside,root);writeFileSync(join(outside,'queue'),'outside');
 try {assert.deepEqual(fs.list()!.entries.map(e=>e.name),['queue']);assert.deepEqual(fs.unlink({rel:'queue',expected}),{removed:true});assert.equal(existsSync(join(moved,'queue')),false);assert.equal(readFileSync(join(outside,'queue'),'utf8'),'outside');}finally{fs.close();}
}));

test('actual binary op4/op5 boundary rejects missing caps trailing bytes and invalid snapshot before effects',()=>fixture(root=>{
 writeFileSync(join(root,'owned'),'unchanged');const good=actual(root,request(root,4,'',caps(20000,NATIVE_FILE_LIMIT)));assert.equal(good.readUInt16BE(8),0);assert.equal(good[10],0);
 const negative=[request(root,4,''),request(root,4,'',caps(0,1024)),Buffer.concat([request(root,4,'',caps(1,1024)),Buffer.from([1])]),request(root,5,''),request(root,5,'owned',Buffer.alloc(64))];
 for(const input of negative){const result=actual(root,input);assert.equal(result.readUInt16BE(8),1);assert.equal(result[10],0);assert.match(result.subarray(16).toString(),/PROTOCOL_INVALID|SIZE_LIMIT|PATH_REFUSED/);assert.equal(readFileSync(join(root,'owned'),'utf8'),'unchanged');}
}));

test('genuine isolated helper positive precedes launched list refusal versus uncertain unlink effect classification',async()=>{
 const base=mkdtempSync(join(tmpdir(),'native-tree-isolated-')),root=join(base,'project'),pkg=join(base,'package');mkdirSync(root);mkdirSync(join(pkg,'src'),{recursive:true});writeFileSync(join(pkg,'package.json'),' {"type":"module"}');
 const modulePath=join(pkg,'src/native-filesystem.ts');copyFileSync(fileURLToPath(new URL('../src/native-filesystem.ts',import.meta.url)),modulePath);
 try {
  const isolated=await import(pathToFileURL(modulePath).href) as typeof import('../src/native-filesystem.js');const target=isolated.nativeArtifactPaths(),genuine=nativeArtifactPaths();mkdirSync(dirname(target.executable),{recursive:true});copyFileSync(genuine.executable,target.executable);copyFileSync(genuine.manifest,target.manifest);
  writeFileSync(join(root,'queue'),'owned');const fs=isolated.NativeFilesystem.openRoot(root);
  try {
   assert.deepEqual(fs.list()!.entries.map(e=>e.name),['queue']);const expected=fs.read('queue')!;
   renameSync(target.executable,target.executable+'.saved');
   assert.throws(()=>fs.list(),e=>e instanceof isolated.NativeFilesystemError&&e.code==='IO_ERROR'&&e.committed===false);
   assert.throws(()=>fs.unlink({rel:'queue',expected}),e=>e instanceof isolated.NativeFilesystemError&&e.code==='PARTIAL_COMMIT'&&e.committed===true);
   assert.equal(readFileSync(join(root,'queue'),'utf8'),'owned');
  }finally{fs.close();}
 }finally{rmSync(base,{recursive:true,force:true});}
});


test('negative-only malformed response frames refuse after genuine isolated native list/unlink positives',async()=>{
 const base=mkdtempSync(join(tmpdir(),'native-tree-frame-')),root=join(base,'project'),pkg=join(base,'package');mkdirSync(root);mkdirSync(join(pkg,'src'),{recursive:true});writeFileSync(join(pkg,'package.json'),'{"type":"module"}');
 const modulePath=join(pkg,'src/native-filesystem.ts');copyFileSync(fileURLToPath(new URL('../src/native-filesystem.ts',import.meta.url)),modulePath);
 try {
  const isolated=await import(pathToFileURL(modulePath).href) as typeof import('../src/native-filesystem.js');const target=isolated.nativeArtifactPaths(),genuine=nativeArtifactPaths();mkdirSync(dirname(target.executable),{recursive:true});copyFileSync(genuine.executable,target.executable);copyFileSync(genuine.manifest,target.manifest);
  writeFileSync(join(root,'queue'),'owned');writeFileSync(join(root,'scratch'),'positive');const fs=isolated.NativeFilesystem.openRoot(root);
  try {
   assert.deepEqual(fs.list()!.entries.map(e=>e.name),['queue','scratch']);assert.deepEqual(fs.unlink({rel:'scratch',expected:fs.read('scratch')!}),{removed:true});
   const expected=fs.read('queue')!, genuineFrame=actual(root,request(root,4,'',caps(20000,NATIVE_FILE_LIMIT)));
   const frame=(payload:Buffer,committed=0)=>{const h=Buffer.from(genuineFrame.subarray(0,16));h[10]=committed;h.writeUInt32BE(payload.length,12);return Buffer.concat([h,payload]);};
   const payload=genuineFrame.subarray(16), countAt=61, recordAt=65;
   assert.equal(payload.readUInt32BE(countAt),1);const record=payload.subarray(recordAt),nameSize=record.readUInt16BE();
   const wrongRoot=Buffer.from(payload);wrongRoot.writeBigUInt64BE(BigInt(fs.identity.ino)+1n,9);
   const wrongKind=Buffer.from(payload);wrongKind[recordAt+2+nameSize]=2;
   const invalidUtf8=Buffer.from(payload);invalidUtf8[recordAt+2]=0xff;
   const wrongPresent=Buffer.from(payload);wrongPresent[0]=2;
   const tooMany=Buffer.from(payload);tooMany.writeUInt32BE(20001,countAt);
   const duplicate=Buffer.concat([payload,record]);duplicate.writeUInt32BE(2,countAt);
   const replies=[frame(wrongRoot),frame(wrongKind),frame(invalidUtf8),frame(wrongPresent),frame(tooMany),frame(duplicate),frame(Buffer.concat([payload,Buffer.from([0])])),frame(payload,1),frame(payload.subarray(0,payload.length-1))];
   // Only negative framing bytes are substituted after genuine positives. This never supplies a native positive/helper fallback.
   const negativeReply=(reply:Buffer)=>{writeFileSync(target.executable,'#!'+process.execPath+'\nprocess.stdout.write(Buffer.from('+JSON.stringify(reply.toString('base64'))+',"base64"));\n');chmodSync(target.executable,0o755);};
   for(const reply of replies){negativeReply(reply);assert.throws(()=>fs.list(),e=>e instanceof isolated.NativeFilesystemError&&e.code==='PROTOCOL_INVALID'&&e.committed===false);}
   for(const reply of [frame(Buffer.from([1]),0),frame(Buffer.from([0]),1),frame(Buffer.from([2]),0),frame(Buffer.from([0,0]),0)]) {
    negativeReply(reply);assert.throws(()=>fs.unlink({rel:'queue',expected}),e=>e instanceof isolated.NativeFilesystemError&&e.code==='PROTOCOL_INVALID'&&e.committed===true);
   }
   assert.equal(readFileSync(join(root,'queue'),'utf8'),'owned');
  }finally{fs.close();}
 }finally{rmSync(base,{recursive:true,force:true});}
});


test('actual full file bound unlink and oversized snapshot refusal preserve exact bounded bytes',()=>fixture(root=>{
 const fs=NativeFilesystem.openRoot(root);
 try {
  const bytes=Buffer.alloc(NATIVE_FILE_LIMIT,97);fs.replace({rel:'at-cap',expected:null,bytes,policy:'create-only'});
  const expected=fs.read('at-cap')!;assert.equal(expected.bytes.length,NATIVE_FILE_LIMIT);
  assert.throws(()=>fs.unlink({rel:'at-cap',expected:{...expected,size:String(NATIVE_FILE_LIMIT+1),bytes:Buffer.alloc(NATIVE_FILE_LIMIT+1)}}),refused('PROTOCOL_INVALID'));
  assert.equal(readFileSync(join(root,'at-cap')).length,NATIVE_FILE_LIMIT);
  assert.deepEqual(fs.unlink({rel:'at-cap',expected}),{removed:true});assert.equal(existsSync(join(root,'at-cap')),false);
 }finally{fs.close();}
}));

// Substituted frames are negatives only, after genuine current-helper public effects/readback.
test('malformed error frames conservatively classify launched mutators and retain valid error flags',async()=>{
 const base=mkdtempSync(join(tmpdir(),'native-error-frame-')),root=join(base,'project'),pkg=join(base,'package');mkdirSync(root);mkdirSync(join(pkg,'src'),{recursive:true});writeFileSync(join(pkg,'package.json'),'{"type":"module"}');
 const modulePath=join(pkg,'src/native-filesystem.ts');copyFileSync(fileURLToPath(new URL('../src/native-filesystem.ts',import.meta.url)),modulePath);
 try {
  const isolated=await import(pathToFileURL(modulePath).href) as typeof import('../src/native-filesystem.js');const target=isolated.nativeArtifactPaths(),genuine=nativeArtifactPaths();mkdirSync(dirname(target.executable),{recursive:true});copyFileSync(genuine.executable,target.executable);copyFileSync(genuine.manifest,target.manifest);
  writeFileSync(join(root,'queue'),'owned');writeFileSync(join(root,'scratch'),'positive');const fs=isolated.NativeFilesystem.openRoot(root);
  try {
   assert.deepEqual(fs.list()!.entries.map(e=>e.name),['queue','scratch']);
   assert.deepEqual(fs.unlink({rel:'scratch',expected:fs.read('scratch')!}),{removed:true});
   assert.equal(existsSync(join(root,'scratch')),false);const expected=fs.read('queue')!;assert.equal(expected.bytes.toString(),'owned');
   symlinkSync(join(root,'queue'),join(root,'link'));assert.throws(()=>fs.unlink({rel:'link',expected}),e=>e instanceof isolated.NativeFilesystemError&&e.code==='SYMLINK_REFUSED'&&!e.committed);
   const header=actual(root,request(root,4,'',caps(20000,NATIVE_FILE_LIMIT))).subarray(0,16);
   const reply=(payload:Buffer,flag:number)=>{const h=Buffer.from(header);h.writeUInt16BE(1,8);h[10]=flag;h.writeUInt32BE(payload.length,12);const frame=Buffer.concat([h,payload]);writeFileSync(target.executable,'#!'+process.execPath+'\nprocess.stdout.write(Buffer.from('+JSON.stringify(frame.toString('base64'))+',"base64"));\n');chmodSync(target.executable,0o755);};
   const mutators=[()=>fs.replace({rel:'queue',expected,bytes:Buffer.from('new'),policy:'authorized-replace'}),()=>fs.mkdir('nested'),()=>fs.unlink({rel:'queue',expected})];
   const readers=[()=>fs.list(),()=>fs.read('queue')];
   const highBit=Buffer.from('PATH_REFUSED');highBit[0]=highBit[0]!|0x80;
   for(const [payload,flag] of [[Buffer.from('UNKNOWN_ERROR'),0],[Buffer.alloc(0),0],[highBit,0],[Buffer.from('PARTIAL_COMMIT'),0],[Buffer.from('PATH_REFUSED'),1]] as const){
    reply(payload,flag);
    for(const invoke of mutators)assert.throws(invoke,e=>e instanceof isolated.NativeFilesystemError&&e.code==='PROTOCOL_INVALID'&&e.committed===true);
    for(const invoke of readers)assert.throws(invoke,e=>e instanceof isolated.NativeFilesystemError&&e.code==='PROTOCOL_INVALID'&&e.committed===false);
   }
   // Typed valid refusal/partial acknowledgement framing is preserved; these remain synthetic negatives.
   reply(Buffer.from('PATH_REFUSED'),0);
   for(const invoke of [...mutators,...readers])assert.throws(invoke,e=>e instanceof isolated.NativeFilesystemError&&e.code==='PATH_REFUSED'&&e.committed===false);
   reply(Buffer.from('PARTIAL_COMMIT'),1);
   for(const invoke of mutators)assert.throws(invoke,e=>e instanceof isolated.NativeFilesystemError&&e.code==='PARTIAL_COMMIT'&&e.committed===true);
   for(const invoke of readers)assert.throws(invoke,e=>e instanceof isolated.NativeFilesystemError&&e.code==='PROTOCOL_INVALID'&&e.committed===false);
   assert.equal(readFileSync(join(root,'queue'),'utf8'),'owned');assert.equal(existsSync(join(root,'nested')),false);
  }finally{fs.close();}
 }finally{rmSync(base,{recursive:true,force:true});}
});
