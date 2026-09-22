/**
 * Studio-as-source-of-truth bridge: catalog reuse, code scaffolding,
 * approval-gated actions and wiring.
 *
 * Every test runs against a mocked global `fetch` (the real SwfteClient is
 * used, so request paths, query strings and bodies are the ones that would go
 * on the wire) and a throwaway working directory, so the file-writing tools
 * are exercised for real — including the ways they must refuse.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { allTools } from '../src/tools/index.js';
import { buildServer } from '../src/server.js';
import { getAdapter } from '../src/kinds/index.js';
import { contractHash, parseCatalogRef } from '../src/catalog.js';
import { isUntyped, PyTypes, tsType } from '../src/codegen.js';
import { catalogRefFromUri } from '../src/resources.js';

const CREDENTIAL = 'pat_supersecretcredential123';
const config = () => loadConfig({ SWFTE_PAT: CREDENTIAL } as never);

/* ── mocked fetch ────────────────────────────────────────────────────────── */

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  headers: Record<string, string>;
}
type Handler = (req: Seen) => { status?: number; body?: unknown } | undefined;

let seen: Seen[] = [];
let routes: Array<[string, RegExp, Handler]> = [];
const realFetch = globalThis.fetch;

function route(method: string, pattern: RegExp, handler: Handler | { status?: number; body?: unknown }) {
  routes.push([method, pattern, typeof handler === 'function' ? handler : () => handler]);
}

function installFetch() {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/agents/, '');
    const req: Seen = {
      method: String(init.method ?? 'GET'),
      path,
      query: Object.fromEntries(url.searchParams.entries()),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers ?? {},
    };
    seen.push(req);
    const hit = routes.find(([m, re]) => m === req.method && re.test(path));
    if (!hit) return new Response(JSON.stringify({ code: 'NO_ROUTE', message: `${req.method} ${path}` }), { status: 599 });
    const out = hit[2](req) ?? {};
    const status = out.status ?? 200;
    return new Response(out.body === undefined ? '' : JSON.stringify(out.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const tool = (name: string) => {
  const t = allTools.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
};
const ctx = () => ({ client: new SwfteClient(config()), config: config() });
const run = (name: string, input: unknown) => tool(name).execute(input as never, ctx()) as Promise<any>;

/* ── fixtures ────────────────────────────────────────────────────────────── */

const evidence = (level: string, extra: Record<string, unknown> = {}) => ({
  level,
  runs: { total: 12, succeeded: 11, failed: 1 },
  successRate: 0.92,
  lastRunAt: '2026-09-20T10:00:00Z',
  evals: 1,
  reviews: { approve: 1, reject: 0 },
  reasons: [`computed ${level}`],
  ...extra,
});

const summary = (kind: string, id: string, name: string, level: string, extra: Record<string, unknown> = {}) => ({
  catalogRef: `${kind}:${id}`,
  kind,
  id,
  workspaceId: 'ws1',
  scope: 'workspace',
  name,
  description: `${name} description`,
  source: 'workflow_v2',
  listingId: null,
  facets: [{ key: 'domain', value: 'finance', confidence: 0.8, status: 'CONFIRMED', source: 'human' }],
  evidence: evidence(level),
  updatedAt: '2026-09-21T00:00:00Z',
  shapeHash: 'shape-1',
  ...extra,
});

const WF_CONTRACT = {
  catalogRef: 'workflow:wf_1',
  invoke: {
    method: 'POST',
    path: '/v2/workflows/wf_1/invoke',
    auth: 'api_key',
    async: true,
    statusPath: '/v2/workflows/executions/{executionId}/status',
  },
  inputSchema: {
    type: 'object',
    properties: {
      invoiceUrl: { type: 'string', description: 'Where the PDF lives */ console.log("pwned") /*' },
      'line-items': { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' } }, required: ['sku'] } },
      currency: { enum: ['usd', 'eur'] },
      class: { type: ['string', 'null'] },
    },
    required: ['invoiceUrl'],
  },
  outputSchema: {},
  snippets: { curl: 'curl -H "Authorization: Bearer $SWFTE_API_KEY" …' },
  embed: null,
};

function detailFor(ref: string, extra: Record<string, unknown> = {}) {
  const { kind, id } = parseCatalogRef(ref);
  return {
    ...summary(kind, id, 'Invoice Extractor', 'validated'),
    rationale: { form: 'workflow', why: 'bounded steps' },
    evidenceRecords: [{ type: 'execution', refId: 'ex1', status: 'SUCCEEDED', at: '2026-09-20T10:00:00Z' }],
    dependencies: [{ catalogRef: 'agent:ag_1', relation: 'invokes' }],
    reviews: [{ id: 'r1', verdict: 'approve', role: 'domain_expert', note: 'ok', reviewerId: 'u1', at: '2026-09-20T00:00:00Z' }],
    ...extra,
  };
}

/* ── lifecycle ───────────────────────────────────────────────────────────── */

let tmp = '';
let prevCwd = '';
beforeEach(() => {
  seen = [];
  routes = [];
  installFetch();
  prevCwd = process.cwd();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-sot-')));
  process.chdir(tmp);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

/* ── catalog ─────────────────────────────────────────────────────────────── */

describe('swfte_find_existing', () => {
  test('sends the contract query and recommends the best-evidenced match', async () => {
    route('GET', /^\/v2\/catalog\/search$/, {
      body: {
        items: [
          summary('workflow', 'wf_0', 'Invoice parser (draft)', 'observed'),
          summary('workflow', 'wf_1', 'Invoice Extractor', 'verified'),
        ],
        nextCursor: 'c2',
        degraded: [],
      },
    });
    const res = await run('swfte_find_existing', {
      query: 'invoice',
      kinds: ['workflow', 'agent'],
      scope: 'all',
      minEvidence: 'observed',
      facets: { domain: 'finance' },
      limit: 5,
    });
    assert.equal(seen.length, 1);
    const req = seen[0]!;
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/v2/catalog/search');
    assert.deepEqual(req.query, { q: 'invoice', kinds: 'workflow,agent', scope: 'all', minEvidence: 'observed', domain: 'finance', limit: '5' });
    assert.equal(res.results.length, 2);
    assert.equal(res.results[0].rank, 1);
    assert.equal(res.results[1].evidenceLevel, 'verified');
    assert.ok(res.results[1].reasons.some((r: string) => /domain=finance/.test(r)));
    assert.match(res.results[1].guidance, /reuse catalogRef workflow:wf_1 via swfte_get_context/i);
    // The observed draft ranks first by relevance; the recommendation follows evidence.
    assert.equal(res.recommendation.action, 'REUSE');
    assert.equal(res.recommendation.catalogRef, 'workflow:wf_1');
    assert.ok(res.recommendation.generationAvoided.tokens > 0);
    assert.match(res.recommendation.generationAvoided.basis, /estimate/);
    assert.equal(res.nextCursor, 'c2');
  });

  test('degraded subsystems are reported, and the search still answers', async () => {
    route('GET', /^\/v2\/catalog\/search$/, {
      body: { items: [summary('agent', 'ag_1', 'Support triage', 'observed')], nextCursor: null, degraded: ['jev_rerank'] },
    });
    const res = await run('swfte_find_existing', { query: 'triage' });
    assert.deepEqual(res.degraded, ['jev_rerank']);
    assert.match(res.degradedNotes[0], /jev_rerank: .*lexical/);
    assert.equal(res.recommendation.action, 'INSPECT_BEFORE_REUSE');
    assert.equal(res.recommendation.catalogRef, 'agent:ag_1');
  });

  test('no match recommends building, and all-disputed matches are not recommended', async () => {
    route('GET', /^\/v2\/catalog\/search$/, { body: { items: [], nextCursor: null, degraded: [] } });
    assert.equal((await run('swfte_find_existing', { query: 'nothing' })).recommendation.action, 'BUILD');
    routes = [];
    route('GET', /^\/v2\/catalog\/search$/, { body: { items: [summary('workflow', 'wf_9', 'Broken', 'disputed')], nextCursor: null, degraded: [] } });
    assert.equal((await run('swfte_find_existing', { query: 'broken' })).recommendation.action, 'BUILD');
  });

  test('a response missing items/degraded is treated as empty, not a crash', async () => {
    route('GET', /^\/v2\/catalog\/search$/, { body: {} });
    const res = await run('swfte_find_existing', { query: 'x' });
    assert.equal(res.count, 0);
    assert.deepEqual(res.degraded, []);
  });
});

describe('swfte_get_context / swfte_get_evidence', () => {
  test('assembles detail + contract into the context package', async () => {
    route('GET', /^\/v2\/catalog\/workflow\/wf_1$/, { body: detailFor('workflow:wf_1') });
    route('GET', /^\/v2\/catalog\/workflow\/wf_1\/contract$/, { body: WF_CONTRACT });
    const res = await run('swfte_get_context', { catalogRef: 'workflow:wf_1' });
    assert.deepEqual(seen.map((s) => s.path).sort(), ['/v2/catalog/workflow/wf_1', '/v2/catalog/workflow/wf_1/contract']);
    assert.equal(res.catalogRef, 'workflow:wf_1');
    assert.equal(res.contract.invoke.path, '/v2/workflows/wf_1/invoke');
    assert.equal(res.contractHash, contractHash(WF_CONTRACT as never));
    assert.deepEqual(res.rationale, { form: 'workflow', why: 'bounded steps' });
    assert.equal(res.dependencies[0].catalogRef, 'agent:ag_1');
    assert.equal(res.evidenceRecords.length, 1);
    assert.equal(res.facets.confirmed.length, 1);
    assert.match(res.evidence.interpretation, /Validated/);
    assert.ok(res.nextSteps.some((s: string) => s.includes('swfte_scaffold_client')));
  });

  test('a missing contract is reported, not thrown', async () => {
    route('GET', /^\/v2\/catalog\/model\/m_1$/, { body: detailFor('model:m_1') });
    route('GET', /^\/v2\/catalog\/model\/m_1\/contract$/, { status: 404, body: { code: 'NOT_FOUND', message: 'no contract' } });
    const res = await run('swfte_get_context', { catalogRef: 'model:m_1' });
    assert.equal(res.contract, null);
    assert.equal(res.contractError.status, 404);
    assert.equal(res.contractHash, null);
  });

  test('evidence reads the entry and interprets the level', async () => {
    route('GET', /^\/v2\/catalog\/agent\/ag_1$/, { body: detailFor('agent:ag_1', { evidence: evidence('disputed') }) });
    const res = await run('swfte_get_evidence', { catalogRef: 'agent:ag_1' });
    assert.equal(seen[0]!.path, '/v2/catalog/agent/ag_1');
    assert.equal(res.evidence.level, 'disputed');
    assert.equal(res.reusable, false);
    assert.match(res.interpretation, /Disputed/);
  });

  test('a malformed or unknown-kind catalogRef is rejected before any request', async () => {
    assert.equal(tool('swfte_get_context').inputSchema.safeParse({ catalogRef: 'nocolon' }).success, false);
    await assert.rejects(run('swfte_get_context', { catalogRef: 'spaceship:1' }), /Unknown catalog kind/);
    assert.equal(seen.length, 0);
  });
});

describe('swfte_trace_dependencies', () => {
  test('downstream merges catalog dependencies with ids found in the live record', async () => {
    route('GET', /^\/v2\/catalog\/workflow\/wf_1$/, { body: detailFor('workflow:wf_1') });
    route('GET', /^\/v2\/workflows\/wf_1$/, {
      body: { nodes: [{ id: 'n1', type: 'AGENT', configuration: { agentId: 'ag_2' } }] },
    });
    route('GET', /^\/v2\/catalog\/agent\/ag_[12]$/, (req) => ({ body: detailFor(`agent:${req.path.split('/').pop()}`, { dependencies: [] }) }));
    route('GET', /^\/v2\/agents\/ag_[12]$/, { body: {} });
    const res = await run('swfte_trace_dependencies', { catalogRef: 'workflow:wf_1', direction: 'downstream', depth: 2 });
    const targets = res.edges.map((e: any) => `${e.to}|${e.source}`);
    assert.ok(targets.includes('agent:ag_1|catalog'));
    assert.ok(targets.includes('agent:ag_2|live-graph'), JSON.stringify(res.edges));
    assert.ok(res.nodes.some((n: any) => n.catalogRef === 'agent:ag_1' && n.depth === 1));
  });

  test('upstream is a bounded scan and says so', async () => {
    route('GET', /^\/v2\/catalog\/search$/, {
      body: { items: [summary('widget', 'wd_1', 'Help widget', 'observed'), summary('chatflow', 'cf_1', 'Intake', 'observed')], nextCursor: null, degraded: [] },
    });
    route('GET', /^\/v2\/catalog\/widget\/wd_1$/, { body: detailFor('widget:wd_1', { dependencies: [{ catalogRef: 'agent:ag_1', relation: 'binds' }] }) });
    route('GET', /^\/v2\/catalog\/chatflow\/cf_1$/, { body: detailFor('chatflow:cf_1', { dependencies: [] }) });
    const res = await run('swfte_trace_dependencies', { catalogRef: 'agent:ag_1', direction: 'upstream', maxScan: 10 });
    assert.equal(seen[0]!.query.scope, 'workspace');
    assert.deepEqual(res.dependents.map((d: any) => d.catalogRef), ['widget:wd_1']);
    assert.equal(res.scanned, 2);
    assert.match(res.note, /bounded scan/);
  });
});

/* ── scaffold ────────────────────────────────────────────────────────────── */

function contractRoutes(ref = 'workflow:wf_1', contract: any = WF_CONTRACT, detail: any = detailFor(ref)) {
  const { kind, id } = parseCatalogRef(ref);
  route('GET', new RegExp(`^/v2/catalog/${kind}/${id}$`), { body: detail });
  route('GET', new RegExp(`^/v2/catalog/${kind}/${id}/contract$`), { body: contract });
}

/** Type-check a generated TypeScript file under strict settings, the way a consuming project would. */
function typecheck(file: string): string[] {
  const program = ts.createProgram([file], {
    strict: true,
    noUncheckedIndexedAccess: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    noEmit: true,
    skipLibCheck: true,
  });
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('swfte_scaffold_client', () => {
  test('writes a typed TypeScript client, .env.example and swfte.json lock', async () => {
    contractRoutes();
    const res = await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'src/swfte' });
    const paths = res.files.map((f: any) => f.path).sort();
    assert.deepEqual(paths, ['src/swfte/.env.example', 'src/swfte/invoice-extractor.ts', 'src/swfte/swfte.json']);
    const client = readFileSync(join(tmp, 'src/swfte/invoice-extractor.ts'), 'utf8');
    assert.match(client, /export async function invokeInvoiceExtractor\(/);
    assert.match(client, /invoiceUrl: string;/);
    assert.match(client, /"line-items"\?: Array<\{/);
    assert.match(client, /currency\?: "usd" \| "eur";/);
    assert.match(client, /class\?: string \| null;/);
    assert.match(client, /export type InvoiceExtractorOutput = unknown;/);
    assert.match(client, /\/v2\/workflows\/executions\/\{executionId\}\/status/);
    // A crafted description cannot close the JSDoc comment and inject code.
    assert.ok(!client.includes('*/ console.log'), 'comment terminator was not escaped');
    assert.ok(!client.includes(CREDENTIAL));
    assert.deepEqual(typecheck(join(tmp, 'src/swfte/invoice-extractor.ts')), []);

    const env = readFileSync(join(tmp, 'src/swfte/.env.example'), 'utf8');
    for (const k of ['SWFTE_API_KEY=', 'SWFTE_BASE_URL=', 'SWFTE_WORKSPACE_ID=']) assert.ok(env.includes(`\n${k}\n`) || env.includes(`${k}\n`), k);
    assert.ok(!env.includes(CREDENTIAL));

    const lock = JSON.parse(readFileSync(join(tmp, 'src/swfte/swfte.json'), 'utf8'));
    assert.equal(lock.artifacts.length, 1);
    assert.equal(lock.artifacts[0].catalogRef, 'workflow:wf_1');
    assert.equal(lock.artifacts[0].updatedAt, '2026-09-21T00:00:00Z');
    assert.equal(lock.artifacts[0].contractHash, contractHash(WF_CONTRACT as never));
    assert.deepEqual(lock.artifacts[0].files, ['src/swfte/invoice-extractor.ts']);
  });

  test('re-scaffolding an unchanged contract is a no-op, not an overwrite', async () => {
    contractRoutes();
    await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'out' });
    const again = await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'out' });
    assert.equal(again.files.find((f: any) => f.path === 'out/invoice-extractor.ts').action, 'unchanged');
    assert.equal(again.contractChanged, undefined);
  });

  test('refuses to overwrite an existing file without force, writing nothing', async () => {
    contractRoutes();
    mkdirSync(join(tmp, 'out'));
    writeFileSync(join(tmp, 'out/invoice-extractor.ts'), '// my hand-written code\n');
    await assert.rejects(
      run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'out' }),
      /Refusing to overwrite existing file\(s\): out\/invoice-extractor.ts/
    );
    assert.equal(readFileSync(join(tmp, 'out/invoice-extractor.ts'), 'utf8'), '// my hand-written code\n');
    assert.equal(existsSync(join(tmp, 'out/swfte.json')), false, 'lock was written despite the refusal');
    assert.equal(existsSync(join(tmp, 'out/.env.example')), false);

    const forced = await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'out', force: true });
    assert.equal(forced.files.find((f: any) => f.path === 'out/invoice-extractor.ts').action, 'overwrite');
  });

  test('refuses an overwrite of a lock file that is not JSON', async () => {
    contractRoutes();
    mkdirSync(join(tmp, 'out'));
    writeFileSync(join(tmp, 'out/swfte.json'), 'not json');
    await assert.rejects(
      run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'out' }),
      /swfte.json \(exists but is not a JSON object\)/
    );
    assert.equal(readFileSync(join(tmp, 'out/swfte.json'), 'utf8'), 'not json');
  });

  test('merges .env.example and the lock instead of replacing them', async () => {
    contractRoutes();
    contractRoutes('agent:ag_1', {
      catalogRef: 'agent:ag_1',
      invoke: { method: 'POST', path: '/v1/agents/ag_1/chat/{userId}', auth: 'api_key', async: false, statusPath: null },
      inputSchema: {},
      outputSchema: {},
    }, detailFor('agent:ag_1', { name: 'Support Triage' }));
    mkdirSync(join(tmp, 'out'));
    writeFileSync(join(tmp, 'out/.env.example'), 'DATABASE_URL=\nSWFTE_API_KEY=keep-me-as-is\n');
    await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'out' });
    const res = await run('swfte_scaffold_client', { catalogRef: 'agent:ag_1', language: 'typescript', targetDir: 'out' });
    const env = readFileSync(join(tmp, 'out/.env.example'), 'utf8');
    assert.match(env, /^DATABASE_URL=$/m);
    assert.match(env, /^SWFTE_API_KEY=keep-me-as-is$/m);
    assert.equal(env.match(/^SWFTE_BASE_URL=/gm)?.length, 1);
    assert.deepEqual(res.env.kept.sort(), ['SWFTE_API_KEY', 'SWFTE_BASE_URL', 'SWFTE_WORKSPACE_ID']);
    const lock = JSON.parse(readFileSync(join(tmp, 'out/swfte.json'), 'utf8'));
    assert.deepEqual(lock.artifacts.map((a: any) => a.catalogRef), ['agent:ag_1', 'workflow:wf_1']);
    // Agent contracts with no schemas fall back to the documented chat shape.
    const agent = readFileSync(join(tmp, 'out/support-triage.ts'), 'utf8');
    assert.match(agent, /export async function chatSupportTriage\(/);
    assert.match(agent, /message: string;/);
    assert.match(agent, /userId\?: string;/);
    assert.deepEqual(typecheck(join(tmp, 'out/support-triage.ts')), []);
  });

  test('reports contract drift against the lock', async () => {
    contractRoutes();
    await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'out' });
    routes = [];
    contractRoutes('workflow:wf_1', { ...WF_CONTRACT, outputSchema: { type: 'object', properties: { total: { type: 'number' } } } });
    const res = await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'out', force: true });
    assert.ok(res.contractChanged);
    assert.notEqual(res.contractChanged.from, res.contractChanged.to);
  });

  test('writes a Python client that compiles', async () => {
    contractRoutes();
    const res = await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'python', targetDir: 'py' });
    assert.ok(res.files.some((f: any) => f.path === 'py/invoice_extractor.py'));
    const py = readFileSync(join(tmp, 'py/invoice_extractor.py'), 'utf8');
    assert.match(py, /^def invoke_invoice_extractor\(/m);
    assert.match(py, /"invoiceUrl": str,/);
    assert.match(py, /"currency": Literal\["usd", "eur"\],/);
    assert.match(py, /"class": Optional\[str\]|"class": Union\[str, None\]/);
    assert.ok(!py.includes(CREDENTIAL));
    let python = '';
    try {
      python = execFileSync('python3', ['--version'], { encoding: 'utf8' });
    } catch {
      python = '';
    }
    if (python) {
      execFileSync('python3', ['-c', `import ast,sys; ast.parse(open(sys.argv[1]).read())`, join(tmp, 'py/invoice_extractor.py')]);
      // Importing executes the TypedDict definitions for real.
      execFileSync('python3', ['-c', 'import invoice_extractor as m; assert m.CATALOG_REF == "workflow:wf_1"'], { cwd: join(tmp, 'py') });
    }
  });

  test('refuses path traversal outside the working directory before any request', async () => {
    contractRoutes();
    await assert.rejects(
      run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: '../escape' }),
      /outside the working directory/
    );
    await assert.rejects(
      run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'a/../../escape' }),
      /outside the working directory/
    );
    await assert.rejects(
      run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: join(tmpdir(), 'elsewhere-abs') }),
      /outside the working directory/
    );
    assert.equal(seen.length, 0, 'a confined path must fail before spending a request');
    assert.equal(existsSync(join(tmp, '..', 'escape')), false);
  });

  test('refuses a symlink that leads outside the working directory', async () => {
    contractRoutes();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-outside-')));
    try {
      symlinkSync(outside, join(tmp, 'link'));
      await assert.rejects(
        run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'link/sub' }),
        /symlink/
      );
      assert.equal(existsSync(join(outside, 'sub')), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('refuses to write content carrying a secret', async () => {
    contractRoutes('workflow:wf_1', WF_CONTRACT, detailFor('workflow:wf_1', { description: `Call with ${CREDENTIAL}` }));
    await assert.rejects(
      run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'out' }),
      /configured Swfte credential/
    );
    assert.equal(existsSync(join(tmp, 'out')), false);
    routes = [];
    contractRoutes('workflow:wf_1', WF_CONTRACT, detailFor('workflow:wf_1', { name: 'Uses sk-swfte-AAAAAAAAAAAAAAAA' }));
    await assert.rejects(
      run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'python', targetDir: 'out' }),
      /secret-shaped token/
    );
  });
});

describe('hosted (inline) mode and file-safety edge cases', () => {
  const hostedRun = (name: string, input: unknown) =>
    tool(name).execute(input as never, { ...ctx(), localFilesystem: false }) as Promise<any>;

  test('a hosted server returns files inline and writes nothing to its own disk', async () => {
    contractRoutes();
    const res = await hostedRun('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'src/swfte' });
    assert.equal(res.inline, true);
    const client = res.files.find((f: any) => f.path === 'src/swfte/invoice-extractor.ts');
    assert.match(client.content, /export async function invokeInvoiceExtractor/);
    assert.ok(res.files.every((f: any) => typeof f.content === 'string'));
    assert.equal(existsSync(join(tmp, 'src')), false, 'hosted mode wrote to the server disk');
    // Confinement still applies to the paths it hands back.
    await assert.rejects(hostedRun('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: '../outside' }), /outside/);
    await assert.rejects(hostedRun('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: '/etc' }), /relative to the project root/);
  });

  test('a directory merely starting with two dots is not traversal', async () => {
    contractRoutes();
    const res = await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: '..generated' });
    assert.ok(res.files.some((f: any) => f.path === '..generated/invoice-extractor.ts'));
  });

  test('line separators cannot break out of a generated comment', async () => {
    contractRoutes('workflow:wf_1', WF_CONTRACT, detailFor('workflow:wf_1', { description: 'ok\u2028process.exit(1)' }));
    await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', language: 'typescript', targetDir: 'out' });
    const client = readFileSync(join(tmp, 'out/invoice-extractor.ts'), 'utf8');
    assert.ok(!client.includes('\u2028'), 'raw U+2028 reached a // comment');
    assert.deepEqual(typecheck(join(tmp, 'out/invoice-extractor.ts')), []);
  });

  test('an analytics endpoint that is not a clean http(s) URL is replaced by the default', async () => {
    route('GET', /^\/v2\/actions\/act_1$/, { body: action({ status: 'EXECUTED', result: { appKey: 'swfte_pk_ok', endpoint: 'javascript:alert(1) #x' } }) });
    const res = await run('swfte_wire_analytics', { catalogRef: 'application:app_1', targetDir: 'src', actionId: 'act_1', framework: 'node' });
    assert.equal(res.endpoint, 'https://api.swfte.com/agents/v1/analytics/web/ingest');
    assert.match(readFileSync(join(tmp, '.env'), 'utf8'), /^SWFTE_ANALYTICS_ENDPOINT=https:\/\/api\.swfte\.com\/agents\/v1\/analytics\/web\/ingest$/m);
  });
});

describe('schema to type edge cases', () => {
  test('empty, untyped and $ref schemas degrade to the loose type', () => {
    assert.equal(isUntyped({}), true);
    assert.equal(isUntyped({ description: 'only annotations' }), true);
    assert.equal(tsType({}), 'unknown');
    assert.equal(tsType(undefined), 'unknown');
    assert.equal(tsType({ $ref: '#/defs/x' }), 'unknown');
    assert.equal(tsType({ type: 'object' }), 'Record<string, unknown>');
    assert.equal(tsType({ type: 'object', additionalProperties: { type: 'number' } }), 'Record<string, number>');
    assert.equal(tsType({ type: 'array' }), 'Array<unknown>');
    assert.equal(tsType({ anyOf: [{ type: 'string' }, {}] }), '(unknown)');
    assert.equal(tsType({ type: 'integer', nullable: true }), 'number | null');
    assert.equal(tsType({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] }), '[string, number]');
    assert.equal(tsType({ enum: ['a', { weird: true }] }), 'unknown');
  });

  test('deeply nested schemas stop at a depth limit instead of recursing forever', () => {
    let s: any = { type: 'string' };
    for (let i = 0; i < 30; i++) s = { type: 'object', properties: { next: s } };
    assert.match(tsType(s), /unknown/);
  });

  test('Python types handle keywords, odd keys and empty objects', () => {
    const py = new PyTypes();
    const name = py.typedDict(
      { type: 'object', properties: { 'from': { type: 'string' }, 'odd key"': { type: 'boolean' }, nested: { type: 'object' } }, required: ['from'] },
      'Input',
      0,
      'Input'
    );
    assert.equal(name, 'Input');
    const src = py.defs.join('\n');
    assert.match(src, /"from": str,/);
    assert.match(src, /"odd key\\"": bool,/);
    assert.match(src, /"nested": Dict\[str, Any\],/);
    assert.match(src, /class Input\(_InputRequired, _InputOptional\):/);
    assert.equal(py.type({}, 'X'), 'Any');
  });
});

describe('swfte_embed_widget', () => {
  const widgetContract = (html: string | null) => ({
    catalogRef: 'widget:wd_1',
    invoke: { method: 'POST', path: '/v1/widgets/wd_1/public/invoke', auth: 'public', async: false, statusPath: null },
    inputSchema: {},
    outputSchema: {},
    embed: html === null ? null : { html },
  });

  test('writes the embed markup into a confined file', async () => {
    route('GET', /^\/v2\/catalog\/widget\/wd_1\/contract$/, { body: widgetContract('<script src="https://cdn.swfte.com/w.js" data-widget="wd_1"></script>') });
    const res = await run('swfte_embed_widget', { catalogRef: 'widget:wd_1', targetFile: 'public/support.html' });
    assert.equal(res.embeddable, true);
    assert.equal(res.written[0].path, 'public/support.html');
    assert.match(readFileSync(join(tmp, 'public/support.html'), 'utf8'), /data-widget="wd_1"/);
  });

  test('refuses to overwrite an existing page without force, and targets outside cwd', async () => {
    route('GET', /^\/v2\/catalog\/widget\/wd_1\/contract$/, { body: widgetContract('<div id="w"></div>') });
    writeFileSync(join(tmp, 'index.html'), '<html>mine</html>');
    await assert.rejects(run('swfte_embed_widget', { catalogRef: 'widget:wd_1', targetFile: 'index.html' }), /Refusing to overwrite/);
    assert.equal(readFileSync(join(tmp, 'index.html'), 'utf8'), '<html>mine</html>');
    await assert.rejects(run('swfte_embed_widget', { catalogRef: 'widget:wd_1', targetFile: '../outside.html' }), /outside the working directory/);
  });

  test('no embed is reported; a secret in markup is refused', async () => {
    route('GET', /^\/v2\/catalog\/agent\/ag_1\/contract$/, { body: { ...widgetContract(null), catalogRef: 'agent:ag_1' } });
    assert.equal((await run('swfte_embed_widget', { catalogRef: 'agent:ag_1' })).embeddable, false);
    routes = [];
    route('GET', /^\/v2\/catalog\/widget\/wd_1\/contract$/, { body: widgetContract('<script data-key="sk-swfte-LEAKEDLEAKED123"></script>') });
    await assert.rejects(run('swfte_embed_widget', { catalogRef: 'widget:wd_1' }), /secret-shaped/);
  });
});

/* ── actions ─────────────────────────────────────────────────────────────── */

const action = (over: Record<string, unknown> = {}) => ({
  id: 'act_1',
  capability: 'analytics.enable',
  target: { kind: 'application', id: 'app_1' },
  params: {},
  environment: 'development',
  status: 'PROPOSED',
  requiresApproval: true,
  requestedBy: 'u1',
  approvedBy: null,
  expiresAt: '2026-09-23T00:00:00Z',
  result: null,
  createdAt: '2026-09-22T00:00:00Z',
  ...over,
});

describe('approval-gated actions', () => {
  test('swfte_request_approval posts the contract body', async () => {
    route('POST', /^\/v2\/actions$/, (req) => ({ status: 201, body: action({ capability: req.body.capability, target: req.body.target, environment: req.body.environment }) }));
    const res = await run('swfte_request_approval', { capability: 'workflow.deploy', target: 'workflow:wf_1', environment: 'staging' });
    assert.equal(seen[0]!.method, 'POST');
    assert.deepEqual(seen[0]!.body, { capability: 'workflow.deploy', target: { kind: 'workflow', id: 'wf_1' }, params: {}, environment: 'staging' });
    assert.equal(res.status, 'PROPOSED');
    assert.match(res.instructions, /approve action act_1/);
  });

  test('execute surfaces 409 as NOT_APPROVED with the current status', async () => {
    route('POST', /^\/v2\/actions\/act_1\/execute$/, { status: 409, body: { code: 'ACTION_NOT_APPROVED', message: 'not approved' } });
    route('GET', /^\/v2\/actions\/act_1$/, { body: action() });
    const res = await run('swfte_execute_approved_action', { actionId: 'act_1' });
    assert.equal(res.executed, false);
    assert.equal(res.blocked, 'NOT_APPROVED');
    assert.equal(res.status, 409);
    assert.match(res.message, /status PROPOSED/);
    assert.match(res.nextStep, /Do not try to approve it yourself/);
    // Exactly one execute attempt: never retried.
    assert.equal(seen.filter((s) => s.method === 'POST').length, 1);
  });

  test('execute surfaces 410 as EXPIRED', async () => {
    route('POST', /^\/v2\/actions\/act_1\/execute$/, { status: 410, body: { code: 'ACTION_EXPIRED' } });
    const res = await run('swfte_execute_approved_action', { actionId: 'act_1' });
    assert.equal(res.blocked, 'EXPIRED');
    assert.equal(res.status, 410);
    assert.match(res.nextStep, /swfte_request_approval/);
  });

  test('execute returns the executed action with secret fields redacted', async () => {
    route('POST', /^\/v2\/actions\/act_1\/execute$/, { body: action({ status: 'EXECUTED', result: { appKey: 'swfte_pk_abc', runtimeToken: 'rt_secret_value' } }) });
    const res = await run('swfte_execute_approved_action', { actionId: 'act_1' });
    assert.equal(res.executed, true);
    assert.equal(res.result.appKey, 'swfte_pk_abc');
    assert.match(res.result.runtimeToken, /redacted/);
  });

  test('status reads one action or lists by status', async () => {
    route('GET', /^\/v2\/actions\/act_1$/, { body: action({ status: 'APPROVED', approvedBy: 'owner' }) });
    route('GET', /^\/v2\/actions$/, { body: [action(), action({ id: 'act_2' })] });
    const one = await run('swfte_get_action_status', { actionId: 'act_1' });
    assert.match(one.instructions, /Approved by owner/);
    const list = await run('swfte_get_action_status', { status: 'PROPOSED' });
    assert.equal(seen[1]!.query.status, 'PROPOSED');
    assert.equal(list.count, 2);
  });

  test('there is no tool that approves an action', () => {
    assert.equal(allTools.some((t) => /approve_action|actions_approve/.test(t.name)), false);
  });
});

/* ── wiring ──────────────────────────────────────────────────────────────── */

describe('swfte_wire_analytics', () => {
  test('phase 1 proposes analytics.enable and writes nothing', async () => {
    route('POST', /^\/v2\/actions$/, (req) => ({ status: 201, body: action({ target: req.body.target }) }));
    const res = await run('swfte_wire_analytics', { catalogRef: 'application:app_1', targetDir: 'src/lib' });
    assert.deepEqual(seen[0]!.body, { capability: 'analytics.enable', target: { kind: 'application', id: 'app_1' }, params: {}, environment: 'development' });
    assert.equal(res.wired, false);
    assert.equal(res.stage, 'AWAITING_APPROVAL');
    assert.match(res.nextStep, /actionId:"act_1"/);
    assert.equal(existsSync(join(tmp, 'src')), false);
  });

  test('phase 2 executes the approved action and writes the init module and env', async () => {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }));
    writeFileSync(join(tmp, '.gitignore'), '.env*\n');
    route('GET', /^\/v2\/actions\/act_1$/, { body: action({ status: 'APPROVED' }) });
    route('POST', /^\/v2\/actions\/act_1\/execute$/, {
      body: action({ status: 'EXECUTED', result: { appKey: 'swfte_pk_live123', endpoint: 'https://api.swfte.com/agents/v1/analytics/web/ingest' } }),
    });
    const res = await run('swfte_wire_analytics', { catalogRef: 'application:app_1', targetDir: 'src/lib', actionId: 'act_1' });
    assert.equal(res.wired, true);
    assert.equal(res.framework, 'next');
    const mod = readFileSync(join(tmp, 'src/lib/swfte-analytics.tsx'), 'utf8');
    assert.match(mod, /from '@swfte\/analytics\/react'/);
    assert.match(mod, /NEXT_PUBLIC_SWFTE_ANALYTICS_APP_KEY/);
    assert.ok(!mod.includes('swfte_pk_live123'), 'the key belongs in env, not source');
    const envLocal = readFileSync(join(tmp, '.env.local'), 'utf8');
    assert.match(envLocal, /^SWFTE_ANALYTICS_APP_KEY=swfte_pk_live123$/m);
    const example = readFileSync(join(tmp, '.env.example'), 'utf8');
    assert.match(example, /^SWFTE_ANALYTICS_APP_KEY=$/m);
    assert.equal(res.warning, undefined);
  });

  test('refuses to write a key that is not publishable', async () => {
    route('GET', /^\/v2\/actions\/act_1$/, { body: action({ status: 'APPROVED' }) });
    route('POST', /^\/v2\/actions\/act_1\/execute$/, { body: action({ status: 'EXECUTED', result: { appKey: 'sk-swfte-notpublishable' } }) });
    const res = await run('swfte_wire_analytics', { catalogRef: 'application:app_1', targetDir: 'src/lib', actionId: 'act_1', framework: 'node' });
    assert.equal(res.wired, false);
    assert.equal(res.stage, 'REFUSED_NON_PUBLISHABLE_KEY');
    assert.equal(existsSync(join(tmp, '.env')), false);
  });

  test('an actionId for a different capability or app is rejected', async () => {
    route('GET', /^\/v2\/actions\/act_1$/, { body: action({ capability: 'app.payments.enable' }) });
    await assert.rejects(
      run('swfte_wire_analytics', { catalogRef: 'application:app_1', targetDir: 'x', actionId: 'act_1' }),
      /is app.payments.enable/
    );
  });

  test('appName resolves to exactly one application', async () => {
    route('GET', /^\/v2\/catalog\/search$/, { body: { items: [summary('application', 'app_7', 'Acme Portal', 'observed')], nextCursor: null, degraded: [] } });
    route('POST', /^\/v2\/actions$/, (req) => ({ status: 201, body: action({ target: req.body.target }) }));
    const res = await run('swfte_wire_analytics', { appName: 'acme portal', targetDir: 'src' });
    assert.equal(seen[0]!.query.kinds, 'application');
    assert.deepEqual(seen[1]!.body.target, { kind: 'application', id: 'app_7' });
    assert.equal(res.stage, 'AWAITING_APPROVAL');
  });

  test('a non-application catalogRef is refused, and traversal targetDir fails first', async () => {
    await assert.rejects(run('swfte_wire_analytics', { catalogRef: 'workflow:wf_1', targetDir: 'x' }), /applies to applications/);
    await assert.rejects(run('swfte_wire_analytics', { catalogRef: 'application:app_1', targetDir: '../../outside' }), /outside the working directory/);
    assert.equal(seen.length, 0);
  });
});

describe('swfte_wire_payments', () => {
  test('phase 1 proposes app.payments.enable with the onboarding urls', async () => {
    route('POST', /^\/v2\/actions$/, (req) => ({ status: 201, body: action({ capability: req.body.capability, target: req.body.target, params: req.body.params }) }));
    const res = await run('swfte_wire_payments', {
      catalogRef: 'application:app_1',
      targetDir: 'server',
      returnUrl: 'https://acme.test/done',
      refreshUrl: 'https://acme.test/retry',
    });
    assert.deepEqual(seen[0]!.body, {
      capability: 'app.payments.enable',
      target: { kind: 'application', id: 'app_1' },
      params: { returnUrl: 'https://acme.test/done', refreshUrl: 'https://acme.test/retry' },
      environment: 'development',
    });
    assert.equal(res.stage, 'AWAITING_APPROVAL');
  });

  test('phase 2 writes a server-side checkout helper and never the runtime token', async () => {
    route('GET', /^\/v2\/actions\/act_9$/, { body: action({ id: 'act_9', capability: 'app.payments.enable', status: 'APPROVED' }) });
    route('POST', /^\/v2\/actions\/act_9\/execute$/, {
      body: action({ id: 'act_9', capability: 'app.payments.enable', status: 'EXECUTED', result: { runtimeToken: 'rt_live_SECRETSECRET', onboardingUrl: 'https://connect.stripe.com/x' } }),
    });
    const res = await run('swfte_wire_payments', { catalogRef: 'application:app_1', targetDir: 'server', actionId: 'act_9' });
    assert.equal(res.wired, true);
    const helper = readFileSync(join(tmp, 'server/swfte-checkout.ts'), 'utf8');
    assert.match(helper, /\/v2\/app-runtime\/payments\/checkout-session/);
    assert.match(helper, /'X-App-Runtime-Token': token/);
    assert.match(helper, /SWFTE_APP_RUNTIME_TOKEN/);
    assert.deepEqual(typecheck(join(tmp, 'server/swfte-checkout.ts')), []);
    const example = readFileSync(join(tmp, '.env.example'), 'utf8');
    assert.match(example, /^SWFTE_APP_RUNTIME_TOKEN=$/m);
    for (const f of ['server/swfte-checkout.ts', '.env.example']) {
      assert.ok(!readFileSync(join(tmp, f), 'utf8').includes('rt_live_SECRETSECRET'), `${f} leaked the runtime token`);
    }
    assert.ok(!JSON.stringify(res).includes('rt_live_SECRETSECRET'), 'the tool response echoed the runtime token');
    assert.equal(res.onboardingUrl, 'https://connect.stripe.com/x');
  });

  test('a 409 while executing is surfaced as blocked, with nothing written', async () => {
    route('GET', /^\/v2\/actions\/act_9$/, { body: action({ id: 'act_9', capability: 'app.payments.enable', status: 'APPROVED' }) });
    route('POST', /^\/v2\/actions\/act_9\/execute$/, { status: 409, body: { code: 'CONFLICT' } });
    const res = await run('swfte_wire_payments', { catalogRef: 'application:app_1', targetDir: 'server', actionId: 'act_9' });
    assert.equal(res.wired, false);
    assert.equal(res.blocked.blocked, 'NOT_APPROVED');
    assert.equal(existsSync(join(tmp, 'server')), false);
  });
});

/* ── build + run ─────────────────────────────────────────────────────────── */

describe('reuse-first build and published runs', () => {
  test('swfte_build tells the model to call swfte_find_existing first', () => {
    assert.match(tool('swfte_build').description, /^CALL swfte_find_existing FIRST/);
  });

  test('a published workflow runs through /invoke', async () => {
    route('POST', /^\/v2\/workflows\/wf_1\/invoke$/, { status: 202, body: { executionId: 'ex_1' } });
    route('GET', /^\/v2\/workflow-executions\/ex_1$/, { body: { status: 'COMPLETED', outputData: { total: 3 } } });
    const res: any = await getAdapter('workflow').run!(new SwfteClient(config()), 'wf_1', { inputs: { a: 1 } });
    assert.equal(seen[0]!.path, '/v2/workflows/wf_1/invoke');
    assert.deepEqual(seen[0]!.body, { inputs: { a: 1 } });
    assert.equal(res.ok, true);
    assert.equal(res.raw.path, 'invoke');
    assert.equal(seen.some((s) => s.path.endsWith('/execute')), false);
  });

  test('a workflow without a published snapshot keeps the /execute then draft path', async () => {
    route('POST', /^\/v2\/workflows\/wf_1\/invoke$/, { status: 409, body: { error: 'PUBLISHED_SNAPSHOT_UNAVAILABLE' } });
    route('POST', /^\/v2\/workflows\/wf_1\/execute$/, (req) =>
      req.body.testingFlag ? { status: 202, body: { executionId: 'ex_d' } } : { status: 409, body: { error: 'WORKFLOW_NOT_PUBLISHED' } }
    );
    route('GET', /^\/v2\/workflow-executions\/ex_d$/, { body: { status: 'COMPLETED', outputData: {} } });
    const res: any = await getAdapter('workflow').run!(new SwfteClient(config()), 'wf_1', { inputs: {} });
    assert.deepEqual(
      seen.filter((s) => s.method === 'POST').map((s) => s.path),
      ['/v2/workflows/wf_1/invoke', '/v2/workflows/wf_1/execute', '/v2/workflows/wf_1/execute']
    );
    assert.match(res.raw.note, /draft test path/);
  });

  test('any other /invoke failure is not papered over by a fallback', async () => {
    route('POST', /^\/v2\/workflows\/wf_1\/invoke$/, { status: 402, body: { error: 'BILLING_BLOCKED' } });
    await assert.rejects(getAdapter('workflow').run!(new SwfteClient(config()), 'wf_1', { inputs: {} }), /BILLING_BLOCKED|402/);
    assert.equal(seen.length, 1);
  });
});

/* ── resources + prompts ─────────────────────────────────────────────────── */

async function handle(server: any, method: string, params: unknown) {
  const handler = server._requestHandlers.get(method);
  assert.ok(handler, `${method} handler not registered`);
  return handler({ method, params }, {});
}

describe('MCP resources and prompts', () => {
  test('capabilities resource is local and lists the catalog surface', async () => {
    const server = buildServer({ config: config() });
    const list = await handle(server, 'resources/list', {});
    assert.ok(list.resources.some((r: any) => r.uri === 'swfte://capabilities'));
    const templates = await handle(server, 'resources/templates/list', {});
    assert.equal(templates.resourceTemplates[0].uriTemplate, 'swfte://catalog/{kind}/{id}');
    const read = await handle(server, 'resources/read', { uri: 'swfte://capabilities' });
    const body = JSON.parse(read.contents[0].text);
    assert.ok(body.catalog.kinds.includes('solution'));
    assert.ok(body.actions.capabilities.includes('analytics.enable'));
    assert.ok(body.tools.some((t: any) => t.name === 'swfte_find_existing'));
    assert.equal(seen.length, 0, 'capabilities must not touch the network');
  });

  test('catalog resource returns the context package', async () => {
    route('GET', /^\/v2\/catalog\/workflow\/wf_1$/, { body: detailFor('workflow:wf_1') });
    route('GET', /^\/v2\/catalog\/workflow\/wf_1\/contract$/, { body: WF_CONTRACT });
    const server = buildServer({ config: config() });
    const read = await handle(server, 'resources/read', { uri: 'swfte://catalog/workflow/wf_1' });
    assert.equal(JSON.parse(read.contents[0].text).catalogRef, 'workflow:wf_1');
    await assert.rejects(handle(server, 'resources/read', { uri: 'swfte://nope' }), /Unknown resource/);
    assert.equal(catalogRefFromUri('swfte://catalog/workflow/a%2Fb'), null);
  });

  test('prompts list and render the three recipes', async () => {
    const server = buildServer({ config: config() });
    const list = await handle(server, 'prompts/list', {});
    assert.deepEqual(list.prompts.map((p: any) => p.name).sort(), ['bake-into-codebase', 'reuse-then-build', 'ship-with-analytics-and-payments']);
    const p = await handle(server, 'prompts/get', { name: 'reuse-then-build', arguments: { goal: 'invoice extraction' } });
    assert.match(p.messages[0].content.text, /swfte_find_existing/);
    const ship = await handle(server, 'prompts/get', { name: 'ship-with-analytics-and-payments', arguments: { catalogRef: 'application:app_1' } });
    assert.match(ship.messages[0].content.text, /swfte_deploy/);
    await assert.rejects(handle(server, 'prompts/get', { name: 'reuse-then-build', arguments: {} }), /requires: goal/);
    await assert.rejects(handle(server, 'prompts/get', { name: 'nope' }), /Unknown prompt/);
  });
});
