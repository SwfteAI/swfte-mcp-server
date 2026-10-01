import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
const root=process.cwd();
const backend='/Users/dejanmaksimovic/Projects/Swfte/websites/studio-web-app/.worktrees/parallel-foundation-agents';
const tracking=path.join(backend,'.unlazy/parallel/foundation-repairs');
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}).trim();
function source(){
  const names=[...new Set([...git(['ls-files']).split('\n'),...git(['ls-files','--others','--exclude-standard']).split('\n')])]
    .filter(p=>p&&!p.startsWith('.unlazy/')&&(/^(src\/|test\/|scripts\/)/.test(p)||['package.json','package-lock.json','tsconfig.json','tsup.config.ts'].includes(p))).sort();
  const files=names.map(file=>({file,sha256:sha256(fs.readFileSync(path.join(root,file)))}));
  return{sha:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),fingerprint:sha256(JSON.stringify(files)),files};
}
async function run(command,args,log){
  const stream=fs.createWriteStream(log,{flags:'wx'});
  const child=spawn(command,args,{cwd:root,stdio:['ignore','pipe','pipe']});
  for(const output of [child.stdout,child.stderr])output.on('data',bytes=>{stream.write(bytes);process.stdout.write(bytes);});
  const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  await new Promise(resolve=>stream.end(resolve));
  return{exitCode,path:path.relative(backend,log),sha256:sha256(fs.readFileSync(log))};
}
const mode=process.argv[2];
if(mode!=='scoped')throw new Error('Use scoped; full inherited suite remains held because it generates forbidden environment files');
const before=source();
const startedAt=new Date().toISOString();
const dir=path.join(tracking,'evidence',`mcp-${startedAt.replaceAll(':','-')}`);
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'inputs.json'),JSON.stringify({startedAt,source:before,scope:'Original00 simulations, shared registry/default budget, all current package types/build'},null,2)+'\n');
const types=await run('npm',['run','typecheck'],path.join(dir,'types.log'));
const build=await run('npm',['run','build'],path.join(dir,'build.log'));
const tests=await run('node',['--import','tsx','--test','--test-reporter=tap','test/simulations.test.ts','test/tools.test.ts'],path.join(dir,'tests.log'));
const tap=fs.readFileSync(path.join(backend,tests.path),'utf8');
const n=name=>Number(tap.match(new RegExp(`^# ${name} (\\d+)$`,'m'))?.[1]??NaN);
const counts={tests:n('tests'),suites:n('suites'),pass:n('pass'),fail:n('fail'),cancelled:n('cancelled'),skipped:n('skipped'),todo:n('todo')};
const after=source();
const result={startedAt,finishedAt:new Date().toISOString(),source:before,afterSource:after,changedDuringRun:before.fingerprint!==after.fingerprint,
  scope:'Original00 simulations and shared registry/default tool budget',fullInheritedSuite:'OPEN: inherited unrelated suites generate .env files; no test-I/O substitution applied',
  logs:{types,build,tests},counts,accepted:types.exitCode===0&&build.exitCode===0&&tests.exitCode===0&&counts.tests>0&&counts.fail===0&&counts.cancelled===0&&counts.skipped===0&&counts.todo===0&&before.fingerprint===after.fingerprint};
fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2)+'\n');
fs.mkdirSync(path.join(tracking,'reports'),{recursive:true});
const receipt={exitCode:result.accepted?0:1,sourceSha:before.sha,sourceTree:before.tree,sourceFingerprint:before.fingerprint,files:before.files,tests:counts.tests,failures:counts.fail,errors:counts.cancelled,skipped:counts.skipped,reportHashes:Object.values(result.logs).map(log=>({path:log.path,sha256:log.sha256})),resultPath:path.relative(backend,path.join(dir,'result.json')),resultSha256:sha256(fs.readFileSync(path.join(dir,'result.json'))),scope:result.scope,fullInheritedSuite:result.fullInheritedSuite};
fs.writeFileSync(path.join(tracking,'reports','mcp-scoped-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
if(!result.accepted){console.error(`FOUNDATION_MCP_SCOPED_FAILED ${JSON.stringify(counts)}`);process.exit(1);}
console.log(`FOUNDATION_MCP_SCOPED_OK tests=${counts.tests} failures=0 errors=0 skipped=0 source=${before.fingerprint}`);
