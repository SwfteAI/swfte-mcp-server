/**
 * OAuth for the hosted server, so `claude mcp login swfte-studio` works and nobody has
 * to paste a token into a config file.
 *
 * <b>The access token IS a PAT.</b> The browser session at the end of the login mints
 * one (`pat_…`) and that is what this server hands back as the OAuth access token. It
 * has to be that way round: a PAT may not mint another PAT, so only a real session can
 * create the credential, and inventing a second token type on top would need a store to
 * map it back — which is the one thing a stateless serverless deployment cannot keep.
 * The consequences are all good ones: revocation is PAT revocation, expiry is PAT
 * expiry, and verification is the check agents-service already performs on every call.
 *
 * <b>Nothing here is persisted.</b> Vercel instances are ephemeral, shared, and a
 * second request may land on a different one, so any in-memory registry would work
 * perfectly in local testing and drop state in production. Instead every artefact this
 * server issues — the client id, the login state, the authorization code — is an
 * HMAC-signed envelope that carries its own contents and its own expiry. Verification
 * needs only the shared secret, so any instance can serve any step of the flow.
 *
 * The upstream contract (MCP_HOSTED_OAUTH_PLAN.md):
 *   GET  {loginUrl}?state=…&redirect_uri={issuer}/callback   session-authenticated,
 *        shows the workspace picker, mints the PAT, redirects back with a one-time code
 *   POST {exchangeUrl} {"code": "…"}                          → {"access_token": "pat_…"}
 */
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

import { SwfteApiError, SwfteClient } from './client.js';
import { ConfigError, detectCredentialKind, type ServerConfig } from './config.js';

/** How long a browser login may take, workspace picker included, before the state dies. */
const LOGIN_STATE_TTL_MS = 15 * 60_000;

/**
 * How long the client has to redeem the code at `/token`. OAuth 2.1 says one minute or
 * less is ideal; five is the practical floor once a redirect has to reach a CLI that
 * may be paused behind a terminal prompt.
 */
const AUTH_CODE_TTL_MS = 5 * 60_000;

/**
 * How long one live verification of a PAT is trusted before the next call re-checks it.
 * Short on purpose: this is the window in which a revoked token still works, and the
 * only reason it is not zero is that every MCP request would otherwise pay for a round
 * trip to agents-service before doing any work.
 */
const VERIFICATION_TTL_MS = 60_000;

/** Bounds the verification cache on a warm instance that has served many users. */
const VERIFICATION_CACHE_MAX = 500;

/** Fallback lifetime reported to the client when the exchange does not state one. */
const DEFAULT_TOKEN_LIFETIME_S = 90 * 24 * 60 * 60;

/**
 * The identity probe. It is the cheapest authenticated call that proves the credential
 * is live *and* says who it belongs to, which is worth having in the logs when a call
 * misbehaves. `swfte_whoami` leads with the same endpoint.
 */
const IDENTITY_PATH = '/v2/workspace/members/me';

/**
 * A PAT carries no record of which OAuth client obtained it, so nothing here can name
 * one. `AuthInfo.clientId` is informational for us — authorization is the PAT's own —
 * and a constant is more honest than a fabricated id.
 */
const PAT_CLIENT_ID = 'swfte-personal-access-token';

export interface OAuthOptions {
  /** Public origin of this server. Everything advertised in metadata hangs off it. */
  issuerUrl: URL;
  /** Path the MCP endpoint is served on; also the resource identifier clients bind to. */
  mcpPath: string;
  /** agents-service login page: session-authenticated, picks a workspace, mints the PAT. */
  loginUrl: string;
  /** agents-service redemption of the one-time code for that PAT. */
  exchangeUrl: string;
  /**
   * Shared secret proving to agents-service that the redemption came from this server.
   *
   * The one-time code passes through the user's browser on its way here, so it lands in
   * history and possibly a referrer. Single use and a short TTL bound that exposure;
   * authenticating the redemption removes it, because a copied code is then worthless to
   * anyone who is not this server. Optional so the flow still works while the endpoint is
   * being built.
   */
  exchangeToken?: string;
  /** HMAC key for every envelope this server issues. Must be identical across instances. */
  signingSecret: string;
  /** Server-wide settings (base URL, tool groups) minus the credential. */
  config: ServerConfig;
  /** Injectable for tests, so the exchange can be asserted without a live backend. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so expiry can be exercised without waiting. */
  now?: () => number;
}

/**
 * Read the hosted-deployment settings from the environment.
 *
 * `config` supplies `baseUrl`, which is why the agents-service endpoints default off it
 * rather than needing their own variables in the common case.
 */
export function loadOAuthOptions(config: ServerConfig, env: NodeJS.ProcessEnv = process.env): OAuthOptions {
  // A preview deployment has no stable hostname, so VERCEL_URL is the right answer
  // there. Production must pin SWFTE_MCP_PUBLIC_URL: the issuer appears inside tokens
  // and metadata that clients cache, and a value that moves per deploy invalidates them.
  const publicUrl = env.SWFTE_MCP_PUBLIC_URL?.trim() || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : '');
  if (!publicUrl) {
    throw new ConfigError(
      'SWFTE_MCP_PUBLIC_URL is not set. The hosted server has to know its own public origin ' +
        '(e.g. https://mcp.swfte.com) — it is the OAuth issuer and the base of every URL it ' +
        'advertises, so it cannot be inferred from an incoming request without letting a ' +
        'forged Host header rewrite the login redirect.'
    );
  }

  const signingSecret = env.SWFTE_MCP_OAUTH_SECRET?.trim();
  if (!signingSecret) {
    // Generating one per instance would look fine locally and then fail perhaps half of
    // all logins in production, because the instance that signs the state is rarely the
    // instance that verifies the code. Refusing to start is the kinder failure.
    throw new ConfigError(
      'SWFTE_MCP_OAUTH_SECRET is not set. Every login artefact is HMAC-signed with it, and ' +
        'all instances must share the same value or logins fail whenever the callback lands ' +
        'on a different instance than the one that started the flow. Generate one with ' +
        '`openssl rand -hex 32`.'
    );
  }

  const base = config.baseUrl.replace(/\/+$/, '');
  return {
    issuerUrl: new URL(publicUrl.replace(/\/+$/, '')),
    mcpPath: normalisePath(env.SWFTE_MCP_PATH?.trim() || '/mcp'),
    loginUrl: env.SWFTE_MCP_LOGIN_URL?.trim() || `${base}/v1/mcp/login`,
    exchangeUrl: env.SWFTE_MCP_EXCHANGE_URL?.trim() || `${base}/v1/mcp/exchange`,
    exchangeToken: env.SWFTE_MCP_EXCHANGE_TOKEN?.trim() || undefined,
    signingSecret,
    config,
  };
}

function normalisePath(p: string): string {
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

/* -------------------------------------------------------------------------- */
/* Signed envelopes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `kind` is part of the signed payload so one envelope cannot be presented where
 * another is expected — a client id replayed as an authorization code, say. Without it
 * a single valid signature would be accepted everywhere.
 */
type EnvelopeKind = 'client' | 'login' | 'code';

interface Envelope {
  k: EnvelopeKind;
  /** Absolute expiry, ms since epoch. Zero means "does not expire" (client ids). */
  x: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function seal(secret: string, payload: Envelope & Record<string, unknown>): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

class EnvelopeError extends Error {}

function open<T extends Envelope>(secret: string, token: string, kind: EnvelopeKind, now: number): T {
  const dot = token.lastIndexOf('.');
  if (dot < 1) throw new EnvelopeError('malformed');

  const body = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(body).digest();

  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new EnvelopeError('bad signature');
  }

  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    throw new EnvelopeError('unreadable payload');
  }

  if (payload.k !== kind) throw new EnvelopeError(`wrong kind: expected ${kind}, got ${payload.k}`);
  if (payload.x !== 0 && payload.x < now) throw new EnvelopeError('expired');
  return payload;
}

/* -------------------------------------------------------------------------- */
/* Client registration                                                         */
/* -------------------------------------------------------------------------- */

interface ClientEnvelope extends Envelope {
  k: 'client';
  /** Registered redirect URIs — the only field authorization actually enforces. */
  r: string[];
  /** Display name, kept so `/register` echoes something recognisable back. */
  n?: string;
  /** Issued-at, seconds. */
  i: number;
}

const MAX_REDIRECT_URIS = 10;

/**
 * Dynamic client registration with no registry behind it: the client id *is* the
 * registration, signed.
 *
 * Enabled because MCP clients depend on it — Claude Code registers itself with a
 * loopback redirect URI on an ephemeral port it only learns at runtime, so there is
 * nothing to pre-register, and "the same install serves any MCP client" is the point of
 * hosting this at all. Storage-free registration also removes the usual abuse of an
 * open `/register`: there is no table for an attacker to fill.
 *
 * What registration grants is deliberately nothing. It mints no credential and unlocks
 * no data; it yields a signed name that lets its holder *start* a login which a human
 * must then complete in their own browser session, against a page that shows them what
 * they are authorising. The residual risk is the one every DCR deployment carries — a
 * phishing client registering its own redirect URI and talking a user through the flow —
 * which is why the redirect URI is restricted below and why the consent page matters.
 */
export class StatelessClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly opts: Pick<OAuthOptions, 'signingSecret'> & { now?: () => number }) {}

  private get now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    let payload: ClientEnvelope;
    try {
      payload = open<ClientEnvelope>(this.opts.signingSecret, clientId, 'client', this.now);
    } catch {
      // Undefined is what the SDK handlers turn into `invalid_client`. Distinguishing
      // "forged" from "unknown" here would only tell a prober which it was.
      return undefined;
    }

    return {
      client_id: clientId,
      client_id_issued_at: payload.i,
      redirect_uris: payload.r,
      ...(payload.n ? { client_name: payload.n } : {}),
      // No secret, ever: a secret would have to be stored to be checked, and a public
      // client with PKCE is the shape every MCP client already uses.
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    };
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>
  ): Promise<OAuthClientInformationFull> {
    const redirectUris = client.redirect_uris ?? [];
    if (redirectUris.length === 0) throw new InvalidClientMetadataError('At least one redirect_uri is required');
    if (redirectUris.length > MAX_REDIRECT_URIS) {
      throw new InvalidClientMetadataError(`At most ${MAX_REDIRECT_URIS} redirect_uris may be registered`);
    }
    for (const uri of redirectUris) assertUsableRedirectUri(uri);

    const issuedAt = Math.floor(this.now / 1000);
    const clientId = seal(this.opts.signingSecret, {
      k: 'client',
      // Registrations do not expire. There is nothing to garbage-collect, and expiring
      // them would strand long-lived installs mid-session for no security gain: the
      // credential's own lifetime is what bounds access.
      x: 0,
      r: redirectUris,
      ...(client.client_name ? { n: client.client_name } : {}),
      i: issuedAt,
    } as ClientEnvelope & Record<string, unknown>);

    return {
      ...client,
      client_id: clientId,
      client_id_issued_at: issuedAt,
      // The SDK generates a secret for any client that did not declare itself public.
      // Drop it: we could not verify one we never stored, so returning it would promise
      // an authentication that does not happen.
      client_secret: undefined,
      client_secret_expires_at: undefined,
      token_endpoint_auth_method: 'none',
    };
  }
}

/**
 * Only loopback HTTP and HTTPS may be registered.
 *
 * This blocks the redirect URI being turned into an exfiltration primitive — a
 * `javascript:` or `data:` URI, or a custom scheme that hands the authorization code to
 * whatever app claimed it on the user's machine. Loopback is what CLI clients need;
 * HTTPS is what web clients need; nothing else has a legitimate caller here.
 */
export function assertUsableRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new InvalidClientMetadataError(`redirect_uri is not a valid URL: ${uri}`);
  }

  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  const ok = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback);
  if (!ok) {
    throw new InvalidClientMetadataError(
      `redirect_uri must be https, or http on loopback: ${uri}. Other schemes can hand the ` +
        'authorization code to software the user never chose.'
    );
  }
  if (parsed.hash) throw new InvalidClientMetadataError(`redirect_uri must not contain a fragment: ${uri}`);
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                    */
/* -------------------------------------------------------------------------- */

interface LoginEnvelope extends Envelope {
  k: 'login';
  /** Which registered client started this, so a code cannot be redeemed by another. */
  c: string;
  /** Where to send the browser once the PAT exists. */
  r: string;
  /** The client's own `state`, returned untouched — its CSRF defence, not ours. */
  s?: string;
  /** PKCE challenge, verified by the SDK's token handler at redemption. */
  p: string;
}

interface CodeEnvelope extends Envelope {
  k: 'code';
  c: string;
  r: string;
  p: string;
  /** The one-time code agents-service issued, redeemable for the PAT. */
  u: string;
}

interface ExchangeResponse {
  access_token?: string;
  /** Tolerated alias: the endpoint is being built in parallel and may spell it this way. */
  pat?: string;
  expires_in?: number;
  workspace_id?: string;
  user_id?: string;
}

export class SwfteOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  /** token sha → verified identity, valid until `until`. Bounded and short-lived. */
  private readonly verified = new Map<string, { info: AuthInfo; until: number }>();

  constructor(private readonly opts: OAuthOptions) {
    this.clientsStore = new StatelessClientsStore(opts);
  }

  private get now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  /** Where agents-service sends the browser back. Fixed, so it can be allowlisted there. */
  get callbackUrl(): string {
    return new URL('/callback', this.opts.issuerUrl).href;
  }

  /**
   * Hand the browser to agents-service, which owns the only identity that may mint a
   * PAT. Everything this server needs to finish the flow rides along in `state`, signed:
   * there is nowhere to write it down, and a signed round trip is what makes a stateless
   * deployment possible at all.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: ExpressResponseLike): Promise<void> {
    const state = seal(this.opts.signingSecret, {
      k: 'login',
      x: this.now + LOGIN_STATE_TTL_MS,
      c: client.client_id,
      r: params.redirectUri,
      ...(params.state ? { s: params.state } : {}),
      p: params.codeChallenge,
    } as LoginEnvelope & Record<string, unknown>);

    const url = new URL(this.opts.loginUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', this.callbackUrl);
    res.redirect(302, url.href);
  }

  /**
   * agents-service is done: the user picked a workspace and a PAT exists behind a
   * one-time code. Translate that back into the OAuth code the waiting client expects.
   *
   * The upstream code is wrapped rather than forwarded, because redemption at `/token`
   * has to verify the PKCE challenge that was recorded when the flow began, and this
   * server remembers nothing between requests.
   */
  async handleCallback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const rawState = url.searchParams.get('state') ?? '';

    let login: LoginEnvelope;
    try {
      login = open<LoginEnvelope>(this.opts.signingSecret, rawState, 'login', this.now);
    } catch (err) {
      // With no trustworthy state there is no redirect target, and bouncing to one taken
      // from the query would make this an open redirector. Answer in place instead.
      return new Response(
        `Login could not be completed: the sign-in link is invalid or has expired (${
          err instanceof Error ? err.message : 'unknown'
        }). Start again with \`claude mcp login\`.`,
        { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }
      );
    }

    const back = new URL(login.r);
    if (login.s) back.searchParams.set('state', login.s);

    const upstreamError = url.searchParams.get('error');
    if (upstreamError) {
      // The user declined, or agents-service refused. That is an answer, and the client
      // is entitled to hear it rather than time out waiting on its loopback listener.
      back.searchParams.set('error', upstreamError);
      const description = url.searchParams.get('error_description');
      if (description) back.searchParams.set('error_description', description);
      return redirect(back.href);
    }

    const upstreamCode = url.searchParams.get('code');
    if (!upstreamCode) {
      back.searchParams.set('error', 'server_error');
      back.searchParams.set('error_description', 'The login completed without returning a code.');
      return redirect(back.href);
    }

    back.searchParams.set(
      'code',
      seal(this.opts.signingSecret, {
        k: 'code',
        x: this.now + AUTH_CODE_TTL_MS,
        c: login.c,
        r: login.r,
        p: login.p,
        u: upstreamCode,
      } as CodeEnvelope & Record<string, unknown>)
    );
    return redirect(back.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.openCode(client, authorizationCode).p;
  }

  /**
   * Redeem the code for the PAT. The SDK's token handler has already verified PKCE by
   * this point, so what remains is proving the code belongs to this client and asking
   * agents-service for the credential it is standing in for.
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const code = this.openCode(client, authorizationCode);

    // OAuth requires the redirect_uri to match the one the code was issued against.
    // Skipping it would let a code obtained for one registered URI be redeemed as though
    // it had been issued for another.
    if (redirectUri !== undefined && redirectUri !== code.r) {
      throw new InvalidGrantError('redirect_uri does not match the one used to obtain this code');
    }

    const body = await this.postExchange(code.u);
    const accessToken = (body.access_token ?? body.pat ?? '').trim();

    if (!accessToken) throw new ServerError('The token exchange returned no access token.');
    if (!detectCredentialKind(accessToken)) {
      // A session cookie, an HTML error page, an id token — anything that is not a Swfte
      // credential would be accepted here and then fail on every single tool call with an
      // opaque 401, hours away from the cause. Fail at the seam that produced it.
      throw new ServerError(
        'The token exchange returned something that is not a Swfte credential ' +
          `(starts with "${accessToken.slice(0, 4)}…"). Expected a PAT (pat_…).`
      );
    }

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: body.expires_in ?? DEFAULT_TOKEN_LIFETIME_S,
    };
  }

  /**
   * No refresh tokens are issued, so nothing can be presented here.
   *
   * Refreshing would mean minting a fresh PAT, and a PAT may not mint a PAT — the whole
   * reason the browser is in this flow. When the PAT expires the user logs in again,
   * which is also the moment they get to re-pick a workspace.
   */
  async exchangeRefreshToken(): Promise<OAuthTokens> {
    throw new InvalidGrantError(
      'This server issues no refresh tokens — the access token is a personal access token with ' +
        'its own lifetime. Run `claude mcp login` again when it expires.'
    );
  }

  /**
   * Verify the bearer token by using it.
   *
   * There is nothing to introspect: the token is a PAT, and the only authority on
   * whether it is live, expired or revoked is agents-service. So the check is a real
   * authenticated call, cached briefly because otherwise every MCP request pays for a
   * round trip before it starts.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!detectCredentialKind(token)) {
      // Rejected without a network call. Catches a stale OAuth token, a copied session
      // cookie, or a client sending the client_id — none of which agents-service could
      // do anything with either.
      throw new InvalidTokenError('Not a Swfte credential (expected a personal access token, pat_ prefixed).');
    }

    const key = createHash('sha256').update(token).digest('base64url');
    const cached = this.verified.get(key);
    if (cached && cached.until > this.now) return cached.info;

    const client = new SwfteClient({
      ...this.opts.config,
      credential: token,
      // Honour what the caller actually sent. The login flow only ever issues PATs, but
      // a workspace API key presented here is a valid principal too, and the client sends
      // different headers for each — forcing one kind would silently mis-send the other.
      credentialKind: detectCredentialKind(token)!,
    });

    let identity: Record<string, unknown>;
    try {
      identity = await client.request<Record<string, unknown>>({
        method: 'GET',
        path: IDENTITY_PATH,
        retries: 1,
      });
    } catch (err) {
      if (err instanceof SwfteApiError && (err.status === 401 || err.status === 403)) {
        // Only these two mean "the token is bad". Treating a 502 the same way would send
        // a user through a whole browser re-login to fix a backend outage, and hand them
        // a fresh token that fails identically.
        throw new InvalidTokenError('The personal access token is invalid, expired, or revoked.');
      }
      throw new ServerError(
        `Could not verify the credential: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const until = this.now + VERIFICATION_TTL_MS;
    const info: AuthInfo = {
      token,
      clientId: PAT_CLIENT_ID,
      // PATs carry no scopes — they act as the user. Advertising invented ones would
      // imply a narrowing that does not exist.
      scopes: [],
      // The SDK's bearer middleware rejects a token with no expiry, and a PAT's real
      // expiry is not derivable from the token string. This is the honest bound: the
      // live verification above is trusted exactly as long as it is cached, after which
      // the next request checks again.
      //
      // Rounded up, never down. `expiresAt` is whole seconds while the cache deadline is
      // in milliseconds, so rounding down would put the advertised expiry *before* the
      // end of the cache window — and the middleware would reject a cached entry as
      // expired for the last fraction of every window, roughly one second in sixty.
      expiresAt: Math.ceil(until / 1000),
      extra: {
        userId: identity.userId ?? identity.id,
        workspaceId: identity.workspaceId ?? identity.workspace_id,
      },
    };

    // Oldest-first eviction. The map is insertion-ordered, and entries are equally cheap
    // to rebuild, so there is nothing cleverer worth doing.
    if (this.verified.size >= VERIFICATION_CACHE_MAX) {
      const oldest = this.verified.keys().next();
      if (!oldest.done) this.verified.delete(oldest.value);
    }
    this.verified.set(key, { info, until });
    return info;
  }

  private openCode(client: OAuthClientInformationFull, authorizationCode: string): CodeEnvelope {
    let code: CodeEnvelope;
    try {
      code = open<CodeEnvelope>(this.opts.signingSecret, authorizationCode, 'code', this.now);
    } catch (err) {
      throw new InvalidGrantError(
        `Authorization code is invalid or expired (${err instanceof Error ? err.message : 'unknown'}).`
      );
    }
    if (code.c !== client.client_id) {
      // A code leaked from the redirect (browser history, a shared terminal) is useless
      // to another registered client. PKCE covers the same ground; this is the cheap
      // second lock.
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    return code;
  }

  private async postExchange(upstreamCode: string): Promise<ExchangeResponse> {
    let res: Response;
    try {
      res = await this.fetch(this.opts.exchangeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': this.opts.config.userAgent,
          ...(this.opts.exchangeToken ? { authorization: `Bearer ${this.opts.exchangeToken}` } : {}),
        },
        body: JSON.stringify({ code: upstreamCode }),
      });
    } catch (err) {
      throw new ServerError(
        `Could not reach the token exchange: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const text = await res.text();
    if (!res.ok) {
      // The everyday case is a code that was already redeemed or has aged out — both are
      // the client's problem to retry, not a server fault, so they must not become 500s.
      const detail = text.length > 300 ? `${text.slice(0, 300)}…` : text;
      if (res.status >= 400 && res.status < 500) {
        throw new InvalidGrantError(`The login code was rejected (${res.status}): ${detail}`);
      }
      throw new ServerError(`The token exchange failed (${res.status}): ${detail}`);
    }

    try {
      return JSON.parse(text) as ExchangeResponse;
    } catch {
      throw new ServerError('The token exchange returned a body that is not JSON.');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Fetch-shaped endpoints                                                      */
/* -------------------------------------------------------------------------- */

export type AuthenticateResult = { authInfo: AuthInfo } | { response: Response };

export interface OAuthEndpoints {
  /** Serve an OAuth or metadata request; `null` when the path belongs to someone else. */
  handle(req: Request): Promise<Response | null>;
  /** Bearer gate for the MCP endpoint. */
  authenticate(req: Request): Promise<AuthenticateResult>;
  /** Advertised in `WWW-Authenticate` so a 401 tells the client where to start. */
  protectedResourceMetadataUrl: string;
  /** Path the MCP endpoint answers on — the resource these endpoints protect. */
  mcpPath: string;
  provider: SwfteOAuthProvider;
}

/**
 * The OAuth surface as a fetch handler.
 *
 * The SDK's handlers are the real implementation — authorize, token, register and both
 * metadata documents come straight from `mcpAuthRouter`, so the protocol details stay
 * the SDK's problem. They are Express-shaped and this deployment is not, so they run
 * through the adapter below; `/callback` is ours because the round trip through
 * agents-service is not something the SDK models.
 */
export function createOAuthEndpoints(opts: OAuthOptions): OAuthEndpoints {
  const provider = new SwfteOAuthProvider(opts);
  const resourceServerUrl = new URL(opts.mcpPath, opts.issuerUrl);

  const router = mcpAuthRouter({
    provider,
    issuerUrl: opts.issuerUrl,
    resourceServerUrl,
    resourceName: 'Swfte Studio',
    // In-process rate limiting on a serverless deployment counts requests per warm
    // instance, which is a limit an attacker escapes by reconnecting. It would cost real
    // memory to provide a number nobody should rely on; rate limiting belongs at the
    // edge, in front of the function.
    authorizationOptions: { rateLimit: false },
    tokenOptions: { rateLimit: false },
    clientRegistrationOptions: { rateLimit: false },
  });

  const protectedResourceMetadataUrl = new URL(
    `/.well-known/oauth-protected-resource${resourceServerUrl.pathname}`,
    opts.issuerUrl
  ).href;

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: protectedResourceMetadataUrl });

  return {
    provider,
    protectedResourceMetadataUrl,
    mcpPath: resourceServerUrl.pathname,

    async handle(req: Request): Promise<Response | null> {
      const { pathname } = new URL(req.url);
      if (pathname === '/callback') return provider.handleCallback(req);
      // The MCP endpoint is excluded before the router sees it. Offering the request to
      // the OAuth handlers would read its body to look for form fields, and a body can
      // only be read once — the transport would then find nothing to parse on the very
      // requests that carry the actual work.
      if (pathname === resourceServerUrl.pathname) return null;
      return runExpress(router, req, { readBody: true });
    },

    async authenticate(req: Request): Promise<AuthenticateResult> {
      let authInfo: AuthInfo | undefined;
      // `readBody: false` for the same reason: the bearer check reads only headers, and
      // the body belongs to the transport behind it.
      const response = await runExpress(bearer, req, {
        readBody: false,
        onNext: (reqLike) => {
          authInfo = (reqLike as { auth?: AuthInfo }).auth;
        },
      });
      if (authInfo) return { authInfo };
      return {
        response:
          response ??
          // Unreachable in practice: the middleware either calls next() or answers.
          new Response(JSON.stringify({ error: 'server_error' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
      };
    },
  };
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}

/* -------------------------------------------------------------------------- */
/* Express adapter                                                             */
/* -------------------------------------------------------------------------- */

/** The slice of Express's response the SDK handlers actually touch. */
export interface ExpressResponseLike {
  redirect(status: number, url: string): unknown;
}

/**
 * Run an Express handler against a Web `Request` and collect a Web `Response`.
 *
 * The SDK ships its OAuth handlers as Express middleware only, while this server speaks
 * fetch because that is what a Vercel Function handler is. Rather than reimplement
 * OAuth to bridge that gap — the part worth getting from the SDK is exactly the part we
 * would be rewriting — the request and response are duck-typed to the small surface the
 * handlers use: `req.query`/`req.body` for parsing, and `status`/`json`/`redirect`/
 * `set` for answering.
 *
 * The body is parsed here and flagged with `_body`, which is body-parser's own signal
 * that a body is already present. That is what lets `express.urlencoded()` and
 * `express.json()` run untouched over a request that was never a Node stream. Reading it
 * consumes the request though, so `readBody` stays off for handlers that only inspect
 * headers — otherwise a middleware would quietly eat the payload of whatever runs next.
 *
 * Returns `null` when the handler declined the request (called `next()` without
 * answering), which is how an unmatched path is distinguished from a 404 the handler
 * chose to send.
 */
async function runExpress(
  handler: (req: unknown, res: unknown, next: (err?: unknown) => void) => void,
  req: Request,
  opts: { readBody?: boolean; onNext?: (req: unknown) => void } = {}
): Promise<Response | null> {
  const onNext = opts.onNext;
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  const readBody = opts.readBody !== false && req.method !== 'GET' && req.method !== 'HEAD';
  const raw = readBody ? await req.text() : '';
  const contentType = headers['content-type'] ?? '';
  let body: unknown = {};
  if (raw) {
    if (contentType.includes('json')) {
      try {
        body = JSON.parse(raw);
      } catch {
        // Leave it empty: the handlers validate their inputs with zod and will report a
        // precise `invalid_request` naming the missing fields, which beats a parse error.
        body = {};
      }
    } else {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
  }

  const shimReq = Object.assign(new EventEmitter(), {
    method: req.method,
    url: url.pathname + url.search,
    originalUrl: url.pathname + url.search,
    baseUrl: '',
    path: url.pathname,
    headers,
    query: Object.fromEntries(url.searchParams),
    params: {},
    body,
    // body-parser skips a request that already carries a parsed body.
    _body: true,
    ip: headers['x-forwarded-for']?.split(',')[0]?.trim() ?? '127.0.0.1',
    get: (name: string) => headers[name.toLowerCase()],
  });

  const out = { status: 200, headers: new Headers(), body: undefined as string | null | undefined };
  let settled = false;

  /**
   * `Headers` throws on anything outside latin-1, and the values here are partly error
   * messages — `WWW-Authenticate` quotes one verbatim, and a client-supplied name can
   * reach an `invalid_client_metadata` description. One curly quote in a message would
   * otherwise turn a clean 401 into an unhandled rejection.
   */
  const setHeaderValue = (name: string, value: unknown) => {
    out.headers.set(name, String(value).replace(/[^\x20-\x7e]/g, '?'));
  };

  return await new Promise<Response | null>((resolve, reject) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(new Response(out.body ?? null, { status: out.status, headers: out.headers }));
    };

    const shimRes = {
      get statusCode() {
        return out.status;
      },
      set statusCode(code: number) {
        out.status = code;
      },
      get headersSent() {
        return settled;
      },
      setHeader(name: string, value: unknown) {
        setHeaderValue(name, value);
        return shimRes;
      },
      getHeader(name: string) {
        return out.headers.get(name) ?? undefined;
      },
      removeHeader(name: string) {
        out.headers.delete(name);
      },
      set(name: string | Record<string, unknown>, value?: unknown) {
        if (typeof name === 'object') for (const [k, v] of Object.entries(name)) setHeaderValue(k, v);
        else setHeaderValue(name, value);
        return shimRes;
      },
      header(name: string | Record<string, unknown>, value?: unknown) {
        return shimRes.set(name, value);
      },
      vary(field: string) {
        const existing = out.headers.get('vary');
        setHeaderValue('vary', existing ? `${existing}, ${field}` : field);
        return shimRes;
      },
      status(code: number) {
        out.status = code;
        return shimRes;
      },
      json(payload: unknown) {
        setHeaderValue('content-type', 'application/json');
        out.body = JSON.stringify(payload);
        finish();
        return shimRes;
      },
      send(payload: unknown) {
        out.body = typeof payload === 'string' ? payload : JSON.stringify(payload);
        finish();
        return shimRes;
      },
      end(payload?: unknown) {
        if (typeof payload === 'string') out.body = payload;
        finish();
        return shimRes;
      },
      writeHead(code: number, extra?: Record<string, unknown>) {
        out.status = code;
        if (extra) shimRes.set(extra);
        return shimRes;
      },
      redirect(a: number | string, b?: string) {
        const [code, location] = typeof a === 'number' ? [a, b!] : [302, a];
        out.status = code;
        setHeaderValue('location', location);
        finish();
        return shimRes;
      },
      // cors and the router attach 'finish'/'close' listeners on some paths.
      on() {
        return shimRes;
      },
      once() {
        return shimRes;
      },
      removeListener() {
        return shimRes;
      },
      emit() {
        return false;
      },
    };

    try {
      handler(shimReq, shimRes, (err?: unknown) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        onNext?.(shimReq);
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Exposed for tests, which drive the OAuth handlers the way a real client would. */
export const __testing = { runExpress, seal, open };
