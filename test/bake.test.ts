/**
 * Solution Hub + bake-in (CONTRACT rev 3–6): stack detection, framework
 * adapters, swfte.json v1 and its migration, the `swfte` CLI (add / sync /
 * verify / upgrade), the X-Swfte-Client header generated clients send, and the
 * fit / adopt / timeline tools.
 *
 * Every test runs against a mocked global `fetch` with the real SwfteClient,
 * in a throwaway project directory, so request paths and bodies are the ones
 * that would go on the wire and file writes are real.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

import { loadConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { allTools } from '../src/tools/index.js';
import { contractHash, effectiveContractHash, sameHash, stableStringify } from '../src/catalog.js';
import { detectStack } from '../src/stack.js';
import { migrateLock, serializeLock } from '../src/lock.js';
import { clientHeaderValue, diffShapes, inspectGenerated } from '../src/codegen.js';
import { runCli, parseArgs } from '../src/cli.js';
import { PACKAGE_VERSION } from '../src/version.js';
import { getPrompt } from '../src/prompts.js';

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
  routes.unshift([method, pattern, typeof handler === 'function' ? handler : () => handler]);
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
    if (!hit) return new Response(JSON.stringify({ code: 'NO_ROUTE', message: `${req.method} ${path}` }), { status: 404 });
    const out = hit[2](req) ?? {};
    return new Response(out.body === undefined ? '' : JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const tool = (name: string) => {
  const t = allTools.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t!;
};
const run = (name: string, input: unknown, extra: Record<string, unknown> = {}) =>
  tool(name).execute(input as never, { client: new SwfteClient(config()), config: config(), ...extra }) as Promise<any>;

/* ── fixtures ────────────────────────────────────────────────────────────── */

const WF_CONTRACT = {
  catalogRef: 'workflow:wf_1',
  invoke: { method: 'POST', path: '/v2/workflows/wf_1/invoke', auth: 'api_key', async: true, statusPath: '/v2/workflows/executions/{executionId}/status' },
  inputSchema: {
    type: 'object',
    properties: { invoiceUrl: { type: 'string' }, currency: { type: 'string' } },
    required: ['invoiceUrl'],
  },
  outputSchema: { type: 'object', properties: { total: { type: 'number' }, vendor: { type: 'string' } } },
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

const detail = (ref: string, name: string, extra: Record<string, unknown> = {}) => {
  const [kind, id] = ref.split(':');
  return {
    catalogRef: ref,
    kind,
    id,
    workspaceId: 'ws1',
    scope: 'workspace',
    name,
    description: `${name} description`,
    facets: [],
    evidence: { level: 'corroborated', runs: { total: 9, succeeded: 9, failed: 0 }, successRate: 1, reasons: [] },
    updatedAt: '2026-09-21T00:00:00Z',
    ...extra,
  };
};

let contracts: Record<string, any> = {};
let upgradeItems: any[] | null = null;

function catalogRoutes() {
  route('GET', /^\/v2\/catalog\/workflow\/wf_1$/, () => ({ body: detail('workflow:wf_1', 'Invoice Extractor') }));
  route('GET', /^\/v2\/catalog\/workflow\/wf_1\/contract$/, () => ({ body: contracts['workflow:wf_1'] }));
  route('GET', /^\/v2\/catalog\/agent\/ag_1$/, () => ({ body: detail('agent:ag_1', 'Support Triage') }));
  route('GET', /^\/v2\/catalog\/agent\/ag_1\/contract$/, () => ({ body: contracts['agent:ag_1'] }));
  route('GET', /^\/v2\/catalog\/upgrades$/, (req) => {
    if (upgradeItems) return { body: { items: upgradeItems } };
    // Default: whatever is pinned is current.
    const items = String(req.query.refs ?? '')
      .split(',')
      .filter(Boolean)
      .map((pin) => {
        const at = pin.lastIndexOf(':');
        const ref = pin.slice(0, at);
        const latest = contracts[ref] ? effectiveContractHash(contracts[ref]).hash : pin.slice(at + 1);
        return { catalogRef: ref, currentHash: pin.slice(at + 1), latestHash: latest, breaking: false, latestVersion: null, evidenceLevel: 'corroborated', summary: null, capabilityChanges: [], requiresReapproval: false };
      });
    return { body: { items } };
  });
}

/* ── lifecycle ───────────────────────────────────────────────────────────── */

let tmp = '';
let prevCwd = '';
beforeEach(() => {
  seen = [];
  routes = [];
  contracts = { 'workflow:wf_1': structuredClone(WF_CONTRACT), 'agent:ag_1': structuredClone(AGENT_CONTRACT) };
  upgradeItems = null;
  installFetch();
  prevCwd = process.cwd();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'swfte-bake-')));
  process.chdir(tmp);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

const write = (rel: string, content: string) => {
  mkdirSync(join(tmp, rel, '..'), { recursive: true });
  writeFileSync(join(tmp, rel), content);
};
const read = (rel: string) => readFileSync(join(tmp, rel), 'utf8');
const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) => write('package.json', JSON.stringify({ name: 'app', dependencies: deps, ...extra }));

/** Run the CLI in the temp project with a PAT in SWFTE_API_KEY (as generated clients read it). */
async function cli(args: string[], env: Record<string, string | undefined> = { SWFTE_API_KEY: CREDENTIAL }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l), env: env as NodeJS.ProcessEnv, cwd: tmp });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Type-check generated files, with minimal stubs for framework modules that are not installed here. */
function typecheck(files: string[], stubs = ''): string[] {
  const stubFile = join(tmp, '__stubs.d.ts');
  writeFileSync(stubFile, stubs);
  const program = ts.createProgram([...files, stubFile], {
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
  return ts.getPreEmitDiagnostics(program).map((d) => `${d.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}

const NEXT_STUB = `declare module 'next/server' { export class NextResponse extends Response { static json(body: unknown, init?: { status?: number }): NextResponse; } }\ndeclare const console: { error(...a: unknown[]): void };`;
const EXPRESS_STUB = `declare module 'express' {
  export interface Request { body: any; query: Record<string, unknown> }
  export interface Response { status(code: number): Response; json(body: unknown): Response }
  type H = (req: Request, res: Response) => unknown;
  export interface IRouter { use(h: unknown): IRouter; post(path: string, h: H): IRouter }
  export function Router(): IRouter;
  export function json(): unknown;
}
declare const console: { error(...a: unknown[]): void };`;

let python: string | null | undefined;
function hasPython(): boolean {
  if (python === undefined) {
    try {
      python = execFileSync('python3', ['--version'], { encoding: 'utf8' });
    } catch {
      python = null;
    }
  }
  return Boolean(python);
}

/* ── stack detection ─────────────────────────────────────────────────────── */

describe('stack detection', () => {
  test('nextjs (next.js) from package.json "next", App Router under src/app', () => {
    pkg({ next: '15.0.0', react: '19.0.0', stripe: '^16' });
    write('tsconfig.json', '{}');
    mkdirSync(join(tmp, 'src/app'), { recursive: true });
    const d = detectStack(tmp);
    assert.equal(d.framework, 'nextjs');
    assert.equal(d.language, 'typescript');
    assert.equal(d.layout.appDir, 'src/app');
    for (const tag of ['nextjs', 'typescript', 'node', 'react', 'stripe']) assert.ok(d.stack.includes(tag), `${tag} in ${d.stack}`);
    assert.match(d.signals[0]!, /"next"/);
  });

  test('nextjs with root app/ and devDependencies only', () => {
    write('package.json', JSON.stringify({ devDependencies: { next: '14' } }));
    mkdirSync(join(tmp, 'app'));
    assert.equal(detectStack(tmp).layout.appDir, 'app');
  });

  test('express from package.json', () => {
    pkg({ express: '^4.19.0', pg: '8' });
    const d = detectStack(tmp);
    assert.equal(d.framework, 'express');
    assert.ok(d.stack.includes('postgres'));
    assert.ok(d.signals.some((s) => /no tsconfig/.test(s)), 'warns that generated TypeScript needs a runner');
  });

  test('nestjs and hono map to the plain TypeScript adapter', () => {
    pkg({ '@nestjs/core': '10' });
    assert.deepEqual([detectStack(tmp).framework, detectStack(tmp).detected], ['plain-ts', 'nestjs']);
    pkg({ hono: '4' });
    assert.deepEqual([detectStack(tmp).framework, detectStack(tmp).detected], ['plain-ts', 'hono']);
  });

  test('fastapi from requirements.txt (any spelling), with an app package', () => {
    write('requirements.txt', '# api\nFastAPI[all]>=0.110\nuvicorn\nSQLAlchemy==2.0\n');
    write('app/__init__.py', '');
    const d = detectStack(tmp);
    assert.equal(d.framework, 'fastapi');
    assert.equal(d.language, 'python');
    assert.equal(d.layout.pythonPackage, 'app');
    assert.ok(d.stack.includes('sqlalchemy'));
  });

  test('fastapi from pyproject.toml (PEP 621 and Poetry)', () => {
    write('pyproject.toml', '[project]\nname = "svc"\ndependencies = [\n  "fastapi>=0.110",\n  "httpx",\n]\n');
    assert.equal(detectStack(tmp).framework, 'fastapi');
    write('pyproject.toml', '[tool.poetry.dependencies]\npython = "^3.11"\nfastapi = "^0.110"\n');
    assert.equal(detectStack(tmp).framework, 'fastapi');
    write('requirements-dev.txt', 'pytest\n');
    assert.equal(detectStack(tmp).framework, 'fastapi');
  });

  test('flask and django map to plain-python', () => {
    write('requirements.txt', 'Django>=5\n');
    assert.deepEqual([detectStack(tmp).framework, detectStack(tmp).detected], ['plain-python', 'django']);
    write('requirements.txt', 'flask\n');
    assert.deepEqual([detectStack(tmp).framework, detectStack(tmp).detected], ['plain-python', 'flask']);
  });

  test('fallbacks: tsconfig or package.json → plain-ts, nothing → plain-python; a broken package.json is a signal', () => {
    assert.equal(detectStack(tmp).framework, 'plain-python');
    write('tsconfig.json', '{}');
    assert.equal(detectStack(tmp).framework, 'plain-ts');
    rmSync(join(tmp, 'tsconfig.json'));
    write('package.json', '{ not json');
    const d = detectStack(tmp);
    assert.equal(d.framework, 'plain-ts');
    assert.ok(d.signals.some((s) => /does not parse/.test(s)));
  });
});

/* ── contract hash ───────────────────────────────────────────────────────── */

describe('contractHash (CONTRACT rev 4 canonical definition)', () => {
  test('is sha256 hex of sorted-key JSON of {invoke, inputSchema, outputSchema}; snippets excluded', () => {
    const material = stableStringify({ invoke: WF_CONTRACT.invoke, inputSchema: WF_CONTRACT.inputSchema, outputSchema: WF_CONTRACT.outputSchema });
    assert.equal(contractHash(WF_CONTRACT as never), createHash('sha256').update(material).digest('hex'));
    assert.match(material, /^\{"inputSchema":\{"properties":/, 'keys sorted, no whitespace');
    assert.equal(contractHash({ ...WF_CONTRACT, snippets: { curl: 'changed' } } as never), contractHash(WF_CONTRACT as never));
  });

  test('prefers the server hash, warns when it differs, and tolerates the legacy prefixed/truncated form', () => {
    const local = contractHash(WF_CONTRACT as never);
    assert.deepEqual(effectiveContractHash({ ...WF_CONTRACT, contractHash: local } as never).warning, undefined);
    const other = effectiveContractHash({ ...WF_CONTRACT, contractHash: 'f'.repeat(64) } as never);
    assert.equal(other.hash, 'f'.repeat(64));
    assert.match(other.warning!, /differs from the locally computed/);
    assert.ok(sameHash(`sha256:${local.slice(0, 32)}`, local), 'leaf-1.2.2 locks are not drift');
    assert.ok(!sameHash(local.slice(0, 8), local), 'a short prefix is not a match');
  });
});

/* ── add: clients, adapters, lock ────────────────────────────────────────── */

describe('swfte add / swfte_scaffold_client', () => {
  test('Next.js project: typed client + App Router route handler that type-checks', async () => {
    pkg({ next: '15' });
    write('tsconfig.json', '{}');
    mkdirSync(join(tmp, 'src/app'), { recursive: true });
    catalogRoutes();
    const r = await cli(['add', 'workflow:wf_1']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Added workflow:wf_1 as "invoice-extractor" \(nextjs/);
    const route = read('src/app/api/invoice-extractor/route.ts');
    assert.match(route, /import \{ invokeInvoiceExtractor, type InvoiceExtractorInput \} from "\.\.\/\.\.\/\.\.\/lib\/swfte\/invoice-extractor";/);
    assert.match(route, /export async function POST\(request: Request\)/);
    assert.match(route, /Auth check goes here/);
    assert.deepEqual(typecheck([join(tmp, 'src/app/api/invoice-extractor/route.ts')], NEXT_STUB), []);
    const lock = JSON.parse(read('swfte.json'));
    assert.deepEqual(Object.keys(lock), ['version', 'baseUrl', 'workspaceId', 'artifacts']);
    assert.deepEqual(lock.artifacts, [
      {
        catalogRef: 'workflow:wf_1',
        alias: 'invoice-extractor',
        language: 'typescript',
        framework: 'nextjs',
        outDir: 'src/lib/swfte',
        contractHash: contractHash(WF_CONTRACT as never),
        pinnedVersion: 'v3',
        files: ['src/app/api/invoice-extractor/route.ts', 'src/lib/swfte/invoice-extractor.ts'],
      },
    ]);
    assert.equal(lock.baseUrl, 'https://api.swfte.com/agents');
    assert.ok(!JSON.stringify(lock).includes(CREDENTIAL));
    assert.ok(!read('src/lib/swfte/invoice-extractor.ts').includes(CREDENTIAL));
  });

  test('Express project: router module importing the client (ESM gets .js specifiers)', async () => {
    pkg({ express: '4' }, { type: 'module' });
    mkdirSync(join(tmp, 'src'));
    catalogRoutes();
    const res = await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', alias: 'invoices' });
    assert.equal(res.framework, 'express');
    assert.deepEqual(res.files.map((f: any) => f.path).sort(), ['.env.example', 'src/swfte/invoices.router.ts', 'src/swfte/invoices.ts', 'swfte.json']);
    const router = read('src/swfte/invoices.router.ts');
    assert.match(router, /from "\.\/invoices\.js";/);
    assert.match(router, /export const invoicesRouter = Router\(\);/);
    assert.match(res.usage, /app\.use\('\/api\/invoices'/);
    // Bundler resolution maps the .js specifier back to the .ts source, like tsc with NodeNext would.
    assert.deepEqual(typecheck([join(tmp, 'src/swfte/invoices.router.ts')], EXPRESS_STUB), []);
  });

  test('FastAPI project: APIRouter module + package marker, never overwriting an existing __init__.py', async () => {
    write('requirements.txt', 'fastapi\n');
    write('app/__init__.py', '# mine\n');
    write('app/swfte_clients/__init__.py', 'VERSION = 1\n');
    catalogRoutes();
    const r = await cli(['add', 'workflow:wf_1']);
    assert.equal(r.code, 0, r.err);
    const router = read('app/swfte_clients/invoice_extractor_router.py');
    assert.match(router, /router = APIRouter\(prefix="\/swfte\/invoice-extractor"/);
    assert.match(router, /from \.invoice_extractor import invoke_invoice_extractor/);
    assert.match(router, /run_in_threadpool/);
    assert.equal(read('app/swfte_clients/__init__.py'), 'VERSION = 1\n');
    const lock = JSON.parse(read('swfte.json'));
    assert.equal(lock.artifacts[0].framework, 'fastapi');
    assert.equal(lock.artifacts[0].language, 'python');
    assert.ok(!lock.artifacts[0].files.includes('app/swfte_clients/__init__.py'), 'a pre-existing package marker is not ours to list');
    if (hasPython()) {
      for (const f of ['app/swfte_clients/invoice_extractor_router.py', 'app/swfte_clients/invoice_extractor.py']) {
        execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', join(tmp, f)]);
      }
      execFileSync('python3', ['-c', 'import invoice_extractor as m; assert m.SWFTE_CLIENT.startswith("python/")'], { cwd: join(tmp, 'app/swfte_clients') });
    }
  });

  test('agent adapters take the conversation owner from app auth, never from the request body', async () => {
    pkg({ express: '4' });
    catalogRoutes();
    assert.equal((await cli(['add', 'agent:ag_1'])).code, 0);
    const router = read('swfte/support-triage.router.ts');
    assert.match(router, /userId: userIdFor\(req\)/);
    assert.doesNotMatch(router, /body\.userId/);
    assert.deepEqual(typecheck([join(tmp, 'swfte/support-triage.router.ts')], EXPRESS_STUB), []);
  });

  test('Python clients never land in a bare swfte/ package that would shadow the Swfte SDK', async () => {
    write('requirements.txt', 'fastapi\nswfte-sdk\n');
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    assert.ok(existsSync(join(tmp, 'swfte_clients/invoice_extractor.py')));
    assert.ok(!existsSync(join(tmp, 'swfte')));
  });

  test('--framework and --out override detection; plain clients get no adapter', async () => {
    pkg({ next: '15' });
    catalogRoutes();
    const r = await cli(['add', 'agent:ag_1', '--framework', 'plain-python', '--out', 'services/ai', '--alias', 'triage']);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(tmp, 'services/ai/triage.py')));
    assert.ok(!existsSync(join(tmp, 'app')));
  });

  test('never overwrites an adapter without force; the refusal writes nothing', async () => {
    pkg({ next: '15' });
    write('app/api/invoice-extractor/route.ts', '// mine\n');
    catalogRoutes();
    const r = await cli(['add', 'workflow:wf_1']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Refusing to overwrite existing file\(s\): app\/api\/invoice-extractor\/route.ts/);
    assert.equal(read('app/api/invoice-extractor/route.ts'), '// mine\n');
    assert.ok(!existsSync(join(tmp, 'swfte.json')));
    assert.equal((await cli(['add', 'workflow:wf_1', '--force'])).code, 0);
  });

  test('path confinement is reused: --out outside the project fails before any request', async () => {
    const r = await cli(['add', 'workflow:wf_1', '--out', '../escape']);
    assert.equal(r.code, 1);
    assert.match(r.err, /outside the working directory/);
    assert.equal(seen.length, 0);
  });

  test('re-adding after the contract moved regenerates our own client without force, keeping alias and framework', async () => {
    pkg({ next: '15' });
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1', '--alias', 'inv'])).code, 0);
    contracts['workflow:wf_1'].outputSchema.properties.dueDate = { type: 'string' };
    const r = await cli(['add', 'workflow:wf_1']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /as "inv" \(nextjs/);
    assert.match(r.err, /contract moved/);
    assert.match(read('lib/swfte/inv.ts'), /dueDate/);
  });

  test('hosted (inline) mode returns files with a merge note instead of writing', async () => {
    catalogRoutes();
    const res = await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', framework: 'nextjs' }, { localFilesystem: false });
    assert.equal(res.inline, true);
    assert.match(res.lock.note, /merge them/);
    assert.ok(res.files.every((f: any) => typeof f.content === 'string'));
    assert.ok(!existsSync(join(tmp, 'swfte.json')));
  });

  test('an alias already naming another artifact is refused', async () => {
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1', '--alias', 'thing'])).code, 0);
    const r = await cli(['add', 'agent:ag_1', '--alias', 'thing']);
    assert.equal(r.code, 1);
    assert.match(r.err, /already names workflow:wf_1/);
  });
});

/* ── generated clients on the wire ───────────────────────────────────────── */

describe('generated clients', () => {
  test('send X-Swfte-Client and poll the nested execution.status', async () => {
    catalogRoutes();
    await run('swfte_scaffold_client', { catalogRef: 'workflow:wf_1', targetDir: 'gen', language: 'typescript' });
    const mod = await import(pathToFileURL(join(tmp, 'gen/invoice-extractor.ts')).href);
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    let polls = 0;
    const fakeFetch = (async (url: string, init: any) => {
      calls.push({ url, headers: init.headers });
      if (url.endsWith('/invoke')) return new Response(JSON.stringify({ executionId: 'ex_9' }));
      polls++;
      const status = polls < 2 ? 'RUNNING' : 'SUCCESS';
      return new Response(JSON.stringify({ execution: { status, outputData: { total: 42 } }, nodeExecutions: [], progress: 1 }));
    }) as unknown as typeof fetch;
    const res = await mod.invokeInvoiceExtractor({ invoiceUrl: 'https://x/y.pdf' }, { apiKey: 'sk-swfte-test', fetch: fakeFetch, pollIntervalMs: 1, baseUrl: 'https://api.example' });
    assert.deepEqual([res.ok, res.status, res.executionId, res.output], [true, 'SUCCESS', 'ex_9', { total: 42 }]);
    const hash = contractHash(WF_CONTRACT as never);
    for (const c of calls) assert.equal(c.headers['X-Swfte-Client'], `typescript/${PACKAGE_VERSION}; ref=workflow:wf_1; hash=${hash}`);
    assert.equal(calls[1]!.url, 'https://api.example/v2/workflows/executions/ex_9/status');
  });

  test('agent clients read content, falling back to the legacy response key', async () => {
    catalogRoutes();
    await run('swfte_scaffold_client', { catalogRef: 'agent:ag_1', targetDir: 'gen', language: 'typescript' });
    const mod = await import(pathToFileURL(join(tmp, 'gen/support-triage.ts')).href);
    const reply = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    const a = await mod.chatSupportTriage({ message: 'hi' }, { apiKey: 'sk-swfte-test', fetch: reply({ content: 'canonical', response: 'old' }) });
    const b = await mod.chatSupportTriage({ message: 'hi' }, { apiKey: 'sk-swfte-test', fetch: reply({ response: 'legacy' }) });
    assert.equal(a.reply, 'canonical');
    assert.equal(b.reply, 'legacy');
    assert.deepEqual(typecheck([join(tmp, 'gen/support-triage.ts')]), []);
  });

  test('the X-Swfte-Client value cannot carry header injection', () => {
    const v = clientHeaderValue('typescript', { catalogRef: 'workflow:a\r\nX-Evil: 1', contractHash: 'h;ref=x', clientVersion: '1.0' });
    assert.ok(!/[\r\n]/.test(v));
    assert.equal(v.split(';').length, 3);
  });
});

/* ── lock v1 + migration ─────────────────────────────────────────────────── */

describe('swfte.json v1', () => {
  const LEGACY = {
    version: 1,
    source: 'swfte-studio',
    artifacts: [
      {
        catalogRef: 'workflow:wf_1',
        kind: 'workflow',
        id: 'wf_1',
        name: 'Invoice Extractor',
        updatedAt: '2026-09-01T00:00:00Z',
        shapeHash: null,
        contractHash: 'sha256:0123456789abcdef0123456789abcdef',
        languages: ['python', 'typescript'],
        files: ['src/swfte/invoice-extractor.ts', 'src/swfte/invoice_extractor.py'],
        scaffoldedAt: '2026-09-01T00:00:00Z',
      },
    ],
  };

  test('migrates the leaf-1.2.2 lock shape: one v1 entry per language, no timestamps', () => {
    const { lock, migrated } = migrateLock(LEGACY, { baseUrl: 'https://u:p@api.example/agents/?x=1' });
    assert.equal(migrated, true);
    assert.equal(lock.baseUrl, 'https://api.example/agents', 'userinfo and query never reach a committed file');
    assert.deepEqual(lock.artifacts.map((a) => [a.alias, a.language, a.framework, a.outDir, a.files.join(','), a.pinnedVersion]), [
      ['invoice-extractor', 'python', 'plain-python', 'src/swfte', 'src/swfte/invoice_extractor.py', '2026-09-01T00:00:00Z'],
      ['invoice-extractor', 'typescript', 'plain-ts', 'src/swfte', 'src/swfte/invoice-extractor.ts', '2026-09-01T00:00:00Z'],
    ]);
    const text = serializeLock(lock);
    assert.ok(!/scaffoldedAt|source|languages/.test(text));
    assert.equal(serializeLock(migrateLock(JSON.parse(text), { baseUrl: 'x' }).lock), text, 'v1 round-trips byte for byte');
    assert.equal(migrateLock(JSON.parse(text), { baseUrl: 'x' }).migrated, false);
  });

  test('a legacy lock beside generated code is folded into the root lock on the next add', async () => {
    write('src/swfte/swfte.json', JSON.stringify(LEGACY));
    catalogRoutes();
    const res = await run('swfte_scaffold_client', { catalogRef: 'agent:ag_1', targetDir: 'src/swfte', language: 'typescript' });
    assert.deepEqual(res.lock.legacySources, ['src/swfte/swfte.json']);
    const lock = JSON.parse(read('swfte.json'));
    assert.deepEqual(lock.artifacts.map((a: any) => `${a.alias}/${a.language}`), ['invoice-extractor/python', 'invoice-extractor/typescript', 'support-triage/typescript']);
    assert.ok(res.nextSteps.some((s: string) => /Delete the old lock/.test(s)));
  });

  test('a lock newer than this package, or with merge-conflict markers, is refused', async () => {
    assert.throws(() => migrateLock({ version: 2, artifacts: [] }, { baseUrl: '' }), /schema version 2/);
    write('swfte.json', '{\n<<<<<<< HEAD\n  "version": 1\n=======\n  "version": 1\n>>>>>>> other\n}\n');
    const r = await cli(['verify', '--offline']);
    assert.equal(r.code, 1);
    assert.match(r.err, /merge-conflict markers/);
  });
});

/* ── verify (CI gate) ────────────────────────────────────────────────────── */

describe('swfte verify', () => {
  async function baked() {
    pkg({ next: '15' });
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    seen = [];
  }

  test('exits 0 with SWFTE_VERIFY_OK when everything is in sync', async () => {
    await baked();
    const r = await cli(['verify']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^SWFTE_VERIFY_OK 1 artifact\(s\) in sync, no breaking upgrades/);
    const up = seen.find((s) => s.path === '/v2/catalog/upgrades')!;
    assert.equal(up.query.refs, `workflow:wf_1:${contractHash(WF_CONTRACT as never)}`);
  });

  test('exits 1 on local drift: client generated against another hash than the lock pins', async () => {
    await baked();
    const lock = JSON.parse(read('swfte.json'));
    lock.artifacts[0].contractHash = 'a'.repeat(64);
    write('swfte.json', JSON.stringify(lock, null, 2));
    const r = await cli(['verify', '--offline']);
    assert.equal(r.code, 1);
    assert.match(r.err, /\[drift\]/);
    assert.match(r.out, /SWFTE_VERIFY_FAILED/);
  });

  test('exits 1 on drift from a hand-edited or deleted client', async () => {
    await baked();
    const file = 'lib/swfte/invoice-extractor.ts';
    write(file, read(file).replace('const TERMINAL', '// my tweak\nconst TERMINAL'));
    let r = await cli(['verify', '--offline']);
    assert.equal(r.code, 1);
    assert.match(r.err, /\[edited\]/);
    rmSync(join(tmp, file));
    r = await cli(['verify', '--offline']);
    assert.equal(r.code, 1);
    assert.match(r.err, /\[missing\]/);
  });

  test('CRLF line endings (Windows checkout) are not drift', async () => {
    await baked();
    const file = 'lib/swfte/invoice-extractor.ts';
    write(file, read(file).replace(/\n/g, '\r\n'));
    assert.equal(inspectGenerated(read(file)).intact, true);
    assert.equal((await cli(['verify', '--offline'])).code, 0);
  });

  test('exits 1 when an upgrade requiresReapproval, even if not breaking', async () => {
    await baked();
    upgradeItems = [{ catalogRef: 'workflow:wf_1', currentHash: 'x', latestHash: 'b'.repeat(64), breaking: false, latestVersion: 'v4', evidenceLevel: 'observed', summary: 'adds an HTTP node', capabilityChanges: ['new egress: http_request'], requiresReapproval: true }];
    const r = await cli(['verify']);
    assert.equal(r.code, 1);
    assert.match(r.err, /\[reapproval\].*new egress: http_request/);
  });

  test('exits 1 on a breaking upgrade; a non-breaking one is only a warning', async () => {
    await baked();
    upgradeItems = [{ catalogRef: 'workflow:wf_1', currentHash: 'x', latestHash: 'c'.repeat(64), breaking: true, latestVersion: 'v4', summary: 'required input "po" added', capabilityChanges: [], requiresReapproval: false }];
    assert.equal((await cli(['verify'])).code, 1);
    upgradeItems = [{ ...upgradeItems[0], breaking: false }];
    const r = await cli(['verify']);
    assert.equal(r.code, 0);
    assert.match(r.err, /non-breaking upgrade available/);
  });

  test('exits 2 when it cannot check: no lock, no credential, or backend down', async () => {
    let r = await cli(['verify']);
    assert.equal(r.code, 2);
    assert.match(r.err, /No swfte\.json/);
    await baked();
    r = await cli(['verify'], {});
    assert.equal(r.code, 2);
    assert.match(r.err, /No credential/);
    assert.equal((await cli(['verify', '--offline'], {})).code, 0);
    route('GET', /^\/v2\/catalog\/upgrades$/, { status: 503, body: { message: 'down' } });
    r = await cli(['verify']);
    assert.equal(r.code, 2);
    assert.match(r.out, /SWFTE_VERIFY_UNCHECKED/);
  });

  test('a lock path pointing outside the project is a failure, not a read', async () => {
    await baked();
    const lock = JSON.parse(read('swfte.json'));
    lock.artifacts[0].files = ['../../etc/passwd'];
    lock.artifacts[0].outDir = '../..';
    write('swfte.json', JSON.stringify(lock));
    const r = await cli(['verify', '--offline']);
    assert.equal(r.code, 1);
    assert.match(r.err, /outside the project/);
  });

  test('swfte_check_upgrades mirrors verify', async () => {
    await baked();
    const ok = await run('swfte_check_upgrades', {});
    assert.equal(ok.verdict, 'SWFTE_VERIFY_OK');
    upgradeItems = [{ catalogRef: 'workflow:wf_1', latestHash: 'd'.repeat(64), breaking: false, capabilityChanges: ['new MCP tool'], requiresReapproval: true }];
    const bad = await run('swfte_check_upgrades', {});
    assert.equal(bad.exitCode, 1);
    assert.equal(bad.problems[0].kind, 'reapproval');
    await assert.rejects(run('swfte_check_upgrades', {}, { localFilesystem: false }), /needs the server running locally/);
  });
});

/* ── sync / upgrade ──────────────────────────────────────────────────────── */

describe('swfte sync / upgrade', () => {
  async function baked() {
    pkg({ next: '15' });
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
  }

  test('regenerates a moved non-breaking contract, prints a diff summary, keeps the adapter', async () => {
    await baked();
    write('app/api/invoice-extractor/route.ts', read('app/api/invoice-extractor/route.ts') + '\n// my auth\n');
    contracts['workflow:wf_1'].outputSchema.properties.dueDate = { type: 'string' };
    const r = await cli(['sync']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /~ invoice-extractor .*Regenerated lib\/swfte\/invoice-extractor.ts: \+out dueDate/);
    assert.match(r.out, /1 regenerated/);
    assert.match(read('lib/swfte/invoice-extractor.ts'), /dueDate\?: string;/);
    assert.match(read('app/api/invoice-extractor/route.ts'), /\/\/ my auth/);
    assert.equal(JSON.parse(read('swfte.json')).artifacts[0].contractHash, contractHash(contracts['workflow:wf_1']));
    assert.equal((await cli(['verify'])).code, 0);
    const again = await cli(['sync']);
    assert.match(again.out, /1 unchanged/);
  });

  test('holds back a breaking change (local shape diff) until swfte upgrade', async () => {
    await baked();
    delete contracts['workflow:wf_1'].outputSchema.properties.vendor;
    contracts['workflow:wf_1'].inputSchema.required = ['invoiceUrl', 'currency'];
    upgradeItems = [];
    const r = await cli(['sync']);
    assert.match(r.out, /held back \(breaking\)/);
    assert.match(r.out, /output "vendor" removed/);
    assert.doesNotMatch(read('lib/swfte/invoice-extractor.ts'), /currency: string;/);
    const up = await cli(['upgrade', 'invoice-extractor']);
    assert.equal(up.code, 0, up.out + up.err);
    assert.match(read('lib/swfte/invoice-extractor.ts'), /currency: string;/);
  });

  test('upgrade refuses capability changes that need re-approval until accepted', async () => {
    await baked();
    contracts['workflow:wf_1'].invoke.path = '/v2/workflows/wf_1/invoke?v=2';
    upgradeItems = [{ catalogRef: 'workflow:wf_1', latestHash: contractHash(contracts['workflow:wf_1']), breaking: false, capabilityChanges: ['new code execution node'], requiresReapproval: true }];
    const r = await cli(['upgrade', 'invoice-extractor']);
    assert.equal(r.code, 1);
    assert.match(r.out, /re-approval/);
    const ok = await cli(['upgrade', 'invoice-extractor', '--accept-capability-changes']);
    assert.equal(ok.code, 0, ok.out);
  });

  test('a hand-edited client is held back unless forced; --dry-run writes nothing', async () => {
    await baked();
    const file = 'lib/swfte/invoice-extractor.ts';
    write(file, read(file) + '// edit\n');
    contracts['workflow:wf_1'].outputSchema.properties.extra = { type: 'string' };
    const dry = await cli(['sync', '--dry-run', '--force']);
    assert.match(dry.out, /dry run/);
    assert.match(read(file), /\/\/ edit\n$/);
    const held = await cli(['sync']);
    assert.match(held.out, /held back \(hand-edited\)/);
    const forced = await cli(['sync', '--force']);
    assert.match(forced.out, /1 regenerated/);
    assert.equal(inspectGenerated(read(file)).intact, true);
  });

  test('restores a deleted client; swfte_sync mirrors the CLI', async () => {
    await baked();
    rmSync(join(tmp, 'lib/swfte/invoice-extractor.ts'));
    const res = await run('swfte_sync', {});
    assert.equal(res.entries[0].status, 'restored');
    assert.ok(existsSync(join(tmp, 'lib/swfte/invoice-extractor.ts')));
  });

  test('unknown alias and missing lock are clear errors', async () => {
    assert.equal((await cli(['sync'])).code, 1);
    await baked();
    const r = await cli(['upgrade', 'nope']);
    assert.equal(r.code, 1);
    assert.match(r.err, /No artifact with alias "nope"/);
  });

  test('shape diff marks the CONTRACT breaking cases', () => {
    const d = diffShapes({ in: { a: 'string!', b: 'string' }, out: { x: 'number', y: 'string' } }, { in: { a: 'string!', b: 'string!', c: 'string!' }, out: { x: 'string' } });
    assert.equal(d.breaking, true);
    assert.deepEqual(d.reasons.sort(), ['input "b" became required', 'output "x" changed type number → string', 'output "y" removed', 'required input "c" added'].sort());
    assert.equal(diffShapes({ in: {}, out: {} }, { in: { opt: 'string' }, out: { z: 'string' } }).breaking, false);
  });
});

/* ── CLI surface ─────────────────────────────────────────────────────────── */

describe('swfte CLI', () => {
  test('usage, version and argument errors exit 2; credentials are never echoed', async () => {
    assert.equal((await cli([])).code, 2);
    assert.equal((await cli(['--help'])).code, 0);
    assert.equal((await cli(['--version'])).out, PACKAGE_VERSION);
    assert.equal((await cli(['bogus'])).code, 2);
    assert.equal((await cli(['add'])).code, 2);
    assert.equal((await cli(['add', 'workflow:wf_1', '--framework', 'rails'])).code, 2);
    assert.throws(() => parseArgs(['--out']), /needs a value/);
    const r = await cli(['add', 'workflow:wf_1'], { SWFTE_API_KEY: 'garbage-credential-value' });
    assert.equal(r.code, 2);
    assert.ok(!r.err.includes('garbage-credential-value'));
  });

  test('accepts a PAT in SWFTE_API_KEY and sends it only as a bearer token', async () => {
    catalogRoutes();
    assert.equal((await cli(['add', 'workflow:wf_1'])).code, 0);
    const h = seen[0]!.headers;
    assert.equal(h.Authorization, `Bearer ${CREDENTIAL}`);
    assert.equal(h['X-API-Key'], undefined);
  });

  test('package.json exposes the swfte bin beside the MCP server bins, and versions agree', () => {
    const pkgJson = JSON.parse(readFileSync(join(prevCwd, 'package.json'), 'utf8'));
    assert.equal(pkgJson.bin.swfte, 'dist/swfte.js');
    assert.equal(pkgJson.bin['swfte-mcp-server'], 'dist/index.js');
    // npx @swfte/mcp-server picks the bin named after the unscoped package when there are several.
    assert.equal(pkgJson.bin['mcp-server'], 'dist/index.js');
    assert.equal(pkgJson.version, PACKAGE_VERSION);
  });
});

/* ── Solution Hub tools ──────────────────────────────────────────────────── */

describe('Solution Hub', () => {
  test('swfte_fit_check sends the detected stack when none is given (nextjs fixture)', async () => {
    pkg({ next: '15', stripe: '16' });
    route('POST', /^\/v2\/catalog\/workflow\/wf_1\/fit$/, {
      body: { score: 0.82, verdict: 'strong', matches: ['invoice parsing'], gaps: [{ kind: 'connection', detail: 'needs gmail', fix: null }], missingConnections: ['gmail'], degraded: [] },
    });
    const res = await run('swfte_fit_check', { catalogRef: 'workflow:wf_1', problem: 'extract totals from emailed invoices' });
    const body = seen[0]!.body;
    assert.equal(body.problem, 'extract totals from emailed invoices');
    for (const tag of ['nextjs', 'typescript', 'stripe']) assert.ok(body.stack.includes(tag), `${tag} in ${body.stack}`);
    assert.equal(res.stack.source, 'detected');
    assert.equal(res.verdict, 'strong');
    assert.match(res.missingConnections[0].fix, /swfte_connect_start \{provider:"gmail"\}/);
    assert.match(res.nextStep, /swfte_adopt/);
  });

  test('swfte_fit_check: a given stack wins; a null score is reported as unmeasured, hosted mode never reads disk', async () => {
    pkg({ express: '4' });
    route('POST', /\/fit$/, { body: { score: null, verdict: 'unknown', degraded: ['jev'] } });
    const res = await run('swfte_fit_check', { catalogRef: 'workflow:wf_1', problem: 'x y z', stack: ['FastAPI', 'postgres'] });
    assert.deepEqual(seen[0]!.body.stack, ['fastapi', 'postgres']);
    assert.match(res.note, /not measured/);
    await run('swfte_fit_check', { catalogRef: 'workflow:wf_1', problem: 'x y z' }, { localFilesystem: false });
    assert.deepEqual(seen[1]!.body.stack, []);
  });

  test('swfte_adopt sends tailoring, surfaces needsInput + missingConnections and a PROPOSED deploy it never executes', async () => {
    write('requirements.txt', 'fastapi\n');
    route('POST', /^\/v2\/catalog\/workflow\/wf_1\/adopt$/, {
      body: {
        catalogRef: 'workflow:wf_9',
        kind: 'workflow',
        id: 'wf_9',
        forkedFrom: 'workflow:wf_1',
        tailoringApplied: true,
        tailoringSummary: 'Swapped Gmail trigger for webhook',
        needsInput: ['connection:slack', 'approvalChannel'],
        deployAction: { id: 'act_7', capability: 'workflow.deploy', target: { kind: 'workflow', id: 'wf_9' }, params: {}, environment: 'staging', status: 'PROPOSED', requiresApproval: true, requestedBy: 'u1', approvedBy: null, expiresAt: '2026-09-29T00:00:00Z', result: null, createdAt: '2026-09-22T00:00:00Z' },
      },
    });
    const res = await run('swfte_adopt', { catalogRef: 'workflow:wf_1', name: 'My invoices', problem: 'invoices from S3', notes: 'EU only', deploy: { environment: 'staging' } });
    assert.equal(seen.length, 1, 'adopt is one POST; nothing is executed');
    const req = seen[0]!;
    assert.equal(req.method, 'POST');
    assert.deepEqual(req.body.name, 'My invoices');
    assert.equal(req.body.tailoring.problem, 'invoices from S3');
    assert.equal(req.body.tailoring.notes, 'EU only');
    assert.ok(req.body.tailoring.stack.includes('fastapi'), 'stack detected from the project');
    assert.deepEqual(req.body.deploy, { environment: 'staging' });
    assert.equal(res.catalogRef, 'workflow:wf_9');
    assert.equal(res.forkedFrom, 'workflow:wf_1');
    assert.deepEqual(res.needsInput, ['connection:slack', 'approvalChannel']);
    assert.deepEqual(res.missingConnections.map((m: any) => m.provider), ['slack']);
    assert.equal(res.deployAction.status, 'PROPOSED');
    assert.ok(res.nextSteps.some((s: string) => /approve it in Studio → Actions; then swfte_execute_approved_action \{actionId:"act_7"\}/.test(s)));
    assert.ok(res.nextSteps.some((s: string) => /approvalChannel/.test(s)));
    assert.ok(res.nextSteps.some((s: string) => /swfte_scaffold_client \{catalogRef:"workflow:wf_9"\}/.test(s)));
  });

  test('swfte_adopt: a plain copy sends no tailoring; failed tailoring is said out loud', async () => {
    route('POST', /\/adopt$/, { body: { catalogRef: 'workflow:wf_2', forkedFrom: 'workflow:wf_1', tailoringApplied: false, needsInput: [], deployAction: null } });
    const plain = await run('swfte_adopt', { catalogRef: 'workflow:wf_1' });
    assert.deepEqual(seen[0]!.body, {});
    assert.equal(plain.tailoringNote, undefined);
    assert.ok(plain.nextSteps.some((s: string) => /swfte_request_approval \{capability:"workflow.deploy"/.test(s)));
    const tailored = await run('swfte_adopt', { catalogRef: 'workflow:wf_1', problem: 'p', stack: ['django'] });
    assert.deepEqual(seen[1]!.body.tailoring, { problem: 'p', stack: ['django'] });
    assert.match(tailored.tailoringNote, /plain copy/);
  });

  test('swfte_get_timeline filters, limits and counts events', async () => {
    route('GET', /^\/v2\/catalog\/workflow\/wf_1\/timeline$/, {
      body: {
        events: [
          { at: '2026-09-22', type: 'adopted', actor: { id: 'u2', displayName: 'Ana' }, summary: 'Adopted into ws2', refId: 'workflow:wf_9' },
          { at: '2026-09-21', type: 'run', actor: null, summary: 'SUCCESS', refId: 'ex1' },
          { at: '2026-09-01', type: 'created', actor: { id: 'u1', displayName: 'Dejan' }, summary: 'Created', refId: null },
        ],
      },
    });
    const res = await run('swfte_get_timeline', { catalogRef: 'workflow:wf_1', types: ['adopted', 'created'], limit: 1 });
    assert.equal(res.total, 3);
    assert.equal(res.count, 1);
    assert.equal(res.truncated, true);
    assert.deepEqual(res.events[0], { at: '2026-09-22', type: 'adopted', actor: 'Ana', summary: 'Adopted into ws2', refId: 'workflow:wf_9' });
    assert.deepEqual(res.counts, { adopted: 1, run: 1, created: 1 });
  });

  test('find_existing and get_context show provenance and independent vs parent evidence', async () => {
    const provenance = { author: { id: 'u1', displayName: 'Dejan', workspaceName: 'Finance Ops' }, createdAt: '2026-08-01', why: 'AP team drowned in PDFs', forkedFrom: 'workflow:wf_0', forks: 3, adoptedBy: 5, version: 'v3' };
    const evidence = { level: 'corroborated', runs: { total: 20, succeeded: 19, failed: 1 }, successRate: 0.95, independentWorkspaces: 3, successRateInterval: [0.76, 0.99], freshness: 'fresh', adopters: 4, reasons: [] };
    route('GET', /^\/v2\/catalog\/search$/, { body: { items: [{ ...detail('workflow:wf_1', 'Invoice Extractor'), provenance, license: 'MIT', evidence }], nextCursor: null, degraded: [] } });
    const found = await run('swfte_find_existing', { query: 'invoice' });
    const r0 = found.results[0];
    assert.match(r0.provenance, /by Dejan \(Finance Ops\) — why: AP team drowned in PDFs — forked from workflow:wf_0/);
    assert.deepEqual([r0.independentWorkspaces, r0.successRateInterval, r0.freshness, r0.license], [3, [0.76, 0.99], 'fresh', 'MIT']);

    route('GET', /^\/v2\/catalog\/workflow\/wf_1$/, { body: { ...detail('workflow:wf_1', 'Invoice Extractor'), provenance, evidence: { level: 'unmeasured', runs: { total: 0, succeeded: 0, failed: 0 } }, parentEvidence: evidence } });
    route('GET', /^\/v2\/catalog\/workflow\/wf_1\/contract$/, { body: { ...WF_CONTRACT, contractHash: contractHash(WF_CONTRACT as never) } });
    const ctx = await run('swfte_get_context', { catalogRef: 'workflow:wf_1' });
    assert.equal(ctx.provenance.author.displayName, 'Dejan');
    assert.equal(ctx.provenance.why, 'AP team drowned in PDFs');
    assert.equal(ctx.provenance.license, 'proprietary', 'workspace entries default to proprietary');
    assert.equal(ctx.evidence.level, 'unmeasured', 'a fork starts with no evidence of its own');
    assert.equal(ctx.evidence.parentEvidence.level, 'corroborated');
    assert.match(ctx.evidence.parentNote, /never|says nothing yet/);
    assert.equal(ctx.contractHashWarning, undefined);
    assert.ok(ctx.nextSteps.some((s: string) => /swfte_fit_check/.test(s)));
  });

  test('the pick-up-tailor-deploy prompt chains find → fit → adopt → scaffold → approval → status', () => {
    const text = getPrompt('pick-up-tailor-deploy', { problem: 'invoice "totals"', environment: 'staging' }).messages[0]!.content.text;
    const order = ['swfte_find_existing', 'swfte_fit_check', 'swfte_adopt', 'swfte_scaffold_client', 'swfte_request_approval {capability:"workflow.deploy"', 'swfte_get_action_status'].map((s) => text.indexOf(s));
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(text, /environment:"staging"/);
    assert.throws(() => getPrompt('pick-up-tailor-deploy', {}), /requires: problem/);
  });
});
