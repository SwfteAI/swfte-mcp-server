# Use the Swfte MCP server in Claude Desktop

Claude Desktop is the easiest place to try out [Swfte](https://www.swfte.com) MCP tools — no terminal needed once it's wired up.

## 1. Install Claude Desktop

[claude.ai/download](https://claude.ai/download)

## 2. Open the config file

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

## 3. Add the Swfte server

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

Get your API key at [swfte.com/settings/api-keys](https://www.swfte.com/settings/api-keys).

## 4. Restart Claude Desktop

Quit completely (`⌘Q` on macOS — closing the window isn't enough), then re-open. You should see a hammer icon in the chat input — click it and confirm the Swfte tools are listed.

## 5. Try a prompt

> *"Browse the Swfte marketplace for support modules and show me the top 5."*

> *"Generate a sales-qualification agent that asks for company, headcount and use-case, then publish it as a widget."*

> *"List my Swfte chatflows and deploy any that are still in DRAFT."*

---

Read more recipes at [swfte.com/resources](https://www.swfte.com/resources).
