# Hosting the MCP server

The npm package is a stdio server: one process, one person, one pasted token. This
document is the other install — the same tools served over HTTP from Vercel, so a user
runs `claude mcp login` in a browser and never handles a credential.

**Nothing here is provisioned.** These files are scaffolding; you create the project and
deploy when you are ready.

> **Not deployable yet.** Two defects in `src/http.ts` stop any deployment answering.
> See [Blockers](#blockers) before you spend a deploy on it.

---

## What is deployed

| Path | What it is |
|---|---|
| `api/index.ts` | The Function. Adapts `createHostedHandler` from `src/http.ts` to a Web handler. |
| `vercel.json` | Function config, build config, and the catch-all rewrite. |
| `public/index.html` | A landing page at `/`, and the build's output directory. |
| `.vercelignore` | Keeps tests, scripts, Docker and run artifacts out of the upload. |

### One Function, routed in TypeScript

`vercel.json` rewrites every unmatched path to `/api`, and `createHostedHandler` routes
on `pathname` from there:

| Path | Served by |
|---|---|
| `/` | `public/index.html`, statically — the filesystem is matched before rewrites |
| `/mcp` | The bearer-gated MCP endpoint (`SWFTE_MCP_PATH` moves it) |
| `/.well-known/oauth-authorization-server` | SDK metadata |
| `/.well-known/oauth-protected-resource/mcp` | SDK metadata; the URL a `401` advertises |
| `/authorize`, `/token`, `/register`, `/revoke` | SDK OAuth handlers |
| `/callback` | The return leg from agents-service, carrying the one-time code |
| anything else | `404` JSON naming the MCP endpoint |

A file per endpoint was the alternative and it does not work as cleanly. `/.well-known/…`
is not expressible as a filename, so those two would need rewrites of their own; and
every endpoint has to agree on the issuer, the resource identifier and the signing
secret, which is exactly how a metadata document ends up advertising a URL that does not
answer. One Function keeps the agreement in one place.

### Runtime

**Node.js, not Edge.** There is deliberately no `export const runtime = 'edge'`.
Streaming and SSE both work on Node, so they are not a reason to reach for Edge, and
Edge would cost the full Node API surface and the longer durations this server needs,
since several tools poll a build or a deploy to a terminal state.

`"fluid": true` is set explicitly. It is the default for new projects, but stating it
means an older project with it switched off does not quietly get 10-second functions.

`maxDuration` is 300s, which every plan allows; Pro and Enterprise can raise it to 800.
Keep `SWFTE_DEFAULT_WAIT_MS` (240s by default) comfortably under it. That value is how
long a build or run tool waits before handing back a resumable handle, and a tool that
outlives its Function returns a gateway error instead of the handle — a worse answer
than waiting less.

### Statelessness, and why there is no database

The transport runs stateless (`sessionIdGenerator: undefined`), the OAuth client store
is stateless, and `api/index.ts` caches only the handler itself — a pure function of the
environment, identical on every instance. Nothing caller-shaped is held between
requests. Fluid Compute serves many invocations from one warm instance and a reconnect
may land on a different one, so anything else would either leak between callers or
vanish, and both pass every local test.

**This deployment needs no database and no KV store.** That falls out of the token
model rather than being worked around: the OAuth access token *is* a PAT, so minting,
verifying, expiring and revoking it are all things agents-service already does. If a
change appears to need a store, that is a signal the token model has drifted, and it is
worth saying out loud before adding one.

The one thing statelessness demands in exchange is that `SWFTE_MCP_OAUTH_SECRET` be
identical across instances. The instance that signs a login is rarely the instance that
verifies the callback.

---

## Build configuration

The npm build (`tsup` → `dist/index.js`, with a shebang) produces the stdio bin. A
deployment does not use it: `@vercel/node` compiles `api/index.ts` and follows its
imports into `src/` itself, from TypeScript source. Running `tsup` on deploy would build
the wrong artifact and leave the build with no static output to publish.

So `vercel.json` overrides two things:

- `"buildCommand": "npm run typecheck"` — replaces the default `npm run build`, and buys
  something: a type error fails the deploy rather than shipping a Function that throws
  on its first request.
- `"outputDirectory": "public"` — a definite answer to "what static output did this
  build produce", which is also where the landing page lives.

`tsconfig.json` gained `api/**/*` in `include`, so `npm run typecheck` covers the
Function. Without it, the one file most likely to break the deployment was the one file
nothing typechecked.

Node version comes from `engines.node` in `package.json` (`>=18.17`); Vercel resolves
that to the newest Node it supports. Pin it to `22.x` there if you want it to stop
moving underneath you.

---

## Environment variables

The headline: **the hosted deployment holds no credential of its own, and must not.**
`createHostedHandler` clears `SWFTE_PAT` and `SWFTE_API_KEY` before building its config.
A deployment carrying an operator's PAT would answer callers *as that operator* — every
call succeeding, each one belonging to the wrong person.

### Required

| Variable | Secret | Notes |
|---|---|---|
| `SWFTE_MCP_PUBLIC_URL` | no | This server's own public origin, e.g. `https://mcp.swfte.com`. It is the OAuth issuer and the base of every URL advertised in metadata, so it cannot be read off the incoming `Host` header without letting a forged one rewrite the login redirect. Falls back to `VERCEL_URL` — right for previews, wrong for production, where a value that changes per deploy invalidates metadata clients have cached. |
| `SWFTE_MCP_OAUTH_SECRET` | **yes** | HMAC key for every login artefact. Generate with `openssl rand -hex 32`. Must be identical across instances and across deploys — rotating it invalidates in-flight logins. |

### Optional

| Variable | Secret | Default | Notes |
|---|---|---|---|
| `SWFTE_MCP_PATH` | no | `/mcp` | Moves the MCP endpoint. Also moves the protected-resource metadata path and the `Cache-Control` rule in `vercel.json`, which is keyed on `/mcp`. |
| `SWFTE_MCP_LOGIN_URL` | no | `${SWFTE_BASE_URL}/v1/mcp/login` | agents-service login + workspace picker. |
| `SWFTE_MCP_EXCHANGE_URL` | no | `${SWFTE_BASE_URL}/v1/mcp/exchange` | Redeems the one-time code for a PAT. |
| `SWFTE_BASE_URL` | no | `https://api.swfte.com/agents` | Point a preview at staging; the two URLs above follow it. |
| `SWFTE_TOOLS` | no | curated subset | `all`, or a comma-separated group list. |
| `SWFTE_DEFAULT_WAIT_MS` | no | `240000` | Must stay under `maxDuration`. |

### Do not set

| Variable | Why |
|---|---|
| `SWFTE_PAT`, `SWFTE_API_KEY` | Required by the stdio install, cleared here. Each request brings its own credential. |
| `SWFTE_WORKSPACE_ID` | Meaningful only for API keys. A PAT carries its own workspace binding, which the backend trusts over anything sent. |
| `SWFTE_ALLOW_DEPLOY` | A process-wide switch, and "may this caller provision billable infrastructure" is a per-user question the moment one process serves many users. Setting it here grants it to **everyone** who can reach the endpoint. Leave it off until it is a per-identity check. |
| `SWFTE_DEBUG` | Writes request lines to the log. Fine locally; noise and needless detail in a shared deployment. |

Set the secret in the dashboard or with `vercel env add SWFTE_MCP_OAUTH_SECRET
production` — never in `vercel.json`, which is committed.

---

## Deploying

```bash
npm i -g vercel      # if you do not have it

vercel link
vercel env add SWFTE_MCP_PUBLIC_URL production
vercel env add SWFTE_MCP_OAUTH_SECRET production   # openssl rand -hex 32

vercel deploy          # preview
vercel deploy --prod   # production
```

`vercel dev` runs the same Function locally at `http://localhost:3000`, which is the
cheapest way to check the wiring before spending a deploy on it. Set
`SWFTE_MCP_PUBLIC_URL=http://localhost:3000` for that.

The fastest check that a deployment is alive, before involving a client:

```bash
curl -s https://<your-deployment>/.well-known/oauth-authorization-server | jq
curl -s -i https://<your-deployment>/mcp -X POST \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The first should list `authorization_endpoint` and `token_endpoint` on your own origin.
The second should be a `401` carrying a `WWW-Authenticate` header pointing at
`/.well-known/oauth-protected-resource/mcp` — that header is what makes
`claude mcp login` discoverable.

---

## Using it from a client

```bash
claude mcp add --transport http swfte https://<your-deployment>/mcp
claude mcp login swfte
```

The browser opens the Swfte login, you pick a workspace, and Claude Code holds a PAT
bound to it. Then ask Claude to run `swfte_whoami` — it reports which workspace the
credential acts in, which turns a later opaque `403` into a concrete answer.

Any other MCP client works the same way: point it at `https://<your-deployment>/mcp`
with the streamable HTTP transport and let it discover the OAuth metadata.

---

## Blockers

Both are in `src/http.ts`, both are reproducible locally, and neither is fixed here —
that file belongs to the OAuth workstream.

**1. The request body is read twice, so every POST to `/mcp` throws.**
`createHostedHandler` consults `oauth.handle(req)` on every path, and for a non-GET
request `runExpress` does `await req.text()`. When the OAuth router declines — which is
what happens for `/mcp` — the same `Request` continues on to `authenticate`, which calls
`runExpress` again:

```
TypeError: Body is unusable: Body has already been read
    at runExpress (src/oauth.ts:784)
    at Object.authenticate (src/oauth.ts:725)
    at handle (src/http.ts:57)
```

A `Request` body reads once. It needs `req.clone()` per consumer, or one read hoisted and
threaded through — the transport already takes `handleRequest(req, { parsedBody })` for
exactly this. Every OAuth `GET` path is unaffected and verified working.

**2. Successful MCP responses arrive with an empty body.** `createHttpHandler` closes the
transport in a `finally` before returning the `Response`:

```ts
return await transport.handleRequest(req, …);
} finally {
  await transport.close().catch(() => undefined);
}
```

`handleRequest` returns as soon as the headers are known — the SSE body is still being
written into a `ReadableStream` — so closing there tears the stream down before anyone
reads it. Measured on `initialize`: **177 bytes with the close removed, 0 bytes with it
in place**, status `200` and `content-type: text/event-stream` either way.

That shape is why it survives review: nothing errors. The request succeeds, the headers
are right, and the JSON-RPC payload is simply missing, so a client reports a protocol
timeout rather than anything that points here. The comment on that `finally` is right
about the leak it prevents; the fix is to tie the close to the end of the stream rather
than to the return of `handleRequest`.

With both worked around locally, the stack is sound end to end: `initialize` answers, 81
tools list, a call with no credential is refused with an actionable message, a malformed
token is rejected before it reaches the network, and a well-formed one builds a real
client and reaches agents-service.

---

## Unverified until a real deploy

1. **Vercel detecting the Web handler signature.** `api/index.ts` exports
   `GET`/`POST`/`DELETE`/`OPTIONS` taking a `Request`, rather than a default
   `(req, res)` handler. The handlers are proven correct when called directly; what is
   unproven is the builder recognising them. A `500` on the first request points here.
2. **The catch-all rewrite preserving the original path.** All routing is
   `new URL(req.url).pathname`, so `/mcp` rewritten to `/api` must still arrive as
   `/mcp`. This is the same assumption every Express-on-Vercel deployment makes, but it
   is an assumption. A `404` naming `mcp_endpoint` on every path is the symptom.
3. **The landing page winning over the rewrite at `/`.** Rewrites are a fallback after
   the filesystem, so `public/index.html` should serve `/`. If `/` returns the `404`
   JSON instead, that ordering is wrong here.
4. **A streamed response surviving the platform.** Local `vercel dev` is a weaker test
   of this than production — and it cannot be tested at all until blocker 2 is fixed.
5. **Region.** Unset, so the Function lands in the project's default region. Every tool
   call is a round trip to agents-service, so pinning `"regions"` near the backend is
   worth measuring once there is something to measure.
