/**
 * Pre-publish hardening (review r-mcp R1, R5): server-supplied text must never become
 * executable code in a generated client, and a server-supplied path must never move the host.
 * Each test is named `Gn:` after its ledger gate and was run against origin/master to fail there.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

import { loadConfig } from '../src/config.js';
import { scaffoldTools } from '../src/tools/scaffold.js';
import { renderPythonClient, renderTypeScriptClient } from '../src/codegen.js';

let root = '';
let prev = '';
beforeEach(() => {
  prev = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-hard-')));
  writeFileSync(join(root, 'package.json'), '{"name":"x","dependencies":{}}');
  process.chdir(root);
});
afterEach(() => {
  process.chdir(prev);
  rmSync(root, { recursive: true, force: true });
});

const contractWith = (over: Record<string, unknown>, invoke: Record<string, unknown> = {}) => ({
  catalogRef: 'workflow:wf_1',
  invoke: { method: 'POST', path: '/v2/workflows/wf_1/invoke', auth: 'pat', async: false, statusPath: null, ...invoke },
  inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
  outputSchema: {},
  ...over,
});

async function scaffold(language: 'typescript' | 'python', contract: Record<string, unknown>) {
  const detail = { catalogRef: 'workflow:wf_1', kind: 'workflow', id: 'wf_1', name: 'Poc', description: 'd', facets: [], evidence: { level: 'verified' } };
  const client: any = {
    baseUrl: 'https://api.swfte.com/agents',
    request: async (o: any) =>
      /contract$/.test(o.path) ? contract : /catalog\/workflow\/wf_1$/.test(o.path) ? detail : o.path.includes('/schema') ? { error: 'x' } : o.path.includes('compliance') ? { findings: [] } : {},
  };
  const config = loadConfig({ SWFTE_PAT: 'pat_TESTPAT123456', SWFTE_TELEMETRY: '0' } as never);
  const tool = scaffoldTools.find((t) => t.name === 'swfte_scaffold_client')!;
  const r: any = await tool.execute({ catalogRef: 'workflow:wf_1', language, pin: false, complianceScan: false } as never, { client, config, localFilesystem: true });
  const file = r.files.map((f: any) => f.path).find((f: string) => /\.(ts|py)$/.test(f) && /swfte/.test(f));
  return { result: r, src: readFileSync(join(root, file), 'utf8'), file };
}

/** True when the marker survives into the Python AST (code or string); comments never do. */
function pyInAst(file: string, marker: string): boolean {
  return execFileSync('python3', [join(prev, 'scripts/py-ast-mentions.py'), file, marker]).toString().trim() === 'True';
}

/** Statements at any depth that assign to / call something named by the marker, outside strings and comments. */
function executableMentions(src: string, marker: RegExp): boolean {
  const sf = ts.createSourceFile('c.ts', src, ts.ScriptTarget.Latest, true);
  let found = false;
  const walk = (n: ts.Node) => {
    if ((ts.isBinaryExpression(n) || ts.isCallExpression(n) || ts.isExpressionStatement(n)) && marker.test(n.getText(sf))) found = true;
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

describe('hostile contractHash (R1)', () => {
  test('G2: hostile contractHash never becomes executable code in the TypeScript client', async () => {
    for (const hash of ['abc globalThis.PWNED_TS=1;//', 'abc globalThis.PWNED_TS=1;//', 'abc\nglobalThis.PWNED_TS=1;//', 'abc */ globalThis.PWNED_TS=1; /*']) {
      const { src } = await scaffold('typescript', contractWith({ contractHash: hash }));
      assert.equal(executableMentions(src, /PWNED_TS/), false, `injected via ${JSON.stringify(hash)}`);
      assert.ok(!src.includes(' '), 'no raw U+2028 in generated source');
    }
  });

  test('G2: hostile contractHash (LF) yields a Python client that ast.parse accepts with no injected import', async () => {
    const { src, file } = await scaffold('python', contractWith({ contractHash: 'abc\nimport os; os.environ["PWNED_PY"]="1"' }));
    assert.equal(pyInAst(join(root, file), 'PWNED_PY'), false);
    assert.ok(!/^import os; os\.environ/m.test(src));
  });

  test('G2: a hostile hash is not recorded as the contract hash either; a real hex digest still is', async () => {
    const good = 'sha256:' + 'ab12cd34'.repeat(8);
    const { src } = await scaffold('typescript', contractWith({ contractHash: good }));
    assert.match(src, new RegExp(`Contract hash: ${good}`));
  });

  test('G2: direct render with a hostile spec.contractHash is escaped in both languages', () => {
    const spec: any = { catalogRef: 'workflow:w', kind: 'workflow', id: 'w', name: 'n', contract: contractWith({}), contractHash: 'x\u2028globalThis.PWNED_TS=1;//\nPWNED_PY = 1', defaultBaseUrl: 'https://api.swfte.com/agents' };
    assert.equal(executableMentions(renderTypeScriptClient(spec), /PWNED_TS/), false);
    const f = join(root, 'direct.py');
    writeFileSync(f, renderPythonClient(spec));
    assert.equal(pyInAst(f, 'PWNED_PY'), false);
  });
});

describe('hostile invoke path (R5)', () => {
  const hostile = ['@evil.example/x', '//evil.example/x', 'https://evil.example/x', '\\evil.example', '/ok/../../x', 'v2/relative'];

  test('G6: hostile invoke path is rejected at generation in both languages', () => {
    for (const path of hostile) {
      const spec: any = { catalogRef: 'workflow:w', kind: 'workflow', id: 'w', name: 'n', contract: contractWith({}, { path }), contractHash: 'abc', defaultBaseUrl: 'https://api.swfte.com' };
      assert.throws(() => renderTypeScriptClient(spec), /not a plain absolute path/, `ts ${path}`);
      assert.throws(() => renderPythonClient(spec), /not a plain absolute path/, `py ${path}`);
    }
    const okSpec: any = { catalogRef: 'workflow:w', kind: 'workflow', id: 'w', name: 'n', contract: contractWith({}, { path: '/v2/workflows/{id}/invoke' }), contractHash: 'abc', defaultBaseUrl: 'https://api.swfte.com' };
    assert.doesNotThrow(() => renderTypeScriptClient(okSpec));
  });

  test('G6: a hostile statusPath is rejected too', () => {
    const spec: any = { catalogRef: 'workflow:w', kind: 'workflow', id: 'w', name: 'n', contract: contractWith({}, { async: true, statusPath: '@evil.example/s' }), contractHash: 'abc', defaultBaseUrl: 'https://api.swfte.com' };
    assert.throws(() => renderTypeScriptClient(spec), /statusPath/);
  });

  test('G6: the generated TS client asserts same origin and refuses redirects', () => {
    const spec: any = { catalogRef: 'workflow:w', kind: 'workflow', id: 'w', name: 'n', contract: contractWith({}), contractHash: 'abc', defaultBaseUrl: 'https://api.swfte.com' };
    const ts_ = renderTypeScriptClient(spec);
    assert.match(ts_, /new URL\(url\)\.origin !== new URL\(baseUrl\)\.origin/);
    assert.match(ts_, /redirect: 'manual'/);
    const py = renderPythonClient(spec);
    assert.match(py, /leaves the base URL origin/);
    assert.match(py, /_NoRedirect/);
  });

  test('G6: executing the generated TS client with a mocked fetch never reaches another host and never follows a redirect', async () => {
    const spec: any = { catalogRef: 'workflow:w', kind: 'workflow', id: 'w', name: 'n', contract: contractWith({}), contractHash: 'abc', defaultBaseUrl: 'https://api.swfte.com' };
    const src = renderTypeScriptClient(spec);
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
    const file = join(root, 'gen.mjs');
    writeFileSync(file, js);
    const mod: any = await import(file);
    const fn = Object.values(mod).find((v) => typeof v === 'function' && !/Error$/.test((v as Function).name)) as Function;
    const calls: any[] = [];
    const f = async (url: string, init: any) => {
      calls.push({ url, redirect: init.redirect });
      return new Response('', { status: 302, headers: { location: 'https://evil.example/' } });
    };
    await assert.rejects(fn({ a: 'x' }, { apiKey: 'sk-swfte-TESTKEY123456', baseUrl: 'https://api.swfte.com', fetch: f }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, 'manual');
    assert.ok(calls[0].url.startsWith('https://api.swfte.com/'));
  });
});
