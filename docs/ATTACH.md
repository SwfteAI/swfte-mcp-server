# Attaching the Swfte MCP server

## 1. Mint a credential

Two kinds work, and the difference matters.

**Personal access token (`pat_…`) — recommended.** Acts as *you*, with the same
access you have in Studio. Bound to one workspace.

There is no Settings page for these yet. The minting UI currently lives inside
the module documents hub, because it was built for the `@swfte/cortex` CLI:

> Studio → **Modules** → open any module → **Documents** tab →
> the **CLI** ingest mode, or the *Connect CLI* button → mint a token.
>
> URL shape: `/v2/studio/modules/<moduleId>/documents`

The raw token is shown **once**. Only its SHA-256 hash is stored, so a lost
token cannot be recovered — mint a new one and revoke the old.

*(A dedicated Settings entry would be the obvious home for this. Today the panel
is only reachable through that route.)*

**Workspace API key (`sk-swfte-…` / `sk_…`).** Acts as the workspace rather than
a person. Use for shared or service setups.

> Studio → Settings → **API keys**.

Set exactly one. Setting both is rejected at startup, because they authenticate
as different principals and silently picking one would be worse than failing.

## 2. Attach

### Claude Code

```bash
cd ~/Projects/Swfte/sdk-mains/swfte-mcp-server
npm install && npm run build

claude mcp add swfte-studio \
  -e SWFTE_PAT=pat_your_token_here \
  -- node "$PWD/dist/index.js"
```

Once published, the local build is unnecessary:

```bash
claude mcp add swfte-studio -e SWFTE_PAT=pat_… -- npx -y @swfte/mcp-server
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "swfte-studio": {
      "command": "npx",
      "args": ["-y", "@swfte/mcp-server"],
      "env": { "SWFTE_PAT": "pat_your_token_here" }
    }
  }
}
```

Cursor and Cline use the same shape — see `examples/`.

## 3. Confirm

Ask Claude to run **`swfte_whoami`**. Do this first in any session that will
create or deploy something: it resolves which workspace you are acting in and
what the credential can do, which turns a later opaque `403` into a concrete
answer.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SWFTE_PAT` | — | Personal access token. Travels in `Authorization` only. |
| `SWFTE_API_KEY` | — | Workspace API key. Alternative to `SWFTE_PAT`. |
| `SWFTE_BASE_URL` | `https://api.swfte.com/agents` | Point at a local backend for development. |
| `SWFTE_WORKSPACE_ID` | — | Only meaningful for API keys. A PAT carries its own binding. |
| `SWFTE_TOOLS` | curated subset | `all`, or a comma-separated group list. |
| `SWFTE_ALLOW_DEPLOY` | `0` | Required, with `confirm:true`, to provision real infrastructure. |
| `SWFTE_DEFAULT_WAIT_MS` | `240000` | How long build/run tools wait before returning a resumable handle. |
| `SWFTE_DEBUG` | `0` | Log every request line to stderr. |

### Why a PAT needs no workspace id

`PersonalAccessTokenAuthFilter` injects `x-user-id`, `x-workspace-id` and
`x-account-id` from the stored token and **overrides anything the client sends**,
so a PAT cannot be used to reach another tenant. This server therefore sends
neither `X-Workspace-Id` nor `X-API-Key` on PAT requests: the first would be
ignored (and misleading if it disagreed with the token), and the second would
copy the secret into a header that has no use for it.

### Tool groups

The full surface is 183 tools. Advertising all of them measurably degrades a
model's ability to pick the right one, so a **96-tool default** is advertised:

```
core, workflows, agents, chatflows, datasets, modules, deployments, analytics
```

Widen or narrow it explicitly:

```bash
SWFTE_TOOLS=all                       # everything
SWFTE_TOOLS=core,workflows            # 17 tools — a focused workflow session
SWFTE_TOOLS=core,voice,conversations  # a voice-ops session
```

Available groups: `core`, `workflows`, `agents`, `chatflows`, `datasets`,
`modules`, `rag`, `voice`, `marketplace`, `files`, `conversations`, `audit`,
`cost`, `mcp`, `analytics`, `experiments`, `connect`, `deployments`.

`core` is always included, and `swfte_whoami` reports which groups are live plus
what is hidden — nothing disappears silently.

## Deploy safety

`swfte_deploy` **previews by default**: it returns the target the backend
pre-flight chose, the runtime profile, and the estimated hourly cost, without
provisioning anything.

Actually provisioning needs **both**:

1. `confirm: true` on the call, and
2. `SWFTE_ALLOW_DEPLOY=1` in the server environment.

Two independent gates, so neither a model deciding to be helpful nor a
long-running loop can spend money unattended. Teardown is never gated —
releasing capacity is always allowed.

To let a session deploy:

```bash
claude mcp add swfte-studio \
  -e SWFTE_PAT=pat_… \
  -e SWFTE_ALLOW_DEPLOY=1 \
  -- npx -y @swfte/mcp-server
```

## Troubleshooting

**Every call returns 401.** The token is invalid, expired, or revoked. Run
`swfte_whoami` — it says so explicitly rather than surfacing three separate
auth errors. Mint a new token.

**`swfte_build` returns a `sessionId` instead of an artifact.** The build
outran `waitMs`. It is still running server-side; call `swfte_build_status`
with that `sessionId`. Nothing was lost.

**`SESSION_NOT_FOUND` from `swfte_build_status`.** Wizard runs live in an
in-memory store that sweeps after a TTL, so this means the session expired —
not that the build failed. The artifact may well exist; check the relevant list
tool before rebuilding.

**A 402 with `PAYMENT_METHOD_REQUIRED` or `SUBSCRIPTION_REQUIRED`.** These are
real product gates, not bugs: building and exporting are free, while creating
past the free allowance needs a card, and running or deploying needs a
subscription. The error carries a `suggestedAction`.

**Deploy says `DEPLOY_DISABLED`.** `SWFTE_ALLOW_DEPLOY=1` is not set on the
server. Preview still works.
