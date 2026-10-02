import {spawnSync,execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Invoke through the shared heavy guard. This runner neither installs dependencies nor contacts providers.
const directory='.unlazy/promotion-confidence-setup/evidence/current';
mkdirSync(directory,{recursive:true});
const fingerprint=()=>{
  const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8',maxBuffer:16*1024*1024})
    .trim().split('\n').filter(path=>path&&existsSync(path)&&/^(src\/|test\/|scripts\/|package(?:-lock)?\.json$|ts(?:config|up\.config)|README\.md$|docs\/(TOOLS|ATTACH)\.md$)/.test(path)).sort();
  const hashes=Object.fromEntries(paths.map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));
  return {hashes,hash:createHash('sha256').update(JSON.stringify(hashes)).digest('hex')};
};
const before=fingerprint();const checks=[];let tap='';
for(const [name,args] of [['typecheck',['run','typecheck']],['all-offline-tests',['test']]]){
  const result=spawnSync('npm',args,{encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,NODE_OPTIONS:'--max-old-space-size=1024'}});
  const output=(result.stdout??'')+(result.stderr??'');
  writeFileSync(`${directory}/${name}.log`,output);
  checks.push({name,exitCode:result.status,signal:result.signal});
  console.log(`${name}: exit=${result.status}`);console.log(output.slice(-3500));
  if(name==='all-offline-tests')tap=output;
  if(result.status!==0)break;
}
const count=name=>{const match=tap.match(new RegExp(`^# ${name} (\\d+)\\s*$`,'m'));return match?Number(match[1]):null;};
const tests={tests:count('tests'),suites:count('suites'),pass:count('pass'),fail:count('fail'),cancelled:count('cancelled'),skipped:count('skipped'),todo:count('todo')};
const requiredControls=[
  'exec sends actual bounded argv once', 'raw and JSON body ambiguity refuses before HTTP',
  'swfte_runtime_file_write sends exact UTF-8 bytes', 'swfte_runtime_upload sends exact UTF-8 bytes',
  'uncertain mutation never retries actual HTTP503', 'actual bounded SSE attaches only by command ID',
  'foreign SSE command cannot be attached', 'chunked oversized response aborts',
  'response exactly at byte limit remains', 'canonical findings alias reads the actual evidence query route',
  'resolver actual journal resumes authenticated contiguous canonical records',
  'resolver journal rejects foreign run from actual HTTP',
  'resolver journal rejects sequence gap from actual HTTP',
  'resolver journal rejects truncated final frame from actual HTTP',
  'resolver journal rejects a chunked response over its actual byte cap',
  'resolver invalid resume cursors refuse before HTTP dispatch',
];
const missingControls=requiredControls.filter(label=>!tap.includes(label));
const after=fingerprint();
const passed=checks.length===2&&checks.every(check=>check.exitCode===0)&&before.hash===after.hash
  &&tests.tests>=855&&tests.pass===tests.tests&&tests.fail===0&&tests.cancelled===0&&tests.skipped===0&&tests.todo===0&&missingControls.length===0;
writeFileSync(`${directory}/result.json`,JSON.stringify({at:new Date().toISOString(),sourceBefore:before,sourceAfter:after,checks,tests,missingControls,passed,
  acceptance:'MCP client/local HTTP controls only; actual backend/provider/runtime and visual acceptance remain separate'},null,2)+'\n');
if(!passed)process.exit(1);
console.log('MCP_RUNTIME_CHECK_PASSED');
