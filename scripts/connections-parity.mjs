#!/usr/bin/env node
/**
 * Original05 WR-G23: real fixture backend -> registered, built MCP stdio tools.
 * Run ONLY through the unchanged heavy guard after the driver releases its hold.
 * Required explicit configuration (never inherited SWFTE_PAT/customer settings):
 *   SWFTE_CONNECTIONS_FIXTURE_BASE_URL      loopback fixture agents-service URL
 *   SWFTE_CONNECTIONS_FIXTURE_PAT           dedicated fixture PAT
 *   SWFTE_CONNECTIONS_FIXTURE_WORKSPACE_ID  actual fixture workspace
 *   SWFTE_CONNECTIONS_FIXTURE_WORKFLOWS     JSON array of three actual workflow ids
 *   SWFTE_CONNECTIONS_FIXTURE_ALIAS_NODE_ID node in one workflow whose saved
 *     oauthProvider or server catalog oauthProvider is exactly google-youtube
 * Missing/unavailable fixtures refuse. This runner never creates a stand-in server.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HEAVY = '/Users/dejanmaksimovic/Projects/Swfte/.unlazy/tools/heavy.mjs';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const EVIDENCE = join(ROOT, '.unlazy/connections-mcp/parity-evidence', RUN_ID);
const receipt = { kind: 'WR-G23', state: 'REFUSED', startedAt: new Date().toISOString(),
  transport: 'registered-built-mcp-stdio', fixture: 'explicit-loopback-only', cases: [] };
let phase = 'guard';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function requireCondition(condition, code) { if (!condition) throw new Error(code); }
function cleanId(value) {
  requireCondition(typeof value === 'string' && value.trim() === value && value.length > 0
    && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value), 'FIXTURE_ID_INVALID');
  return value;
}
function requireHeavy() {
  const parent = execFileSync('ps', ['-p', String(process.ppid), '-o', 'args='], { encoding: 'utf8' });
  requireCondition(parent.includes(HEAVY) && !parent.includes('--min-free-gb'), 'HEAVY_GUARD_REQUIRED');
}
async function tree(directory, prefix = '') {
  const output = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) output.push(...await tree(join(directory, entry.name), path));
    else if (entry.isFile()) output.push({ path, sha256: sha(await readFile(join(directory, entry.name))) });
    else requireCondition(false, 'SOURCE_SYMLINK_REFUSED');
  }
  return output;
}
async function sourceFingerprint() {
  const sources = (await tree(join(ROOT, 'src'))).map(row => ({ ...row, path: 'src/' + row.path }));
  for (const path of ['package.json', 'package-lock.json', 'tsup.config.ts', 'scripts/connections-parity.mjs'])
    sources.push({ path, sha256: sha(await readFile(join(ROOT, path))) });
  sources.sort((a, b) => a.path.localeCompare(b.path));
  return { aggregateSha256: sha(JSON.stringify(sources)), files: sources };
}
function safeEnvironment(config, credential = config.pat) {
  return { PATH: process.env.PATH ?? '', SWFTE_PAT: credential, SWFTE_API_KEY: '',
    SWFTE_BASE_URL: config.baseUrl, SWFTE_WORKSPACE_ID: config.workspaceId,
    SWFTE_MCP_SERVER_CONNECTIONS: 'true', SWFTE_DEBUG: 'false', SWFTE_TELEMETRY: 'false',
    SWFTE_ALLOW_DEPLOY: 'false', SWFTE_TOOLS: 'core,connect', SWFTE_DEFAULT_WAIT_MS: '10000' };
}
async function build(config) {
  const child = spawn('npm', ['run', 'build'], { cwd: ROOT, env: safeEnvironment(config), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const digest = createHash('sha256');
  let bytes = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { bytes += chunk.length; digest.update(chunk); });
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 120_000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? -1 : code));
  }).finally(() => clearTimeout(timer));
  receipt.build = { exitCode: code, outputBytes: bytes, outputSha256: digest.digest('hex') };
  requireCondition(code === 0, 'CURRENT_BUILD_FAILED');
}
async function request(config, path, body, credential = config.pat, expected = [200]) {
  const response = await fetch(config.baseUrl + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + credential, Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error', signal: AbortSignal.timeout(15_000) });
  requireCondition(expected.includes(response.status), 'FIXTURE_HTTP_REFUSED');
  if (response.status !== 200) { await response.body?.cancel(); return { status: response.status }; }
  requireCondition(response.headers.get('content-type')?.toLowerCase().includes('application/json'), 'FIXTURE_JSON_REQUIRED');
  const data = await response.json();
  return { status: response.status, data };
}
async function session(config, credential = config.pat) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'dist/index.js')],
    cwd: ROOT, env: safeEnvironment(config, credential), stderr: 'pipe' });
  const client = new Client({ name: 'connections-parity', version: '1.0.0' });
  // Startup/error streams are hashed only. Raw response/credential content is never logged or cached.
  const stderr = createHash('sha256');
  let stderrBytes = 0;
  const onStderr = chunk => { stderr.update(chunk); stderrBytes += chunk.length; };
  transport.stderr?.on('data', onStderr);
  try { await within(() => client.connect(transport), 15_000); }
  catch { await client.close().catch(() => {}); throw new Error('MCP_HANDSHAKE_REFUSED'); }
  return { client, close: async () => {
    await client.close();
    receipt.stdio ??= [];
    receipt.stdio.push({ stderrBytes, stderrSha256: stderr.digest('hex') });
  } };
}
async function within(action, timeoutMs = 15_000) {
  let timer;
  return Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('FIXTURE_DEADLINE')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}
function body(reply) {
  const first = reply.content?.[0];
  requireCondition(first?.type === 'text' && typeof first.text === 'string', 'MCP_JSON_REQUIRED');
  const output = JSON.parse(first.text);
  forbidCredentialKeys(output);
  return output;
}
function forbidCredentialKeys(value, depth = 0) {
  requireCondition(depth <= 32, 'WIRE_DEPTH_REFUSED');
  if (!value || typeof value !== 'object') return;
  const forbidden = new Set(['accesstoken', 'refreshtoken', 'secret', 'value', 'password', 'apikey',
    'clientsecret', 'secretaccesskey', 'accesskeyid', 'sessiontoken', 'token', 'credentials', 'privatekey']);
  for (const [key, child] of Object.entries(value)) {
    requireCondition(!forbidden.has(key.toLowerCase().replace(/[_-]/g, '')), 'CREDENTIAL_WIRE_REFUSED');
    forbidCredentialKeys(child, depth + 1);
  }
}
function nodes(workflow) {
  requireCondition(workflow?.nodes && typeof workflow.nodes === 'object', 'FIXTURE_GRAPH_REQUIRED');
  return Array.isArray(workflow.nodes) ? workflow.nodes : Object.values(workflow.nodes);
}
function catalogEntries(catalog) {
  const rows = Array.isArray(catalog) ? catalog : catalog?.nodes ?? catalog?.catalog ?? catalog?.content ?? catalog?.entries;
  requireCondition(Array.isArray(rows), 'FIXTURE_CATALOG_REQUIRED');
  return rows;
}
async function main() {
  requireHeavy();
  phase = 'configuration';
  const config = { baseUrl: process.env.SWFTE_CONNECTIONS_FIXTURE_BASE_URL?.trim(),
    pat: process.env.SWFTE_CONNECTIONS_FIXTURE_PAT?.trim(),
    workspaceId: cleanId(process.env.SWFTE_CONNECTIONS_FIXTURE_WORKSPACE_ID),
    workflowIds: JSON.parse(process.env.SWFTE_CONNECTIONS_FIXTURE_WORKFLOWS ?? 'null'),
    aliasNodeId: cleanId(process.env.SWFTE_CONNECTIONS_FIXTURE_ALIAS_NODE_ID) };
  const base = new URL(config.baseUrl);
  requireCondition(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
    && ['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash,
    'LOOPBACK_FIXTURE_REQUIRED');
  config.baseUrl = base.href.replace(/\/$/, '');
  requireCondition(typeof config.pat === 'string' && config.pat.startsWith('pat_') && !/\s/.test(config.pat), 'FIXTURE_PAT_REQUIRED');
  requireCondition(Array.isArray(config.workflowIds) && config.workflowIds.length === 3, 'THREE_ACTUAL_WORKFLOWS_REQUIRED');
  config.workflowIds = config.workflowIds.map(cleanId);
  requireCondition(new Set(config.workflowIds).size === 3, 'THREE_DISTINCT_WORKFLOWS_REQUIRED');
  receipt.sourceBefore = await sourceFingerprint();
  receipt.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  phase = 'fixture-availability';
  const inventory = (await request(config, '/v2/connections')).data;
  requireCondition(Array.isArray(inventory), 'NATIVE_INVENTORY_REQUIRED');
  forbidCredentialKeys(inventory);
  const workflows = [];
  for (const id of config.workflowIds) {
    const workflow = (await request(config, '/v2/workflows/' + encodeURIComponent(id))).data;
    requireCondition(workflow?.id === id && workflow?.workspaceId === config.workspaceId, 'ACTUAL_WORKSPACE_IDENTITY_REQUIRED');
    workflows.push(workflow);
  }
  const aliasWorkflow = workflows.find(workflow => nodes(workflow).some(node => node?.id === config.aliasNodeId));
  requireCondition(aliasWorkflow !== undefined, 'ACTUAL_ALIAS_NODE_REQUIRED');
  const aliasNode = nodes(aliasWorkflow).find(node => node?.id === config.aliasNodeId);
  const catalog = catalogEntries((await request(config, '/v2/workflows/nodes/catalog')).data);
  const nodeType = aliasNode?.type;
  const alias = aliasNode?.oauthProvider ?? aliasNode?.configuration?.oauthProvider
    ?? catalog.find(entry => entry?.type === nodeType || entry?.code === nodeType)?.oauthProvider;
  requireCondition(alias === 'google-youtube', 'ACTUAL_GOOGLE_YOUTUBE_ALIAS_REQUIRED');
  phase = 'current-build';
  await build(config);
  receipt.dist = { aggregateSha256: sha(JSON.stringify(await tree(join(ROOT, 'dist')))) };
  phase = 'registered-parity';
  const mcp = await session(config);
  try {
    const listing = await within(() => mcp.client.listTools());
    requireCondition(listing.tools?.some(tool => tool.name === 'swfte_connections_check')
      && listing.tools?.some(tool => tool.name === 'swfte_connections_list'), 'REGISTERED_TOOLS_REQUIRED');
    const listReply = await within(() => mcp.client.callTool({ name: 'swfte_connections_list', arguments: {} }));
    const listed = body(listReply);
    requireCondition(!listReply.isError && listed.source === 'server'
      && isDeepStrictEqual(listed.connections, inventory), 'NATIVE_INVENTORY_PARITY_REQUIRED');
    for (const workflowId of config.workflowIds) {
      const actual = (await request(config, '/v2/connections/auto-bind', { workflowId })).data;
      forbidCredentialKeys(actual);
      requireCondition(actual && Array.isArray(actual.bindings), 'NATIVE_BINDINGS_REQUIRED');
      const needs = actual.bindings.map(({ nodeId, field, provider }) => ({ nodeId, field, provider }));
      const reply = await within(() => mcp.client.callTool({ name: 'swfte_connections_check', arguments: { workflowId } }));
      const projected = body(reply);
      requireCondition(!reply.isError && projected.source === 'server' && Array.isArray(projected.bindings)
        && isDeepStrictEqual(projected.needs, needs) && isDeepStrictEqual(projected.bindings, actual.bindings)
        && projected.ok === actual.bindings.every(row => row.outcome === 'AUTO_BOUND'), 'ACTUAL_BINDING_PARITY_REQUIRED');
      if (workflowId === aliasWorkflow.id)
        requireCondition(needs.some(row => row.nodeId === config.aliasNodeId && row.provider === 'google'), 'CANONICAL_ALIAS_PARITY_REQUIRED');
      receipt.cases.push({ name: 'workflow-parity', workflowId, needsCount: needs.length,
        nativeSha256: sha(JSON.stringify(actual.bindings)), mcpSha256: sha(JSON.stringify(projected.bindings)), passed: true });
    }
    phase = 'real-missing-workflow-refusal';
    const missingId = 'connections-parity-missing-' + randomUUID();
    const missing = await request(config, '/v2/connections/auto-bind', { workflowId: missingId }, config.pat, [404]);
    const reply = await within(() => mcp.client.callTool({ name: 'swfte_connections_check', arguments: { workflowId: missingId } }));
    const refusal = body(reply);
    requireCondition(reply.isError === true && refusal.status === missing.status && !('needs' in refusal)
      && !('bindings' in refusal) && !('ok' in refusal), 'AUTO_BIND_404_MUST_NOT_FALL_BACK');
    receipt.cases.push({ name: 'working-inventory-missing-workflow-refusal', status: 404, passed: true });
  } finally { await mcp.close(); }
  phase = 'real-auth-refusal';
  const invalidPat = 'pat_connections_parity_refused_' + randomUUID().replace(/-/g, '');
  const auth = await request(config, '/v2/connections', undefined, invalidPat, [401, 403]);
  const denied = await session(config, invalidPat);
  try {
    const reply = await within(() => denied.client.callTool({ name: 'swfte_connections_check', arguments: { workflowId: config.workflowIds[0] } }));
    const refusal = body(reply);
    requireCondition(reply.isError === true && [401, 403].includes(refusal.status) && !('needs' in refusal)
      && !('bindings' in refusal) && !('ok' in refusal), 'AUTH_MUST_NOT_FALL_BACK');
    receipt.cases.push({ name: 'actual-auth-refusal', directStatus: auth.status, mcpStatus: refusal.status, passed: true });
  } finally { await denied.close(); }
  phase = 'source-restability';
  receipt.sourceAfter = await sourceFingerprint();
  requireCondition(isDeepStrictEqual(receipt.sourceAfter, receipt.sourceBefore), 'SOURCE_CHANGED_DURING_PARITY');
  receipt.state = 'PASS';
  receipt.completedAt = new Date().toISOString();
  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(join(EVIDENCE, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log('WR_MCP_PARITY_OK workflows=3 diffs=0');
}

main().catch(async () => {
  receipt.state = 'REFUSED';
  receipt.phase = phase;
  receipt.completedAt = new Date().toISOString();
  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(join(EVIDENCE, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  // Do not print exception text, backend envelopes, credentials or full MCP responses.
  console.error('WR_MCP_PARITY_REFUSED phase=' + phase + ' evidence=' + EVIDENCE);
  process.exitCode = 1;
});
