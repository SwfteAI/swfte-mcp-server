import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root=process.cwd();
const backend='/Users/dejanmaksimovic/Projects/Swfte/websites/studio-web-app/.worktrees/parallel-foundation-agents';
const tracking=path.join(backend,'.unlazy/parallel/foundation-repairs');
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}).trim();
function source(){
  const names=[...new Set([...git(['ls-files']).split('\n'),...git(['ls-files','--others','--exclude-standard']).split('\n')])]
    .filter(p=>p&&!p.startsWith('.unlazy/')&&(/^(src\/|api\/|test\/|scripts\/|docs\/)/.test(p)||['package.json','package-lock.json','tsconfig.json','tsup.config.ts','README.md','LICENSE'].includes(p))).sort();
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
if(!['scoped','full','plan-full','source'].includes(mode))throw new Error('Use scoped, full, plan-full or source');
assert.equal(path.basename(root),'parallel-foundation-mcp','Allocated MCP required');
if(mode==='source'){
  console.log(JSON.stringify(source(),null,2));
  process.exit(0);
}
const planned=mode==='scoped'?['test/simulations.test.ts','test/tools.test.ts','test/wizard-terminal.test.ts','test/env-files.test.ts']
  :fs.readdirSync(path.join(root,'test')).filter(file=>/\.test\.(ts|mjs)$/.test(file)).sort().map(file=>`test/${file}`);
if(mode==='plan-full'){
  console.log(JSON.stringify({scope:'All original and current test entrypoints',testFiles:planned,count:planned.length,execution:0},null,2));
  process.exit(0);
}
const guardKey=crypto.createHash('sha256').update(root).digest('hex').slice(0,16);
const guard=JSON.parse(fs.readFileSync(`/Users/dejanmaksimovic/Projects/Swfte/.unlazy/heavy/wt-${guardKey}/owner.json`,'utf8'));
assert.equal(guard.pid,process.ppid,'Launch this check directly through heavy.mjs');
const holdPath=path.join(tracking,'dependency-maintenance-hold.json');
assert(!fs.existsSync(holdPath)||!JSON.parse(fs.readFileSync(holdPath,'utf8')).held,'Explicit maintenance release required');
assert.equal(process.env.NODE_OPTIONS,'--max-old-space-size=1536','Bounded Node memory required');
const scope=mode==='full'?'Full original MCP suite plus current foundation repairs':'Current original00 simulations/shared registry + Wizard terminal/neutral-file controls';
const before=source();
const startedAt=new Date().toISOString();
const dir=path.join(tracking,'evidence',`mcp-${startedAt.replaceAll(':','-')}`);
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'inputs.json'),JSON.stringify({startedAt,source:before,scope,planned,argv:['node','--import','tsx','--test','--test-concurrency=1','--test-reporter=tap',...planned]},null,2)+'\n');
const types=await run('npm',['run','typecheck'],path.join(dir,'types.log'));
const build=await run('npm',['run','build'],path.join(dir,'build.log'));
const tests=await run('node',['--import','tsx','--test','--test-concurrency=1','--test-reporter=tap',...planned],path.join(dir,'tests.log'));
const tap=fs.readFileSync(path.join(backend,tests.path),'utf8');
const n=name=>Number([...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`,'gm'))].at(-1)?.[1]??NaN);
const counts={tests:n('tests'),suites:n('suites'),pass:n('pass'),fail:n('fail'),cancelled:n('cancelled'),skipped:n('skipped'),todo:n('todo')};
const after=source();
const result={startedAt,finishedAt:new Date().toISOString(),source:before,afterSource:after,changedDuringRun:before.fingerprint!==after.fingerprint,
  scope,planned,fullInheritedSuite:mode==='full'?'ALL entrypoints executed; exact source/raw counts determine acceptance':'OPEN until full mode passes',
  logs:{types,build,tests},counts,accepted:types.exitCode===0&&build.exitCode===0&&tests.exitCode===0&&counts.tests>0&&counts.fail===0&&counts.cancelled===0&&counts.skipped===0&&counts.todo===0&&before.fingerprint===after.fingerprint};
fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2)+'\n');
fs.mkdirSync(path.join(tracking,'reports'),{recursive:true});
const receipt={exitCode:result.accepted?0:1,sourceSha:before.sha,sourceTree:before.tree,sourceFingerprint:before.fingerprint,files:before.files,tests:counts.tests,failures:counts.fail,errors:counts.cancelled,skipped:counts.skipped,reportHashes:Object.values(result.logs).map(log=>({path:log.path,sha256:log.sha256})),resultPath:path.relative(backend,path.join(dir,'result.json')),resultSha256:sha256(fs.readFileSync(path.join(dir,'result.json'))),scope:result.scope,fullInheritedSuite:result.fullInheritedSuite};
fs.writeFileSync(path.join(tracking,'reports',`mcp-${mode}-receipt.json`),JSON.stringify(receipt,null,2)+'\n');
if(!result.accepted){console.error(`FOUNDATION_MCP_${mode.toUpperCase()}_FAILED ${JSON.stringify(counts)}`);process.exit(1);}
console.log(`FOUNDATION_MCP_${mode.toUpperCase()}_OK tests=${counts.tests} failures=0 errors=0 skipped=0 source=${before.fingerprint}`);
