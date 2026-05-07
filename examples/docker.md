# Run the Swfte MCP server with Docker

Multi-arch images (`linux/amd64`, `linux/arm64`) are published to:

- Docker Hub: [`swfte/mcp-server`](https://hub.docker.com/r/swfte/mcp-server)
- GHCR: `ghcr.io/swfteai/swfte-mcp-server`

## Pull

```bash
docker pull swfte/mcp-server:latest
```

## Run (stdio mode — for MCP clients)

The server speaks MCP over stdio, so you typically launch it through your MCP client. The Docker form:

```bash
docker run --rm -i \
  -e SWFTE_API_KEY=sk-swfte-... \
  -e SWFTE_WORKSPACE_ID=ws-... \
  swfte/mcp-server:latest
```

The `-i` is required (stdin must stay open).

## Use Docker from Claude Desktop

```json
{
  "mcpServers": {
    "swfte": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "SWFTE_API_KEY",
        "-e", "SWFTE_WORKSPACE_ID",
        "swfte/mcp-server:latest"
      ],
      "env": {
        "SWFTE_API_KEY": "sk-swfte-...",
        "SWFTE_WORKSPACE_ID": "ws-..."
      }
    }
  }
}
```

This is useful when you want a pinned, reproducible binary instead of `npx`.

---

Get an API key at [swfte.com/settings/api-keys](https://www.swfte.com/settings/api-keys). API reference: [swfte.com/developers](https://www.swfte.com/developers).
