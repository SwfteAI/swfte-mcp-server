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
  'durable confidence actual Java negative four digit Instant preserves complete result',
  'durable confidence Java nonblank Unicode preserves NBSP figure and narrow spaces',
  'durable confidence unpriced model prices and duplicate roles refuse',
  'durable confidence exact finding fingerprint and failure evidence remain domain bound',
  'durable confidence pooled intervals deduplicate actual typed claims despite additive fields',
  'durable confidence normalized Instant boundary refuses offset and midnight overflow',
  'durable confidence exact Instant fractions offsets and calendar preserve Java time semantics',
  'durable confidence legacy statistical confidence and null point preserve v1 compatibility',
  'durable confidence forged summary timestamps and Wilson bounds refuse',
  'durable confidence actual UNKNOWN measured Wilson interval survives without verdict confidence',
  'durable confidence stale flag exactly matches UNKNOWN STALE reason',
  'durable confidence wrong server canonical digest refuses exact readback',
  'durable confidence every required result field and malformed claim finding coverage summary refuse',
  'durable confidence malformed HTTP JSON never retries mutation or creates fallback',
  'durable confidence Java opaque identifier parity refuses before HTTP',
  'durable confidence submit binds actual identity and exact single admission request',
  'durable confidence readback never calls create or start',
  'uncertain durable confidence503 never retries replaces UUID or falls back',
  'durable confidence invalid UUID missing hash and caller identity refuse before HTTP',
  'foreign durable confidence workspace actor command hash and run refuse',
  'malformed durable confidence receipt and unavailable verified identity refuse',
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
  'managed READ uses the existing approval capability and exact task revision',
  'managed READ resolves through the actual approved action handle',
  'managed READ cannot resolve using owner credentials',
  'foreign and duplicate current task rows refuse',
  'duplicate task keys never pick the first',
  'zero and unsafe setup revisions refuse',
  'uncertain managed READ approval is not automatically retried',
];
const missingControls=requiredControls.filter(label=>!tap.includes(label));
const after=fingerprint();
const passed=checks.length===2&&checks.every(check=>check.exitCode===0)&&before.hash===after.hash
  &&tests.tests>=883&&tests.pass===tests.tests&&tests.fail===0&&tests.cancelled===0&&tests.skipped===0&&tests.todo===0&&missingControls.length===0;
writeFileSync(`${directory}/result.json`,JSON.stringify({at:new Date().toISOString(),sourceBefore:before,sourceAfter:after,checks,tests,missingControls,passed,
  acceptance:'MCP client/local HTTP controls only; actual backend/provider/runtime and visual acceptance remain separate'},null,2)+'\n');
if(!passed)process.exit(1);
console.log('MCP_RUNTIME_CHECK_PASSED');
