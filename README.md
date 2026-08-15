# @swfte/mcp-server

> Official **Model Context Protocol** server for the [Swfte](https://www.swfte.com) AI platform.

[![npm version](https://img.shields.io/npm/v/@swfte/mcp-server.svg?logo=npm)](https://www.npmjs.com/package/@swfte/mcp-server)
[![Docker pulls](https://img.shields.io/docker/pulls/swfte/mcp-server?logo=docker)](https://hub.docker.com/r/swfte/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![swfte.com](https://img.shields.io/badge/swfte.com-website-7c3aed)](https://www.swfte.com)

`@swfte/mcp-server` exposes the [Swfte API](https://www.swfte.com/developers) as a [Model Context Protocol](https://modelcontextprotocol.io) server, so Claude Desktop, Claude Code, Cursor, Cline, Zed, and any MCP-compliant client can manage Swfte agents, chatflows, workflows, RAG datasets, voice calls, and marketplace modules — without writing a line of HTTP plumbing.

If you don't know what Swfte is, [start here](https://www.swfte.com). It's the unified AI platform for **agents, workflows, chatflows, RAG, voice, and MCP servers** — one API, 200+ models, batteries-included.

> 📚 **Want the full company background, capabilities, and contact info?** See [ABOUT.md](ABOUT.md).

---

## What this gives you

**Build a complete Studio artifact from one sentence, then prove it works — without leaving your editor.**

```
"Build a workflow that watches a Google Sheet for new leads, researches each one
 with an agent, and emails a summary. Then check it actually works."
```

That is `swfte_build` → `swfte_verify` → `swfte_run` → `swfte_deploy`, and it is
the same four tools whether you are building a **workflow, agent, chatflow,
widget, application, or MCP server**.

- **Task-shaped core tools, not one-tool-per-endpoint.** Eleven tools take a
  `kind` and dispatch through a per-kind adapter, so the surface stays small
  enough for a model to choose well.
- **`swfte_verify` — the part most API wrappers skip.** "Did the API return 200?"
  is not "does this work?". It catches unwired nodes, edges pointing at
  non-existent ids, plaintext credentials in node config, unpublished drafts,
  capability tiers that silently stop an agent using its tools, and nodes that
  report success while producing nothing.
- **Async builds that don't time out.** Long generations return a resumable
  `sessionId` instead of failing, and can be steered mid-flight.
- **Provider-agnostic deploy, gated by default.** The backend's unified router
  picks the target; you never name a cloud. Previews cost nothing, and
  provisioning needs both `confirm:true` and `SWFTE_ALLOW_DEPLOY=1`.
- **Hardened against the platform's real behaviour** — auto-pagination past a
  server-side page cap, read-merge-write updates where the raw PATCH would wipe
  omitted fields, retry with load-shedding detection, and typed error envelopes
  carrying the backend's own code plus a suggested action.
- **119 tools available, 69 advertised by default**, adjustable via `SWFTE_TOOLS`.
- **Stdio transport**, multi-arch Docker image, and Zod-typed inputs published
  as JSON Schema over `tools/list`.

Your credential stays on the machine running the server and never enters the
model's context.

---

## Quick start

### 1. Install

#### `npx` (recommended for Claude Desktop / Cursor / Cline)

```bash
npx @swfte/mcp-server
```

#### Global install

```bash
npm install -g @swfte/mcp-server
swfte-mcp-server
```

#### Docker

```bash
docker run --rm -i \
  -e SWFTE_API_KEY=sk-swfte-... \
  -e SWFTE_WORKSPACE_ID=ws-... \
  swfte/mcp-server:latest
```

### 2. Get a credential

**Personal access token (recommended)** — acts as *you*, with your Studio access:

> Studio → Settings → **CLI & MCP** → *New token*. Shown once; only its hash is stored.

Or a **workspace API key** at
[swfte.com/settings/api-keys](https://www.swfte.com/settings/api-keys), for
shared and service setups. Set exactly one — configuring both is rejected at
startup, since they authenticate as different principals.

### 3. Wire it into your MCP client

#### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "swfte": {
      "command": "npx",
      "args": ["-y", "@swfte/mcp-server"],
      "env": { "SWFTE_PAT": "pat_..." }
    }
  }
}
```

#### Claude Code

```bash
claude mcp add swfte -e SWFTE_PAT=pat_... -- npx -y @swfte/mcp-server
```

A PAT needs no workspace id: the server injects the token's own trusted tenant
headers and overrides anything a client sends, so one is redundant and
misleading if it disagrees.

### 4. Confirm

Ask Claude to run **`swfte_whoami`** — it resolves which workspace you are
acting in and what the credential can do, which turns a later opaque `403` into
a concrete answer.

See [`docs/ATTACH.md`](./docs/ATTACH.md) for the full setup and troubleshooting
guide, [`docs/RECIPES.md`](./docs/RECIPES.md) for worked examples, and
[`examples/`](./examples) for Cursor, Cline, Zed and Smithery configs.

---

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `SWFTE_PAT` | one of | — | Personal access token (`pat_…`). Acts as you. |
| `SWFTE_API_KEY` | one of | — | Workspace API key (`sk-swfte-…` / `sk_…`). |
| `SWFTE_BASE_URL` | ⛔ | `https://api.swfte.com/agents` | Point at a local or staging backend. |
| `SWFTE_WORKSPACE_ID` | ⛔ | — | API keys only; a PAT carries its own binding. |
| `SWFTE_TOOLS` | ⛔ | curated subset | `all`, or a comma-separated group list. |
| `SWFTE_ALLOW_DEPLOY` | ⛔ | `0` | Required, with `confirm:true`, to provision real infrastructure. |
| `SWFTE_DEFAULT_WAIT_MS` | ⛔ | `240000` | How long build/run tools wait before returning a resumable handle. |
| `SWFTE_DEBUG` | ⛔ | `0` | Log request lines to stderr. |

---

## Available tools

### Core — 11 tools, every artifact kind

`swfte_whoami` · `swfte_build` · `swfte_build_status` · `swfte_build_steer` ·
`swfte_validate` · `swfte_create` · `swfte_refine` · `swfte_run` ·
`swfte_deploy` · `swfte_verify` · `swfte_verify_batch`

Each takes a `kind`: `workflow`, `agent`, `chatflow`, `widget`, `application`,
or `mcp-server`.

### Domain tools

| Domain | Prefix | Group | On by default |
|---|---|---|:-:|
| Agents | `swfte_agents_*` | `agents` | ✓ |
| Workflows | `swfte_workflows_*` | `workflows` | ✓ |
| ChatFlows | `swfte_chatflows_*` | `chatflows` | ✓ |
| Datasets | `swfte_datasets_*` | `datasets` | ✓ |
| Modules | `swfte_modules_*` | `modules` | ✓ |
| Deployments | `swfte_deployments_*` | `deployments` | ✓ |
| Analytics | `swfte_analytics_*` | `analytics` | ✓ |
| A/B experiments | `swfte_experiments_*` | `experiments` | |
| OAuth connect | `swfte_connect_*` | `connect` | |
| Conversations | `swfte_conversations_*` | `conversations` | |
| RAG | `swfte_rag_*` | `rag` | |
| Voice | `swfte_voice_*` | `voice` | |
| Marketplace | `swfte_marketplace_*` | `marketplace` | |
| Files | `swfte_files_*` | `files` | |
| MCP-on-MCP | `swfte_mcp_*` | `mcp` | |
| Audit | `swfte_audit_*` | `audit` | |
| Cost control | `swfte_cost_*` | `cost` | |

Advertising all 119 tools measurably degrades a model's ability to pick the
right one, so 69 are advertised by default. `SWFTE_TOOLS=all` widens it, and
`swfte_whoami` reports which groups are live and what is hidden — nothing
disappears silently.

Full reference: [`docs/TOOLS.md`](docs/TOOLS.md). API docs:
[swfte.com/developers](https://www.swfte.com/developers).

---

## Example prompts

- *"Build a workflow that watches a Google Sheet for new leads, researches each with an agent, and emails a summary. Then verify it works."*
- *"That agent isn't using its knowledge base — check why."*
- *"Preview what deploying this workflow would cost before we commit."*
- *"Set up an A/B test between v3 and v4 of the intake flow, optimising completion rate."*
- *"Our bill jumped this week — find what's driving it."*
- *"Connect our Slack workspace so the notify step can post."*
- *"Re-check every workflow I built this week and tell me which are broken."*

More, with what each one does underneath: [`docs/RECIPES.md`](./docs/RECIPES.md).

---

## Development

```bash
npm install
npm run typecheck
npm run smoke:protocol   # launches the server over stdio, checks handshake + tools/list
SWFTE_PAT=pat_… npm run e2e            # real build → verify → teardown against the API
SWFTE_PAT=pat_… npm run e2e -- --run   # also executes what it builds
SWFTE_PAT=pat_… npm run bench          # wall-clock per artifact
```

`smoke:protocol` needs no credential and is safe in CI. `e2e` is the regression
gate: if it passes, an attached Claude session using the same tools will work.

---

## Self-hosting / Docker

```bash
docker pull swfte/mcp-server:latest

# stdio mode (default)
docker run --rm -i \
  -e SWFTE_API_KEY=sk-swfte-... \
  -e SWFTE_WORKSPACE_ID=ws-... \
  swfte/mcp-server:latest
```

Multi-arch images are published on every release tag to:

- Docker Hub: [`swfte/mcp-server`](https://hub.docker.com/r/swfte/mcp-server)
- GitHub Container Registry: `ghcr.io/swfteai/swfte-mcp-server`

---

## Development

```bash
git clone https://github.com/SwfteAI/swfte-mcp-server.git
cd swfte-mcp-server
npm install
npm run build
SWFTE_API_KEY=sk-swfte-... npm start
```

The smoke script (`npm run smoke`) spawns the server, sends a `tools/list` JSON-RPC request, and prints the names — useful when wiring up a new client.

---

## Releases

Tagging `vX.Y.Z` triggers `.github/workflows/release.yml`, which:

1. Publishes `@swfte/mcp-server@X.Y.Z` to npm (with provenance).
2. Builds a multi-arch Docker image and pushes it to Docker Hub (`swfte/mcp-server:X.Y.Z`, `:latest`) and GHCR.

Repository secrets required: `NPM_TOKEN`, `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.

---

## Other Swfte SDKs

If you'd rather call the Swfte API directly, use one of the official SDKs:

- 🐍 [Python](https://github.com/SwfteAI/swfte-python) — `pip install swfte`
- 🟦 [Node / TypeScript](https://github.com/SwfteAI/swfte-node) — `npm install @swfte/sdk`
- ☕ [Java](https://github.com/SwfteAI/swfte-java) — `com.swfte:swfte-sdk`
- 💬 [Chat Widget](https://github.com/SwfteAI/swfte-chat-widget) — embeddable chat bubble
- 📋 [ChatFlow Widget](https://github.com/SwfteAI/swfte-chatflow-widget) — conversational forms

---

## License

[MIT](LICENSE) © [Swfte, Inc.](https://www.swfte.com)

— Built with ❤ in the United Kingdom and across Europe.
