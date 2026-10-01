/**
 * LL-G1: every MCP tool call is one traced step.
 *
 * Real MCP `Client` over the SDK's in-memory transport, real `SwfteClient`, and a local HTTP stub that
 * captures every request's headers and body and echoes `X-Swfte-Trace-Id` the way the backend's
 * RequestCorrelationFilter does (it adopts the caller's traceparent). Nothing here reaches a network
 * beyond 127.0.0.1.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { loadConfig, type ServerConfig } from '../src/config.js';
import { SwfteClient } from '../src/client.js';
import { buildServer } from '../src/server.js';
import { allTools } from '../src/tools/index.js';
import type { ToolDefinition } from '../src/tools/_types.js';
import {
  LOCAL_STEPS_PATH,
  LOCAL_STEPS_PER_POST,
  MCP_CLIENT_HEADER,
  MCP_SESSION_HEADER,
  MCP_TOOL_HEADER,
  SESSION_ID_RE,
  TRACE_ECHO_HEADER,
  TRACE_META_KEY,
  TRACE_TRAILER_RE,
  TRACEPARENT_HEADER,
  UNREACHED_QUEUE_MAX,
} from '../src/learning-contract.js';

/* ── local backend stub ──────────────────────────────────────────────────── */

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

type Mode = 'up' | 'down';
type Responder = (req: Seen) => { status?: number; body?: unknown; echo?: string | null } | undefined;

const seen: Seen[] = [];
let mode: Mode = 'up';
let responder: Responder = () => undefined;
let stub: HttpServer;
let baseUrl = '';

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

function lower(h: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (typeof v === 'string') out[k.toLowerCase()] = v;
  return out;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (mode === 'down') {
    // The connection dies before any answer: exactly what the client sees when the backend is unreachable.
    req.socket.destroy();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body: unknown = raw;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    // multipart or text; keep raw
  }
  const s: Seen = { method: req.method ?? '', path: (req.url ?? '').split('?')[0]!, headers: lower(req.headers), body };
  seen.push(s);
  const custom = responder(s);
  const tp = TRACEPARENT_RE.exec(s.headers[TRACEPARENT_HEADER] ?? '');
  // Default: adopt the caller's traceparent, as RequestCorrelationFilter does.
  const echo = custom && 'echo' in custom ? custom.echo : tp ? tp[1] : null;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (echo) headers[TRACE_ECHO_HEADER] = echo;
  const status = custom?.status ?? (s.path === LOCAL_STEPS_PATH ? 202 : 200);
  res.writeHead(status, headers);
  res.end(JSON.stringify(custom?.body ?? (s.path === LOCAL_STEPS_PATH ? { accepted: s.body?.steps?.length ?? 0 } : { ok: true })));
}

before(async () => {
  stub = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

after(async () => {
  stub.closeAllConnections?.();
  await new Promise<void>((r) => stub.close(() => r()));
});

beforeEach(() => {
  seen.length = 0;
  mode = 'up';
  responder = () => undefined;
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

// Built at runtime so no committed string looks like a credential.
const PAT = ['pat', 'trace', 'fixture'].join('_');

function config(extra: Record<string, string> = {}): ServerConfig {
  return loadConfig({ SWFTE_PAT: PAT, SWFTE_BASE_URL: baseUrl, ...extra } as never);
}

const probeTools: ToolDefinition[] = [
  {
    name: 'probe_get',
    description: 'GET /v2/probe once (default GET retry budget).',
    inputSchema: z.object({}).passthrough(),
    execute: async (_i, { client }) => client.request({ method: 'GET', path: '/v2/probe' }),
  },
  {
    name: 'probe_post',
    description: 'POST /v2/probe once, no retries.',
    inputSchema: z.object({ name: z.string().optional() }).passthrough(),
    execute: async (_i, { client }) => client.request({ method: 'POST', path: '/v2/probe', body: { a: 1 } }),
  },
  {
    name: 'probe_two',
    description: 'Two sub-requests of one orchestrating call.',
    inputSchema: z.object({}),
    execute: async (_i, { client }) => {
      await client.request({ method: 'GET', path: '/v2/probe/a' });
      return client.request({ method: 'GET', path: '/v2/probe/b' });
    },
  },
  {
    name: 'probe_binary',
    description: 'getBinary and postMultipart, the two other header builders.',
    inputSchema: z.object({}),
    execute: async (_i, { client }) => {
      await client.getBinary('/v2/probe/zip');
      const form = new FormData();
      form.set('f', new Blob(['x']), 'f.txt');
      return client.postMultipart('/v2/probe/upload', form);
    },
  },
  {
    name: 'probe_typed',
    description: 'Requires a string; used for invalid input.',
    inputSchema: z.object({ name: z.string() }),
    execute: async () => 'never',
  },
  {
    name: 'probe_throw',
    description: 'Throws a plain error without touching the backend.',
    inputSchema: z.object({}),
    execute: async () => {
      throw new Error('plain failure');
    },
  },
];

const classify = allTools.find((t) => t.name === 'swfte_composition_classify')!;

interface Harness {
  mcp: Client;
  swfte: SwfteClient;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  close: () => Promise<void>;
}

async function harness(clientName = 'claude-code', cfg: ServerConfig = config()): Promise<Harness> {
  const swfte = new SwfteClient(cfg);
  const server = buildServer({ config: cfg, tools: [...probeTools, classify], resolveClient: () => swfte });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: clientName, version: '1.0.0' });
  await mcp.connect(clientSide);
  return {
    mcp,
    swfte,
    call: (name, args = {}) => mcp.callTool({ name, arguments: args }),
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

function trailerId(result: any): string {
  const content = result.content as Array<{ type: string; text: string }>;
  const last = content[content.length - 1]!;
  assert.equal(last.type, 'text');
  const m = TRACE_TRAILER_RE.exec(last.text);
  assert.ok(m, `last content item is not the trailer: ${JSON.stringify(last.text)}`);
  return m[1]!;
}

/** The trace + span of a captured request. */
function ids(s: Seen): { trace: string; span: string } {
  const m = TRACEPARENT_RE.exec(s.headers[TRACEPARENT_HEADER] ?? '');
  assert.ok(m, `${s.method} ${s.path} carries no well-formed traceparent: ${s.headers[TRACEPARENT_HEADER]}`);
  return { trace: m[1]!, span: m[2]! };
}

async function waitFor(pred: () => boolean, what: string, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Resolve once no request has arrived for `quietMs`. */
async function settle(quietMs = 150): Promise<void> {
  let n = -1;
  while (n !== seen.length) {
    n = seen.length;
    await new Promise((r) => setTimeout(r, quietMs));
  }
}

const stepPosts = () => seen.filter((s) => s.path === LOCAL_STEPS_PATH);
const backend = () => seen.filter((s) => s.path !== LOCAL_STEPS_PATH);

const STEP_KEYS = new Set(['traceId', 'spanId', 'tool', 'resultClass', 'errorSignature', 'argShape', 'ms', 'occurredAtMs']);

function assertStepShape(step: any): void {
  for (const k of Object.keys(step)) assert.ok(STEP_KEYS.has(k), `step carries a field the endpoint refuses: ${k}`);
  assert.match(step.traceId, /^[0-9a-f]{32}$/);
  assert.match(step.spanId, /^[0-9a-f]{16}$/);
  assert.match(step.tool, /^[a-z][a-z0-9_.-]{0,63}$/);
  assert.ok(['OK', 'ERROR', 'UNREACHED', 'CLIENT_TIMEOUT'].includes(step.resultClass));
  assert.ok(Number.isInteger(step.ms) && step.ms >= 0);
  if (step.errorSignature !== undefined) assert.match(step.errorSignature, /^[A-Za-z0-9_.:/-]{1,128}$/);
  for (const t of Object.values(step.argShape ?? {})) {
    assert.ok(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null', 'handle'].includes(t as string));
  }
}

/* ── tests ───────────────────────────────────────────────────────────────── */

describe('trace propagation (LL-G1)', () => {
  test('each tool call sends a fresh traceparent plus session, client and tool headers', async () => {
    const h = await harness();
    try {
      const r1 = await h.call('probe_get');
      const r2 = await h.call('probe_get');
      assert.equal(backend().length, 2);
      const [a, b] = backend().map(ids);
      assert.notEqual(a!.trace, b!.trace, 'two tool calls shared one trace id');
      for (const s of backend()) {
        assert.match(s.headers[MCP_SESSION_HEADER.toLowerCase()] ?? '', SESSION_ID_RE);
        assert.equal(s.headers[MCP_CLIENT_HEADER.toLowerCase()], 'claude-code');
        assert.equal(s.headers[MCP_TOOL_HEADER.toLowerCase()], 'probe_get');
        // The strict adopter header is untouched by the learning headers.
        assert.equal(s.headers['x-swfte-client'], undefined);
      }
      // The backend adopted the traceparent, so the reported id is the call's trace id.
      assert.equal(trailerId(r1), a!.trace);
      assert.equal(trailerId(r2), b!.trace);
      assert.equal(r1._meta?.[TRACE_META_KEY], a!.trace);
      assert.equal(r2._meta?.[TRACE_META_KEY], b!.trace);
      // Existing result text is unchanged and still first.
      assert.deepEqual(JSON.parse(r1.content[0].text), { ok: true });
      assert.equal(r1.content.length, 2);
    } finally {
      await h.close();
    }
  });

  test('a retried GET keeps the trace id and changes the span id', async () => {
    let n = 0;
    responder = (s) => (s.path === '/v2/probe' && ++n === 1 ? { status: 503, body: { code: 'UNAVAILABLE' } } : undefined);
    const h = await harness();
    try {
      const r = await h.call('probe_get');
      assert.equal(r.isError, undefined);
      assert.equal(backend().length, 2, 'expected one retry');
      const [first, second] = backend().map(ids);
      assert.equal(first!.trace, second!.trace, 'the retry started a new trace');
      assert.notEqual(first!.span, second!.span, 'the retry reused the span id');
      assert.equal(trailerId(r), first!.trace);
    } finally {
      await h.close();
    }
  });

  test('sub-requests of one orchestrating call share its trace with distinct spans', async () => {
    const h = await harness();
    try {
      const r = await h.call('probe_two');
      const [a, b] = backend().map(ids);
      assert.equal(a!.trace, b!.trace);
      assert.notEqual(a!.span, b!.span);
      assert.equal(trailerId(r), a!.trace);
    } finally {
      await h.close();
    }
  });

  test('getBinary and postMultipart carry the call trace too', async () => {
    const h = await harness();
    try {
      await h.call('probe_binary');
      assert.equal(backend().length, 2);
      const [a, b] = backend().map(ids);
      assert.equal(a!.trace, b!.trace);
      for (const s of backend()) assert.equal(s.headers[MCP_TOOL_HEADER.toLowerCase()], 'probe_binary');
    } finally {
      await h.close();
    }
  });

  test('the session header is constant within a session and differs across servers', async () => {
    const h1 = await harness();
    const h2 = await harness();
    try {
      await h1.call('probe_get');
      await h1.call('probe_post');
      await h2.call('probe_get');
      const sessions = backend().map((s) => s.headers[MCP_SESSION_HEADER.toLowerCase()]);
      assert.equal(sessions[0], sessions[1], 'session changed within one server');
      assert.notEqual(sessions[0], sessions[2], 'two servers shared a session id');
      for (const s of sessions) assert.match(s ?? '', SESSION_ID_RE);
    } finally {
      await h1.close();
      await h2.close();
    }
  });

  test('an unknown host is sent as other and its raw name never travels', async () => {
    const raw = 'Acme-Internal-IDE';
    const h = await harness(raw);
    const hc = await harness('codex-cli');
    try {
      await h.call('probe_get');
      await hc.call('probe_get');
      const [unknown, codex] = backend();
      assert.equal(unknown!.headers[MCP_CLIENT_HEADER.toLowerCase()], 'other');
      assert.equal(codex!.headers[MCP_CLIENT_HEADER.toLowerCase()], 'codex');
      for (const s of seen) {
        assert.ok(!JSON.stringify(s.headers).toLowerCase().includes(raw.toLowerCase()), 'raw client name sent');
      }
    } finally {
      await h.close();
      await hc.close();
    }
  });

  test('outside a tool call the client adds no learning headers', async () => {
    const c = new SwfteClient(config());
    await c.request({ method: 'GET', path: '/v2/plain' });
    const [s] = seen;
    assert.equal(s!.headers[TRACEPARENT_HEADER], undefined);
    assert.equal(s!.headers[MCP_SESSION_HEADER.toLowerCase()], undefined);
    assert.equal(s!.headers[MCP_CLIENT_HEADER.toLowerCase()], undefined);
    assert.equal(s!.headers[MCP_TOOL_HEADER.toLowerCase()], undefined);
  });

  test('a backend echo that differs from the minted id is what the result reports', async () => {
    const echoed = 'ab'.repeat(16);
    responder = () => ({ echo: echoed });
    const h = await harness();
    try {
      const r = await h.call('probe_get');
      assert.notEqual(ids(backend()[0]!).trace, echoed);
      assert.equal(trailerId(r), echoed);
      assert.equal(r._meta?.[TRACE_META_KEY], echoed);
    } finally {
      await h.close();
    }
  });

  test('a malformed echo is ignored and the minted id is reported', async () => {
    responder = () => ({ echo: 'NOT-A-TRACE-ID' });
    const h = await harness();
    try {
      const r = await h.call('probe_get');
      assert.equal(trailerId(r), ids(backend()[0]!).trace);
    } finally {
      await h.close();
    }
  });

  test('every result kind carries _meta and the exact trailer as its last item', async () => {
    responder = (s) => (s.path === '/v2/probe' && s.method === 'POST' ? { status: 400, body: { code: 'VALIDATION_FAILED', message: 'bad' } } : undefined);
    const h = await harness();
    try {
      const cases: Array<[string, Record<string, unknown>, boolean]> = [
        ['probe_get', {}, false], // success
        ['probe_post', {}, true], // backend error (SwfteApiError)
        ['probe_typed', { name: 42 }, true], // invalid input
        ['probe_throw', {}, true], // plain error
        ['no_such_tool', {}, true], // unknown tool
        ['swfte_composition_classify', { signals: {} }, false], // local-only success
      ];
      for (const [name, args, isError] of cases) {
        const r = await h.call(name, args);
        assert.equal(Boolean(r.isError), isError, `${name}: isError`);
        const id = trailerId(r);
        assert.match(id, /^[0-9a-f]{32}$/);
        assert.equal(r._meta?.[TRACE_META_KEY], id, `${name}: _meta disagrees with the trailer`);
        assert.equal(r.content.length, 2, `${name}: expected the original item plus the trailer`);
        assert.doesNotMatch(r.content[0].text, TRACE_TRAILER_RE);
      }
      // The backend error keeps its structured body as the first item.
      const err = await h.call('probe_post');
      assert.equal(JSON.parse(err.content[0].text).code, 'VALIDATION_FAILED');
      assert.equal(trailerId(err), ids(backend().at(-1)!).trace);
    } finally {
      await h.close();
    }
  });

  test('swfte_composition_classify posts exactly one local step and no other request', async () => {
    const h = await harness();
    try {
      const r = await h.call('swfte_composition_classify', { signals: { recurringInteraction: true } });
      await waitFor(() => stepPosts().length === 1, 'the local step');
      await settle();
      assert.equal(seen.length, 1, `unexpected requests: ${seen.map((s) => `${s.method} ${s.path}`).join(', ')}`);
      const post = stepPosts()[0]!;
      assert.equal(post.method, 'POST');
      assert.deepEqual(Object.keys(post.body), ['steps']);
      assert.equal(post.body.steps.length, 1);
      const step = post.body.steps[0];
      assertStepShape(step);
      assert.equal(step.traceId, trailerId(r));
      assert.equal(step.tool, 'swfte_composition_classify');
      assert.equal(step.resultClass, 'OK');
      assert.deepEqual(step.argShape, { signals: 'object' });
      // Posted under the session and client, but never as a traced attempt of its own.
      assert.match(post.headers[MCP_SESSION_HEADER.toLowerCase()] ?? '', SESSION_ID_RE);
      assert.equal(post.headers[MCP_CLIENT_HEADER.toLowerCase()], 'claude-code');
      assert.equal(post.headers[TRACEPARENT_HEADER], undefined);
      assert.equal(post.headers[MCP_TOOL_HEADER.toLowerCase()], undefined);
    } finally {
      await h.close();
    }
  });

  test('a local step records argument shapes and handles, never values', async () => {
    const h = await harness();
    const handle = ['conn', 'slack', '7f3a'].join('_');
    const vault = ['secret:', '', 'vault', 'db'].join('/');
    const text = 'a private sentence that must not travel';
    try {
      const r = await h.call('probe_typed', { name: 7, conn: handle, ref: vault, note: text, n: 1.5, list: [1], none: null, flag: true });
      assert.equal(r.isError, true);
      await waitFor(() => stepPosts().length === 1, 'the invalid-input step');
      const raw = JSON.stringify(stepPosts()[0]!.body);
      for (const v of [handle, vault, text, '1.5']) assert.ok(!raw.includes(v), `a value reached the step: ${v}`);
      const step = stepPosts()[0]!.body.steps[0];
      assertStepShape(step);
      assert.equal(step.resultClass, 'ERROR');
      assert.equal(step.errorSignature, 'mcp:invalid_input');
      assert.deepEqual(step.argShape, {
        name: 'integer', conn: 'handle', ref: 'handle', note: 'string', n: 'number', list: 'array', none: 'null', flag: 'boolean',
      });
    } finally {
      await h.close();
    }
  });

  test('a call that reached the backend posts no local step', async () => {
    const h = await harness();
    try {
      await h.call('probe_get');
      await settle();
      assert.equal(stepPosts().length, 0);
    } finally {
      await h.close();
    }
  });

  test('an unreachable backend queues an UNREACHED step and drains it on the next contact', async () => {
    const h = await harness();
    try {
      mode = 'down';
      const failed = await h.call('probe_post', { name: 'x' });
      assert.equal(failed.isError, true);
      const failedId = trailerId(failed);
      assert.equal(failed._meta?.[TRACE_META_KEY], failedId);
      const pending = h.swfte.pendingLocalSteps;
      assert.equal(pending.queued, 1);
      const queued = pending.steps[0]!;
      assertStepShape(queued);
      assert.equal(queued.resultClass, 'UNREACHED');
      assert.equal(queued.traceId, failedId, 'the queued step is not the failed call');
      assert.equal(queued.tool, 'probe_post');
      assert.deepEqual(queued.argShape, { name: 'string' });
      assert.equal(stepPosts().length, 0);

      mode = 'up';
      await h.call('probe_get');
      await waitFor(() => stepPosts().length === 1, 'the drain');
      await settle();
      const drained = stepPosts()[0]!.body.steps;
      assert.equal(drained.length, 1);
      assert.equal(drained[0].traceId, failedId);
      assert.equal(drained[0].resultClass, 'UNREACHED');
      assert.equal(stepPosts()[0]!.headers[TRACEPARENT_HEADER], undefined);
      assert.equal(h.swfte.pendingLocalSteps.queued, 0);
    } finally {
      await h.close();
    }
  });

  test('a local step that cannot be delivered waits in the queue as itself (no new step)', async () => {
    const h = await harness();
    try {
      mode = 'down';
      const r = await h.call('swfte_composition_classify', { signals: {} });
      await waitFor(() => h.swfte.pendingLocalSteps.queued === 1, 'the undelivered local step to be requeued');
      await new Promise((res) => setTimeout(res, 100));
      const { steps } = h.swfte.pendingLocalSteps;
      assert.equal(steps.length, 1, 'posting a step created another step');
      assert.equal(steps[0]!.resultClass, 'OK');
      assert.equal(steps[0]!.traceId, trailerId(r));

      mode = 'up';
      await h.call('probe_get');
      await waitFor(() => stepPosts().length === 1, 'the drain');
      await settle();
      assert.equal(stepPosts().length, 1);
      assert.equal(h.swfte.pendingLocalSteps.queued, 0);
    } finally {
      await h.close();
    }
  });

  test('the queue stays bounded, drops the oldest and drains in batches', async () => {
    const h = await harness();
    const extra = 7;
    try {
      mode = 'down';
      const ids: string[] = [];
      for (let i = 0; i < UNREACHED_QUEUE_MAX + extra; i++) ids.push(trailerId(await h.call('probe_post')));
      const pending = h.swfte.pendingLocalSteps;
      assert.equal(pending.queued, UNREACHED_QUEUE_MAX);
      assert.equal(pending.dropped, extra);
      const kept = pending.steps.map((s) => s.traceId);
      assert.deepEqual(kept, ids.slice(extra), 'the queue did not drop exactly the oldest entries');

      mode = 'up';
      await h.call('probe_get');
      await waitFor(() => h.swfte.pendingLocalSteps.queued === 0, 'the full drain');
      await settle();
      const posts = stepPosts();
      assert.equal(posts.length, Math.ceil(UNREACHED_QUEUE_MAX / LOCAL_STEPS_PER_POST));
      for (const p of posts) assert.ok(p.body.steps.length <= LOCAL_STEPS_PER_POST);
      assert.deepEqual(posts.flatMap((p) => p.body.steps.map((s: any) => s.traceId)), ids.slice(extra));
    } finally {
      await h.close();
    }
  });

  test('a refused step post is dropped, not retried forever', async () => {
    responder = (s) => (s.path === LOCAL_STEPS_PATH ? { status: 404, body: { code: 'NOT_FOUND', message: 'Not found' } } : undefined);
    const h = await harness();
    try {
      await h.call('swfte_composition_classify', { signals: {} });
      await waitFor(() => stepPosts().length === 1, 'the step post');
      await settle();
      assert.equal(stepPosts().length, 1);
      assert.equal(h.swfte.pendingLocalSteps.queued, 0);
    } finally {
      await h.close();
    }
  });

  test('SWFTE_TELEMETRY=0 posts and queues no steps; tracing headers still flow', async () => {
    const h = await harness('claude-code', config({ SWFTE_TELEMETRY: '0' }));
    try {
      await h.call('swfte_composition_classify', { signals: {} });
      mode = 'down';
      await h.call('probe_post');
      assert.equal(h.swfte.pendingLocalSteps.queued, 0);
      mode = 'up';
      const r = await h.call('probe_get');
      await settle();
      assert.equal(stepPosts().length, 0);
      assert.equal(trailerId(r), ids(backend().at(-1)!).trace);
    } finally {
      await h.close();
    }
  });
});
