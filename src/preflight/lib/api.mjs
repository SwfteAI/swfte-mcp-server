import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Standalone REST client for the Swfte platform.
 *
 * Deliberately duplicated rather than imported from ../../scripts/api.mjs:
 * `preflight/` is meant to be copied whole into any solution directory, so it
 * must not reach outside itself. Read-only by construction — the only verb
 * exported is GET.
 *
 * PACKAGED COPY. One thing is added over the engagement original: `withTransport`,
 * so the MCP server can hand in its own already-authenticated GET instead of
 * this file re-deriving credentials from the environment. It is additive and
 * opt-in — with no transport set, the env-driven path below is byte-for-byte
 * the original. No rule sees the difference: rules are pure functions of the
 * snapshot and never touch this module.
 */
const BASE = (process.env.SWFTE_BASE_URL ?? 'https://api.swfte.com/agents').replace(/\/+$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pat() {
  const p = process.env.SWFTE_PAT;
  if (!p) throw new Error('SWFTE_PAT is not set');
  return p;
}

/**
 * Injected GET, when one is supplied. Signature: (path, opts) -> parsed body,
 * throwing on a real failure with `.status` set where known.
 *
 * Still funnelled through the same serialising `chain` below, because the
 * concurrency limit is a property of the platform, not of this transport.
 */
const transportContext = new AsyncLocalStorage();

/** Scope credentials and the request queue to this invocation, including concurrent hosted calls. */
export function withTransport(fn, action) {
  return transportContext.run({ transport: fn, chain: Promise.resolve() }, action);
}

// Standalone CLI requests share one queue. Hosted invocations each get their own.
const standalone = { transport: null, chain: Promise.resolve() };

export function get(path, opts = {}) {
  const scope = transportContext.getStore() ?? standalone;
  const run = () => (scope.transport ? scope.transport(path, opts) : rawGet(path, opts));
  const next = scope.chain.then(run, run);
  scope.chain = next.then(() => undefined, () => undefined);
  return next;
}

async function rawGet(path, opts) {
  const url = `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = { Authorization: `Bearer ${pat()}`, Accept: 'application/json' };
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
    } catch (e) {
      last = new Error(`GET ${path} transport: ${e.message}`);
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      if ((res.status >= 500 || res.status === 429) && attempt < 3) {
        last = new Error(`GET ${path} -> ${res.status}`);
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      const err = new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }
  throw last;
}

/** GET that returns null on 404/500 instead of throwing — for optional probes. */
export async function tryGet(path, opts) {
  try {
    return await get(path, opts);
  } catch (e) {
    return { $error: e.message, $status: e.status ?? 0 };
  }
}

export const isError = (v) => v && typeof v === 'object' && '$error' in v;
