/** Explicit build/release producer only; never invoked by runtime consumers. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const NATIVE_TUPLES = Object.freeze(['darwin-arm64','darwin-x64','linux-x64-glibc']);
const cache = join(root,'.native-artifacts');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const version = /^\d+\.\d+(?:\.\d+)?$/;
export function hostTuple() {
  const glibc=process.report?.getReport()?.header?.glibcVersionRuntime;
  if(process.platform==='darwin' && ['arm64','x64'].includes(process.arch)) return `darwin-${process.arch}`;
  if(process.platform==='linux' && process.arch==='x64' && typeof glibc==='string' && version.test(glibc)) return 'linux-x64-glibc';
  throw new Error('UNSUPPORTED_PLATFORM: no artifact producer for this OS/CPU/libc tuple');
}
function directory(path) {
  const st=lstatSync(path);
  if(!st.isDirectory() || st.isSymbolicLink()) throw new Error('NATIVE_DIRECTORY_REFUSED');
}
function bounded(path,limit,executable=false) {
  if(!constants.O_NOFOLLOW) throw new Error('UNSUPPORTED_PLATFORM');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=fstatSync(fd);
    if(!before.isFile() || before.nlink!==1 || before.size<1 || before.size>limit
      || (before.mode&0o022) || (executable && !(before.mode&0o111))) throw new Error('NATIVE_ARTIFACT_REFUSED');
    const bytes=Buffer.alloc(before.size+1); let at=0;
    while(at<bytes.length) { const n=readSync(fd,bytes,at,bytes.length-at,at); if(!n) break; at+=n; }
    const after=fstatSync(fd);
    if(at!==before.size || after.size!==before.size || after.nlink!==1 || after.mode!==before.mode
      || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs) throw new Error('NATIVE_ARTIFACT_CHANGED');
    return bytes.subarray(0,at);
  } finally { closeSync(fd); }
}
function sourceBytes() { return bounded(join(root,'native/confined-fs.c'),1024*1024); }
function abi(binary,tuple) {
  if(tuple.startsWith('darwin-')) {
    if(binary.length<32 || binary.readUInt32LE(0)!==0xfeedfacf || binary.readUInt32LE(12)!==2
      || binary.readUInt32LE(4)!==(tuple==='darwin-arm64'?0x0100000c:0x01000007)) throw new Error('NATIVE_OUTPUT_ABI_MISMATCH');
    const count=binary.readUInt32LE(16),size=binary.readUInt32LE(20);
    if(count>4096 || size>binary.length-32) throw new Error('NATIVE_OUTPUT_ABI_MISMATCH');
    let at=32,minimum;
    for(let i=0;i<count;i++) {
      if(at+8>32+size) throw new Error('NATIVE_OUTPUT_ABI_MISMATCH');
      const command=binary.readUInt32LE(at),length=binary.readUInt32LE(at+4);
      if(length<8 || at+length>32+size) throw new Error('NATIVE_OUTPUT_ABI_MISMATCH');
      if(command===0x32) { if(length<24 || binary.readUInt32LE(at+8)!==1) throw new Error('NATIVE_OUTPUT_ABI_MISMATCH'); minimum=binary.readUInt32LE(at+12); }
      if(command===0x24) { if(length<16) throw new Error('NATIVE_OUTPUT_ABI_MISMATCH'); minimum=binary.readUInt32LE(at+8); }
      at+=length;
    }
    if(at!==32+size || minimum!==0x000b0000) throw new Error('NATIVE_OUTPUT_MINIMUM_MISMATCH');
    return;
  }
  if(tuple!=='linux-x64-glibc' || binary.length<64 || !binary.subarray(0,4).equals(Buffer.from([127,69,76,70]))
    || binary[4]!==2 || binary[5]!==1 || binary[6]!==1 || ![0,3].includes(binary[7])
    || ![2,3].includes(binary.readUInt16LE(16)) || binary.readUInt16LE(18)!==62) throw new Error('NATIVE_OUTPUT_ABI_MISMATCH');
  const table=Number(binary.readBigUInt64LE(32)),width=binary.readUInt16LE(54),count=binary.readUInt16LE(56);
  if(!Number.isSafeInteger(table) || width<56 || count<1 || count>1024 || table+width*count>binary.length) throw new Error('NATIVE_OUTPUT_ABI_MISMATCH');
  let interpreter;
  for(let i=0;i<count;i++) { const at=table+i*width;
    if(binary.readUInt32LE(at)!==3) continue;
    if(interpreter!==undefined) throw new Error('NATIVE_OUTPUT_LIBC_MISMATCH');
    const start=Number(binary.readBigUInt64LE(at+8)),length=Number(binary.readBigUInt64LE(at+32));
    if(!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || length<2 || length>1024 || start+length>binary.length
      || binary[start+length-1]!==0) throw new Error('NATIVE_OUTPUT_ABI_MISMATCH');
    interpreter=binary.subarray(start,start+length-1).toString('ascii');
  }
  if(!/^\/lib(?:64|\/x86_64-linux-gnu)?\/ld-linux-x86-64\.so\.2$/.test(interpreter??'')) throw new Error('NATIVE_OUTPUT_LIBC_MISMATCH');
}
function artifact(folder,tuple,sourceHash) {
  directory(folder);
  if(JSON.stringify(readdirSync(folder).sort())!==JSON.stringify(['confined-fs','manifest.json'])) throw new Error('NATIVE_ARTIFACT_CONTENTS_REFUSED');
  const manifestBytes=bounded(join(folder,'manifest.json'),16384),manifest=JSON.parse(manifestBytes.toString('utf8'));
  const binary=bounded(join(folder,'confined-fs'),8*1024*1024,true);
  if(!manifest || manifest.schema!=='swfte-native-artifact/1' || manifest.protocol!=='SWFTE_CF1'
    || manifest.wireVersion!==1 || manifest.tuple!==tuple || manifest.sourceSha256!==sourceHash
    || manifest.bytes!==binary.length || manifest.sha256!==sha(binary)
    || typeof manifest.compiler!=='string' || !isAbsolute(manifest.compiler) || !Array.isArray(manifest.flags)
    || !manifest.producer || manifest.producer.arch!==(tuple==='darwin-arm64'?'arm64':'x64')
    || manifest.producer.platform!==(tuple.startsWith('darwin-')?'darwin':'linux')) throw new Error('NATIVE_MANIFEST_REFUSED');
  if(tuple==='linux-x64-glibc') {
    if(typeof manifest.glibcMinimum!=='string' || !version.test(manifest.glibcMinimum)
      || manifest.producer.glibc!==manifest.glibcMinimum) throw new Error('NATIVE_OUTPUT_LIBC_MISMATCH');
  } else if(manifest.macosMinimum!=='11.0') throw new Error('NATIVE_OUTPUT_MINIMUM_MISMATCH');
  abi(binary,tuple);
  return {tuple,manifest,manifestBytes,binary};
}
export function validateNativeMatrix(input=cache,{requireAll=true}={}) {
  const sourceHash=sha(sourceBytes()); directory(input);
  const names=readdirSync(input).sort();
  if(names.length<1 || names.some(name=>!NATIVE_TUPLES.includes(name))
    || (requireAll && (names.length!==3 || NATIVE_TUPLES.some(tuple=>!names.includes(tuple))))) throw new Error('NATIVE_MATRIX_INCOMPLETE_OR_UNKNOWN');
  return names.map(tuple=>artifact(join(input,tuple),tuple,sourceHash));
}
export function assembleNative(input=cache,output=join(root,'dist/native'),{requireAll=true}={}) {
  // Every source tuple is fully admitted before the first destination write.
  const artifacts=validateNativeMatrix(input,{requireAll});
  mkdirSync(output,{recursive:true}); directory(output);
  for(const item of artifacts) {
    const folder=join(output,item.tuple); mkdirSync(folder,{recursive:true}); directory(folder);
    for(const [name,bytes,mode] of [['confined-fs',item.binary,0o755],['manifest.json',item.manifestBytes,0o644]]) {
      const path=join(folder,name);
      // Build/cache/package directories are trusted; this is not the runtime confined writer.
      try { const st=lstatSync(path); if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1) throw new Error('NATIVE_OUTPUT_PATH_REFUSED'); }
      catch(error) { if(error.code!=='ENOENT') throw error; }
      writeFileSync(path,bytes,{mode}); chmodSync(path,mode);
      if(sha(bounded(path,8*1024*1024,name==='confined-fs'))!==sha(bytes)) throw new Error('NATIVE_OUTPUT_CHANGED');
    }
  }
  const assembly={schema:'swfte-native-assembly/1',protocol:'SWFTE_CF1',sourceSha256:sha(sourceBytes()),
    artifacts:Object.fromEntries(artifacts.map(item=>[item.tuple,item.manifest.sha256]))};
  writeFileSync(join(output,'assembly.json'),JSON.stringify(assembly,null,2)+'\n',{mode:0o644});
  return assembly;
}
function buildHost() {
  const tuple=hostTuple(),source=sourceBytes();
  const compiler=process.env.SWFTE_NATIVE_CC??(process.platform==='darwin'?'/usr/bin/clang':'/usr/bin/cc');
  if(!isAbsolute(compiler) || /[\x00-\x1f\x7f]/.test(compiler)) throw new Error('NATIVE_COMPILER_REFUSED');
  const flags=['-std=c11','-Wall','-Wextra','-Werror','-O2'];
  if(process.platform==='darwin') flags.push('-arch',process.arch==='x64'?'x86_64':'arm64','-mmacosx-version-min=11.0');
  const temporary=mkdtempSync(join(root,'.native-build-'));
  try {
    const input=join(temporary,'input.c'),executable=join(temporary,'confined-fs');
    writeFileSync(input,source,{mode:0o600,flag:'wx'}); chmodSync(input,0o600);
    execFileSync(compiler,[...flags,input,'-o',executable],{cwd:root,shell:false,timeout:60_000,
      stdio:['ignore','pipe','pipe'],env:{LANG:'C',LC_ALL:'C',...(process.platform==='darwin'&&process.env.SDKROOT?{SDKROOT:process.env.SDKROOT}:{})}});
    chmodSync(executable,0o755); const binary=bounded(executable,8*1024*1024,true); abi(binary,tuple);
    const glibc=process.report?.getReport()?.header?.glibcVersionRuntime;
    const manifest={schema:'swfte-native-artifact/1',protocol:'SWFTE_CF1',wireVersion:1,tuple,bytes:binary.length,
      sha256:sha(binary),sourceSha256:sha(source),compiler,flags,
      producer:{platform:process.platform,arch:process.arch,...(tuple==='linux-x64-glibc'?{glibc}:{})},
      ...(tuple==='linux-x64-glibc'?{glibcMinimum:glibc}:{macosMinimum:'11.0'})};
    const metadata=join(temporary,'manifest.json'); writeFileSync(metadata,JSON.stringify(manifest,null,2)+'\n',{mode:0o644,flag:'wx'}); chmodSync(metadata,0o644);
    mkdirSync(cache,{recursive:true}); directory(cache); const folder=join(cache,tuple); mkdirSync(folder,{recursive:true}); directory(folder);
    for(const [from,name] of [[executable,'confined-fs'],[metadata,'manifest.json']]) {
      const target=join(folder,name);
      try { const st=lstatSync(target); if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1) throw new Error('NATIVE_CACHE_PATH_REFUSED'); }
      catch(error) { if(error.code!=='ENOENT') throw error; }
      renameSync(from,target);
    }
    artifact(folder,tuple,sha(source));
    process.stdout.write(`SWFTE_NATIVE_BUILD_OK ${tuple} ${manifest.sha256}\n`);
  } finally { rmSync(temporary,{recursive:true,force:true}); }
}
export function prepareNative() {
  if(process.env.SWFTE_NATIVE_REQUIRE_ALL==='1') {
    hostTuple(); // Strict release is unavailable on an unsupported producer host.
    return assembleNative(cache,join(root,'dist/native'),{requireAll:true});
  }
  let tuple;
  try { tuple=hostTuple(); } catch(error) {
    if(error.message.startsWith('UNSUPPORTED_PLATFORM')) { process.stdout.write('SWFTE_NATIVE_UNSUPPORTED_BUILD_HOST\n'); return; }
    throw error;
  }
  let reusable=false;
  try { artifact(join(cache,tuple),tuple,sha(sourceBytes())); reusable=true; } catch(error) {
    if(error.code!=='ENOENT' && error.message!=='NATIVE_MANIFEST_REFUSED') throw error;
  }
  // Stale/missing ordinary host output may be rebuilt by the real host compiler.
  // Strict release never recompiles or labels a host artifact as another tuple.
  if(!reusable) buildHost();
  return assembleNative(cache,join(root,'dist/native'),{requireAll:false});
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const command=process.argv[2]??'--build-host';
  if(process.argv.length>3) throw new Error('NATIVE_BUILD_ARGUMENT_REFUSED');
  if(command==='--validate-all') { validateNativeMatrix(); process.stdout.write('SWFTE_NATIVE_MATRIX_OK\n'); }
  else if(command==='--prepare-and-assemble') prepareNative();
  else if(command==='--build-host') { buildHost(); assembleNative(cache,join(root,'dist/native'),{requireAll:false}); }
  else throw new Error('NATIVE_BUILD_ARGUMENT_REFUSED');
}
