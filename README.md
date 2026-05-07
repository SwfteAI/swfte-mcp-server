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

- **40+ MCP tools** that wrap every important V2 endpoint — agents, chatflows, workflows, conversations, datasets, files, RAG, MCP-on-MCP, modules, marketplace, voice, audit, cost-control.
- **Stdio transport** — works out of the box with Claude Desktop and Claude Code.
- **Workspace-scoped** — set `SWFTE_WORKSPACE_ID` once, or pass `workspaceId` per call.
- **Zero-config security** — your API key stays on the machine running the MCP server, never in the LLM context.
- **Multi-arch Docker image** — `swfte/mcp-server` on Docker Hub for amd64 + arm64.
- **TypeScript-first** — every input is typed via Zod, schemas surfaced to the client as JSON-Schema.

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

### 2. Get an API key

[swfte.com/settings/api-keys](https://www.swfte.com/settings/api-keys). Free tier is enough to try every tool.

### 3. Wire it into your MCP client

#### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "swfte": {
      "command": "npx",
      "args": ["-y", "@swfte/mcp-server"],
      "env": {
        "SWFTE_API_KEY": "sk-swfte-...",
        "SWFTE_WORKSPACE_ID": "ws-..."
      }
    }
  }
}
```

#### Claude Code

```bash
claude mcp add swfte \
  --env SWFTE_API_KEY=sk-swfte-... \
  --env SWFTE_WORKSPACE_ID=ws-... \
  -- npx -y @swfte/mcp-server
```

See [`examples/`](./examples) for Cursor, Cline, Zed and Smithery configs.

---

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `SWFTE_API_KEY` | ✅ | — | Bearer API key. Get one at [swfte.com/settings/api-keys](https://www.swfte.com/settings/api-keys). |
| `SWFTE_WORKSPACE_ID` | ⛔ | — | Default workspace. Tools accept a per-call override. |
| `SWFTE_BASE_URL` | ⛔ | `https://api.swfte.com/agents` | Override for self-hosted / staging. |
| `SWFTE_DEBUG` | ⛔ | `0` | Set to `1` to log request lines to stderr. |

---

## Available tools

| Domain | Tool prefix | Highlights |
|---|---|---|
| **Agents** | `swfte_agents_*` | list, get, create, update, delete, wizard generate/quick/templates |
| **ChatFlows** | `swfte_chatflows_*` | list/get/create, validate, deploy, publish, session start/get, builder templates |
| **Workflows** | `swfte_workflows_*` | list, get, create, validate, clone, export |
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

---

## Example prompts

Once the server is connected, you can ask Claude things like:

- *"Browse the Swfte marketplace for customer-support modules and install the top one into my workspace."*
- *"List all chatflows in workspace ws-acme, then deploy any that are in DRAFT status."*
- *"Generate a sales-qualification agent from this prompt, then publish it as a widget."*
- *"Run a hybrid RAG search across dataset ds-help-center for 'refund policy' and rerank the top 20."*
- *"Show me last week's voice calls that lasted more than 5 minutes, with their transcripts."*
- *"Set a $100 weekly spend cap on the workspace and show me current usage."*

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
