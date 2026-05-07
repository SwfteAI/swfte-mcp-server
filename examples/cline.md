# Use the Swfte MCP server in Cline (VS Code)

In VS Code:

1. Install the Cline extension.
2. Open the Cline panel → **MCP Servers** tab → **Edit Configuration**.
3. Add:

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

Cline will auto-discover the tools. Ask things like:

- *"Use Swfte to look up the audit log for any deletes in the last 24 hours."*
- *"Search the `support-articles` Swfte dataset and answer this question with citations."*

Get an API key at [swfte.com/settings/api-keys](https://www.swfte.com/settings/api-keys). Full reference at [swfte.com/developers](https://www.swfte.com/developers).
