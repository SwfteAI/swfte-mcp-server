/**
 * `swfte dev` — a local mock of the Swfte endpoints the baked clients call, so
 * an app runs offline (CONTRACT rev 8b, developer path).
 *
 * Every artifact in swfte.json gets its invoke route (and, for async
 * workflows, the execution-status route) served from a fixture derived from
 * its contract:
 *
 *   1. `.swfte/fixtures/<alias>.<ts|py>.json` — recorded by `swfte dev --record`
 *      (full inputSchema/outputSchema, the pinned version's invoke path);
 *   2. otherwise the generated client itself — its INVOKE block and the
 *      `swfte-shape` line every client carries — so it works with no network
 *      and nothing recorded.
 *
 * Response bodies are examples built from the schema (`examples`, `example`,
 * `default`, `const`, first `enum` value, else a typed placeholder). Required
 * inputs are checked (400 VALIDATION_FAILED names what is missing) and a
 * credentialed route still wants an Authorization header (401 otherwise), so
 * the app's wiring is exercised the way production will exercise it.
 * `X-Swfte-Dev-Status: WAITING_FOR_INPUT | FAILED | …` makes a workflow run
 * end in that status, for testing the paused and failed paths.
 *
 * It binds 127.0.0.1 only, keeps nothing on disk, and never forwards anything.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { readShape, type Shape } from './codegen.js';
import { ConfinedWriter } from './fsguard.js';
import { loadLock, normalizeRel, type LockArtifact } from './lock.js';
import type { JsonSchema } from './catalog.js';

export const FIXTURE_DIR = '.swfte/fixtures';

export function fixturePath(a: Pick<LockArtifact, 'alias' | 'language'>): string {
  return `${FIXTURE_DIR}/${a.alias}.${a.language === 'typescript' ? 'ts' : 'py'}.json`;
}

export interface DevFixture {
  catalogRef: string;
  alias: string;
  pinnedVersion: string | null;
  invoke: { method: string; path: string; auth: string; async: boolean; statusPath: string | null };
  inputSchema: JsonSchema | null;
  outputSchema: JsonSchema | null;
  /** Where the fixture came from: "recorded" (swfte dev --record) or "client" (the generated file). */
  source: 'recorded' | 'client';
}

export interface DevRoute {
  alias: string;
  catalogRef: string;
  method: string;
  path: string;
  kind: 'invoke' | 'status';
  source: DevFixture['source'];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/* ── fixtures ────────────────────────────────────────────────────────────── */

/** The INVOKE block of a generated client (TypeScript or Python), or null. */
export function invokeFromClient(content: string): DevFixture['invoke'] | null {
  const q = (re: RegExp): string | null => {
    const m = re.exec(content);
    if (!m) return null;
    try {
      const v = JSON.parse(m[1]!);
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  };
  const ts = /const INVOKE:[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(content)?.[1];
  if (ts) {
    const sub = (key: string) => {
      const m = new RegExp(`\\b${key}:\\s*("(?:[^"\\\\]|\\\\.)*"|true|false|null)`).exec(ts);
      return m ? (JSON.parse(m[1]!) as unknown) : undefined;
    };
    const p = sub('path');
    if (typeof p !== 'string') return null;
    return {
      method: String(sub('method') ?? 'POST'),
      path: p,
      auth: String(sub('auth') ?? 'api_key'),
      async: sub('async') === true,
      statusPath: typeof sub('statusPath') === 'string' ? (sub('statusPath') as string) : null,
    };
  }
  const path = q(/^INVOKE_PATH\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m);
  if (!path) return null;
  return {
    method: q(/^INVOKE_METHOD\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m) ?? 'POST',
    path,
    auth: q(/^INVOKE_AUTH\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m) ?? 'api_key',
    async: /^INVOKE_ASYNC\s*=\s*True\s*$/m.test(content),
    statusPath: q(/^STATUS_PATH\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m),
  };
}

/** A JSON Schema reconstructed from a `swfte-shape` side ({field: "type[!]"}). */
function schemaFromShape(shape: Shape): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [k, t] of Object.entries(shape)) {
    const base = t.replace(/!$/, '');
    if (t.endsWith('!')) required.push(k);
    const types = base.split('|').filter((x) => x && x !== 'any' && x !== 'enum');
    properties[k] = types.length ? { type: types.length === 1 ? types[0] : types } : {};
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) } as JsonSchema;
}

/** Load the fixture for one artifact: a recorded one if present, else derived from the generated client. */
export function loadFixture(writer: ConfinedWriter, a: LockArtifact): DevFixture | null {
  const read = (rel: string): string | null => {
    try {
      return readFileSync(writer.resolve(rel), 'utf8');
    } catch {
      return null;
    }
  };
  const recorded = read(fixturePath(a));
  if (recorded) {
    try {
      const f = JSON.parse(recorded) as Partial<DevFixture>;
      if (isObj(f) && isObj(f.invoke) && typeof f.invoke.path === 'string') {
        return {
          catalogRef: String(f.catalogRef ?? a.catalogRef),
          alias: a.alias,
          pinnedVersion: typeof f.pinnedVersion === 'string' ? f.pinnedVersion : null,
          invoke: { method: String(f.invoke.method ?? 'POST'), path: f.invoke.path, auth: String(f.invoke.auth ?? 'api_key'), async: f.invoke.async === true, statusPath: typeof f.invoke.statusPath === 'string' ? f.invoke.statusPath : null },
          inputSchema: isObj(f.inputSchema) ? (f.inputSchema as JsonSchema) : null,
          outputSchema: isObj(f.outputSchema) ? (f.outputSchema as JsonSchema) : null,
          source: 'recorded',
        };
      }
    } catch {
      // fall through to the client
    }
  }
  const candidates = [...new Set([...a.files, normalizeRel(`${a.outDir}/${a.alias}.ts`)])].filter((f) => /\.(ts|py)$/.test(f));
  for (const rel of candidates) {
    const content = read(rel);
    if (!content || !content.includes('swfte-checksum')) continue;
    const invoke = invokeFromClient(content);
    if (!invoke) continue;
    const shape = readShape(content);
    return {
      catalogRef: a.catalogRef,
      alias: a.alias,
      pinnedVersion: a.pinnedVersion,
      invoke,
      inputSchema: shape ? schemaFromShape(shape.in) : null,
      outputSchema: shape ? schemaFromShape(shape.out) : null,
      source: 'client',
    };
  }
  return null;
}

/* ── examples ────────────────────────────────────────────────────────────── */

/** A deterministic example value for a JSON Schema. */
export function exampleOf(schema: unknown, name = 'value', depth = 0): unknown {
  if (!isObj(schema) || depth > 6) return null;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if ('example' in schema) return schema.example;
  if ('default' in schema) return schema.default;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  for (const k of ['oneOf', 'anyOf', 'allOf'] as const) {
    const alts = schema[k];
    if (Array.isArray(alts) && alts.length) return exampleOf(alts[0], name, depth + 1);
  }
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type;
  switch (t) {
    case 'string': {
      const f = String(schema.format ?? '');
      if (f === 'date-time') return '2026-01-01T00:00:00Z';
      if (f === 'date') return '2026-01-01';
      if (f === 'email') return 'user@example.com';
      if (f === 'uri' || f === 'url') return 'https://example.com';
      if (f === 'uuid') return '00000000-0000-4000-8000-000000000000';
      return `example ${name}`;
    }
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array':
      return schema.items ? [exampleOf(schema.items, name, depth + 1)] : [];
    case 'object':
    default: {
      if (!isObj(schema.properties)) return t === 'object' ? {} : null;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties)) out[k] = exampleOf(v, k, depth + 1);
      return out;
    }
  }
}

function missingRequired(schema: JsonSchema | null, body: unknown): string[] {
  if (!isObj(schema) || !Array.isArray(schema.required)) return [];
  const b = isObj(body) ? body : {};
  return schema.required.map(String).filter((k) => b[k] === undefined || b[k] === null);
}

/* ── server ──────────────────────────────────────────────────────────────── */

interface Compiled {
  fixture: DevFixture;
  method: string;
  re: RegExp;
  chat: boolean;
  statusRe: RegExp | null;
}

function pathRegex(path: string): RegExp {
  const parts = path.split(/(\{[A-Za-z_][A-Za-z0-9_]*\})/).map((seg) => (/^\{.*\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp(`^${parts.join('')}$`);
}

export interface DevServer {
  url: string;
  routes: DevRoute[];
  /** Artifacts in swfte.json that have no fixture (no recorded file, no generated client). */
  skipped: string[];
  close(): Promise<void>;
}

export async function startDevServer(opts: { root: string; port?: number; log?: (line: string) => void }): Promise<DevServer> {
  const writer = new ConfinedWriter({ root: opts.root });
  const loaded = loadLock(writer, { baseUrl: '' });
  if (!loaded.exists) throw new Error('No swfte.json in the project root: run `swfte init` and `swfte add <catalogRef>` first.');
  const compiled: Compiled[] = [];
  const skipped: string[] = [];
  for (const a of loaded.lock.artifacts) {
    const fixture = loadFixture(writer, a);
    if (!fixture) {
      skipped.push(a.alias);
      continue;
    }
    compiled.push({
      fixture,
      method: fixture.invoke.method.toUpperCase(),
      re: pathRegex(fixture.invoke.path),
      chat: /\/chat(\/|$)/.test(fixture.invoke.path) || a.catalogRef.startsWith('agent:'),
      statusRe: fixture.invoke.async && fixture.invoke.statusPath ? pathRegex(fixture.invoke.statusPath) : null,
    });
  }
  const executions = new Map<string, { status: string; output: unknown; alias: string }>();
  let seq = 0;
  const log = opts.log ?? (() => undefined);

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'x-swfte-dev': '1' });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Clients whose base URL keeps the cloud's /agents prefix still land here.
    const path = url.pathname.replace(/^\/agents(?=\/)/, '');
    const method = (req.method ?? 'GET').toUpperCase();
    if (path === '/__swfte/routes') return send(res, 200, { routes: devRoutes(), skipped });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
    }
    let body: unknown = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'MALFORMED_JSON', message: 'Body is not JSON.' });
      }
    }
    for (const c of compiled) {
      const needsAuth = c.fixture.invoke.auth !== 'public';
      if (c.statusRe && method === 'GET' && c.statusRe.test(path)) {
        const id = decodeURIComponent(path.split('/').filter(Boolean).find((s) => executions.has(decodeURIComponent(s))) ?? '');
        const run = executions.get(id);
        if (!run) continue;
        if (needsAuth && !req.headers.authorization) return send(res, 401, { error: 'UNAUTHORIZED', message: 'swfte dev: send a credential (any value works locally).' });
        log(`GET  ${path} → ${run.status}`);
        return send(res, 200, {
          execution: { id, status: run.status, ...(run.status === 'SUCCESS' ? { outputData: run.output } : {}) },
          nodeExecutions: [],
          progress: run.status === 'SUCCESS' || run.status === 'FAILED' ? 100 : 50,
        });
      }
      if (method !== c.method || !c.re.test(path)) continue;
      if (needsAuth && !req.headers.authorization) return send(res, 401, { error: 'UNAUTHORIZED', message: 'swfte dev: send a credential (any value works locally).' });
      const missing = c.chat ? (isObj(body) && typeof body.message === 'string' && body.message ? [] : ['message']) : missingRequired(c.fixture.inputSchema, body);
      if (missing.length) {
        log(`${method} ${path} → 400 (missing ${missing.join(', ')})`);
        return send(res, 400, { error: 'VALIDATION_FAILED', message: `Missing required input: ${missing.join(', ')}`, missing });
      }
      const output = exampleOf(c.fixture.outputSchema, 'output');
      if (c.chat) {
        const text = `(swfte dev) ${c.fixture.alias} would answer: ${String((body as Record<string, unknown>).message).slice(0, 200)}`;
        log(`${method} ${path} → 200 (mock reply)`);
        return send(res, 200, { content: text, conversationId: `dev-conversation-${c.fixture.alias}`, agentId: c.fixture.catalogRef.split(':')[1] ?? null });
      }
      if (!c.fixture.invoke.async) {
        log(`${method} ${path} → 200`);
        return send(res, 200, output ?? {});
      }
      const forced = String(req.headers['x-swfte-dev-status'] ?? '').trim().toUpperCase();
      const executionId = `dev-${c.fixture.alias}-${++seq}`;
      executions.set(executionId, { status: /^[A-Z_]{2,40}$/.test(forced) ? forced : 'SUCCESS', output, alias: c.fixture.alias });
      log(`${method} ${path} → 200 (execution ${executionId})`);
      return send(res, 200, { executionId, status: 'RUNNING' });
    }
    return send(res, 404, { error: 'NO_DEV_ROUTE', message: `swfte dev serves no ${method} ${path}. GET /__swfte/routes lists what it serves.` });
  };

  const devRoutes = (): DevRoute[] =>
    compiled.flatMap((c) => [
      { alias: c.fixture.alias, catalogRef: c.fixture.catalogRef, method: c.method, path: c.fixture.invoke.path, kind: 'invoke' as const, source: c.fixture.source },
      ...(c.statusRe ? [{ alias: c.fixture.alias, catalogRef: c.fixture.catalogRef, method: 'GET', path: c.fixture.invoke.statusPath!, kind: 'status' as const, source: c.fixture.source }] : []),
    ]);

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { error: 'DEV_SERVER_ERROR', message: err instanceof Error ? err.message : String(err) }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4010, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    routes: devRoutes(),
    skipped,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
