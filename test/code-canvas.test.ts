import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { codeTools } from '../src/tools/code.js';
import { SwfteApiError } from '../src/client.js';
import { loadConfig } from '../src/config.js';

let root: string, previous: string;
beforeEach(() => { previous = process.cwd(); root = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-canvas-')));
  writeFileSync(join(root, 'package.json'), '{}'); process.chdir(root); });
afterEach(() => { process.chdir(previous); rmSync(root, { recursive: true, force: true }); });
const exportTool = codeTools.find(tool => tool.name === 'swfte_export_src')!;
const checkTool = codeTools.find(tool => tool.name === 'swfte_translate_check')!;
const config = loadConfig({ SWFTE_PAT: 'pat_TEST_CANVAS', SWFTE_TELEMETRY: '0' });
const zip = zipSync({ 'Cargo.toml': new TextEncoder().encode('[package]\nname="example"\nversion="0.1.0"\n') });
function error(status: number, envelope: Record<string, unknown> = {}) {
  return new SwfteApiError({ status, code: status === 422 ? 'TRANSLATION_REFUSED' : 'REFUSED',
    message: 'refused', method: 'GET', path: '/fixture', envelope });
}
function execute(client: unknown, input: Record<string, unknown> = {}) {
  return exportTool.execute(exportTool.inputSchema.parse({ workflowId: 'wf/1', destDir: 'source', ...input }),
    { client: client as never, config, localFilesystem: true });
}

test('Auto exports an execution workflow without attempting canvas', async () => {
  const paths: string[] = [];
  const result: any = await execute({ getBinary: async (path: string) => { paths.push(path); return { bytes: zip, headers: {} }; } });
  assert.deepEqual(paths, ['/v2/workflows/execution/wf%2F1/download-src']);
  assert.equal(result.fileCount, 1); assert.equal(existsSync(join(root, 'source', 'Cargo.toml')), true);
});
test('Auto falls back exactly once after execution 404 and preserves provenance headers', async () => {
  const paths: string[] = [];
  const result: any = await execute({ getBinary: async (path: string) => { paths.push(path);
    if (paths.length === 1) throw error(404);
    return { bytes: zip, headers: { 'x-swfte-source-content-hash': 'source-hash', 'x-swfte-translator-version': '1' } }; } });
  assert.deepEqual(paths, ['/v2/workflows/execution/wf%2F1/download-src', '/v2/workflows/wf%2F1/export-src']);
  assert.equal(result.sourceContentHash, 'source-hash'); assert.equal(result.translatorVersion, '1');
});
test('Explicit execution never falls back and transient/auth failures do not try canvas', async () => {
  for (const [status, source] of [[404, 'execution'], [401, 'auto'], [403, 'auto'], [500, 'auto']] as const) {
    let calls = 0;
    await assert.rejects(execute({ getBinary: async () => { calls++; throw error(status); } }, { source }),
      value => value instanceof SwfteApiError && value.status === status);
    assert.equal(calls, 1); assert.equal(existsSync(join(root, 'source')), false);
  }
});
test('Canvas refusal returns every unsupported node without creating destination', async () => {
  const refusals = [{ nodeId: 'llm', code: 'NODE_HAS_NO_REAL_EMITTER' }, { nodeId: 'mail', code: 'NODE_UNSUPPORTED' }];
  const paths: string[] = [];
  const result: any = await execute({ getBinary: async (path: string) => { paths.push(path); throw error(422, { refusals }); } }, { source: 'canvas' });
  assert.deepEqual(paths, ['/v2/workflows/wf%2F1/export-src']); assert.deepEqual(result.refusals, refusals);
  assert.equal(result.refused, true); assert.equal(existsSync(join(root, 'source')), false);
});
test('Auto canvas refusal keeps an existing owned destination intact even with overwrite', async () => {
  const { mkdirSync } = await import('node:fs'); mkdirSync(join(root, 'source'));
  writeFileSync(join(root, 'source', '.swfte-export.json'), JSON.stringify({ writtenBy: 'swfte_export_src' }));
  writeFileSync(join(root, 'source', 'user.txt'), 'user edits'); let calls = 0;
  const result: any = await execute({ getBinary: async () => { calls++; throw calls === 1 ? error(404) : error(422, { refusals: [{ nodeId: 'wait' }] }); } }, { overwrite: true });
  assert.equal(result.refused, true); assert.equal(calls, 2);
  assert.equal(readFileSync(join(root, 'source', 'user.txt'), 'utf8'), 'user edits');
});
test('404 from both routes stops after two attempts', async () => {
  let calls = 0; await assert.rejects(execute({ getBinary: async () => { calls++; throw error(404); } }));
  assert.equal(calls, 2); assert.equal(existsSync(join(root, 'source')), false);
});
test('Translation check always sends dryRun and works in a hosted server without local files', async () => {
  const requests: unknown[] = [];
  const report = { translatable: false, refusals: [{ nodeId: 'llm' }] };
  assert.equal(checkTool.readOnly, true);
  const result: any = await checkTool.execute(checkTool.inputSchema.parse({ workflowId: 'wf/1' }), {
    client: { request: async (request: unknown) => { requests.push(request); return report; } } as never,
    config, localFilesystem: false,
  });
  assert.deepEqual(requests, [{ method: 'POST', path: '/v2/workflows/wf%2F1/translate-to-execution', query: { dryRun: true }, retries: 0 }]);
  assert.deepEqual(result.refusals, report.refusals); assert.equal(existsSync(join(root, 'source')), false);
});
