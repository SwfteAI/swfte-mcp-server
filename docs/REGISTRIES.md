# Submitting `@swfte/mcp-server` to MCP registries

This file is the canonical record of where the [Swfte](https://www.swfte.com) MCP server is listed and how to update each listing.

## Anthropic / Official MCP servers list

The official curated list lives at:

- https://github.com/modelcontextprotocol/servers
- https://www.modelcontextprotocol.io/servers

Submission flow: open a PR against `modelcontextprotocol/servers` adding an entry to the `README.md` under **Community Servers** with:

```md
- **[Swfte](https://github.com/SwfteAI/swfte-mcp-server)** — Manage Swfte agents, chatflows, workflows, RAG datasets, voice calls, and marketplace modules. [swfte.com](https://www.swfte.com)
```

PR template body (paste this verbatim):

```
Adds the official Swfte MCP server to the community list.

- Repo: https://github.com/SwfteAI/swfte-mcp-server
- npm: https://www.npmjs.com/package/@swfte/mcp-server
- Docker: https://hub.docker.com/r/swfte/mcp-server
- Website: https://www.swfte.com
- License: MIT
- Tools: 58 — agents, chatflows, workflows, conversations, datasets, files, RAG, MCP-on-MCP, modules, marketplace, voice, audit, cost-control.
- Auth: SWFTE_API_KEY (Bearer)
- Transports: stdio
```

## Smithery.ai

- URL: https://smithery.ai/server/@swfte/mcp-server
- Manifest: [`smithery.yaml`](../smithery.yaml) at repo root.
- Submission: tag a release; Smithery picks it up automatically when the repo is public and the manifest validates.

## mcp.so

- URL: https://mcp.so
- Submission form: https://mcp.so/submit
- Required fields: name, repo URL, npm package, description, screenshot. Use the README banner section for the screenshot.

## PulseMCP

- URL: https://www.pulsemcp.com
- Adds servers automatically by scraping the public MCP server lists. Manual submission via https://www.pulsemcp.com/submit.

## Glama.ai MCP catalogue

- URL: https://glama.ai/mcp/servers
- Submission: open an issue at https://github.com/glamaai/awesome-mcp-servers with the repo URL and the same metadata block as above.

## Swfte's own marketplace

The Swfte server is also listed in the first-party Swfte marketplace under [swfte.com/marketplace](https://www.swfte.com/marketplace) — handled by the marketplace team via the standard publication flow.

---

When adding a new registry, add a section here so we have a single source of truth for "where is this listed?".
