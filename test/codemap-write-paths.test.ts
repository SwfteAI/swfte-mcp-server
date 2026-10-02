import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { scaffoldTools } from '../src/tools/scaffold.js';
import { codeTools } from '../src/tools/code.js';
import { ConfinedWriter } from '../src/fsguard.js';
import { recordMcpWrittenFiles, provenanceForSites } from '../src/codemap/provenance.js';
import { newCallContext, runInCall } from '../src/tracing.js';
import { assigned, project } from './codemap-support.js';

const receiptPath = '.swfte/codemap/provenance.json';
const html = '<iframe src="https://widgets.swfte.com/wd_owned"></iframe>\n';
const source = "import { Swfte } from '@swfte/sdk';\nconst client = new Swfte();\nclient.workflows.invoke('wf_a', {});\n";
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const trace = (tool: string) => newCallContext({ sessionId: 'fixture-session', client: 'codex', tool, args: {} });

test('actual MCP embed writes a local file-bound receipt and later edits invalidate it', async () => {
  const root = project({ 'package.json': '{"name":"local-fixture"}' });
  const old = process.cwd(); process.chdir(root);
  const seen: string[] = [];
  const client = { request: async ({ path }: { path: string }) => {
    seen.push(path); assert.equal(path, '/v2/catalog/widget/wd_owned/contract');
    return { catalogRef: 'widget:wd_owned', embed: { html } };
  } };
  try {
    const tool = scaffoldTools.find(t => t.name === 'swfte_embed_widget')!;
    await runInCall(trace(tool.name), () => tool.execute({ catalogRef: 'widget:wd_owned', targetFile: 'public/embed.html' },
      { client, config: { credential: 'fixture-local-credential' }, localFilesystem: true } as never));
    const rows = JSON.parse(readFileSync(join(root, receiptPath), 'utf8'));
    assert.equal(rows.length, 1); assert.equal(rows[0].path, 'public/embed.html');
    const committed = readFileSync(join(root, 'public/embed.html'), 'utf8');
    assert.match(committed, /Swfte embed:/); assert.notEqual(committed, html);
    assert.equal(rows[0].hash, hash(committed)); assert.equal(rows[0].provenance.addedBy, 'codex');
    assert.equal(rows[0].provenance.via, 'mcp'); assert.equal(seen.length, 1);
    assert.equal(provenanceForSites(root, [assigned('public/embed.html')]).size, 1);
    writeFileSync(join(root, 'public/embed.html'), html + '<!-- later local edit -->');
    assert.equal(provenanceForSites(root, [assigned('public/embed.html')]).size, 0);
  } finally { process.chdir(old); rmSync(root, { recursive: true, force: true }); }
});

test('inline and no-target embed results never create local receipts', async () => {
  const root = project({ 'package.json': '{"name":"local-fixture"}' });
  const old = process.cwd(); process.chdir(root);
  try {
    const tool = scaffoldTools.find(t => t.name === 'swfte_embed_widget')!;
    const client = { request: async () => ({ catalogRef: 'widget:wd_owned', embed: { html } }) };
    await runInCall(trace(tool.name), () => tool.execute({ catalogRef: 'widget:wd_owned', targetFile: 'inline.html' },
      { client, config: { credential: 'fixture-local-credential' }, localFilesystem: false } as never));
    await runInCall(trace(tool.name), () => tool.execute({ catalogRef: 'widget:wd_owned' },
      { client, config: { credential: 'fixture-local-credential' }, localFilesystem: true } as never));
    assert.equal(existsSync(join(root, 'inline.html')), false);
    assert.equal(existsSync(join(root, receiptPath)), false);
  } finally { process.chdir(old); rmSync(root, { recursive: true, force: true }); }
});

test('unchanged writer plans and unread remote inline plans do not create receipts', async () => {
  const root = project({ 'same.ts': source });
  try {
    const writer = new ConfinedWriter({ root });
    writer.create(writer.resolve('same.ts'), source);
    await runInCall(trace('swfte_scaffold_client'), async () => recordMcpWrittenFiles(writer, writer.commit()));
    assert.equal(existsSync(join(root, receiptPath)), false);
    recordMcpWrittenFiles({ root: '/not-a-local-project', inline: true }, [{ path: 'new.ts', action: 'create', bytes: 1 }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual source export records only committed scannable files under the project', async () => {
  const root = project({ 'package.json': '{"name":"local-fixture"}' });
  const old = process.cwd(); process.chdir(root);
  const archive = zipSync({ 'client.ts': strToU8(source), 'README.md': strToU8('Fixture documentation') });
  let reads = 0;
  try {
    const tool = codeTools.find(t => t.name === 'swfte_export_src')!;
    const client = { getBinary: async (path: string) => {
      reads++; assert.equal(path, '/v2/workflows/execution/wf_a/download-src');
      return { bytes: archive, headers: {} };
    } };
    await runInCall(trace(tool.name), () => tool.execute({ workflowId: 'wf_a', destDir: 'exported' }, { client, localFilesystem: true } as never));
    const rows = JSON.parse(readFileSync(join(root, receiptPath), 'utf8'));
    assert.equal(rows.length, 1); assert.equal(rows[0].path, 'exported/client.ts');
    assert.equal(rows[0].hash, hash(readFileSync(join(root, 'exported/client.ts'), 'utf8')));
    assert.equal(rows[0].provenance.addedBy, 'codex'); assert.equal(reads, 1);
    assert.equal(provenanceForSites(root, [assigned('exported/client.ts')]).size, 1);
    // A later identical export must preserve its receipt timestamp, not claim a new edit.
    const before = readFileSync(join(root, receiptPath), 'utf8');
    await runInCall(trace(tool.name), () => tool.execute({ workflowId: 'wf_a', destDir: 'exported' }, { client, localFilesystem: true } as never));
    assert.equal(readFileSync(join(root, receiptPath), 'utf8'), before);
  } finally { process.chdir(old); rmSync(root, { recursive: true, force: true }); }
});

test('a refused embed overwrite leaves the file and receipts unchanged', async () => {
  const root = project({ 'existing.html': '<p>owned local content</p>' });
  const old = process.cwd(); process.chdir(root);
  try {
    const tool = scaffoldTools.find(t => t.name === 'swfte_embed_widget')!;
    const client = { request: async () => ({ catalogRef: 'widget:wd_owned', embed: { html } }) };
    await assert.rejects(runInCall(trace(tool.name), () => tool.execute({ catalogRef: 'widget:wd_owned', targetFile: 'existing.html' },
      { client, config: { credential: 'fixture-local-credential' }, localFilesystem: true } as never)), /overwrite/i);
    assert.equal(readFileSync(join(root, 'existing.html'), 'utf8'), '<p>owned local content</p>');
    assert.equal(existsSync(join(root, receiptPath)), false);
  } finally { process.chdir(old); rmSync(root, { recursive: true, force: true }); }
});

test('source export refuses a hardlinked destination before changing external bytes or claiming a receipt', async () => {
  const root = project({ 'package.json': '{"name":"local-fixture"}' });
  const outside = project({ 'external.ts': 'external fixture bytes' });
  const old = process.cwd(); process.chdir(root);
  try {
    mkdirSync(join(root, 'exported'));
    linkSync(join(outside, 'external.ts'), join(root, 'exported/client.ts'));
    const tool = codeTools.find(t => t.name === 'swfte_export_src')!;
    const client = { getBinary: async () => ({ bytes: zipSync({ 'client.ts': strToU8(source) }), headers: {} }) };
    await assert.rejects(runInCall(trace(tool.name), () => tool.execute({ workflowId: 'wf_a', destDir: 'exported' },
      { client, localFilesystem: true } as never)), /hardlink|linked|regular/i);
    assert.equal(readFileSync(join(outside, 'external.ts'), 'utf8'), 'external fixture bytes');
    assert.equal(existsSync(join(root, receiptPath)), false);
  } finally { process.chdir(old); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('source export refuses a hardlinked ownership marker before any source write', async () => {
  const root = project({ 'package.json': '{"name":"local-fixture"}' });
  const outside = project({ 'marker.json': '{"writtenBy":"swfte_export_src","keep":"external"}' });
  const old = process.cwd(); process.chdir(root);
  try {
    mkdirSync(join(root, 'exported'));
    linkSync(join(outside, 'marker.json'), join(root, 'exported/.swfte-export.json'));
    const before = readFileSync(join(outside, 'marker.json'), 'utf8');
    const tool = codeTools.find(t => t.name === 'swfte_export_src')!;
    const client = { getBinary: async () => ({ bytes: zipSync({ 'client.ts': strToU8(source) }), headers: {} }) };
    await assert.rejects(runInCall(trace(tool.name), () => tool.execute({ workflowId: 'wf_a', destDir: 'exported' },
      { client, localFilesystem: true } as never)), /hardlink|linked|regular/i);
    assert.equal(readFileSync(join(outside, 'marker.json'), 'utf8'), before);
    assert.equal(existsSync(join(root, 'exported/client.ts')), false);
    assert.equal(existsSync(join(root, receiptPath)), false);
  } finally { process.chdir(old); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('invalid export destinations refuse before an outbound download', async () => {
  const root = project({ 'package.json': '{"name":"fixture"}' });
  const old = process.cwd(); process.chdir(root); let attempts = 0;
  try {
    const tool = codeTools.find(t => t.name === 'swfte_export_src')!;
    const client = { getBinary: async () => { attempts++; throw new Error('unexpected outbound attempt'); } };
    for (const destDir of ['.', '../outside', '']) {
      await assert.rejects(tool.execute({ workflowId: 'wf_a', destDir }, { client, localFilesystem: true } as never), /Refusing|empty|outside/i);
    }
    assert.equal(attempts, 0); assert.equal(existsSync(join(root, receiptPath)), false);
  } finally { process.chdir(old); rmSync(root, { recursive: true, force: true }); }
});

test('hardlinked overwrite marker refuses before download or clearing owned output', async () => {
  const root = project({ 'exported/keep.ts': 'local edits' });
  const outside = project({ 'marker.json': '{"writtenBy":"swfte_export_src"}' });
  const old = process.cwd(); process.chdir(root); let attempts = 0;
  try {
    linkSync(join(outside, 'marker.json'), join(root, 'exported/.swfte-export.json'));
    const client = { getBinary: async () => { attempts++; throw new Error('unexpected outbound attempt'); } };
    await assert.rejects(codeTools.find(t => t.name === 'swfte_export_src')!.execute(
      { workflowId: 'wf_a', destDir: 'exported', overwrite: true }, { client, localFilesystem: true } as never), /hardlink|linked|regular/i);
    assert.equal(attempts, 0); assert.equal(readFileSync(join(root, 'exported/keep.ts'), 'utf8'), 'local edits');
    assert.equal(readFileSync(join(outside, 'marker.json'), 'utf8'), '{"writtenBy":"swfte_export_src"}');
    assert.equal(existsSync(join(root, receiptPath)), false);
  } finally { process.chdir(old); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('invalid archive refuses before destructive overwrite of a marked export', async () => {
  const root = project({ 'exported/keep.ts': 'local edits', 'exported/.swfte-export.json': '{"writtenBy":"swfte_export_src"}' });
  const old = process.cwd(); process.chdir(root); let attempts = 0;
  try {
    const client = { getBinary: async () => { attempts++; return { bytes: zipSync({ '../escape.ts': strToU8(source) }), headers: {} }; } };
    await assert.rejects(codeTools.find(t => t.name === 'swfte_export_src')!.execute(
      { workflowId: 'wf_a', destDir: 'exported', overwrite: true }, { client, localFilesystem: true } as never), /outside|destination/i);
    assert.equal(attempts, 1); assert.equal(readFileSync(join(root, 'exported/keep.ts'), 'utf8'), 'local edits');
    assert.equal(readFileSync(join(root, 'exported/.swfte-export.json'), 'utf8'), '{"writtenBy":"swfte_export_src"}');
    assert.equal(existsSync(join(root, 'escape.ts')), false); assert.equal(existsSync(join(root, receiptPath)), false);
  } finally { process.chdir(old); rmSync(root, { recursive: true, force: true }); }
});

test('actual MCP sync receipts follow physical restored writes only, never dry-run or unchanged work', async () => {
  const root = project({ 'package.json': '{"name":"fixture"}' });
  const old = process.cwd(); process.chdir(root);
  const contract = { catalogRef: 'agent:ag_1', invoke: { method: 'POST', path: '/v1/agents/ag_1/chat/{userId}', auth: 'api_key', async: false, statusPath: null }, inputSchema: {}, outputSchema: {} };
  const client = { request: async ({ path }: { path: string }) => {
    if (path === '/v2/catalog/agent/ag_1/contract') return contract;
    if (path === '/v2/catalog/agent/ag_1') return { catalogRef: 'agent:ag_1', kind: 'agent', id: 'ag_1', name: 'Fixture Agent', scope: 'workspace' };
    if (path === '/v2/catalog/upgrades') return { items: [] };
    throw new Error('unexpected outbound path: ' + path);
  } };
  const context = { client, config: { credential: 'fixture-local-credential', baseUrl: 'https://api.swfte.com/agents', workspaceId: 'ws_fixture', telemetry: false }, localFilesystem: true } as never;
  try {
    const scaffold = scaffoldTools.find(t => t.name === 'swfte_scaffold_client')!;
    const baked = await runInCall(trace(scaffold.name), () => scaffold.execute(
      { catalogRef: 'agent:ag_1', language: 'typescript', targetDir: 'src/swfte', alias: 'fixture-agent', complianceScan: false }, context)) as { files: Array<{ path: string }> };
    const target = baked.files.find(file => file.path.endsWith('.ts'))!.path;
    rmSync(join(root, receiptPath)); rmSync(join(root, target));
    const sync = scaffoldTools.find(t => t.name === 'swfte_sync')!;
    await runInCall(trace(sync.name), () => sync.execute({ dryRun: true }, context));
    assert.equal(existsSync(join(root, target)), false); assert.equal(existsSync(join(root, receiptPath)), false);
    const restored = await runInCall(trace(sync.name), () => sync.execute({}, context)) as { files: Array<{ path: string; action: string }> };
    assert.ok(restored.files.some(file => file.path === target && file.action === 'create'));
    const receipts = readFileSync(join(root, receiptPath), 'utf8'); const rows = JSON.parse(receipts);
    assert.equal(rows.length, 1); assert.equal(rows[0].path, target); assert.equal(rows[0].hash, hash(readFileSync(join(root, target), 'utf8')));
    assert.equal(rows[0].provenance.via, 'mcp'); assert.equal(rows[0].provenance.addedBy, 'codex');
    await runInCall(trace(sync.name), () => sync.execute({}, context));
    assert.equal(readFileSync(join(root, receiptPath), 'utf8'), receipts);
  } finally { process.chdir(old); rmSync(root, { recursive: true, force: true }); }
});
