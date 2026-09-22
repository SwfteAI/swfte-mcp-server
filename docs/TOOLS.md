# Tool reference

`@swfte/mcp-server` exposes **230 tools**, of which a curated **103** are
advertised by default. See [ATTACH.md](ATTACH.md) for `SWFTE_TOOLS`.

Tools that take a `workspaceId` only honour it for **API-key** credentials. A
PAT carries its own workspace binding, injected server-side, and any value sent
alongside it is overridden.

---

## Studio as source of truth (core)

| Tool | Method | Path |
|---|---|---|
| `swfte_find_existing` | GET | `/v2/catalog/search` |
| `swfte_get_context` | GET | `/v2/catalog/{kind}/{id}` + `/v2/catalog/{kind}/{id}/contract` |
| `swfte_get_evidence` | GET | `/v2/catalog/{kind}/{id}` |
| `swfte_trace_dependencies` | GET | `/v2/catalog/{kind}/{id}` (+ the artifact's own record; upstream scans `/v2/catalog/search`) |
| `swfte_scaffold_client` | GET | `/v2/catalog/{kind}/{id}` + `/contract` — writes locally |
| `swfte_embed_widget` | GET | `/v2/catalog/{kind}/{id}/contract` — writes locally |
| `swfte_request_approval` | POST | `/v2/actions` |
| `swfte_execute_approved_action` | POST | `/v2/actions/{id}/execute` |
| `swfte_get_action_status` | GET | `/v2/actions/{id}` · `/v2/actions?status=` |
| `swfte_wire_analytics` | POST/GET | `/v2/actions` (analytics.enable) → `/v2/actions/{id}/execute` — writes locally |
| `swfte_wire_payments` | POST/GET | `/v2/actions` (app.payments.enable) → `/v2/actions/{id}/execute` — writes locally |
| `swfte_fit_check` | POST | `/v2/catalog/{kind}/{id}/fit` — `{problem, stack}`; stack detected from the local project when omitted |
| `swfte_adopt` | POST | `/v2/catalog/{kind}/{id}/adopt` — `{name?, tailoring?:{problem, stack, notes}, deploy?:{environment}}`; a deploy comes back PROPOSED, never executed |
| `swfte_get_timeline` | GET | `/v2/catalog/{kind}/{id}/timeline` |
| `swfte_sync` | GET | `/v2/catalog/{kind}/{id}` + `/contract` per swfte.json entry, `/v2/catalog/upgrades` — rewrites generated clients locally (= `swfte sync` / `swfte upgrade`) |
| `swfte_check_upgrades` | GET | `/v2/catalog/upgrades?refs=<catalogRef:contractHash>,…` + local drift check (= `swfte verify`) |

`swfte_scaffold_client` detects the framework (Next.js, Express, FastAPI, or a
plain TypeScript/Python client), writes the typed client plus an adapter, and
pins it in the repo-root `swfte.json` v1. `swfte_find_existing` and
`swfte_get_context` carry each entry's provenance (author, why, forkedFrom,
licence) and evidence split into independent workspaces, success-rate interval
and freshness, with a fork's `parentEvidence` kept apart. The CLI that shares
this code is described in the README, "Bake it into your codebase".

### Opt-in `extras` group

Three convenience variants of advertised tools sit outside the default surface
(`SWFTE_TOOLS=…,extras` brings them back): `swfte_workflows_executions_list`
(same endpoint as `swfte_workflows_executions`),
`swfte_workflows_deployment_status_simple` (a subset of
`swfte_workflows_deployment_status`) and `swfte_deployments_count` (a subset of
`swfte_deployments_list`).

## Agents — `swfte_agents_*`

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

### Agent mail — `swfte_agent_mail_*` (group `agent-mail`)

`mailboxes_list` · `mailbox_get` · `mailbox_create` · `mailbox_bind` ·
`mailbox_deactivate` · `messages_list` · `send`. Hidden by default; enable with
`SWFTE_TOOLS=…,agent-mail` or `all`.

`mailbox_create` is an ensure-exists: a `409 mailbox_conflict` means the
`localPart` is taken, so the existing mailbox is looked up and returned rather
than reported as a failure. It does **not** update the name or agent binding of
a mailbox it found — `mailbox_bind` does that, and `agentId: null` clears a
binding. The address is minted from `localPart` and is immutable.

`mailbox_deactivate` stops routing and stamps `deactivatedAt`. Stored messages
are kept and stay listable; the address is not released, and there is no
reactivate call. It is flagged destructive and requires `confirm: true`.

Two properties of this group are not shared by any other:

- **`messages_list` returns untrusted external content.** Senders, subjects and
  bodies were written by people outside the workspace. The result is wrapped in
  an envelope carrying `untrustedContent: true` and an advisory, so the content
  and the warning cannot be separated when a client renders it. Text inside a
  message asking the model to send mail or call a tool is part of the message.
- **`send` reaches real people.** `accepted` means the provider took the
  request — not that anything was delivered, that the address exists, or that
  anyone read it. The `Idempotency-Key` is derived from mailbox + recipient +
  subject + body, so a deliberate retry cannot email someone twice, and the call
  is never auto-retried. A `workspaceId` argument that disagrees with the
  server's configured workspace is refused rather than sent.

Agent binding resolves only against a monolith deployment. A standalone mail
host has no agent registry, so any `agentId` returns `404 agent_not_found`
there; these tools attach that explanation to the error rather than leaving it
indistinguishable from a typo.

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
