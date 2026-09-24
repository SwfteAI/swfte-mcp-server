/**
 * Developer path (CONTRACT rev 8b): version pins, `swfte init`, `swfte dev`,
 * deny-by-default adapters, credentials never on the command line or on disk.
 *
 * Mocked global fetch for the Swfte API; the dev server is real (127.0.0.1,
 * ephemeral port) and the generated clients are imported and run for real.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { effectiveContractHash } from '../src/catalog.js';
import { runCli } from '../src/cli.js';
import { exampleOf, invokeFromClient, startDevServer } from '../src/devserver.js';

const PAT = 'pat_supersecretcredential123';

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: any;
}
type Reply = { status?: number; body?: unknown };
let seen: Seen[] = [];
let routes: Array<[string, RegExp, (req: Seen) => Reply]> = [];
const realFetch = globalThis.fetch;

function route(method: string, pattern: RegExp, handler: ((req: Seen) => Reply) | Reply) {
  routes.unshift([method, pattern, typeof handler === 'function' ? handler : () => handler]);
}

/** Mocked Swfte API. Requests to 127.0.0.1 (the dev server) go to the real network. */
function installFetch() {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const req: Seen = { method: String(init.method ?? 'GET'), path: url.pathname.replace(/^\/agents/, ''), query: Object.fromEntries(url.searchParams.entries()), headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(req);
    const hit = routes.find(([m, re]) => m === req.method && re.test(req.path));
    if (!hit) return new Response(JSON.stringify({ code: 'NO_ROUTE', message: `${req.method} ${req.path}` }), { status: 404 });
    const out = hit[2](req);
    return new Response(out.body === undefined ? '' : JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const WF_CONTRACT = {
  catalogRef: 'workflow:wf_1',
  invoke: { method: 'POST', path: '/v2/workflows/wf_1/invoke', auth: 'api_key', async: true, statusPath: '/v2/workflows/executions/{executionId}/status' },
  inputSchema: { type: 'object', properties: { lead: { type: 'string' }, region: { enum: ['eu', 'us'] } }, required: ['lead'] },
  outputSchema: { type: 'object', properties: { score: { type: 'number', examples: [87] }, tier: { type: 'string', enum: ['A', 'B'] } } },
  snippets: {},
  embed: null,
  version: 'v3',
};
const AGENT_CONTRACT = {
  catalogRef: 'agent:ag_1',
  invoke: { method: 'POST', path: '/v1/agents/ag_1/chat/{userId}', auth: 'api_key', async: false, statusPath: null },
  inputSchema: {},
  outputSchema: {},
};

let contract: any;
let published: Map<string, any>;
let unpublished: Set<string>;

function catalogRoutes() {
  route('GET', /^\/v2\/catalog\/workflow\/wf_1$/, () => ({ body: { catalogRef: 'workflow:wf_1', kind: 'workflow', id: 'wf_1', name: 'Lead Scorer', scope: 'workspace', facets: [], evidence: { level: 'observed' }, updatedAt: '2026-09-21T00:00:00Z' } }));
  route('GET', /^\/v2\/catalog\/workflow\/wf_1\/contract$/, () => ({ body: contract }));
  route('GET', /^\/v2\/catalog\/agent\/ag_1$/, () => ({ body: { catalogRef: 'agent:ag_1', kind: 'agent', id: 'ag_1', name: 'Support Triage', scope: 'workspace', facets: [], evidence: { level: 'observed' } } }));
  route('GET', /^\/v2\/catalog\/agent\/ag_1\/contract$/, () => ({ body: AGENT_CONTRACT }));
  route('GET', /^\/v2\/workflows\/wf_1\/versions\/[^/]+\/schema$/, (req) => {
    const version = decodeURIComponent(req.path.split('/')[5]!);
    if (unpublished.has(version) || (version !== contract.version && !published.has(version))) return { status: 404, body: { error: 'VERSION_NOT_PUBLISHED', message: `Version ${version} was never published` } };
    if (!published.has(version)) published.set(version, structuredClone(contract));
    const c = published.get(version);
    return { body: { workflowId: 'wf_1', version, published: true, inputSchema: c.inputSchema, outputSchema: c.outputSchema, invoke: { ...c.invoke, path: `/v2/workflows/wf_1/versions/${version}/invoke` } } };
  });
  route('GET', /^\/v2\/catalog\/upgrades$/, (req) => ({
    body: {
      items: String(req.query.refs ?? '').split(',').filter(Boolean).map((pin) => {
        const at = pin.lastIndexOf(':');
        const ref = pin.slice(0, at);
        const latest = ref === 'workflow:wf_1' ? effectiveContractHash(contract).hash : pin.slice(at + 1);
        return { catalogRef: ref, currentHash: pin.slice(at + 1), latestHash: latest, breaking: false, capabilityChanges: [], requiresReapproval: false, latestVersion: contract.version };
      }),
    },
  }));
}

let tmp = '';
beforeEach(() => {
  seen = [];
  routes = [];
  contract = structuredClone(WF_CONTRACT);
  published = new Map();
  unpublished = new Set();
  installFetch();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-devpath-')));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
});

async function cli(args: string[], env: Record<string, string | undefined> = { SWFTE_API_KEY: PAT }, extra: { waitForExit?: () => Promise<void> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l), env: env as NodeJS.ProcessEnv, cwd: tmp, ...extra });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const read = (rel: string) => readFileSync(join(tmp, rel), 'utf8');
const write = (rel: string, content: string) => {
  mkdirSync(join(tmp, rel, '..'), { recursive: true });
  writeFileSync(join(tmp, rel), content);
};
const lock = () => JSON.parse(read('swfte.json'));
const nodeProject = (deps: Record<string, string> = {}) => write('package.json', JSON.stringify({ name: 'app', type: 'module', dependencies: deps }));

/** Every file under the project, as text. */
function allText(dir = tmp): string {
  let text = '';
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    text += e.isDirectory() ? allText(p) : readFileSync(p, 'utf8');
  }
  return text;
}

let importSeq = 0;
/** Import a generated TypeScript file for real (tsx loader), bypassing the module cache. */
async function importTs(rel: string): Promise<any> {
  return import(`${pathToFileURL(join(tmp, rel)).href}?v=${++importSeq}`);
}

/* ── version pins ────────────────────────────────────────────────────────── */

describe('version pins: swfte add pins, generated clients call the versioned invoke, upgrade moves the pin', () => {
  test('swfte add pins the current published version; the client calls /versions/{version}/invoke', async () => {
    nodeProject();
    catalogRoutes();
    const r = await cli(['add', 'workflow:wf_1']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Pinned to published version v3/);
    assert.equal(lock().artifacts[0].pinnedVersion, 'v3');
    const client = read('swfte/lead-scorer.ts');
    assert.match(client, /path: "\/v2\/workflows\/wf_1\/versions\/v3\/invoke"/);
    assert.match(client, /export const PINNED_VERSION: string \| null = "v3";/);
    assert.doesNotMatch(client, /"\/v2\/workflows\/wf_1\/invoke"/);

    // Run the generated client: the request goes to the pinned version.
    const mod = await importTs('swfte/lead-scorer.ts');
    const calls: string[] = [];
    const fakeFetch = (async (url: string, init: any) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      if (init.method === 'POST') return new Response(JSON.stringify({ executionId: 'ex1' }), { status: 200 });
      return new Response(JSON.stringify({ execution: { status: 'SUCCESS', outputData: { score: 1 } } }), { status: 200 });
    }) as typeof fetch;
    const res = await mod.invokeLeadScorer({ lead: 'x' }, { apiKey: 'sk-swfte-test', baseUrl: 'https://api.swfte.com/agents', fetch: fakeFetch, pollIntervalMs: 1 });
    assert.equal(res.ok, true);
    assert.deepEqual(calls, ['POST /agents/v2/workflows/wf_1/versions/v3/invoke', 'GET /agents/v2/workflows/executions/ex1/status']);
  });

  test('the Python client is pinned the same way', async () => {
    write('requirements.txt', 'fastapi\n');
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    const py = read('swfte_clients/lead_scorer.py');
    assert.match(py, /^INVOKE_PATH = "\/v2\/workflows\/wf_1\/versions\/v3\/invoke"$/m);
    assert.match(py, /^PINNED_VERSION: Optional\[str\] = "v3"$/m);
  });

  test('a newer publish upstream does not reach pinned code: sync keeps the pin and the pinned schema', async () => {
    nodeProject();
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    const before = read('swfte/lead-scorer.ts');
    contract.version = 'v4';
    contract.outputSchema = { type: 'object', properties: { score: { type: 'number' }, reason: { type: 'string' } } };
    const r = await cli(['sync']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Pinned to v3; up to date\. A newer version \(v4\) is published; `swfte upgrade lead-scorer` moves the pin/);
    assert.equal(read('swfte/lead-scorer.ts'), before);
    assert.equal(lock().artifacts[0].pinnedVersion, 'v3');
    assert.equal((await cli(['verify'])).code, 0);
  });

  test('swfte upgrade moves the pin to the current published version and regenerates for it', async () => {
    nodeProject();
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    contract.version = 'v4';
    contract.outputSchema = { type: 'object', properties: { score: { type: 'number' }, reason: { type: 'string' } } };
    const r = await cli(['upgrade', 'lead-scorer']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Pin moved v3 → v4/);
    assert.equal(lock().artifacts[0].pinnedVersion, 'v4');
    assert.equal(lock().artifacts[0].contractHash, effectiveContractHash(contract).hash);
    const client = read('swfte/lead-scorer.ts');
    assert.match(client, /versions\/v4\/invoke/);
    assert.match(client, /reason\?: string;/);
  });

  test('swfte upgrade will not move a pin to an unpublished version', async () => {
    nodeProject();
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    contract.version = 'v4';
    contract.outputSchema = { type: 'object', properties: { score: { type: 'number' }, extra: { type: 'string' } } };
    unpublished.add('v4');
    const r = await cli(['upgrade', 'lead-scorer']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not a published version.*pin stays at v3/);
    assert.equal(lock().artifacts[0].pinnedVersion, 'v3');
  });

  test('verify fails (exit 1) when the pinned version is no longer published', async () => {
    nodeProject();
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    unpublished.add('v3');
    const r = await cli(['verify']);
    assert.equal(r.code, 1);
    assert.match(r.err, /\[vanished\].*pinned version the code calls is gone/);
  });

  test('--no-pin leaves the client on /invoke; an unpublished workflow and an agent stay unpinned', async () => {
    nodeProject();
    catalogRoutes();
    const r = await cli(['add', 'workflow:wf_1', '--no-pin']);
    assert.equal(r.code, 0, r.err);
    assert.equal(lock().artifacts[0].pinnedVersion, null);
    assert.match(read('swfte/lead-scorer.ts'), /path: "\/v2\/workflows\/wf_1\/invoke"/);

    delete contract.version;
    assert.equal((await cli(['add', 'workflow:wf_1', '--alias', 'draft'])).code, 0);
    assert.equal(lock().artifacts.find((a: any) => a.alias === 'draft').pinnedVersion, null);

    assert.equal((await cli(['add', 'agent:ag_1'])).code, 0);
    assert.equal(lock().artifacts.find((a: any) => a.catalogRef === 'agent:ag_1').pinnedVersion, null);
  });

  test('upgrade pins a workflow that was added before it was published', async () => {
    nodeProject();
    catalogRoutes();
    delete contract.version;
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    assert.equal(lock().artifacts[0].pinnedVersion, null);
    contract.version = 'v1';
    const r = await cli(['upgrade', 'lead-scorer']);
    assert.equal(r.code, 0, r.out);
    assert.equal(lock().artifacts[0].pinnedVersion, 'v1');
    assert.match(read('swfte/lead-scorer.ts'), /versions\/v1\/invoke/);
  });
});

/* ── deny-by-default adapters ────────────────────────────────────────────── */

const NEXT_SERVER_STUB = `export class NextResponse extends Response {
  static json(body, init = {}) { return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json' } }); }
}
`;

describe('generated route adapters deny by default (authorize() hook, 401 until wired)', () => {
  test('Next.js route: 401 for every request until authorize() is wired; then it calls through', async () => {
    nodeProject({ next: '15' });
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    write('node_modules/next/package.json', JSON.stringify({ name: 'next', type: 'module', exports: { './server': './server.js' } }));
    write('node_modules/next/server.js', NEXT_SERVER_STUB);
    const routeFile = 'app/api/lead-scorer/route.ts';
    const src = read(routeFile);
    assert.doesNotMatch(src, /TODO/);

    let upstream = 0;
    globalThis.fetch = (async () => {
      upstream++;
      return new Response(JSON.stringify({ executionId: 'e' }), { status: 200 });
    }) as typeof fetch;
    const denied = await importTs(routeFile);
    const res = await denied.POST(new Request('http://app.local/api/lead-scorer', { method: 'POST', body: JSON.stringify({ lead: 'x' }), headers: { authorization: 'Bearer anything' } }));
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /authorize\(\)/);
    assert.equal(upstream, 0, 'an unauthorised request reached Swfte');

    // Wiring the hook is the only change needed.
    write('app/api/lead-scorer/route-wired.ts', src.replace(/(authorize\(_request: Request\): Promise<Caller \| null> \{\n\s*)return null;/, "$1return { userId: 'u1' };"));
    process.env.SWFTE_API_KEY = 'sk-swfte-testkey12345';
    process.env.SWFTE_BASE_URL = 'https://api.swfte.com/agents';
    try {
      globalThis.fetch = (async (_u: string, init: any) => {
        upstream++;
        return new Response(JSON.stringify(init.method === 'POST' ? { executionId: 'e1' } : { execution: { status: 'SUCCESS', outputData: { score: 2 } } }), { status: 200 });
      }) as typeof fetch;
      const wired = await importTs('app/api/lead-scorer/route-wired.ts');
      const ok = await wired.POST(new Request('http://app.local/api/lead-scorer', { method: 'POST', body: JSON.stringify({ lead: 'x' }) }));
      assert.equal(ok.status, 200);
      assert.deepEqual((await ok.json()).output, { score: 2 });
    } finally {
      delete process.env.SWFTE_API_KEY;
      delete process.env.SWFTE_BASE_URL;
    }
  });

  test('Express router and agent adapters: authorize() gates the call and owns the conversation', async () => {
    nodeProject({ express: '4' });
    catalogRoutes();
    assert.equal((await cli(['add', 'agent:ag_1'])).code, 0);
    const router = read('swfte/support-triage.router.ts');
    assert.match(router, /export async function authorize\(_request: Request\): Promise<Caller \| null> \{\n  return null;\n\}/);
    assert.match(router, /if \(!caller\) \{\n    res\.status\(401\)/);
    assert.match(router, /userId: caller\.userId/);
    assert.doesNotMatch(router, /TODO|body\.userId/);
  });

  test('FastAPI router: 401 until authorize() is wired (run against a FastAPI stub)', async (t) => {
    try {
      execFileSync('python3', ['--version']);
    } catch {
      t.skip('python3 not available');
      return;
    }
    write('requirements.txt', 'fastapi\n');
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    const stub = {
      'fastapi/__init__.py': [
        'class Request:\n    def __init__(self, query=None):\n        self.query_params = query or {}\n',
        'def Body(*a, **k):\n    return None\n',
        'class APIRouter:\n    def __init__(self, prefix="", tags=None):\n        self.routes = {}\n    def post(self, path):\n        def deco(fn):\n            self.routes[path] = fn\n            return fn\n        return deco\n',
      ].join('\n'),
      'fastapi/concurrency.py': 'async def run_in_threadpool(fn):\n    return fn()\n',
      'fastapi/responses.py': 'class JSONResponse:\n    def __init__(self, content, status_code=200):\n        self.content = content\n        self.status_code = status_code\n',
    };
    for (const [rel, text] of Object.entries(stub)) write(`pystub/${rel}`, text);
    const script = [
      'import asyncio, sys',
      `sys.path.insert(0, ${JSON.stringify(join(tmp, 'pystub'))})`,
      `sys.path.insert(0, ${JSON.stringify(tmp)})`,
      'from swfte_clients import lead_scorer_router as m',
      'import fastapi',
      'res = asyncio.run(m.router.routes[""](fastapi.Request(), {"lead": "x"}))',
      'print(res.status_code, res.content["error"])',
    ].join('\n');
    const out = execFileSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, SWFTE_API_KEY: '' } });
    assert.match(out, /^401 Unauthorized: .*authorize\(\)/);
  });
});

/* ── swfte init ──────────────────────────────────────────────────────────── */

describe('swfte init', () => {
  test('writes swfte.json and .env.example, detects the stack, and never writes the PAT anywhere', async () => {
    nodeProject({ next: '15' });
    const r = await cli(['init'], { SWFTE_PAT: PAT });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(lock(), { version: 1, baseUrl: 'https://api.swfte.com/agents', workspaceId: null, artifacts: [] });
    assert.match(read('.env.example'), /^SWFTE_API_KEY=$/m);
    assert.match(r.out, /Stack: nextjs/);
    assert.ok(!allText().includes(PAT), 'the PAT reached a file');
    assert.ok(!r.out.includes(PAT) && !r.err.includes(PAT), 'the PAT was printed');
    // A PAT is flagged, and a key scoped to the artifacts is what it recommends.
    assert.match(r.out, /personal access token/);
    assert.match(r.out, /"resourceScopes":\["<kind>:<id>"\]/);
    assert.match(r.out, /\$SWFTE_PAT/);
    assert.equal(seen.length, 0, 'init made a network call');
  });

  test('with artifacts already baked, the scoped-key request names exactly their catalogRefs', async () => {
    nodeProject();
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    const r = await cli(['init'], {});
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Kept existing swfte\.json/);
    assert.match(r.out, /Prefer a per-artifact scoped API key over a personal access token/);
    assert.match(r.out, /"resourceScopes":\["workflow:wf_1"\]/);
    assert.equal(lock().artifacts.length, 1);
  });

  test('refuses a credential on the command line without echoing it, and writes nothing', async () => {
    for (const flag of ['--token', '--api-key', '--pat']) {
      const r = await cli(['init', flag, PAT], {});
      assert.equal(r.code, 2);
      assert.match(r.err, /never takes a credential on the command line/);
      assert.ok(!r.err.includes(PAT));
      const r2 = await cli(['init', `${flag}=${PAT}`], {});
      assert.equal(r2.code, 2);
      assert.ok(!r2.err.includes(PAT));
    }
    assert.ok(!existsSync(join(tmp, 'swfte.json')));
  });

  test('refuses a --base-url off the credential allow-list (the committed file would steer every key)', async () => {
    const r = await cli(['init', '--base-url', 'https://evil.example.com/agents'], {});
    assert.equal(r.code, 2);
    assert.match(r.err, /evil\.example\.com/);
    assert.ok(!existsSync(join(tmp, 'swfte.json')));
  });

  test('refuses to put a secret-shaped workspace value into swfte.json', async () => {
    const r = await cli(['init', '--workspace', 'sk-swfte-looksecretvalue99'], {});
    assert.notEqual(r.code, 0);
    assert.ok(!existsSync(join(tmp, 'swfte.json')));
  });
});

/* ── swfte dev ───────────────────────────────────────────────────────────── */

describe('swfte dev: local mock server serving contract-derived fixtures', () => {
  test('fixture examples from the schema: examples, enum, typed placeholders', () => {
    assert.deepEqual(exampleOf(WF_CONTRACT.outputSchema), { score: 87, tier: 'A' });
    assert.deepEqual(exampleOf({ type: 'object', properties: { at: { type: 'string', format: 'date-time' }, n: { type: 'integer', minimum: 5 }, xs: { type: 'array', items: { type: 'boolean' } } } }), { at: '2026-01-01T00:00:00Z', n: 5, xs: [true] });
  });

  test('the generated client runs offline against swfte dev, from the client alone (no network)', async () => {
    nodeProject();
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    assert.equal((await cli(['add', 'agent:ag_1'])).code, 0);
    const client = read('swfte/lead-scorer.ts');
    assert.deepEqual(invokeFromClient(client), { method: 'POST', path: '/v2/workflows/wf_1/versions/v3/invoke', auth: 'api_key', async: true, statusPath: '/v2/workflows/executions/{executionId}/status' });
    seen = [];
    const server = await startDevServer({ root: tmp, port: 0 });
    try {
      assert.deepEqual(server.skipped, []);
      assert.ok(server.routes.some((r) => r.path === '/v2/workflows/wf_1/versions/v3/invoke' && r.source === 'client'));
      const wf = await importTs('swfte/lead-scorer.ts');
      const ok = await wf.invokeLeadScorer({ lead: 'acme' }, { apiKey: 'dev', baseUrl: server.url, pollIntervalMs: 1 });
      assert.equal(ok.status, 'SUCCESS');
      assert.equal(ok.ok, true);
      // From the client's shape line alone: typed placeholders.
      assert.deepEqual(ok.output, { score: 1, tier: 'example tier' });

      // Required input missing → 400 naming it, as production validates.
      await assert.rejects(wf.invokeLeadScorer({} as never, { apiKey: 'dev', baseUrl: server.url }), /400.*lead/);
      // No credential → 401, so the key wiring is exercised too.
      const anon = await realFetch(`${server.url}/v2/workflows/wf_1/versions/v3/invoke`, { method: 'POST', body: '{"lead":"x"}' });
      assert.equal(anon.status, 401);

      // A paused run: the client returns promptly with the waiting status.
      const paused = await wf.invokeLeadScorer({ lead: 'x' }, {
        apiKey: 'dev',
        baseUrl: server.url,
        pollIntervalMs: 1,
        fetch: ((u: string, init: any) => realFetch(u, { ...init, headers: { ...init.headers, 'X-Swfte-Dev-Status': 'WAITING_FOR_INPUT' } })) as typeof fetch,
      });
      assert.equal(paused.status, 'WAITING_FOR_INPUT');
      assert.equal(paused.ok, false);

      const agent = await importTs('swfte/support-triage.ts');
      const reply = await agent.chatSupportTriage({ message: 'hello' }, { apiKey: 'dev', baseUrl: server.url });
      assert.match(reply.reply, /support-triage would answer: hello/);
    } finally {
      await server.close();
    }
    assert.equal(seen.length, 0, 'swfte dev reached the Swfte API');
  });

  test('swfte dev --record keeps the full contract as a fixture and serves its examples', async () => {
    nodeProject();
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    const out: string[] = [];
    const err: string[] = [];
    let served: any = null;
    const code = await runCli(['dev', '--record', '--port', '0'], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: { SWFTE_API_KEY: PAT } as NodeJS.ProcessEnv,
      cwd: tmp,
      waitForExit: async () => {
        const url = /at (http:\/\/127\.0\.0\.1:\d+)/.exec(out.join('\n'))![1]!;
        const res = await realFetch(`${url}/v2/workflows/wf_1/versions/v3/invoke`, { method: 'POST', headers: { authorization: 'Bearer dev', 'content-type': 'application/json' }, body: '{"lead":"x"}' });
        const { executionId } = (await res.json()) as { executionId: string };
        const status = await realFetch(`${url}/v2/workflows/executions/${executionId}/status`, { headers: { authorization: 'Bearer dev' } });
        served = await status.json();
      },
    });
    const r = { code, out: out.join('\n'), err: err.join('\n') };
    assert.deepEqual(served.execution.outputData, { score: 87, tier: 'A' });
    assert.equal(r.code, 0, r.err);
    const fixture = JSON.parse(read('.swfte/fixtures/lead-scorer.ts.json'));
    assert.equal(fixture.pinnedVersion, 'v3');
    assert.equal(fixture.invoke.path, '/v2/workflows/wf_1/versions/v3/invoke');
    assert.deepEqual(fixture.outputSchema, WF_CONTRACT.outputSchema);
    assert.match(r.out, /recorded fixture/);
    assert.ok(!read('.swfte/fixtures/lead-scorer.ts.json').includes(PAT));
  });
});
