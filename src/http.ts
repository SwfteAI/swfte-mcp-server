/**
 * HTTP transport entry point.
 *
 * Returns a plain `(Request) => Promise<Response>` handler, which is what a Vercel
 * Function route speaks natively — no Express shim, no Node `http` adapter.
 *
 * <b>Stateless on purpose.</b> `sessionIdGenerator: undefined` puts the transport in
 * stateless mode: each request carries everything needed to serve it. Serverless
 * invocations do not share memory and a reconnect can land on a different instance, so
 * a session map would work perfectly in local testing and then drop sessions in
 * production under exactly the conditions that are hardest to reproduce. Statelessness
 * costs server-initiated messages, which none of these tools use.
 *
 * Auth is NOT handled here. The bearer token reaches tools through
 * `buildServer({ resolveClient })`, and mounting the OAuth endpoints in front of this
 * handler is the next phase — see MCP_HOSTED_OAUTH_PLAN.md.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { buildServer } from './server.js';
import type { SwfteClient } from './client.js';
import type { ServerConfig } from './config.js';

export interface HttpHandlerOptions {
  /**
   * Server-wide settings: base URL, tool groups, timeouts. NOT the credential — that
   * arrives per request. `config.credential` is still required by the type, so hosted
   * deployments should pass a placeholder and rely on `resolveClient`.
   */
  config: ServerConfig;
  /** Build the client for one call from that call's verified token. */
  resolveClient: (authInfo?: AuthInfo) => SwfteClient | Promise<SwfteClient>;
}

/**
 * A fetch-style MCP handler.
 *
 * A fresh transport and server per request is deliberate rather than wasteful: in
 * stateless mode there is nothing to carry between requests, and reusing one instance
 * across concurrent invocations would let two callers' messages interleave on the same
 * transport. Construction is cheap — the tool table is module-level data.
 */
export function createHttpHandler(opts: HttpHandlerOptions): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    const server = buildServer({ config: opts.config, resolveClient: opts.resolveClient });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // Release the transport with the response. Skipping this leaks a listener per
      // request, which on a warm Fluid Compute instance accumulates across invocations
      // rather than dying with the process the way it would on stdio.
      await transport.close().catch(() => undefined);
    }
  };
}
