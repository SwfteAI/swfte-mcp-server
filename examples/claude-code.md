# Use the Swfte MCP server in Claude Code

[Claude Code](https://claude.ai/code) speaks MCP natively — adding the [Swfte](https://www.swfte.com) tools is one command.

```bash
claude mcp add swfte \
  --env SWFTE_API_KEY=sk-swfte-... \
  --env SWFTE_WORKSPACE_ID=ws-... \
  -- npx -y @swfte/mcp-server
```

Verify:

```bash
claude mcp list
# swfte    npx -y @swfte/mcp-server
```

In any Claude Code session, the Swfte tools will appear under the `swfte_*` prefix. Ask things like:

- *"List my Swfte agents and tell me which ones haven't been used in 30 days."*
- *"Hybrid-search the help-center dataset for 'cancellation policy' and rerank the top 20."*
- *"Set a $200 weekly cap on the workspace and a $50 per-day cap on `claude-opus-4-7`."*

Get an API key: [swfte.com/settings/api-keys](https://www.swfte.com/settings/api-keys).

Full Swfte API reference: [swfte.com/developers](https://www.swfte.com/developers).
