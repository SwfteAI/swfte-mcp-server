import { AsyncLocalStorage } from 'node:async_hooks';
import type { ServerConfig } from './config.js';
import {
  LOCAL_STEPS_PATH,
  LOCAL_STEPS_PER_POST,
  MCP_CLIENT_HEADER,
  MCP_SESSION_HEADER,
  TRACE_ECHO_HEADER,
  TRACEPARENT_HEADER,
} from './learning-contract.js';
import {
  currentCall,
  LocalStepQueue,
  outsideCall,
  parseTraceparent,
  recordEcho,
  traceHeaders,
  type CallContext,
  type PendingStep,
} from './tracing.js';

/** One attempt at posting local steps; they are best effort and never retried inline. */
const LOCAL_STEPS_TIMEOUT_MS = 5_000;

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  workspaceId?: string;
  headers?: Record<string, string>;
  /** Per-request timeout. Defaults to 60s; wizard/exec polls override it. */
  timeoutMs?: number;
  /**
   * Retry budget for *transient* failures (network, 429, 5xx). GET defaults to 2; mutations to 0.
   * Set 0 for non-idempotent calls where a duplicate would be harmful.
   */
  retries?: number;
  /** Treat these statuses as success and return the parsed body. */
  expectStatuses?: number[];
}

/**
 * Machine-readable failure. Every tool surfaces one of these rather than a bare
 * string, because a thrown message gives the model nothing to branch on. The
 * `code` is the backend's own envelope code where it has one
 * (`PAYMENT_METHOD_REQUIRED`, `SUBSCRIPTION_REQUIRED`, `WORKFLOW_NOT_PUBLISHED`,
 * `VALIDATION_FAILED`, …), otherwise a synthetic one.
 */
export class SwfteApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  readonly envelope: Record<string, unknown>;
  readonly method: string;
  readonly path: string;
  readonly suggestedAction?: string;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    reason?: string;
    envelope?: Record<string, unknown>;
    method: string;
    path: string;
    suggestedAction?: string;
  }) {
    super(init.message);
    this.name = 'SwfteApiError';
    this.status = init.status;
    this.code = init.code;
    this.reason = init.reason;
    this.envelope = init.envelope ?? {};
    this.method = init.method;
    this.path = init.path;
    this.suggestedAction = init.suggestedAction;
  }

  /** Shape handed back to the model. */
  toJSON(): Record<string, unknown> {
    return {
      error: true,
      code: this.code,
      status: this.status,
      message: this.message,
      ...(this.reason ? { reason: this.reason } : {}),
      request: `${this.method} ${this.path}`,
      ...(this.suggestedAction ? { suggestedAction: this.suggestedAction } : {}),
      ...(Object.keys(this.envelope).length > 0 ? { detail: this.envelope } : {}),
    };
  }
}

/**
 * Statuses worth retrying. 429 and 5xx are load-shedding or transient infra;
 * 408 is a server-side timeout. Everything else is a real answer.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Guidance attached to the well-known gate codes, so the model proposes the
 * right next step instead of retrying into the same wall.
 */
const SUGGESTED_ACTIONS: Record<string, string> = {
  PAYMENT_METHOD_REQUIRED:
    'This workspace needs a card on file before it can create more build artifacts. ' +
    'Add one in Studio → Billing, then retry.',
  SUBSCRIPTION_REQUIRED:
    'Running and deploying require an active subscription. Building and exporting stay free. ' +
    'Upgrade in Studio → Billing, then retry.',
  QUOTA_EXCEEDED: 'Workspace quota reached. Raise the cap in Studio → Billing or wait for the period to roll over.',
  WORKFLOW_NOT_PUBLISHED:
    'Publish a version to exercise released behavior. swfte_run can fall back to a draft test path, which may mock nodes and is not proof of published execution.',
  VALIDATION_FAILED: 'Fix the reported validation errors with swfte_refine, then retry swfte_create.',
  HTTP_403: 'Access was rejected. Verify workspace permissions and the documented endpoint/method; retain the response and inspect existing artifacts before retrying a mutation. Unexpected HTML does not establish whether policy, routing or payload caused rejection.',
  HTTP_405: 'This endpoint does not accept the request method. Consult swfte_capabilities and the current supported update tool; do not repeat the same mutation or assume a different method is safe without its documented contract.',
  HTTP_409: 'State or version conflict. Read current state and reconcile the intended update before retrying; do not overwrite concurrent changes.',
  HTTP_429: 'Rate limited. Honor server retry timing and inspect execution/build status before repeating a metered mutation.',
  pat_invalid: 'The personal access token is invalid, expired, or revoked. Mint a new one in Studio → Modules → any module → Documents → Connect CLI.',
  pat_missing: 'No credential reached the server. Check SWFTE_PAT is set in the MCP server environment.',
};

export interface PaginateOptions extends Omit<RequestOptions, 'method'> {
  /** Query param carrying the zero-based page index. */
  pageParam?: string;
  /** Query param carrying the page size. */
  sizeParam?: string;
  /** Page size to request. Kept at/below any server cap by the caller. */
  pageSize?: number;
  /** Hard ceiling on pages fetched, so a pathological total can't spin forever. */
  maxPages?: number;
  /** Pull the item array out of a page response. */
  extract?: (page: any) => unknown[];
}

/** Default item extractor — these four shapes cover every list endpoint we touch. */
function defaultExtract(page: any): unknown[] {
  if (Array.isArray(page)) return page;
  return page?.content ?? page?.items ?? page?.data ?? page?.agents ?? page?.workflows ?? [];
}

export class OperationDeadlineError extends Error {
  constructor() { super('Operation time budget exhausted; an in-flight mutation may have committed. Inspect returned IDs before retrying.'); }
}

export class SwfteClient {
  private readonly operationDeadline = new AsyncLocalStorage<number>();
  withDeadline<T>(deadline: number, action: () => Promise<T>): Promise<T> {
    return this.operationDeadline.run(Math.min(deadline, this.operationDeadline.getStore() ?? Infinity), action);
  }
  remainingMs(): number { return (this.operationDeadline.getStore() ?? Infinity) - Date.now(); }
  assertDeadline(): void { if (this.remainingMs() <= 0) throw new OperationDeadlineError(); }
  private requestBudget(timeoutMs: number): number {
    this.assertDeadline();
    return Math.max(1, Math.min(timeoutMs, this.remainingMs()));
  }

  constructor(private readonly config: ServerConfig) {}

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  get credentialKind(): ServerConfig['credentialKind'] {
    return this.config.credentialKind;
  }

  get configuredWorkspaceId(): string | undefined {
    return this.config.workspaceId;
  }

  get serverConnectionsEnabled(): boolean {
    return this.config.serverConnections === true;
  }

  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const retries = opts.retries ?? (opts.method === 'GET' ? 2 : 0);
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.requestOnce<T>(opts);
      } catch (err) {
        this.assertDeadline();
        if (err instanceof OperationDeadlineError) throw err;
        lastError = err;

        const retryable =
          err instanceof SwfteApiError
            ? RETRYABLE_STATUSES.has(err.status)
            : // Network-level failure (DNS, reset, abort). Worth one more go.
              true;

        if (!retryable || attempt === retries) throw err;

        // Linear-ish backoff. These are seconds-scale platform hiccups, not
        // contention we need to exponentially back away from.
        await sleep(Math.min(1_500 * (attempt + 1), Math.max(0, this.remainingMs())));
      }
    }

    throw lastError;
  }

  private async requestOnce<T>(opts: RequestOptions): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    const headers = this.buildHeaders(opts);

    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }

    if (this.config.debug) {
      process.stderr.write(`[swfte-mcp] → ${opts.method} ${url}\n`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestBudget(opts.timeoutMs ?? 60_000));

    let res: Response;
    let text: string;
    try {
      res = await this.send(url, { method: opts.method, headers, body }, controller);
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }

    if (this.config.debug) {
      process.stderr.write(`[swfte-mcp] ← ${res.status} ${opts.method} ${opts.path}\n`);
    }

    const ok = res.ok || (opts.expectStatuses?.includes(res.status) ?? false);
    if (!ok) throw this.toApiError(res, text, opts);

    // A 202 Accepted for an async provision routinely carries an EMPTY body.
    // Parsing that would throw and read to the caller as a failed deploy —
    // prompting a retry and a double-provision. Same for 204.
    if (!text) return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      // Some endpoints (export, logs) legitimately return text/plain.
      return text as unknown as T;
    }
  }

  private buildHeaders(opts: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.credential}`,
      'User-Agent': this.config.userAgent,
      Accept: 'application/json',
      ...opts.headers,
    };

    if (this.config.credentialKind === 'api-key') {
      // ApiKeyAuthFilter reads X-API-Key first, Authorization second. Send both
      // for compatibility with either resolution order.
      headers['X-API-Key'] = this.config.credential;

      const workspaceId = opts.workspaceId ?? this.config.workspaceId;
      if (workspaceId) headers['X-Workspace-ID'] = workspaceId;
    }
    // PAT path: deliberately no X-API-Key (that would copy the secret into a
    // second header for no gain) and no X-Workspace-Id — PersonalAccessToken-
    // AuthFilter injects the token's own trusted tenant headers and overrides
    // whatever we send, so ours can only mislead.

    // Inside a tool call: the call's trace with a fresh span for this attempt, plus the MCP session,
    // client and tool. Set last so a caller-supplied header cannot replace them. Outside a call
    // nothing is added.
    const call = currentCall();
    if (call) Object.assign(headers, traceHeaders(call));

    return headers;
  }

  /* ── learning loop: attempt bookkeeping and local steps ─────────────────── */

  private readonly localSteps = new LocalStepQueue();
  private draining = false;

  /** Steps waiting for the backend (UNREACHED attempts, undelivered local steps) and how many were dropped. */
  get pendingLocalSteps(): { queued: number; dropped: number; steps: PendingStep['step'][] } {
    return { queued: this.localSteps.size, dropped: this.localSteps.dropped, steps: this.localSteps.snapshot() };
  }

  private get learningEnabled(): boolean {
    return this.config.telemetry !== false;
  }

  /**
   * Every HTTP attempt goes through here. Inside a tool call it counts the attempt, records the echoed
   * trace id, queues an UNREACHED step when the backend could not be reached, and drains pending steps
   * once the backend answers. Outside a call it is a plain fetch.
   */
  private async send(
    url: string,
    init: RequestInit & { headers: Record<string, string> },
    controller: AbortController
  ): Promise<Response> {
    const call = currentCall();
    if (!call) return fetch(url, { ...init, signal: controller.signal });

    call.requests += 1;
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      // Our own abort is a timeout: the request may well have reached the backend, so it is not
      // UNREACHED. Anything else (refused, reset, DNS) never produced an answer.
      if (!controller.signal.aborted) this.queueUnreached(call, init.headers, startedAt);
      throw err;
    }
    recordEcho(call, res.headers.get(TRACE_ECHO_HEADER));
    this.drainLocalSteps();
    return res;
  }

  private queueUnreached(call: CallContext, headers: Record<string, string>, startedAt: number): void {
    if (!this.learningEnabled) return;
    const ids = parseTraceparent(headers[TRACEPARENT_HEADER]);
    if (!ids) return;
    this.localSteps.push({
      sessionId: call.sessionId,
      client: call.client,
      step: {
        traceId: ids.traceId,
        spanId: ids.spanId,
        tool: call.tool,
        resultClass: 'UNREACHED',
        errorSignature: 'net:unreachable',
        argShape: call.argShape,
        ms: Math.max(0, Date.now() - startedAt),
        occurredAtMs: startedAt,
      },
    });
  }

  /**
   * Post a step for a tool call that made no backend request. Fire-and-forget: it never throws, never
   * delays the caller, and a step it cannot deliver waits in the bounded queue.
   */
  recordLocalStep(entry: PendingStep): void {
    try {
      if (!this.learningEnabled) return;
      this.localSteps.push(entry);
      this.drainLocalSteps();
    } catch {
      // A step never fails a tool.
    }
  }

  /**
   * Deliver pending steps in batches of LOCAL_STEPS_PER_POST, one session/client per POST. Runs outside
   * any tool call (so the POST carries no call trace, counts for no call and cannot queue a step of its
   * own) and outside the caller's operation deadline. One drain at a time.
   */
  private drainLocalSteps(): void {
    if (this.draining || this.localSteps.size === 0 || !this.learningEnabled) return;
    this.draining = true;
    outsideCall(() =>
      this.operationDeadline.exit(() => {
        void this.deliverLocalSteps()
          .catch(() => false)
          .then((reachable) => {
            this.draining = false;
            if (reachable && this.localSteps.size > 0) this.drainLocalSteps();
          });
      })
    );
  }

  /** Returns false when the backend could not be reached (the batch is back in the queue). */
  private async deliverLocalSteps(): Promise<boolean> {
    while (this.localSteps.size > 0) {
      const batch = this.localSteps.takeBatch(LOCAL_STEPS_PER_POST);
      const head = batch[0]!;
      try {
        await this.request({
          method: 'POST',
          path: LOCAL_STEPS_PATH,
          body: { steps: batch.map((e) => e.step) },
          headers: { [MCP_SESSION_HEADER]: head.sessionId, [MCP_CLIENT_HEADER]: head.client },
          retries: 0,
          timeoutMs: LOCAL_STEPS_TIMEOUT_MS,
        });
      } catch (err) {
        // The backend answered and refused (flag off, not a PAT, invalid): resending cannot help, drop it.
        if (err instanceof SwfteApiError) continue;
        this.localSteps.unshift(batch);
        return false;
      }
    }
    return true;
  }

  private toApiError(res: Response, text: string, opts: RequestOptions): SwfteApiError {
    let envelope: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) envelope = parsed;
    } catch {
      // Non-JSON body. Most often an HTML error page from an edge/proxy hop —
      // truncate hard so a page of markup doesn't land in the model's context.
      if (text) envelope = { body: text.length > 500 ? `${text.slice(0, 500)}…` : text };
    }

    // Backends disagree on where the code lives; check every spelling we've seen.
    const nested = (envelope.error ?? {}) as Record<string, unknown>;
    const code = String(
      envelope.code ?? nested.code ?? (typeof envelope.error === 'string' ? envelope.error : '') ?? ''
    ) || `HTTP_${res.status}`;

    const message =
      String(envelope.message ?? nested.message ?? envelope.reason ?? '') ||
      `${res.status} ${res.statusText} on ${opts.method} ${opts.path}`;

    return new SwfteApiError({
      status: res.status,
      code,
      message,
      reason: typeof envelope.reason === 'string' ? envelope.reason : undefined,
      envelope,
      method: opts.method,
      path: opts.path,
      suggestedAction: SUGGESTED_ACTIONS[code],
    });
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.config.baseUrl}${cleanPath}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /**
   * GET a binary body (a zip, an export bundle) plus the response headers.
   *
   * Separate from `request` because that one assumes JSON both ways: it would
   * mangle a zip through `res.text()` and lose the headers the code round-trip
   * needs (`X-Swfte-Blueprint-Sha` tells you whether the blueprint moved under
   * your edits).
   */
  async getBinary(
    path: string,
    opts: { query?: RequestOptions['query']; timeoutMs?: number; accept?: string } = {}
  ): Promise<{ bytes: Uint8Array; headers: Record<string, string>; contentType: string }> {
    const url = this.buildUrl(path, opts.query);
    // `accept` for a non-JSON document (a Markdown export); the body comes back as bytes either way.
    const headers = this.buildHeaders({ method: 'GET', path, ...(opts.accept ? { headers: { Accept: opts.accept } } : {}) });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestBudget(opts.timeoutMs ?? 180_000));
    try {
      const res = await this.send(url, { method: 'GET', headers }, controller);
      if (!res.ok) {
        const text = await res.text();
        throw this.toApiError(res, text, { method: 'GET', path });
      }
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        headers: out,
        contentType: res.headers.get('content-type') ?? '',
      };
    } finally {
      // Keep the deadline active until the streamed response body is consumed.
      clearTimeout(timer);
    }
  }

  /**
   * POST multipart/form-data. Used by the code-sync upload, which takes the
   * workspace as a file part rather than as JSON.
   *
   * Deliberately sets no Content-Type: fetch derives it from the FormData along
   * with the boundary, and setting it by hand produces a body the server cannot
   * parse.
   */
  async postMultipart<T = unknown>(
    path: string,
    form: FormData,
    opts: { query?: RequestOptions['query']; timeoutMs?: number; workspaceId?: string } = {}
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const headers = this.buildHeaders({ method: 'POST', path, workspaceId: opts.workspaceId });
    delete headers['Content-Type'];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestBudget(opts.timeoutMs ?? 180_000));
    let res: Response;
    let text: string;
    try {
      res = await this.send(url, { method: 'POST', headers, body: form }, controller);
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw this.toApiError(res, text, { method: 'POST', path });
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Fetch every page of a list endpoint.
   *
   * This exists because `GET /v1/agents` caps its page size at 20 and *silently
   * ignores* larger values — asking for 200 returns 20 with no indication that
   * more exist. Single-request list code therefore misses everything past the
   * first page, which is how a fleet run once accumulated 79 agent records
   * across 45 intended names: the existence check never saw the duplicates.
   */
  async paginate<T = unknown>(opts: PaginateOptions): Promise<T[]> {
    const pageParam = opts.pageParam ?? 'page';
    const sizeParam = opts.sizeParam ?? 'pageSize';
    const pageSize = opts.pageSize ?? 20;
    const maxPages = opts.maxPages ?? 50;
    const extract = opts.extract ?? defaultExtract;

    const all: T[] = [];
    let page = 0;
    let totalPages = 1;

    do {
      const body = await this.request<any>({
        ...opts,
        method: 'GET',
        query: { ...opts.query, [pageParam]: page, [sizeParam]: pageSize },
      });

      const items = extract(body) as T[];
      all.push(...items);

      totalPages = Number(body?.totalPages ?? 1) || 1;
      page += 1;

      // Defensive: if the server reports no totalPages but keeps returning a
      // full page, keep going until it short-changes us.
      if (totalPages === 1 && items.length === pageSize && page < maxPages) totalPages = page + 1;
    } while (page < totalPages && page < maxPages);

    return all;
  }

  /**
   * Partial update via GET → merge → PUT.
   *
   * The v2 agent `PATCH` endpoint **wipes fields omitted from the body** —
   * patching only `temperature` was observed to blank `systemPrompt`. Any
   * partial update must therefore read the full record, overlay the change, and
   * write the whole thing back.
   */
  async mergePut<T = unknown>(
    path: string,
    partial: Record<string, unknown>,
    opts: Omit<RequestOptions, 'method' | 'path' | 'body'> = {}
  ): Promise<T> {
    const current = await this.request<Record<string, unknown>>({ ...opts, method: 'GET', path });
    return this.request<T>({
      ...opts,
      method: 'PUT',
      path,
      body: { ...current, ...partial },
      // A merge-PUT is idempotent, but a retry after a partial write could race
      // a concurrent edit. One retry is the right budget.
      retries: opts.retries ?? 1,
    });
  }

  /**
   * Poll `fn` until `done` says the job reached a terminal state, or the
   * deadline passes. Returns the last snapshot either way, with `timedOut` set
   * so callers can distinguish "finished" from "still going".
   */
  async pollUntil<T>(
    fn: () => Promise<T>,
    done: (snapshot: T) => boolean,
    opts: { timeoutMs: number; intervalMs?: number; onTick?: (s: T) => void }
  ): Promise<{ snapshot: T; timedOut: boolean; elapsedMs: number; polls: number }> {
    const intervalMs = opts.intervalMs ?? 2_000;
    const started = Date.now();
    const deadline = Math.min(started + opts.timeoutMs, this.operationDeadline.getStore() ?? Infinity);

    let snapshot = await fn();
    let polls = 1;
    opts.onTick?.(snapshot);

    while (!done(snapshot) && Date.now() < deadline) {
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      try {
        snapshot = await fn();
        polls += 1;
        opts.onTick?.(snapshot);
      } catch (err) {
        // A single failed poll mid-job is not job failure. Keep polling until
        // the deadline; `request` has already burned its own retry budget.
        if (this.config.debug) {
          process.stderr.write(
            `[swfte-mcp] poll error (continuing): ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
      }
    }

    return {
      snapshot,
      timedOut: !done(snapshot),
      elapsedMs: Date.now() - started,
      polls,
    };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
