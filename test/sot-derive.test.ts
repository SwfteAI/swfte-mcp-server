import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { CATALOG_KINDS, contractHash, type CatalogContract } from '../src/catalog.js';
import { clientInfo, renderPythonClient, renderTypeScriptClient, type ClientSpec } from '../src/codegen.js';
import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { allTools } from '../src/tools/index.js';
import { FIXTURE_ROOT, capturedFixtures, sha256, workflowGolden, type BackendContract, type CapturedCase } from './fixtures/phase5-contracts/index.js';

const HASH = /^[0-9a-f]{64}$/;
function temporary(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-phase5-derived-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function specFor(row: CapturedCase, contract: BackendContract = row.contract): ClientSpec {
  assert.ok(contract.invoke, 'Only a real callable contract reaches the generator');
  return { catalogRef: contract.catalogRef, kind: row.kind,
    id: contract.catalogRef.slice(contract.catalogRef.indexOf(':') + 1),
    name: 'Derived backend fixture', alias: `phase5-${row.kind}`,
    contract: contract as CatalogContract, contractHash: contract.contractHash!,
    defaultBaseUrl: 'https://api.example.test/agents',
    pinnedVersion: row.variant === 'pinned-workflow' ? contract.version : null };
}
function diagnostics(t: TestContext, source: string, probe = ''): string[] {
  const dir = temporary(t), client = join(dir, 'client.ts'), call = join(dir, 'probe.ts');
  writeFileSync(client, source); writeFileSync(call, probe);
  const program = ts.createProgram([client, call], {
    strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [],
  });
  return ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}
function bodyFor(row: CapturedCase) {
  switch (row.kind) {
    case 'workflow': return { amount: 1, customerEmail: 'a@b.c' };
    case 'agent': return { message: 'Hello' };
    case 'widget': return { input: { message: 'Hello' } };
    case 'model': return { model: row.contract.catalogRef.slice(6), messages: [{ role: 'user', content: 'Hello' }] };
    default: throw new Error('Unsupported callable fixture kind');
  }
}
function compilePython(source: string) {
  const result = execFileSync('python3', ['-c',
    'import ast,sys\nsrc=sys.stdin.read()\nast.parse(src, filename="derived-client.py")\ncompile(src,"derived-client.py","exec")\nprint("PY_SOURCE_COMPILED")'],
  { input: source, encoding: 'utf8' });
  assert.equal(result.trim(), 'PY_SOURCE_COMPILED');
}

test('derive all catalog kinds have captured backend source provenance and immutable fingerprints', () => {
  const { provenance, cases } = capturedFixtures();
  assert.equal(provenance.format, 1); assert.equal(provenance.mode, 'driver-captured-real-backend-records');
  assert.equal(cases.length, 15); assert.equal(cases.filter(row => row.variant === 'provider-everyKind').length, 12);
  assert.deepEqual(cases.filter(row => row.variant !== 'provider-everyKind').map(row => row.variant).sort(),
    ['image-model', 'pinned-workflow', 'public-agent']);
  assert.match(provenance.backendCommit, /^[0-9a-f]{40}$/);
  assert.match(provenance.derivedGoldenSha256, HASH);
  for (const source of ['SotCatalogContractProvider.java', 'CatalogContract.java', 'ContractSnippets.java',
    'WorkflowSchemaDeriver.java', 'SotContractProviderTest.java', 'SotDerivedFixtureGoldenTest.java']) {
    const matches = Object.entries(provenance.sourceSha256).filter(([path]) => path.endsWith(`/${source}`));
    assert.equal(matches.length, 1, `Explicit source provenance for ${source}`); assert.match(matches[0]![1], HASH);
  }
  assert.equal(sha256(readFileSync(new URL('BackendFixtureCapture.java', FIXTURE_ROOT))), provenance.captureSourceSha256);
  assert.deepEqual([...new Set(cases.filter(row => (CATALOG_KINDS as readonly string[]).includes(row.kind)).map(row => row.kind))].sort(), [...CATALOG_KINDS].sort());
  const expectedKeys = ['catalogRef', 'invoke', 'inputSchema', 'outputSchema', 'snippets', 'embed',
    'contractHash', 'version', 'invokeUnavailableReason'].sort();
  for (const row of cases) {
    assert.match(row.origin, /actual backend CatalogContract record/);
    assert.equal(row.contract.catalogRef, row.catalogRef); assert.equal(sha256(row.bytes), row.sha256);
    assert.equal(readFileSync(new URL(`${row.file}.sha256`, FIXTURE_ROOT), 'utf8').trim(), `${row.sha256}  ${row.file}`);
    assert.deepEqual(Object.keys(row.contract).sort(), expectedKeys);
    assert.equal(contractHash(row.contract as CatalogContract), row.contract.contractHash);
    assert.ok(row.contract.snippets?.typescript && row.contract.snippets?.python && row.contract.snippets?.curl);
    if (!row.contract.invoke) {
      assert.ok(row.contract.invokeUnavailableReason); assert.deepEqual(row.contract.inputSchema, {});
      assert.deepEqual(row.contract.outputSchema, {});
    }
  }
  const raw = readFileSync(new URL('two-input-workflow.golden.json', FIXTURE_ROOT));
  assert.equal(sha256(raw), provenance.derivedGoldenSha256);
  assert.equal(provenance.derivedGoldenSha256, '9c576a0e0f40307dc9b71effbcd456fbf028a33f97c130785ad827b76eb23fe6');
  assert.equal(readFileSync(new URL('two-input-workflow.golden.json.sha256', FIXTURE_ROOT), 'utf8').trim(),
    `${provenance.derivedGoldenSha256}  two-input-workflow.golden.json`);
  const derived = cases.find(row => row.catalogRef === 'workflow:wf_1' && row.variant === 'provider-everyKind')!;
  assert.deepEqual(derived.bytes, raw);
  assert.throws(() => assert.equal(sha256(Buffer.concat([raw, Buffer.from(' ')])), provenance.derivedGoldenSha256));
});

test('derive TypeScript compiles real callable backend fixtures', t => {
  const callable = capturedFixtures().cases.filter(row => row.contract.invoke);
  assert.deepEqual([...new Set(callable.map(row => row.kind))].sort(), ['agent', 'model', 'widget', 'workflow']);
  for (const row of callable) {
    const spec = specFor(row), info = clientInfo(spec, 'typescript');
    const probe = `import { ${info.fn} } from './client.js';\nvoid ${info.fn}(${JSON.stringify(bodyFor(row))});\n`;
    assert.deepEqual(diagnostics(t, renderTypeScriptClient(spec), probe), [], row.catalogRef);
  }
});

test('derive TypeScript rejects wrong or missing required workflow input and observes removed required', t => {
  const row = capturedFixtures().cases.find(row => row.catalogRef === 'workflow:wf_1' && row.variant === 'provider-everyKind')!;
  const spec = specFor(row), info = clientInfo(spec, 'typescript'), source = renderTypeScriptClient(spec);
  const call = (literal: string) => `import { ${info.fn} } from './client.js';\nvoid ${info.fn}(${literal});\n`;
  assert.deepEqual(diagnostics(t, source, call("{amount:1,customerEmail:'a@b.c'}")), []);
  const wrong = diagnostics(t, source, call("{amount:'x',customerEmail:'a@b.c'}"));
  assert.ok(wrong.length); assert.ok(wrong.some(message => message.includes('string') && message.includes('number')));
  const missing = diagnostics(t, source, call('{amount:1}'));
  assert.ok(missing.length); assert.ok(missing.some(message => message.includes('customerEmail')));
  const output = diagnostics(t, source, `import type { ${info.outputType} } from './client.js';\nconst result: ${info.outputType} = {amount:'wrong'};\n`);
  assert.ok(output.length); assert.ok(output.some(message => message.includes('number')));
  const removed = structuredClone(row.contract); delete removed.inputSchema.required;
  const mutantMissing = diagnostics(t, renderTypeScriptClient(specFor(row, removed)), call('{amount:1}'));
  assert.deepEqual(mutantMissing, [], 'Deleting required makes the missing-input probe compile');
  assert.throws(() => assert.ok(mutantMissing.length > 0), { code: 'ERR_ASSERTION' }, 'The missing-input rejection oracle is falsifiable');
});

test('derive Python parses real callable backend fixtures and committed snippet', () => {
  for (const row of capturedFixtures().cases.filter(row => row.contract.invoke)) {
    const source = renderPythonClient(specFor(row));
    compilePython(source);
    assert.match(source, /from typing import/); assert.doesNotMatch(source, /import requests/);
    if (row.kind === 'workflow') { assert.match(source, /"amount": float/); assert.match(source, /"customerEmail": str/); }
    compilePython(row.contract.snippets!.python!);
  }
  compilePython(workflowGolden().snippets!.python!);
});

test('derive unavailable kinds stay unavailable through registered scaffold without writes', async t => {
  const cases = capturedFixtures().cases.filter(row => !row.contract.invoke && (CATALOG_KINDS as readonly string[]).includes(row.kind));
  assert.deepEqual(cases.map(row => row.catalogRef).sort(), ['agent:ag_pub', 'application:application_1',
    'chatflow:chatflow_1', 'mcp-server:mcp-server_1', 'model:model_1', 'model:sdxl',
    'module:module_1', 'solution:solution_1', 'workflow:wf_pub']);
  assert.ok(cases.some(row => row.variant === 'public-agent')); assert.ok(cases.some(row => row.variant === 'image-model'));
  assert.ok(cases.some(row => row.kind === 'model' && row.catalogRef === 'model:model_1'));
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const config = loadConfig({ SWFTE_PAT: 'pat_PHASE5_DERIVED_FIXTURE', SWFTE_BASE_URL: 'https://api.example.test/agents', SWFTE_TELEMETRY: '0' });
  const tool = allTools.find(row => row.name === 'swfte_scaffold_client')!;
  const wire: string[] = [];
  for (const row of cases) {
    const [kind, id] = row.catalogRef.split(':');
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = new URL(String(input)), path = url.pathname.replace(/^\/agents/, '');
      wire.push(`${init.method ?? 'GET'} ${path}`);
      const body = path.endsWith('/contract') ? row.contract : { catalogRef: row.catalogRef, kind, id,
        name: 'Unavailable backend fixture', scope: 'workspace', workspaceId: 'ws-fixture', evidence: { level: 'verified' } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await assert.rejects(tool.execute(tool.inputSchema.parse({ catalogRef: row.catalogRef, framework: 'plain-ts',
      targetDir: 'phase5-unavailable', alias: 'unavailable-fixture', pin: false, complianceScan: false }),
    { client: new SwfteClient(config), config, localFilesystem: false }), /no .*invok|no .*contract|does not expose|not .*invok/i, row.catalogRef);
  }
  assert.equal(wire.length, cases.length * 2); assert.ok(wire.every(item => item.startsWith('GET /v2/catalog/')));
});

test('derive generated clients preserve backend auth version async and schema semantics', async () => {
  for (const row of capturedFixtures().cases.filter(row => row.contract.invoke)) {
    const spec = specFor(row), source = renderTypeScriptClient(spec), python = renderPythonClient(spec);
    const info = clientInfo(spec, 'typescript'), invoke = row.contract.invoke!;
    const expectedPath = row.variant === 'pinned-workflow' ? '/v2/workflows/wf_1/versions/1.0.0/invoke'
      : ({ workflow: '/v2/workflows/wf_1/invoke', agent: '/v1/agents/agent_1/chat/{userId}',
        widget: '/v1/widgets/widget_1/public/invoke', model: '/v1/chat/completions' } as Record<string, string>)[row.kind];
    assert.equal(invoke.method, 'POST'); assert.equal(invoke.path, expectedPath);
    assert.equal(invoke.auth, row.kind === 'widget' ? 'public' : 'api_key');
    assert.equal(invoke.async, row.kind === 'workflow');
    assert.equal(invoke.statusPath, row.kind === 'workflow' ? '/v2/workflows/executions/{executionId}/status' : null);
    assert.ok(source.includes(JSON.stringify(invoke.path))); assert.ok(python.includes(JSON.stringify(invoke.path)));
    assert.ok(source.includes(`auth: ${JSON.stringify(invoke.auth)}`));
    assert.ok(python.includes(`INVOKE_AUTH = ${JSON.stringify(invoke.auth)}`));
    if (invoke.async) { assert.ok(source.includes(invoke.statusPath!)); assert.ok(python.includes(invoke.statusPath!)); }
    if (row.variant === 'pinned-workflow') {
      assert.equal(invoke.path, '/v2/workflows/wf_1/versions/1.0.0/invoke');
      assert.match(source, /PINNED_VERSION: string \| null = "1\.0\.0"/); assert.match(python, /PINNED_VERSION: Optional\[str\] = "1\.0\.0"/);
    } else { assert.match(source, /PINNED_VERSION: string \| null = null/); }
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports: Record<string, Function> = {};
    runInNewContext(output, { exports, URL, AbortController, setTimeout, clearTimeout }, { timeout: 1000 });
    for (const apiKey of ['pat_PHASE5_SYNTHETIC', 'synthetic-workspace-api-key']) {
      const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
      const fetch = async (url: string, init: RequestInit) => {
        requests.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify(invoke.async
          ? init.method === 'POST' ? { executionId: 'fixture-execution' } : { execution: { status: 'SUCCESS', outputData: { amount: 1 } } }
          : row.kind === 'agent' ? { content: 'Synthetic reply' } : { success: true }),
        { status: 200, headers: { 'content-type': 'application/json' } });
      };
      await exports[info.fn]!(bodyFor(row), { apiKey, workspaceId: 'ws-fixture', fetch, pollIntervalMs: 0, timeoutMs: 1000 });
      assert.equal(requests[0]!.method, 'POST'); assert.deepEqual(requests[0]!.body, bodyFor(row));
      assert.equal(new URL(requests[0]!.url).pathname, `/agents${expectedPath!.replace('{userId}', 'swfte-client')}`);
      assert.ok(requests.every(request => new URL(request.url).origin === 'https://api.example.test'));
      if (invoke.auth === 'public') {
        assert.ok(requests.every(request => !request.headers.Authorization && !request.headers['X-API-Key'] && !request.headers['X-Workspace-ID']));
      } else {
        assert.ok(requests.every(request => request.headers.Authorization === `Bearer ${apiKey}`));
        assert.equal(requests[0]!.headers['X-API-Key'], apiKey.startsWith('pat_') ? undefined : apiKey);
        assert.equal(requests[0]!.headers['X-Workspace-ID'], apiKey.startsWith('pat_') ? undefined : 'ws-fixture');
      }
      assert.equal(requests.length, invoke.async ? 2 : 1);
      if (invoke.async) assert.equal(new URL(requests[1]!.url).pathname, '/agents/v2/workflows/executions/fixture-execution/status');
    }
    for (const path of ['//outside.example/invoke', 'https://outside.example/invoke', '/v2/../invoke']) {
      const hostile = { ...spec, contract: { ...spec.contract, invoke: { ...invoke, path } } };
      assert.throws(() => renderTypeScriptClient(hostile), /not a plain absolute path/);
      assert.throws(() => renderPythonClient(hostile), /not a plain absolute path/);
    }
  }
});

test('derive committed workflow TypeScript snippet compiles and curl preserves real invoke poll paths', t => {
  const golden = workflowGolden(), snippet = golden.snippets!;
  const globals = 'declare const process: {env: Record<string,string|undefined>;exit(code:number):never};\n';
  assert.deepEqual(diagnostics(t, globals + snippet.typescript), []);
  assert.match(snippet.curl!, /-X POST/); assert.match(snippet.curl!, /\$SWFTE_API_KEY/);
  assert.ok(snippet.curl!.includes('/v2/workflows/wf_1/invoke'));
  assert.ok(snippet.curl!.includes('/v2/workflows/executions/${EXECUTION_ID}/status'));
  assert.ok(snippet.curl!.includes('.execution.status')); assert.match(snippet.curl!, /SUCCESS\|SUCCEEDED\|COMPLETED/);
  assert.equal(golden.invoke!.method, 'POST'); assert.equal(golden.invoke!.async, true);
});
