/**
 * The only network path of the code map (docs/codemap/CONTRACT.md §4, §7).
 *
 *   POST /v2/codemap/repos/{repoId}/manifests   the manifest, as manifest.ts serialized it
 *   GET  /v2/codemap/key                         the workspace key (held in memory only)
 *
 * Rules this module keeps:
 *   - the body is always serializeManifest(...) output: the allowlist runs on every upload, including
 *     a manifest read back from the offline queue;
 *   - the credential goes only to a base URL the operator set (SWFTE_BASE_URL) or one on the allowed
 *     hosts list (hosts.ts), and never across a redirect;
 *   - a network failure or an unavailable server is reported as `offline` (or `queued-offline` when
 *     the caller hands a queue), never as success and never as a thrown "uploaded";
 *   - it imports nothing that writes to disk and never imports the compliance transport
 *     (src/compliance.ts, src/tools/compliance.ts), directly or transitively. A unit test walks this
 *     file's static import graph to prove both.
 */
import { gzipSync } from 'node:zlib';
import { assertLockBaseUrl, UntrustedHostError } from '../hosts.js';
import { WORKSPACE_KEY_BYTES } from './fingerprint.js';
import { checkManifest, serializeManifest } from './manifest.js';
import { REPO_ID_PATTERN, type Manifest } from './types.js';

export const CODEMAP_BASE = '/v2/codemap';
export const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;

/** What the upload needs of the MCP's config; a ServerConfig satisfies it. */
export interface UploadConfig {
  baseUrl: string;
  credential: string;
  credentialKind: 'pat' | 'api-key';
  workspaceId?: string;
  userAgent?: string;
  /** Environment for the allowed-hosts rule (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface UploadOptions {
  gzip?: boolean;
  /** Where a manifest goes when the server cannot be reached (queue.ts provides one). */
  queue?: { enqueue(manifest: Manifest): string };
}

export type UploadResult =
  | { status: 'stored' | 'duplicate'; commitSha: string; callSites: number }
  | { status: 'offline'; commitSha: string; reason: string }
  | { status: 'queued-offline'; commitSha: string; reason: string; queuedAt: string };

export class CodemapApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** JSON pointer of an allowlist violation, when the server named one. */
  readonly pointer?: string;
  constructor(status: number, code: string, message: string, pointer?: string) {
    super(message);
    this.name = 'CodemapApiError';
    this.status = status;
    this.code = code;
    this.pointer = pointer;
  }
}

/** The server was not reachable (or answered as unavailable). */
export class CodemapOfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodemapOfflineError';
  }
}

export interface WorkspaceKey {
  keyId: string;
  /** 32 raw bytes. In memory only: this module never writes it anywhere, and toJSON leaves it out. */
  readonly key: Uint8Array;
}

const UNAVAILABLE = new Set([408, 429, 500, 502, 503, 504]);

/** The base URL the credential may go to, or a thrown UntrustedHostError. */
export function credentialTarget(cfg: UploadConfig): string {
  const env = cfg.env ?? process.env;
  const base = String(cfg.baseUrl ?? '').replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new UntrustedHostError('Refusing to send the Swfte credential: the base URL is not a valid URL.');
  }
  if (u.username || u.password) {
    throw new UntrustedHostError('Refusing to send the Swfte credential: the base URL contains credentials (user:password@host).');
  }
  return assertLockBaseUrl(base, env, env.SWFTE_BASE_URL?.trim() || undefined).replace(/\/+$/, '');
}

function headers(cfg: UploadConfig): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${cfg.credential}`,
    Accept: 'application/json',
    'User-Agent': cfg.userAgent ?? 'swfte-codemap',
  };
  if (cfg.credentialKind === 'api-key') {
    h['X-API-Key'] = cfg.credential;
    if (cfg.workspaceId) h['X-Workspace-ID'] = cfg.workspaceId;
  }
  return h;
}

type Answer = { kind: 'answer'; status: number; body: unknown } | { kind: 'offline'; reason: string };

async function call(cfg: UploadConfig, method: 'GET' | 'POST', path: string, body?: { bytes: Uint8Array; gzip: boolean }): Promise<Answer> {
  const base = credentialTarget(cfg); // throws before anything is sent
  const doFetch = cfg.fetch ?? fetch;
  const h = headers(cfg);
  if (body) {
    h['Content-Type'] = 'application/json';
    if (body.gzip) h['Content-Encoding'] = 'gzip';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await doFetch(`${base}${path}`, {
      method,
      headers: h,
      body: body ? body.bytes : undefined,
      // A redirect would carry the credential to wherever it points; the API never redirects.
      redirect: 'manual',
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    return { kind: 'offline', reason: name === 'AbortError' ? 'the request timed out' : 'the server could not be reached' };
  } finally {
    clearTimeout(timer);
  }
  if (UNAVAILABLE.has(res.status)) return { kind: 'offline', reason: `the server answered ${res.status}` };
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    throw new CodemapApiError(res.status || 302, 'UNEXPECTED_REDIRECT', `${method} ${path} answered a redirect; the credential was not forwarded.`);
  }
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  return { kind: 'answer', status: res.status, body: parsed };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** An error answer as a typed error: the code and pointer only, never an echoed value. */
function apiError(method: string, path: string, status: number, body: unknown): CodemapApiError {
  const o = isObj(body) ? body : {};
  const nested = isObj(o.error) ? o.error : {};
  const rawCode = o.code ?? nested.code ?? (typeof o.error === 'string' ? o.error : undefined);
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) ? rawCode : `HTTP_${status}`;
  const rawPointer = o.pointer ?? nested.pointer;
  const pointer = typeof rawPointer === 'string' && /^(\/[A-Za-z0-9_~.-]*)*$/.test(rawPointer) && rawPointer.length <= 200 ? rawPointer : undefined;
  return new CodemapApiError(status, code, `${method} ${path} answered ${status} ${code}${pointer !== undefined ? ` at ${pointer || '(document)'}` : ''}.`, pointer);
}

/**
 * Upload one manifest. Resolves `stored` / `duplicate` only on the server's own 200 answer for this
 * commit; `offline` / `queued-offline` when the server cannot be reached; throws CodemapApiError for
 * a refusal (400 allowlist, 404 not opted in, 401/403, 413) and UntrustedHostError before sending
 * anything to a host the credential may not go to.
 */
export async function uploadManifest(cfg: UploadConfig, repoId: string, manifest: Manifest, opts: UploadOptions = {}): Promise<UploadResult> {
  if (!REPO_ID_PATTERN.test(repoId)) throw new CodemapApiError(0, 'INVALID_REPO_ID', 'The repo id must be r_ + 32 hex.');
  const checked = checkManifest(manifest); // the allowlist, every time (a queued manifest included)
  const body = serializeManifest(checked);
  if (checked.repo.id !== repoId) throw new CodemapApiError(0, 'REPO_MISMATCH', 'The manifest names a different repo than the upload path.');
  const raw = Buffer.from(body, 'utf8');
  const gzip = Boolean(opts.gzip);
  const path = `${CODEMAP_BASE}/repos/${repoId}/manifests`;
  const answer = await call(cfg, 'POST', path, { bytes: gzip ? gzipSync(raw) : raw, gzip });
  if (answer.kind === 'offline') {
    if (opts.queue) return { status: 'queued-offline', commitSha: checked.commitSha, reason: answer.reason, queuedAt: opts.queue.enqueue(checked) };
    return { status: 'offline', commitSha: checked.commitSha, reason: answer.reason };
  }
  if (answer.status !== 200) throw apiError('POST', path, answer.status, answer.body);
  const b = answer.body;
  if (!isObj(b) || (b.status !== 'stored' && b.status !== 'duplicate') || b.commitSha !== checked.commitSha || typeof b.callSites !== 'number' || !Number.isInteger(b.callSites) || b.callSites < 0) {
    throw new CodemapApiError(200, 'UNEXPECTED_ANSWER', `POST ${path} answered 200 without a stored/duplicate receipt for this commit; nothing is reported as uploaded.`);
  }
  return { status: b.status, commitSha: checked.commitSha, callSites: b.callSites };
}

/**
 * GET /v2/codemap/key → the workspace key, decoded and checked (32 bytes). 404 before any opt-in
 * (CodemapApiError NOT_FOUND); CodemapOfflineError when the server cannot be reached. The key is never
 * written to disk: this module has no filesystem access at all.
 */
export async function fetchWorkspaceKey(cfg: UploadConfig): Promise<WorkspaceKey> {
  const path = `${CODEMAP_BASE}/key`;
  const answer = await call(cfg, 'GET', path);
  if (answer.kind === 'offline') throw new CodemapOfflineError(`GET ${path}: ${answer.reason}. Fingerprints need the workspace key; try again when online.`);
  if (answer.status !== 200) throw apiError('GET', path, answer.status, answer.body);
  const b = answer.body;
  const keyText = isObj(b) && typeof b.key === 'string' ? b.key : '';
  const keyId = isObj(b) && typeof b.keyId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(b.keyId) ? b.keyId : null;
  const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(keyText) ? Buffer.from(keyText, 'base64') : Buffer.alloc(0);
  if (!keyId || bytes.length !== WORKSPACE_KEY_BYTES) {
    throw new CodemapApiError(200, 'UNEXPECTED_ANSWER', `GET ${path} did not answer a ${WORKSPACE_KEY_BYTES}-byte workspace key.`);
  }
  const key = new Uint8Array(bytes);
  const out = { keyId } as WorkspaceKey;
  Object.defineProperty(out, 'key', { value: key, enumerable: false, writable: false });
  Object.defineProperty(out, 'toJSON', { value: () => ({ keyId }), enumerable: false });
  return out;
}
