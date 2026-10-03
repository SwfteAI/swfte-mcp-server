import {spawnSync,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const directory='.unlazy/promotion-confidence-setup/evidence/current';mkdirSync(directory,{recursive:true});
const fingerprint=()=>{const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'}).trim().split('\n').filter(path=>path&&/^(src\/|test\/|scripts\/mcp-runtime-check)/.test(path)).sort();const hashes=Object.fromEntries(paths.map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));return{hashes,hash:createHash('sha256').update(JSON.stringify(hashes)).digest('hex')}};
const before=fingerprint(),checks=[];
for(const [name,args]of[['typecheck',['run','typecheck']],['all-offline-tests',['test']]]){const result=spawnSync('npm',args,{encoding:'utf8',maxBuffer:64*1024*1024,env:{...process.env,NODE_OPTIONS:'--max-old-space-size=1024'}});const output=(result.stdout??'')+(result.stderr??'');writeFileSync(`${directory}/${name}.log`,output);checks.push({name,exitCode:result.status,signal:result.signal});console.log(`${name}: ${result.status}`);console.log(output.slice(-4500));if(result.status!==0)break;}
const after=fingerprint(),passed=checks.length===2&&checks.every(check=>check.exitCode===0)&&before.hash===after.hash;
writeFileSync(`${directory}/result.json`,JSON.stringify({at:new Date().toISOString(),sourceBefore:before,sourceAfter:after,checks,passed,backendRuntime:'NOT_ESTABLISHED',fidelity:'NOT_EXECUTED'},null,2)+'\n');if(!passed)process.exit(1);
