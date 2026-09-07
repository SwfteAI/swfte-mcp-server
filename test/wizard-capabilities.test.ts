import { test } from 'node:test';
import { zodToJsonSchema } from 'zod-to-json-schema';
import assert from 'node:assert/strict';
import { appWizardTools } from '../src/tools/app-wizard.js';
import { customNodeWizardTools, customNodeTerminal } from '../src/tools/custom-node-wizard.js';
import { allTools } from '../src/tools/index.js';
import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';

function fixture(allowDeploy = true, result: any = { buildStatus: 'BUILDING' }) {
  const requests: any[] = [];
  const config = { ...loadConfig({ SWFTE_PAT: 'pat_test' } as never), allowDeploy };
  const client = new SwfteClient(config);
  client.request = async (request: any) => { requests.push(request); return result; };
  return { requests, client, config };
}
async function invoke(name: string, input: any, ctx: ReturnType<typeof fixture>) {
  const tool = allTools.find(t => t.name === name)!;
  assert.ok(tool, name);
  return tool.execute(tool.inputSchema.parse(input), ctx);
}
const cases: [string, string, string, any][] = [
  ['create','POST','/create',{name:'demo',prompt:'Build a demo page',confirm:true}],
  ['prompt','POST','/s%20one/prompt',{prompt:'Revise the page'}],
  ...['status','plan','preview','files','complete','abort','snapshot'].map(x => [x, ['complete','abort','snapshot'].includes(x) ? 'POST':'GET', `/s%20one/${x}`, {}] as [string,string,string,any]),
  ['file','GET','/s%20one/file/src/App.tsx',{path:'src/App.tsx'}],
  ['restore','POST','/s%20one/restore',{s3Key:'app-wizard-snapshots/s one/snapshot.tar.gz'}],
  ['destroy','DELETE','/s%20one',{}],
  ['artifacts','GET','/artifacts',{}],
  ['artifact_get','GET','/artifacts/a%20one',{}],
  ['artifact_download','GET','/artifacts/a%20one/download',{}],
  ['artifact_delete','DELETE','/artifacts/a%20one',{}],
  ['artifact_fork','POST','/artifacts/a%20one/fork',{}],
  ['deploy','POST','/s%20one/deploy',{appName:'test-app',confirm:true,envVars:{TEST:'yes'}}],
  ['deployments','GET','/deployments',{}],
  ['deployment_get','GET','/deployments/d%20one',{}],
  ['deployment_logs','GET','/deployments/d%20one/logs',{}],
  ['deployment_redeploy','POST','/deployments/d%20one/redeploy',{confirm:true}],
  ['deployment_stop','POST','/deployments/d%20one/stop',{}],
  ['deployment_destroy','DELETE','/deployments/d%20one',{}],
];
for (const [name, method, path, extra] of cases) test(`AppWizard ${name} follows controller route and retry contract`, async () => {
  const ctx = fixture();
  const result = await invoke(`swfte_app_wizard_${name}`, {sessionId:'s one',artifactId:'a one',deploymentId:'d one', ...extra}, ctx);
  assert.deepEqual(result, {buildStatus:'BUILDING'}); // Preserve backend status, never fabricate done.
  assert.equal(ctx.requests.length,1);
  assert.equal(ctx.requests[0].path, `/v2/app/wizard${path}`);
  assert.equal(ctx.requests[0].method, method);
  assert.equal(ctx.requests[0].retries, method === 'GET' ? 1 : 0);
  assert.equal(ctx.requests[0].body?.confirm, undefined);
  if (name === 'prompt') assert.deepEqual(ctx.requests[0].body, {prompt:extra.prompt});
  if (name === 'deploy') assert.deepEqual(ctx.requests[0].body,{appName:'test-app',envVars:{TEST:'yes'}});
});
test('capacity creation gates cannot make a request without both permissions', async () => {
  for (const [name, extra] of [['create',{name:'demo',prompt:'Build a demo page'}],['deploy',{appName:'test-app'}],['deployment_redeploy',{}]] as const) {
    for (const [allowDeploy,confirm,reason] of [[true,false,'CONFIRMATION_REQUIRED'],[false,true,'DEPLOY_DISABLED']] as const) {
      const ctx = fixture(allowDeploy);
      const result: any = await invoke(`swfte_app_wizard_${name}`,{sessionId:'s',deploymentId:'d',...extra,confirm},ctx);
      assert.equal(result.reason,reason); assert.equal(ctx.requests.length,0);
    }
  }
});
test('capacity cleanup stays available with provisioning disabled', async () => {
  for (const name of ['destroy','deployment_stop','deployment_destroy']) {
    const ctx=fixture(false); await invoke(`swfte_app_wizard_${name}`,{sessionId:'s',deploymentId:'d'},ctx); assert.equal(ctx.requests.length,1);
  }
});
test('reject empty session IDs, traversal paths and unknown build modes', () => {
  const tool = (suffix: string) => appWizardTools.find(t => t.name === `swfte_app_wizard_${suffix}`)!;
  assert.throws(() => tool('status').inputSchema.parse({sessionId:''}));
  for (const path of ['../secret','/etc/passwd','src/../../secret','src\\secret']) assert.throws(() => tool('file').inputSchema.parse({sessionId:'s',path}));
  assert.throws(() => tool('create').inputSchema.parse({name:'demo',prompt:'Build a demo page',mode:'UNKNOWN'}));
});
test('custom-node generation GET is a mutation with retries disabled, exact query and terminal payload', async () => {
  const terminal={status:'completed',generatedNode:{name:'n'},createdNode:{id:'n1'}};
  const ctx=fixture(false,`data: {"status":"heartbeat"}\r\n\r\ndata: ${JSON.stringify(terminal)}\r\n\r\n`);
  const result=await invoke('swfte_custom_nodes_generate',{workspaceId:'w one',mode:'PROMPT',input:'Build a node',autoCreate:true},ctx);
  assert.deepEqual(result,terminal); assert.equal(ctx.requests.length,1);
  assert.equal(ctx.requests[0].path,'/v2/workspaces/w%20one/custom-nodes/wizard/generate/stream');
  assert.equal(ctx.requests[0].retries,0); assert.equal(ctx.requests[0].headers.Accept,'text/event-stream');
  assert.deepEqual(ctx.requests[0].query,{mode:'PROMPT',input:'Build a node',autoCreate:true,model:undefined});
  assert.notEqual(customNodeWizardTools.find(t=>t.name==='swfte_custom_nodes_generate')!.readOnly,true);
});
test('custom-node stream fails closed on truncation, malformed data, missing persisted ID and [DONE]', () => {
  for(const raw of ['', 'data: {"status":"progress"}\n\n','data: [DONE]\n\n','data: invalid\n\n','data: {"status":"completed","generatedNode":{}}\n\n']) {
    assert.throws(()=>customNodeTerminal(raw,true));
  }
  assert.deepEqual(customNodeTerminal('data: {"status":"error","error":"billing unavailable"}\n\n',false),{status:'error',error:'billing unavailable'});
  assert.deepEqual(customNodeTerminal('data: {"status":"completed","generatedNode":{}}\n\ndata: invalid\n\n',false),{status:'completed',generatedNode:{}});
});
test('node reconciliation and cleanup use workspace-scoped routes', async () => {
  for(const [action,method,path] of [['list','GET',''],['get','GET','/n%20one'],['delete','DELETE','/n%20one']]) {
    const ctx=fixture(); await invoke(`swfte_custom_nodes_${action}`,{workspaceId:'w one',nodeId:'n one'},ctx);
    assert.equal(ctx.requests[0].path,`/v2/workspaces/w%20one/custom-nodes${path}`);
    assert.equal(ctx.requests[0].method,method); assert.equal(ctx.requests[0].retries,method==='GET'?1:0);
  }
});
test('application blueprint tool remains distinct from hosted AppWizard capabilities', () => {
  assert.ok(allTools.find(t=>t.name==='swfte_build')!.inputSchema.safeParse({kind:'application',prompt:'Build a demo page'}).success);
  assert.equal(new Set(allTools.map(t=>t.name)).size,allTools.length);
});

test('custom-node schemas inline identifiers for MCP clients', () => {
  for (const tool of customNodeWizardTools) {
    const schema = zodToJsonSchema(tool.inputSchema);
    assert.equal(JSON.stringify(schema).includes('"$ref"'), false, tool.name);
  }
});
