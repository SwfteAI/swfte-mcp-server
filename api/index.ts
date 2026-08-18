/**
 * The hosted server, as a Vercel Function.
 *
 * `createHostedHandler` in `src/http.ts` is the whole thing — OAuth metadata,
 * `/authorize`, `/token`, `/register`, `/callback` and the bearer-gated MCP endpoint —
 * behind one `(Request) => Promise<Response>`. That is precisely what a Vercel Node.js
 * Function speaks, so this file is the adapter and nothing else: no Express, no Node
 * `http` shim, no request translation that could mangle a streamed body.
 *
 * <b>One catch-all Function, not a file per route.</b> `vercel.json` rewrites every
 * unmatched path here and the handler routes on `pathname`. The alternative — a file per
 * endpoint — cannot work as cleanly: `/.well-known/…` is not expressible as a filename,
 * and the endpoints have to agree on the issuer, the resource identifier and the signing
 * secret, which is how a metadata document ends up advertising a URL that does not
 * answer. One Function keeps that agreement in one place, and gives the OAuth workstream
 * a routing table it owns rather than one split across the deployment config.
 *
 * <b>Node.js runtime, not Edge.</b> Deliberately no `export const runtime = 'edge'`.
 * Streaming and SSE work on Node, so they are not a reason to reach for Edge, and Edge
 * would cost the full Node API surface and the longer durations that tools polling a
 * build or a deploy actually need.
 */
import { createHostedHandler, type HostedHandler } from '../src/http.js';

/**
 * Built on first request, then reused.
 *
 * This is a memo of a pure function of the environment, not per-caller state: every
 * instance computes the same handler, and nothing about one request is retained for the
 * next. That distinction is the one that matters here — Fluid Compute serves many
 * invocations from one warm instance and a reconnect may land on a different instance,
 * so anything caller-shaped cached up here would either leak between callers or vanish.
 *
 * It is deliberately not built at module scope. `createHostedHandler` throws on missing
 * configuration, and a throw during module evaluation is a cold-start crash: the
 * platform reports `FUNCTION_INVOCATION_FAILED` and the message naming the variable is
 * buried in a log nobody reads on a first deploy. Caught here, the same mistake answers
 * with the message itself.
 */
let built: HostedHandler | Error | undefined;

function hosted(): HostedHandler | Error {
  if (built === undefined) {
    try {
      built = createHostedHandler();
    } catch (err) {
      built = err instanceof Error ? err : new Error(String(err));
    }
  }
  return built;
}

async function handle(request: Request): Promise<Response> {
  const handler = hosted();

  if (handler instanceof Error) {
    // 503, not 500: the deployment is intact and the request was fine — an environment
    // variable is missing, which is fixed by setting it and redeploying, and the body
    // says which one.
    return new Response(
      JSON.stringify({ error: 'server_misconfigured', message: handler.message }, null, 2),
      { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
    );
  }

  return handler(request);
}

// Named method exports, not `export default`. A default export is read as the Node
// `(req, res)` signature; named methods are what marks this a Web handler, which is what
// `src/http.ts` returns.
//
// GET covers `/authorize`, `/callback`, both metadata documents and the MCP SSE stream.
// POST covers `/token`, `/register`, `/revoke` and every JSON-RPC call. DELETE ends an
// MCP session. OPTIONS is the CORS preflight a browser-based client sends before
// `/token` — the SDK's router answers it, but only if it is routed here at all.
export function GET(request: Request): Promise<Response> {
  return handle(request);
}

export function POST(request: Request): Promise<Response> {
  return handle(request);
}

export function DELETE(request: Request): Promise<Response> {
  return handle(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return handle(request);
}
