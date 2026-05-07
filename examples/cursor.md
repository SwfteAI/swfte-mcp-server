# Use the Swfte MCP server in Cursor

Cursor's MCP support lives at `Settings → MCP`. Add a new server with:

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

Restart Cursor. You'll see the [Swfte](https://www.swfte.com) tools listed under MCP. The Cursor agent can now call them autonomously.

API keys: [swfte.com/settings/api-keys](https://www.swfte.com/settings/api-keys).
Full API reference: [swfte.com/developers](https://www.swfte.com/developers).
