/**
 * Per-tool-call trace context (brief 08, learning loop).
 *
 * Every MCP tool call runs inside one {@link CallContext} held on `AsyncLocalStorage`, so every
 * backend request the call makes — however deep inside an orchestrating tool — carries:
 *   - `traceparent: 00-<trace>-<span>-01`, one fresh trace id per TOOL CALL and a fresh span id per
 *     HTTP ATTEMPT (revision L1: a retry is a new attempt inside the same step);
 *   - `X-Swfte-Mcp-Session` (one id per MCP server session), `X-Swfte-Mcp-Client` (the host, normalised
 *     to a closed set so an unknown host's raw name never travels) and `X-Swfte-Mcp-Tool`.
 * Outside a call context nothing is added, so direct uses of `SwfteClient` behave exactly as before.
 *
 * The context also counts the backend attempts the call made and records the trace id the backend
 * echoed in `X-Swfte-Trace-Id`, which becomes the result's `_meta` entry and its text trailer.
 *
 * Calls that never reach the backend are still steps: a call that made no request posts one
 * {@link LocalStep}, and an attempt that could not reach the backend is kept in a bounded
 * {@link LocalStepQueue} as an `UNREACHED` step until the backend answers again. Steps hold names,
 * JSON types, classes and timings only — never an argument value.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import {
  MCP_CLIENT_HEADER,
  MCP_SESSION_HEADER,
  MCP_TOOL_HEADER,
  SESSION_ID_RE,
  TRACE_ID_RE,
  TRACE_META_KEY,
  TRACE_TRAILER_PREFIX,
  TRACEPARENT_HEADER,
  UNREACHED_QUEUE_MAX,
  type LocalStep,
  type McpClientName,
} from './learning-contract.js';

export type ArgType = NonNullable<LocalStep['argShape']>[string];

export interface CallContext {
  /** 32 lowercase hex, fresh per tool call, never all zero. */
  readonly traceId: string;
  /** The MCP server session this call belongs to. */
  readonly sessionId: string;
  /** The MCP host, already normalised. */
  readonly client: McpClientName;
  /** The tool name as sent in `X-Swfte-Mcp-Tool` (`unknown` when the requested name is not a tool name). */
  readonly tool: string;
  /** Top-level argument names mapped to JSON types. Never values. */
  readonly argShape: Record<string, ArgType>;
  /** Backend HTTP attempts made inside this call (every attempt, including retries). */
  requests: number;
  /** The trace id the backend echoed in `X-Swfte-Trace-Id`, when it echoed a well-formed one. */
  echoedTraceId?: string;
}

const calls = new AsyncLocalStorage<CallContext>();

/** The context of the tool call currently executing, if any. */
export function currentCall(): CallContext | undefined {
  return calls.getStore();
}

/** Run `fn` as one tool call. Every backend request made inside it carries the call's trace. */
export function runInCall<T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> {
  return calls.run(ctx, fn);
}

/** Run `fn` outside any tool call, so the requests it makes carry no call trace and count for no call. */
export function outsideCall<T>(fn: () => T): T {
  return calls.exit(fn);
}

function randomHex(bytes: number): string {
  // All-zero ids are invalid in W3C trace context; the odds are negligible, the loop makes it certain.
  for (;;) {
    const hex = randomBytes(bytes).toString('hex');
    if (/[^0]/.test(hex)) return hex;
  }
}

/** 16 random bytes as 32 lowercase hex. */
export function mintTraceId(): string {
  return randomHex(16);
}

/** 8 random bytes as 16 lowercase hex. */
export function mintSpanId(): string {
  return randomHex(8);
}

/** One id per MCP server session; matches `SESSION_ID_RE`. */
export function mintSessionId(): string {
  return `mcp_${randomHex(12)}`;
}

/** A transport-supplied session id when it is well formed, else the fallback. */
export function sessionIdOr(candidate: unknown, fallback: string): string {
  return typeof candidate === 'string' && SESSION_ID_RE.test(candidate) ? candidate : fallback;
}

export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

/** The (trace, span) pair of a traceparent this module formatted. */
export function parseTraceparent(value: string | undefined): { traceId: string; spanId: string } | undefined {
  const m = value ? TRACEPARENT_RE.exec(value) : null;
  return m ? { traceId: m[1]!, spanId: m[2]! } : undefined;
}

/** What `X-Swfte-Mcp-Tool` accepts on the backend; anything else is sent as `unknown`. */
const TOOL_NAME_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

export function toolNameForTrace(name: unknown): string {
  return typeof name === 'string' && TOOL_NAME_RE.test(name) ? name : 'unknown';
}

export function newCallContext(init: {
  sessionId: string;
  client: McpClientName;
  tool: unknown;
  args: unknown;
}): CallContext {
  return {
    traceId: mintTraceId(),
    sessionId: init.sessionId,
    client: init.client,
    tool: toolNameForTrace(init.tool),
    argShape: argShapeOf(init.args),
    requests: 0,
  };
}

/**
 * The headers one HTTP attempt carries: the call's trace with a NEW span id, plus session, client and
 * tool. Called once per attempt, so a retry keeps the trace id and changes the span id.
 */
export function traceHeaders(ctx: CallContext): Record<string, string> {
  return {
    [TRACEPARENT_HEADER]: formatTraceparent(ctx.traceId, mintSpanId()),
    [MCP_SESSION_HEADER]: ctx.sessionId,
    [MCP_CLIENT_HEADER]: ctx.client,
    [MCP_TOOL_HEADER]: ctx.tool,
  };
}

/**
 * Record the echoed `X-Swfte-Trace-Id`. Only a well-formed id is kept. The first echo wins, except that
 * an echo equal to the call's own trace id (the backend adopted our traceparent) always wins.
 */
export function recordEcho(ctx: CallContext, echoed: string | null | undefined): void {
  if (!echoed || !TRACE_ID_RE.test(echoed)) return;
  if (ctx.echoedTraceId === undefined || echoed === ctx.traceId) ctx.echoedTraceId = echoed;
}

/** The id a result reports: the backend's echo when there was one, else the minted id. */
export function resultTraceId(ctx: CallContext): string {
  return ctx.echoedTraceId ?? ctx.traceId;
}

export function traceTrailer(traceId: string): string {
  return `${TRACE_TRAILER_PREFIX}${traceId}`;
}

type ToolResult = { content?: unknown; _meta?: unknown; [k: string]: unknown };

/**
 * Stamp a tool result with its trace: `_meta[TRACE_META_KEY]` and, as the LAST text content item, the
 * one-line trailer. Existing content is left exactly as it was.
 */
export function withTrace<R extends ToolResult>(result: R, traceId: string): R {
  const content = Array.isArray(result.content) ? result.content : [];
  const meta = result._meta && typeof result._meta === 'object' ? (result._meta as Record<string, unknown>) : {};
  return {
    ...result,
    content: [...content, { type: 'text', text: traceTrailer(traceId) }],
    _meta: { ...meta, [TRACE_META_KEY]: traceId },
  };
}

/* ── argument shapes ──────────────────────────────────────────────────────── */

const ARG_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const MAX_ARGS = 50;

function isHandle(value: string): boolean {
  return value.startsWith('conn_') || value.startsWith('secret://');
}

function typeOf(value: unknown): ArgType | undefined {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return isHandle(value) ? 'handle' : 'string';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return undefined;
  }
}

/**
 * Top-level argument NAMES mapped to JSON types; `conn_...` / `secret://...` strings are typed `handle`.
 * Never a value. Names that do not look like parameter names are skipped (a free-text key is content),
 * and at most {@link MAX_ARGS} names are kept.
 */
export function argShapeOf(args: unknown): Record<string, ArgType> {
  const shape: Record<string, ArgType> = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return shape;
  let n = 0;
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (n >= MAX_ARGS) break;
    if (!ARG_NAME_RE.test(key)) continue;
    const t = typeOf(value);
    if (!t) continue;
    shape[key] = t;
    n += 1;
  }
  return shape;
}

/* ── local steps ──────────────────────────────────────────────────────────── */

/** A step waiting to be posted, with the session and client headers it must be posted under. */
export interface PendingStep {
  step: LocalStep;
  sessionId: string;
  client: McpClientName;
}

/**
 * The bounded in-memory queue of steps not yet delivered: UNREACHED attempts, and local steps whose own
 * POST could not reach the backend. Past {@link UNREACHED_QUEUE_MAX} the oldest entries are dropped and
 * counted. Held per `SwfteClient`, i.e. per credential, so a step is only ever posted under the identity
 * that made the attempt.
 */
export class LocalStepQueue {
  private items: PendingStep[] = [];
  private droppedCount = 0;

  constructor(private readonly max: number = UNREACHED_QUEUE_MAX) {}

  get size(): number {
    return this.items.length;
  }

  /** Entries dropped because the queue was full. */
  get dropped(): number {
    return this.droppedCount;
  }

  push(entry: PendingStep): void {
    this.items.push(entry);
    this.trim();
  }

  /** Put entries that could not be delivered back at the front (they are the oldest). */
  unshift(entries: PendingStep[]): void {
    this.items = [...entries, ...this.items];
    this.trim();
  }

  /** Remove and return up to `limit` leading entries that share the head's session and client. */
  takeBatch(limit: number): PendingStep[] {
    const head = this.items[0];
    if (!head) return [];
    const batch: PendingStep[] = [];
    const rest: PendingStep[] = [];
    for (const e of this.items) {
      if (batch.length < limit && e.sessionId === head.sessionId && e.client === head.client) batch.push(e);
      else rest.push(e);
    }
    this.items = rest;
    return batch;
  }

  /** A copy of the queued steps, oldest first. */
  snapshot(): LocalStep[] {
    return this.items.map((e) => e.step);
  }

  private trim(): void {
    const over = this.items.length - this.max;
    if (over > 0) {
      this.items.splice(0, over);
      this.droppedCount += over;
    }
  }
}

/**
 * A short, value-free error class for a local step: a code token, never a message (messages can quote
 * input). `mcp:<token>` with the token reduced to `[A-Za-z0-9_]`.
 */
export function errorSignature(token: string): string {
  const clean = token.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60) || 'error';
  return `mcp:${clean}`;
}
