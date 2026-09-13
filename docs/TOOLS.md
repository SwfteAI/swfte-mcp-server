# Tool reference

`@swfte/mcp-server` exposes **183 tools**, of which a curated **96** are
advertised by default. See [ATTACH.md](ATTACH.md) for `SWFTE_TOOLS`.

Tools that take a `workspaceId` only honour it for **API-key** credentials. A
PAT carries its own workspace binding, injected server-side, and any value sent
alongside it is overridden.

---

## Core — the reason to attach this server

These take a `kind` discriminator (`workflow`, `agent`, `chatflow`, `widget`,
`application`, `mcp-server`, `module`, `model`) and dispatch through a per-kind adapter, so the
same eleven tools cover every artifact type.

| Tool | What it does |
|---|---|
| `swfte_whoami` | Resolve identity, workspace, credential kind, entitlements. **Call first.** |
| `swfte_build` | Description → artifact. Starts the wizard, polls to completion, returns the artifact plus its coverage report and process trail. Returns a resumable `sessionId` rather than failing if it outruns `waitMs`. |
| `swfte_build_status` | Resume polling a long build. |
| `swfte_build_steer` | Redirect a build mid-flight. |
| `swfte_validate` | Validate without persisting. |
| `swfte_create` | Persist. A `422` returns structured findings, not an opaque error. |
| `swfte_refine` | Iterate with plain-language feedback. |
| `swfte_run` | Execute to terminal, with per-node traces. |
| `swfte_deploy` | Preview / deploy / teardown. **Previews by default**, and gated on preflight for workflows. |
| `swfte_verify` | Kind-appropriate assertion sweep — "does this actually work?" |
| `swfte_verify_batch` | The same, over up to 25 artifacts. |
| `swfte_preflight` | 28 rules over a whole solution, each a way the platform reports success while doing nothing. Read-only. |
| `swfte_preflight_manifest` | Derive preflight's input from an id registry, a spec, or seed ids. |
| `swfte_publish` | `POST /v2/workflows/{id}/publish`, refused unless preflight passes. |

### What `swfte_preflight` checks, and why it is separate

`swfte_verify` asks whether one artifact is sound. `swfte_solution_verify` asks
whether a set of artifacts forms the solution it claims to be. Preflight asks
the third question neither can: whether this solution has walked into one of the
platform's known silent-failure modes — a `{{node.field}}` reference to a code
node that files that field under `.result`; `rows` handed in as an object so
templates never resolve; a `DATA_TABLE` filter carrying `{{…}}` the executor
never resolves; a templated table name that get-or-creates a brand-new empty
table; an execution header that disagrees with its own traces; an output over
the size guard that empties the variable pool downstream; a dataset reporting
`COMPLETED` over zero segments; an `AGENTIC` agent whose only knowledge
retrieves nothing, so it answers with an empty string.

None of these fail a structural check. All of them ship.

Every rule has been shown to fail under a deliberate mutation
(`npm run preflight:mutation`, currently `28 rules · 73/73 · 0 broken`). A rule
no mutation can kill is reported BROKEN there rather than counted as passing.

A rule that cannot run reports **skip**, and a skip is never a pass. See
[PUBLISH-GATE.md](./PUBLISH-GATE.md) for the gate, its three verdicts, and the
two overrides.

### What `swfte_verify` checks

**Workflow** — persisted · graph soundness (unwired nodes, edges pointing at
non-existent ids) · no plaintext credentials in node config · published · executes ·
per-node traces (including nodes that report success while producing nothing).

**Agent** — persisted · not half-created (a record with no model and
`agentType: NONE_SELECTED` is immutable and can only be deleted) · capability tier
high enough for its attached tools and for session memory · knowledge linked ·
prompt precedence unambiguous · responds.

**Chatflow** — persisted · has collected fields · goal config · published.

**Widget** — persisted · bound to a backing brain · deployed · embed snippet fetchable.

**Application** — persisted · hosted · the deployed URL actually answers.

**MCP server** — artifact exists · defines tools · builds.

### Kind support matrix

| | build | steer | validate | create | refine | run | deploy | verify |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| workflow | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| agent | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| chatflow | ✓ | ✓ | ✓ | auto | ✓ | — | — | ✓ |
| widget | ✓ | — | — | auto | — | — | ✓ | ✓ |
| application | ✓ | — | — | ✓ | — | — | ✓ | ✓ |
| mcp-server | ✓ | ✓ | ✓ | — | — | — | ✓ | ✓ |
| module | ✓ | — | — | auto | — | ✓ | — | ✓ |
| model | — | — | — | — | — | ✓ | ✓ | ✓ |

"auto" means the wizard persists during generation, so no separate create is
needed. Gaps are real backend differences, not unfinished work — calling an
unsupported verb returns an explanation rather than a generic failure.

Two kinds work differently enough to call out:

- **`module`** is assembled from resources rather than written from a
  description. `swfte_build` creates the module and starts a build; attach
  documents first or it compiles with nothing in it. `swfte_run` queries it.
- **`model`** has no `build` at all — model-vault models are *uploaded*, and a
  multi-part weights upload is not something to drive through a chat turn. Get
  weights in via Studio → Model Vault, then deploy, probe, and verify here.
  Serving is GPU-backed and bills while running, so `swfte_verify` reminds you
  to tear it down.

`custom-node` is declared but not implemented: its wizard is SSE-only with no
async+poll pair, so it needs a different transport from every other kind.
Calling it reports that plainly rather than half-working.

---

## Domain tools

### Agents — `swfte_agents_*` (group `agents`)

| Tool | Endpoint | Note |
|---|---|---|
| `swfte_agents_list` | `GET /v1/agents` | Auto-paginates; page size is capped at 20 server-side |
| `swfte_agents_get` | `GET /v2/agents/{id}` | |
| `swfte_agents_create` | `POST /v2/agents` | |
| `swfte_agents_update` | `GET`+`PUT /v1/agents/{id}` | Read-merge-write: the raw PATCH replaces the record |
| `swfte_agents_delete` | `DELETE /v2/agents/{id}` | |
| `swfte_agents_chat` | `POST /v1/agents/{id}/chat/{userId}` | Prefer `swfte_run` |
| `swfte_agents_link_tools` | `POST /v2/agents/wizard/link-tools` | |
| `swfte_agents_link_knowledge` | `POST /v2/agents/wizard/link-knowledge` | |
| `swfte_agents_wizard_quick` | `POST /v2/agents/wizard/quick` | Generates AND persists, no review step |
| `swfte_agents_wizard_templates` | `GET /v2/agents/wizard/templates` | |
| `swfte_agents_types` | `GET .../agent-types` + `/providers` | |

### Workflows — `swfte_workflows_*` (group `workflows`)

`list` · `get` · `create` · `validate` · `clone` · `export`. Build, run, and
deploy go through the core tools.

### ChatFlows — `swfte_chatflows_*` (group `chatflows`)

`list` · `get` · `create` · `validate` · `deploy` · `publish` ·
`session_start` · `session_get` · `builder_templates`.

### A/B experiments — `swfte_experiments_*` (group `experiments`)

`list` · `get` · `create` · `update` · `start` · `assign` · `record_outcome` ·
`summary` · `decide` · `delete`.

Lifecycle is `DRAFT → RUNNING → DECIDED → ARCHIVED` and is enforced server-side.
`assign` returning **404 means the experiment is not RUNNING** — the caller
should serve the current version, which is normal rather than an error.
`decide` records a decision; it does not judge significance.

### Analytics — `swfte_analytics_*` (group `analytics`)

Workspace: `workspace_usage` · `workspace_costs` · `workspace_models` ·
`timeseries` · `top_consumers`.
Agent: `agent` · `agent_tools` · `agent_conversations` · `agent_realtime` ·
`prompt_summary`.
Enterprise: `anomalies` · `cost_analysis` · `forecast`.

`swfte_analytics_agent_tools` is the direct way to confirm an agent really
invokes its tools rather than describing them.

### OAuth connect — `swfte_connect_*` (group `connect`)

`start` · `wait` · `status`. Consent is browser-interactive, so `start` returns
an `authorizationUrl` for the user to open and `wait` polls for the resulting
`secretId`.

### Deployments — `swfte_deployments_*` (group `deployments`)

`list` · `get` · `for_agent` · `trail` · `executions` · `activate` ·
`terminate` · `count`. `trail` is where to look when a deployment reaches
`FAILED`.

### Everything else

`datasets` · `modules` · `rag` · `voice` · `marketplace` · `files` ·
`conversations` · `audit` · `cost` · `mcp` — CRUD and query tools, hidden by
default. Enable with `SWFTE_TOOLS=all` or by naming the group.

---

## Error envelopes

Failures come back as structured JSON, not prose, so they can be branched on:

```json
{
  "error": true,
  "code": "SUBSCRIPTION_REQUIRED",
  "status": 402,
  "message": "…",
  "request": "POST /v2/workflows/wf_1/deploy",
  "suggestedAction": "Running and deploying require an active subscription. Building and exporting stay free."
}
```

Codes worth knowing: `PAYMENT_METHOD_REQUIRED`, `SUBSCRIPTION_REQUIRED`,
`QUOTA_EXCEEDED`, `VALIDATION_FAILED`, `WORKFLOW_NOT_PUBLISHED` (handled
automatically by `swfte_run`), `pat_invalid`.

A `degraded: true` on a run result means the backend load-shed — retry rather
than changing the artifact.
