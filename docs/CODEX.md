# Using the Swfte MCP server with Codex

This page sets up the Swfte MCP server in the Codex CLI, explains the one-line trace trailer that ends
every Swfte tool result, and walks through checking that a Codex tool call joined its Swfte work record.

Configuration fields below were checked against the [official MCP documentation](https://developers.openai.com/codex/mcp)
on 2026-10-01. Use the local build to inspect these development changes; this work does not publish a package.

## 1. Configure the server in `~/.codex/config.toml`

Codex reads MCP servers from `[mcp_servers.<name>]` tables in `~/.codex/config.toml` (or a project's
`.codex/config.toml`). Use one of the two entries below, not both.

### Published package (released features)

```toml
[mcp_servers.swfte]
command = "npx"
args = ["-y", "@swfte/mcp-server"]
# Forward these variables from the shell that starts Codex. Their values never live in this file.
env_vars = ["SWFTE_PAT", "SWFTE_API_KEY", "SWFTE_BASE_URL", "SWFTE_WORKSPACE_ID", "SWFTE_TOOLS", "SWFTE_TELEMETRY"]
startup_timeout_sec = 30
tool_timeout_sec = 600
enabled_tools = ["swfte_whoami", "swfte_composition_classify", "swfte_find_existing", "swfte_get_context", "swfte_recipes_search", "swfte_recipes_get", "swfte_report_outcome", "swfte_propose_rule"]
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
enabled_tools = ["swfte_whoami", "swfte_composition_classify", "swfte_find_existing", "swfte_get_context", "swfte_recipes_search", "swfte_recipes_get", "swfte_report_outcome", "swfte_propose_rule"]
```

`tool_timeout_sec` is generous because build and deploy tools wait on the platform. Codex also has
`codex mcp add`, but its `--env KEY=VALUE` flag writes the value into `config.toml`, so do not use it for
the credential.

The explicit tool list above permits inspection and human-review reports. Add mutation tools only for a
specific authorized task. Build and deploy tools can incur costs; this setup creates no Lab schedule.

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
  (the default groups plus `learning`) before starting Codex. The authenticated backend must also return
  `mcp: true` from `/v2/learning/capabilities`; missing, malformed and unavailable capabilities deny
  learning tools, resources and prompts. Shipped backend flags remain off. Tracing needs no group:
  every ordinary tool call carries its trace headers and trailer either way.

## 3. What every tool call carries

Each Swfte tool call has one correlation trace. When records are enabled and workspace consent permits
recording, its attempts form one work-record step. For every backend request a call makes, the server
sends:

- `traceparent`: a W3C trace context. The trace id is fresh for each tool call; a retry or a sub-request
  of the same call keeps the trace id and gets a new span id.
- `X-Swfte-Mcp-Session`: one id per MCP server session (one per Codex process for the stdio server).
- `X-Swfte-Mcp-Client`: the host, from the MCP `initialize` handshake, reduced to `claude-code`, `codex`,
  `cursor` or `other`. For example, `codex-mcp-client` is sent as `codex`; any name beginning with
  `codex` is reduced the same way. An unrecognized host remains
  `other`. The raw client name is never sent.
- `X-Swfte-Mcp-Tool`: the tool name, e.g. `swfte_whoami`.

A call that makes no backend request (for example `swfte_composition_classify`, or a call refused for
invalid input) is posted as a local step to `POST /v2/learning/records/steps`. When the backend cannot be
reached, the attempt waits in a bounded in-memory queue (200 steps, oldest dropped first) and is posted as
an `UNREACHED` step on the next successful contact. A client deadline queues `CLIENT_TIMEOUT`: it does
not assert that a mutation failed or never reached the backend. Temporary ingest refusals retain the same
trace/span for later redelivery, without automatic mutation retry. Steps hold argument names and JSON types only, never
values; connection and secret handles appear as the type `handle`. `SWFTE_TELEMETRY=0` turns local steps
off; the headers above are still sent.

## 4. The trace trailer

Every Swfte tool result, success or error, ends with one extra text item, always the last one:

```text
swfte-trace: 4bf92f3577b34da6a3ce929d0e0e4736
```

It is exactly `swfte-trace: ` followed by 32 lowercase hex characters. The same id is in the result's
`_meta` under the key `swfte/traceId`. It is the id generated for this tool call. A matching backend echo
confirms correlation; a malformed or different echo cannot replace the id. Neither echo nor trailer
authorizes an outcome, proves sandbox execution, or grants cross-workspace access.

Why a text line as well as `_meta`: hosts do not reliably pass `_meta` on to hooks, transcripts or
wrappers, while the result text always survives. A hook, a Nexus session or a person reading the
transcript can join the call to its work record from that line alone. Parse it structurally, as the last
text item matching `^swfte-trace: ([0-9a-f]{32})$`, and do not strip it from results you forward.

## 5. Verify the join, step by step

1. Use an owner-approved development backend whose `/v2/learning/capabilities` returns `records: true`
   and whose workspace consent permits recording (`private` by default). This verification does not
   turn any flag on. Start Codex with `SWFTE_PAT` supplied, and confirm the server is registered:
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
   jq -e --arg t "$TRACE" '[.items[] | select(any(.steps[]; .traceId == $t))]
     | if length == 1 then .[0] | {record: .id, channel, client, step: (.steps[] | select(.traceId == $t))}
       else error("expected exactly one owned record") end' records.json
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

The MCP tests use the real SDK/client against HTTP or fetch fixtures. Passing them verifies protocol
behavior, not a production backend join. The manual check above verifies an owned runtime record;
successful execution still requires canonical backend execution and proof. `swfte_report_outcome` and
`swfte_propose_rule` remain pending human-review reports and never count as evidence. Cross-tenant
knowledge needs a fresh independent sandbox replay and strict secret scan.

## 6. Manual noninteractive invocation

For an explicitly authorized task that needs repository edits, use an explicit sandbox and JSONL
output as documented in [official noninteractive mode](https://developers.openai.com/codex/noninteractive):

```sh
codex exec --json --sandbox workspace-write "Inspect the configured Swfte MCP tools and write a local report of the available learning gates."
```

The example is a manual invocation. It installs no schedule, enables no Lab or Nexus ingestion, and
does not bypass MCP or backend authorization. No Codex model invocation was run as part of the fixture tests.
