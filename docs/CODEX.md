# Using the Swfte MCP server with Codex

This page sets up the Swfte MCP server in the Codex CLI, explains the one-line trace trailer that ends
every Swfte tool result, and walks through checking that a Codex tool call joined its Swfte work record.

## 1. Configure the server in `~/.codex/config.toml`

Codex reads MCP servers from `[mcp_servers.<name>]` tables in `~/.codex/config.toml` (or a project's
`.codex/config.toml`). Use one of the two entries below, not both.

### Published package (recommended)

```toml
[mcp_servers.swfte]
command = "npx"
args = ["-y", "@swfte/mcp-server"]
# Forward these variables from the shell that starts Codex. Their values never live in this file.
env_vars = ["SWFTE_PAT", "SWFTE_API_KEY", "SWFTE_BASE_URL", "SWFTE_WORKSPACE_ID", "SWFTE_TOOLS", "SWFTE_TELEMETRY"]
startup_timeout_sec = 30
tool_timeout_sec = 600
```

### Local stdio build (working on this repository)

Build once with `npm install && npm run build`, then point Codex at the built entry point. Use the
absolute path of your checkout.

```toml
[mcp_servers.swfte]
command = "node"
args = ["/absolute/path/to/swfte-mcp-server/dist/index.js"]
env_vars = ["SWFTE_PAT", "SWFTE_API_KEY", "SWFTE_BASE_URL", "SWFTE_WORKSPACE_ID", "SWFTE_TOOLS", "SWFTE_TELEMETRY"]
startup_timeout_sec = 30
tool_timeout_sec = 600
```

`tool_timeout_sec` is generous because build and deploy tools wait on the platform. Codex also has
`codex mcp add`, but its `--env KEY=VALUE` flag writes the value into `config.toml`, so do not use it for
the credential.

## 2. Authenticate with an environment variable

The server needs exactly one credential, taken from the environment of the process that launches it:

| Variable | What it is |
| --- | --- |
| `SWFTE_PAT` | Personal access token. Acts as you; tool calls are recorded as an agent acting for you. Mint one in Studio under Modules, any module, Documents, Connect CLI. |
| `SWFTE_API_KEY` | Workspace API key, for shared or service use. |

Set it in the shell (or your secret manager's shell integration) before starting Codex:

```sh
export SWFTE_PAT="<paste the token from Studio; never commit it>"
codex
```

Rules that keep the credential out of files and transcripts:

- Never write the token into `config.toml`: no `env = { ... }` table with a value, no `codex mcp add --env`.
  `env_vars` forwards the variable by name only.
- Set exactly one of `SWFTE_PAT` and `SWFTE_API_KEY`; the server refuses to start with both.
- `SWFTE_BASE_URL` is optional and defaults to `https://api.swfte.com/agents`.
- The learning-loop tools (`swfte_report_outcome`, `swfte_propose_rule`, `swfte_recipes_*`) are in the
  opt-in `learning` group. To advertise them, export
  `SWFTE_TOOLS=core,workflows,agents,chatflows,datasets,modules,deployments,connect,learning`
  (the default groups plus `learning`) before starting Codex. Tracing needs no group: every tool call
  carries its trace headers and trailer either way.

## 3. What every tool call carries

Each Swfte tool call is one step of a work record. For every backend request a call makes, the server
sends:

- `traceparent`: a W3C trace context. The trace id is fresh for each tool call; a retry or a sub-request
  of the same call keeps the trace id and gets a new span id.
- `X-Swfte-Mcp-Session`: one id per MCP server session (one per Codex process for the stdio server).
- `X-Swfte-Mcp-Client`: the host, from the MCP `initialize` handshake, reduced to `claude-code`, `codex`,
  `cursor` or `other`. Codex introduces itself as `codex-mcp-client`, which is sent as `codex`. The raw
  client name is never sent.
- `X-Swfte-Mcp-Tool`: the tool name, e.g. `swfte_whoami`.

A call that makes no backend request (for example `swfte_composition_classify`, or a call refused for
invalid input) is posted as a local step to `POST /v2/learning/records/steps`. When the backend cannot be
reached, the attempt waits in a bounded in-memory queue (200 steps, oldest dropped first) and is posted as
an `UNREACHED` step on the next successful contact. Steps hold argument names and JSON types only, never
values; connection and secret handles appear as the type `handle`. `SWFTE_TELEMETRY=0` turns local steps
off; the headers above are still sent.

## 4. The trace trailer

Every Swfte tool result, success or error, ends with one extra text item, always the last one:

```text
swfte-trace: 4bf92f3577b34da6a3ce929d0e0e4736
```

It is exactly `swfte-trace: ` followed by 32 lowercase hex characters. The same id is in the result's
`_meta` under the key `swfte/traceId`. It is the id the backend echoed in `X-Swfte-Trace-Id` when it
echoed one, otherwise the id the server generated for the call; the two are the same whenever the backend
adopted the `traceparent`.

Why a text line as well as `_meta`: hosts do not reliably pass `_meta` on to hooks, transcripts or
wrappers, while the result text always survives. A hook, a Nexus session or a person reading the
transcript can join the call to its work record from that line alone. Parse it structurally, as the last
text item matching `^swfte-trace: ([0-9a-f]{32})$`, and do not strip it from results you forward.

## 5. Verify the join, step by step

1. Start Codex from a shell where `SWFTE_PAT` is exported, and confirm the server is registered:
   `codex mcp list` shows `swfte`.
2. Ask Codex to run one tool that reaches the backend, for example: "Call `swfte_whoami`."
3. Copy the trace id from the last line of that tool result, the `swfte-trace: <id>` line:

   ```sh
   export TRACE="<the 32 hex characters after swfte-trace:>"
   ```

4. Fetch your workspace's recent MCP records from Codex (same credential, from the environment):

   ```sh
   curl -s -H "Authorization: Bearer $SWFTE_PAT" \
     "${SWFTE_BASE_URL:-https://api.swfte.com/agents}/v2/learning/records?channel=mcp&client=codex&limit=25" \
     > records.json
   ```

5. Find the step with that trace id:

   ```sh
   jq --arg t "$TRACE" '.items[] | select(any(.steps[]; .traceId == $t))
     | {record: .id, channel, client, step: (.steps[] | select(.traceId == $t))}' records.json
   ```

6. The join holds when exactly one record comes back with `"channel": "mcp"`, `"client": "codex"` and one
   step whose `traceId` is your id and whose `tool` is `swfte_whoami`. `attempts` counts HTTP attempts
   (a retry adds one to the same step). Repeat with `swfte_composition_classify`, which never calls the
   backend: its step arrives through the local-step path with the trace id from its trailer.

If nothing comes back:

| Symptom | Likely cause |
| --- | --- |
| `{"code":"NOT_FOUND","message":"Not found"}` from `/v2/learning/records` | Work records are not switched on for this environment (`learning.records.enabled`). |
| Records exist but none has your trace id | The workspace's learning consent tier is `off`, or the call ran under a different credential or workspace. |
| The record says `"client": "other"` | The Codex build reported an unrecognised client name. The join still holds; filter without `client=codex`. |
| The result has no `swfte-trace:` line | The server predates tracing. Update `@swfte/mcp-server` or rebuild the local checkout. |
