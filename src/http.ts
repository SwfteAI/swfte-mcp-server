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
 * `createHttpHandler` serves the MCP endpoint alone. `createHostedHandler` puts the
 * OAuth surface from `oauth.ts` in front of it, and is what a hosted deployment mounts —
 * see MCP_HOSTED_OAUTH_PLAN.md.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { buildServer } from './server.js';
import { SwfteClient } from './client.js';
import { detectCredentialKind, loadConfig, type ServerConfig } from './config.js';
import { createOAuthEndpoints, loadOAuthOptions, type AuthenticateResult, type OAuthEndpoints } from './oauth.js';

export interface HttpHandlerOptions {
  /**
   * Server-wide settings: base URL, tool groups, timeouts. NOT the credential — that
   * arrives per request. `config.credential` is still required by the type, so hosted
   * deployments should pass a placeholder and rely on `resolveClient`.
   */
  config: ServerConfig;
  /** Build the client for one call from that call's verified token. */
  resolveClient: (authInfo?: AuthInfo) => SwfteClient | Promise<SwfteClient>;
  /**
   * Gate every MCP request behind a verified bearer token.
   *
   * Left unset the endpoint is open, which is only ever right when something in front of
   * it has already established the caller — a local dev process holding one credential,
   * or a test. A hosted deployment always sets it.
   */
  authenticate?: (req: Request) => Promise<AuthenticateResult>;
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
    let authInfo: AuthInfo | undefined;
    if (opts.authenticate) {
      const result = await opts.authenticate(req);
      // A rejection is already a complete OAuth response, WWW-Authenticate header and
      // all, which is what points the client at the login it needs to run.
      if ('response' in result) return result.response;
      authInfo = result.authInfo;
    }

    // Hosted: this process's disk is not the caller's project. Local-file tools
    // refuse, and file-producing tools hand their files back inline instead.
    const server = buildServer({ config: opts.config, resolveClient: opts.resolveClient, localFilesystem: false });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    await server.connect(transport);
    const close = () => void transport.close().catch(() => undefined);

    let response: Response;
    try {
      // The transport is what carries `authInfo` down to each tool call's `extra`, which
      // is where `resolveClient` reads the credential from.
      response = await transport.handleRequest(req, authInfo ? { authInfo } : undefined);
    } catch (err) {
      close();
      throw err;
    }

    // Closing here rather than in a `finally` around handleRequest, which is what shipped
    // first and was wrong. handleRequest resolves once the status and headers are known,
    // while the body is still streaming, so closing at that point killed the stream
    // mid-write: 200, correct content-type, zero bytes. Nothing threw, so the only
    // symptom was a client timing out with nothing pointing back here.
    //
    // The transport still has to be released — a leaked listener on a warm Fluid Compute
    // instance accumulates across invocations instead of dying with the process the way
    // it would on stdio. So the close is tied to the end of the body instead.
    if (!response.body) {
      close();
      return response;
    }

    const released = response.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
        flush: close,
        cancel: close,
      })
    );

    return new Response(released, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * A placeholder so `ServerConfig` can be built before anyone has logged in.
 *
 * Hosted, there is no server-wide credential at all: every call brings its own. This
 * value exists only to satisfy the field and is replaced per request by `resolveClient`,
 * and its shape is deliberately one `detectCredentialKind` accepts so config loading
 * does not fail before the real credential arrives.
 */
const HOSTED_PLACEHOLDER_CREDENTIAL = 'pat_hosted_no_credential';

/**
 * Build the client for one call from the token that call carried.
 *
 * The verified bearer token *is* the credential — the login mints a PAT and hands it
 * over as the access token — so there is no lookup here, only the mapping from token to
 * client. Anything reaching this without auth is a wiring mistake and says so, because
 * the alternative is a client built on the placeholder credential that fails much later
 * with a 401 nobody can trace back here.
 */
export function resolveClientFromAuth(config: ServerConfig): (authInfo?: AuthInfo) => SwfteClient {
  return (authInfo?: AuthInfo) => {
    if (!authInfo?.token) {
      throw new Error('No verified credential on this request — the bearer gate did not run.');
    }
    return new SwfteClient({
      ...config,
      credential: authInfo.token,
      // The login only issues PATs, but a workspace API key presented as a bearer token
      // is a valid principal too and needs different headers. Detect rather than assume.
      credentialKind: detectCredentialKind(authInfo.token) ?? 'pat',
    });
  };
}

export interface HostedHandlerOptions {
  env?: NodeJS.ProcessEnv;
}

export interface HostedHandler {
  (req: Request): Promise<Response>;
  /** The OAuth surface, exposed so a deployment can log or test its endpoints. */
  oauth: OAuthEndpoints;
  /** Path the MCP endpoint answers on. */
  mcpPath: string;
}

/**
 * The whole hosted server as one fetch handler: OAuth, metadata, callback and the
 * authenticated MCP endpoint.
 *
 * One handler rather than a route per endpoint because the pieces have to agree on the
 * issuer, the resource identifier and the signing secret, and computing those in two
 * places is how a metadata document ends up advertising an endpoint that does not
 * answer.
 */
export function createHostedHandler(opts: HostedHandlerOptions = {}): HostedHandler {
  const env = opts.env ?? process.env;

  // Nobody sets SWFTE_PAT on a hosted deployment, and if someone did, honouring it would
  // hand every anonymous caller that person's identity. Overriding both credential
  // variables makes that impossible rather than merely unlikely.
  const config = loadConfig({ ...env, SWFTE_PAT: HOSTED_PLACEHOLDER_CREDENTIAL, SWFTE_API_KEY: undefined });
  const oauth = createOAuthEndpoints(loadOAuthOptions(config, env));
  const mcpPath = oauth.mcpPath;

  const mcp = createHttpHandler({
    config,
    authenticate: oauth.authenticate,
    resolveClient: resolveClientFromAuth(config),
  });

  const handler = async function handle(req: Request): Promise<Response> {
    try {
      const oauthResponse = await oauth.handle(req);
      if (oauthResponse) return oauthResponse;

      const { pathname } = new URL(req.url);
      if (pathname === mcpPath) return mcp(req);

      return new Response(JSON.stringify({ error: 'not_found', mcp_endpoint: mcpPath }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      // An unhandled throw here reaches the client as the platform's own error page, with
      // nothing an OAuth client can parse and nothing in the logs tying it to a request.
      // Answer in the shape the caller expects and put the reason where it can be read.
      const message = err instanceof Error ? err.message : String(err);
      console.error('[swfte-mcp] unhandled error:', err);
      return new Response(JSON.stringify({ error: 'server_error', error_description: message }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  } as HostedHandler;

  handler.oauth = oauth;
  handler.mcpPath = mcpPath;
  return handler;
}
