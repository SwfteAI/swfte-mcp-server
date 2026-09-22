# @swfte/mcp-server

> Official **Model Context Protocol** server for the [Swfte](https://www.swfte.com) AI platform.

[![npm version](https://img.shields.io/npm/v/@swfte/mcp-server.svg?logo=npm)](https://www.npmjs.com/package/@swfte/mcp-server)
[![Docker pulls](https://img.shields.io/docker/pulls/swfte/mcp-server?logo=docker)](https://hub.docker.com/r/swfte/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![swfte.com](https://img.shields.io/badge/swfte.com-website-7c3aed)](https://www.swfte.com)

`@swfte/mcp-server` exposes the [Swfte API](https://www.swfte.com/developers) as a [Model Context Protocol](https://modelcontextprotocol.io) server, so Claude Desktop, Claude Code, Cursor, Cline, Zed, and any MCP-compliant client can manage Swfte agents, chatflows, workflows, Relay journeys, RAG datasets, voice calls, and marketplace modules — without writing a line of HTTP plumbing.

If you don't know what Swfte is, [start here](https://www.swfte.com). It's the unified AI platform for **agents, workflows, chatflows, RAG, voice, and MCP servers** — one API, 200+ models, batteries-included.

> 📚 **Want the full company background, capabilities, and contact info?** See [ABOUT.md](ABOUT.md).

---

## What this gives you

- **230 MCP tools** that wrap every important V2 endpoint — agents, chatflows, workflows, Relay journeys/runs/mailboxes, conversations, datasets, files, RAG, MCP-on-MCP, modules, marketplace, voice, audit, cost-control.
- **Stdio transport** — works out of the box with Claude Desktop and Claude Code.
- **Workspace-scoped** — set `SWFTE_WORKSPACE_ID` once, or pass `workspaceId` per call.
- **Zero-config security** — your API key stays on the machine running the MCP server, never in the LLM context.
- **Multi-arch Docker image** — `swfte/mcp-server` on Docker Hub for amd64 + arm64.
- **TypeScript-first** — every input is typed via Zod, schemas surfaced to the client as JSON-Schema.
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
- **230 tools available, 103 advertised by default**, adjustable via `SWFTE_TOOLS`.
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

> Studio → **Modules** → open a module → **Documents** → *Connect CLI* → mint a token.
> (`/v2/studio/modules/<moduleId>/documents`. There is no Settings entry yet — the
> panel was built for the `@swfte/cortex` CLI and shares its home.)
> Shown once; only its SHA-256 hash is stored.

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

| Domain | Tool prefix | Highlights |
|---|---|---|
| **Agents** | `swfte_agents_*` | list, get, create, update, delete, find by name/type/capability, wizard generate/quick/templates |
| **ChatFlows** | `swfte_chatflows_*` | list/get/create, validate, deploy, publish, session start/get, builder templates |
| **Workflows** | `swfte_workflows_*` | list, get, create, validate, clone, export, publish, deployment status, pre-deploy, execute, list/get/pause/resume executions, node-level traces |
| **Journeys** | `swfte_journeys_*` | list/get/create/update/delete templates, generate from prompt, deploy/run/test a journey, app-level multi-journey deploy |
| **Relay Runs** | `swfte_relay_runs_*` | list, get, conversation snapshot, cancel, resolve a paused gate |
| **Relay Mailboxes** | `swfte_relay_mailboxes_*` | resolve a connected mailbox's address for a journey's email trigger |
| **Conversations** | `swfte_conversations_*` | initiate, list, get, transcript, terminate |
| **Datasets** | `swfte_datasets_*` | list, get, create, documents list/create/status |
| **Files** | `swfte_files_*` | list, config, get, delete |
| **RAG** | `swfte_rag_*` | hybrid search, rerank, embedding/reranker model lists, strategies |
| **MCP-on-MCP** | `swfte_mcp_*` | servers list/connect, tools list/schema/execute, health-check |
| **Modules** | `swfte_modules_*` | list, get, create, build, versions |
| **Marketplace** | `swfte_marketplace_*` | browse, get, install, installations |
| **Voice** | `swfte_voice_*` | list calls, in-progress, get, transcript, recording |
| **Audit** | `swfte_audit_*` | events, resource events, my events |
| **Cost Control** | `swfte_cost_*` | routing rules, usage caps, usage stats |

Every tool's input schema is published over MCP `tools/list` so your client can autocomplete and validate.

Full endpoint→tool mapping is in [`docs/TOOLS.md`](docs/TOOLS.md). Underlying API reference: [swfte.com/developers](https://www.swfte.com/developers) and [swfte.com/resources](https://www.swfte.com/resources).
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
| Analytics | `swfte_analytics_*` | `analytics` | |
| A/B experiments | `swfte_experiments_*` | `experiments` | |
| OAuth connect | `swfte_connect_*` | `connect` | ✓ |
| Conversations | `swfte_conversations_*` | `conversations` | |
| RAG | `swfte_rag_*` | `rag` | |
| Voice | `swfte_voice_*` | `voice` | |
| Marketplace | `swfte_marketplace_*` | `marketplace` | |
| Files | `swfte_files_*` | `files` | |
| MCP-on-MCP | `swfte_mcp_*` | `mcp` | |
| Audit | `swfte_audit_*` | `audit` | |
| Cost control | `swfte_cost_*` | `cost` | |
| Agent mail | `swfte_agent_mail_*` | `agent-mail` | |

Advertising all 230 tools measurably degrades a model's ability to pick the
right one, so 103 are advertised by default. `SWFTE_TOOLS=all` widens it, and
`swfte_whoami` reports which groups are live and what is hidden — nothing
disappears silently.

Full reference: [`docs/TOOLS.md`](docs/TOOLS.md). API docs:
[swfte.com/developers](https://www.swfte.com/developers).

---

## Use Studio as your source of truth from Claude Code

Swfte Studio keeps a catalog of every workflow, agent, chatflow, widget,
application, MCP server, model, module and solution in your workspace (plus the
public catalog), each with an **evidence level** computed from real runs, evals
and reviews: `unmeasured → observed → corroborated → validated → verified`,
plus `stale` and `disputed`. This server makes that catalog the first thing a
coding agent consults, and the path by which proven artifacts land in your code.

**1. Reuse before you generate.** `swfte_find_existing {query}` searches the
catalog and returns ranked matches with their evidence level, the reasons they
matched, and a recommendation — `REUSE`, `INSPECT_BEFORE_REUSE` or `BUILD` —
with an estimate of the generation a reuse avoids. `swfte_build` says so in its
description and repeats it in every response. If Jev re-ranking is unavailable
the search still answers and lists it under `degraded`.

**2. Read the context package.** `swfte_get_context {catalogRef}` returns the
invocation contract (method, path, auth, async status path, input/output JSON
Schemas, snippets, embed), evidence and its reasons, Jev facets (proposed vs
confirmed), the stored design rationale, reviews and dependencies.
`swfte_get_evidence` and `swfte_trace_dependencies` (downstream, or a bounded
upstream scan before you change something others reuse) go deeper.

**3. Bake it into the codebase.** `swfte_scaffold_client {catalogRef, language:
"typescript" | "python", targetDir}` writes a dependency-free typed client
(types generated from the contract's schemas; async workflows are polled to
completion), merges `SWFTE_API_KEY` / `SWFTE_BASE_URL` / `SWFTE_WORKSPACE_ID`
into `.env.example`, and records `{catalogRef, updatedAt, contractHash}` in
`swfte.json` — commit it, and a changed contract hash tells you the artifact
moved. `swfte_embed_widget` writes an artifact's embed markup instead. Writes
are confined to the directory the server runs in (`..` and outside absolute
paths are refused), never overwrite an existing file without `force: true`
(nothing is written if any file would be), and never contain a credential.

**4. Wire analytics, payments and deploys — with approval.** Platform changes go
through approval-gated actions: `swfte_request_approval` proposes one (deploy,
host, payments, connect, analytics), a human approves it in Studio → Actions,
and `swfte_execute_approved_action` runs it (`409` = not approved yet, `410` =
expired — both reported as explicit outcomes). There is deliberately no approve
tool. `swfte_wire_analytics` and `swfte_wire_payments` wrap that flow: the
first call proposes the action; the second, with the `actionId`, executes it
and writes an `@swfte/analytics` init module (publishable `swfte_pk_` key in
your env file) or a server-side checkout helper (runtime token read from
`SWFTE_APP_RUNTIME_TOKEN`, never written). Deploys stay with `swfte_deploy`,
which previews by default.

`swfte_run` on a workflow now runs the **published** snapshot through
`POST /v2/workflows/{id}/invoke`; a workflow with no active published version
falls back to `/execute` and then to the draft test path, and says which path
it took.

Resources and prompts carry the same flow for clients that use them:
`swfte://capabilities`, `swfte://catalog/{kind}/{id}` (the context package),
and the prompts `reuse-then-build`, `ship-with-analytics-and-payments` and
`bake-into-codebase`.

---

## Example prompts

- *"Build a workflow that watches a Google Sheet for new leads, researches each with an agent, and emails a summary. Then verify it works."*
- *"That agent isn't using its knowledge base — check why."*
- *"Preview what deploying this workflow would cost before we commit."*
- *"Set up an A/B test between v3 and v4 of the intake flow, optimising completion rate."*
- *"Our bill jumped this week — find what's driving it."*
- *"Connect our Slack workspace so the notify step can post."*
- *"Re-check every workflow I built this week and tell me which are broken."*

- *"Browse the Swfte marketplace for customer-support modules and install the top one into my workspace."*
- *"List all chatflows in workspace ws-acme, then deploy any that are in DRAFT status."*
- *"Generate a sales-qualification agent from this prompt, then publish it as a widget."*
- *"Draft a Relay journey for inbound insurance claims from this description, deploy it, and show me any runs that are paused for a gate approval."*
- *"Run a hybrid RAG search across dataset ds-help-center for 'refund policy' and rerank the top 20."*
- *"Show me last week's voice calls that lasted more than 5 minutes, with their transcripts."*
- *"Set a $100 weekly spend cap on the workspace and show me current usage."*
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

To serve the same tools over HTTP instead — so clients connect with
`claude mcp add --transport http` and log in from a browser rather than carrying a
pasted token — see [`DEPLOY.md`](./DEPLOY.md).

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
