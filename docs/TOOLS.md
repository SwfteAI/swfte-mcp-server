# Tool reference

`@swfte/mcp-server` exposes **119 tools**, of which a curated **69** are
advertised by default. See [ATTACH.md](ATTACH.md) for `SWFTE_TOOLS`.

Tools that take a `workspaceId` only honour it for **API-key** credentials. A
PAT carries its own workspace binding, injected server-side, and any value sent
alongside it is overridden.

---

| Tool | Method | Path |
|---|---|---|
| `swfte_agents_list` | GET | `/v2/agents` |
| `swfte_agents_get` | GET | `/v2/agents/{agentId}` |
| `swfte_agents_create` | POST | `/v2/agents` |
| `swfte_agents_update` | PATCH | `/v2/agents/{agentId}` |
| `swfte_agents_delete` | DELETE | `/v2/agents/{agentId}` |
| `swfte_agents_wizard_generate` | POST | `/v2/agents/wizard/generate` |
| `swfte_agents_wizard_quick` | POST | `/v2/agents/wizard/quick` |
| `swfte_agents_wizard_templates` | GET | `/v2/agents/wizard/templates` |
| `swfte_agents_find` | GET | `/v1/agents` |

## ChatFlows — `swfte_chatflows_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_chatflows_list` | GET | `/v2/chatflows` |
| `swfte_chatflows_get` | GET | `/v2/chatflows/{id}` |
| `swfte_chatflows_create` | POST | `/v2/chatflows` |
| `swfte_chatflows_validate` | POST | `/v2/chatflows/{id}/validate` |
| `swfte_chatflows_deploy` | POST | `/v2/chatflows/{id}/deploy` |
| `swfte_chatflows_publish` | POST | `/v2/chatflows/{id}/publish` |
| `swfte_chatflows_session_start` | POST | `/v2/chatflows/{id}/sessions` |
| `swfte_chatflows_session_get` | GET | `/v2/chatflows/sessions/{sessionId}` |
| `swfte_chatflows_builder_templates` | GET | `/v2/chatflows/builder/templates` |

## Workflows — `swfte_workflows_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_workflows_list` | GET | `/v2/workflows` |
| `swfte_workflows_get` | GET | `/v2/workflows/{workflowId}` |
| `swfte_workflows_create` | POST | `/v2/workflows` |
| `swfte_workflows_validate` | POST | `/v2/workflows/validate` |
| `swfte_workflows_clone` | POST | `/v2/workflows/{workflowId}/clone` |
| `swfte_workflows_export` | GET | `/v2/workflows/{workflowId}/export` |
| `swfte_workflows_publish` | POST | `/v2/workflows/{workflowId}/publish` |
| `swfte_workflows_deployment_status` | GET | `/v2/workflows/{workflowId}/deployment-status` |
| `swfte_workflows_deployment_status_simple` | GET | `/v2/workflows/{workflowId}/deployment-status/simple` |
| `swfte_workflows_pre_deploy` | POST | `/v2/workflows/{workflowId}/pre-deploy` |
| `swfte_workflows_execute` | POST | `/v2/workflows/{workflowId}/execute` |
| `swfte_workflows_executions_list` | GET | `/v2/workflows/{workflowId}/executions` |
| `swfte_workflows_execution_status` | GET | `/v2/workflows/executions/{executionId}/status` |
| `swfte_workflows_execution_traces` | GET | `/v2/workflows/executions/{executionId}/traces` |
| `swfte_workflows_execution_pause` | POST | `/v2/workflows/executions/{executionId}/pause` |
| `swfte_workflows_execution_resume` | POST | `/v2/workflows/executions/{executionId}/resume` |
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
| `swfte_deploy` | Preview / deploy / teardown. **Previews by default.** |
| `swfte_verify` | Kind-appropriate assertion sweep — "does this actually work?" |
| `swfte_verify_batch` | The same, over up to 25 artifacts. |

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

## Journeys — `swfte_journeys_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_journeys_list` | GET | `/v2/journey-templates` |
| `swfte_journeys_get` | GET | `/v2/journey-templates/{id}` |
| `swfte_journeys_create` | POST | `/v2/journey-templates` |
| `swfte_journeys_update` | PUT | `/v2/journey-templates/{id}` |
| `swfte_journeys_delete` | DELETE | `/v2/journey-templates/{id}` |
| `swfte_journeys_generate` | POST | `/v2/journey-templates/generate` |
| `swfte_journeys_deploy` | POST | `/v2/relay/journeys/{journeyTemplateId}/deploy` |
| `swfte_journeys_run` | POST | `/v2/relay/journeys/{journeyTemplateId}/run` |
| `swfte_journeys_test` | POST | `/v2/relay/journeys/{journeyTemplateId}/test` |
| `swfte_journeys_app_deploy` | POST | `/v2/applications/{moduleId}/deploy` |
| `swfte_journeys_app_deployments_list` | GET | `/v2/applications/{moduleId}/deploy` |

A journey template's `definitionJson.segments[]` entries are discriminated by `kind`: `NODE` (deterministic integration call), `BRANCH` (boolean fork with `whenTrue`/`whenFalse`), `SWITCH` (multi-way fork via `cases`/`fallback`), `AGENT_OBJECTIVE` (LLM step with `responseOutputs` field extraction), and `HUMAN_ACCOUNTABLE` (human gate with `assignee`/`branches`).

## Relay Runs — `swfte_relay_runs_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_relay_runs_list` | GET | `/v1/relay/runs` |
| `swfte_relay_runs_get` | GET | `/v1/relay/runs/{runId}` |
| `swfte_relay_runs_snapshot` | GET | `/v1/relay/runs/{runId}/snapshot` |
| `swfte_relay_runs_cancel` | POST | `/v1/relay/runs/{runId}/cancel` |
| `swfte_relay_runs_gate_decide` | POST | `/v1/relay/runs/{runId}/gate/{gateRequestId}` |

A "run" is any Relay-tracked unit of work — an agent chat, a journey's workflow execution, or a worker run — keyed by `kind`. Cancel and gate-decide require the relay-operator role.

## Relay Mailboxes — `swfte_relay_mailboxes_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_relay_mailboxes_get_profile` | GET | `/v2/mailbox/profile` |

There is no separate mailbox-binding CRUD resource on the API — an inbox is bound to a journey by setting its `definitionJson.trigger` to `{type:"email", email, secretId}` and deploying with `swfte_journeys_deploy`. This tool only resolves the real address behind a newly-connected Gmail `secretId` so you can populate that trigger correctly.

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
