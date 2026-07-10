# Tool reference

Every MCP tool exposed by `@swfte/mcp-server` and the underlying [Swfte](https://www.swfte.com) API endpoint it calls.

All tools accept an optional `workspaceId` field that overrides the `SWFTE_WORKSPACE_ID` env var.

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

## Conversations — `swfte_conversations_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_conversations_initiate` | POST | `/v2/conversations/initiate` |
| `swfte_conversations_list` | GET | `/v2/conversations` |
| `swfte_conversations_get` | GET | `/v2/conversations/{conversationId}` |
| `swfte_conversations_transcript` | GET | `/v2/conversations/{conversationId}/transcript` |
| `swfte_conversations_terminate` | POST | `/v2/conversations/{conversationId}/terminate` |

## Datasets — `swfte_datasets_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_datasets_list` | GET | `/api/v2/datasets` |
| `swfte_datasets_get` | GET | `/api/v2/datasets/{id}` |
| `swfte_datasets_create` | POST | `/api/v2/datasets` |
| `swfte_datasets_documents_list` | GET | `/api/v2/datasets/{id}/documents` |
| `swfte_datasets_documents_create` | POST | `/api/v2/datasets/{id}/documents` |
| `swfte_datasets_documents_status` | GET | `/api/v2/datasets/{id}/documents/processing-status` |

## Files — `swfte_files_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_files_list` | GET | `/api/v2/files` |
| `swfte_files_config` | GET | `/api/v2/files/config` |
| `swfte_files_get` | GET | `/api/v2/files/{id}` |
| `swfte_files_delete` | DELETE | `/api/v2/files/{id}` |

## RAG — `swfte_rag_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_rag_search` | POST | `/v2/rag/search` |
| `swfte_rag_rerank` | POST | `/v2/rag/rerank` |
| `swfte_rag_models_embeddings` | GET | `/v2/rag/models/embeddings` |
| `swfte_rag_models_rerankers` | GET | `/v2/rag/models/rerankers` |
| `swfte_rag_strategies` | GET | `/v2/rag/strategies` |

## MCP-on-MCP — `swfte_mcp_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_mcp_servers_list` | GET | `/api/v2/mcp/servers` |
| `swfte_mcp_servers_connect` | POST | `/api/v2/mcp/servers/connect` |
| `swfte_mcp_tools_list` | GET | `/api/v2/mcp/tools` |
| `swfte_mcp_tool_schema` | GET | `/api/v2/mcp/tools/{toolId}/schema` |
| `swfte_mcp_tool_execute` | POST | `/api/v2/mcp/tools/{toolId}/execute` |
| `swfte_mcp_health_check` | POST | `/api/v2/mcp/health-check` |

## Modules — `swfte_modules_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_modules_list` | GET | `/v2/modules` |
| `swfte_modules_get` | GET | `/v2/modules/{moduleId}` |
| `swfte_modules_create` | POST | `/v2/modules` |
| `swfte_modules_build` | POST | `/v2/modules/{moduleId}/build` |
| `swfte_modules_versions` | GET | `/v2/modules/{moduleId}/versions` |

## Marketplace — `swfte_marketplace_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_marketplace_browse` | GET | `/v2/marketplace` |
| `swfte_marketplace_get` | GET | `/v2/marketplace/{publicationId}` |
| `swfte_marketplace_install` | POST | `/v2/marketplace/{publicationId}/install` |
| `swfte_marketplace_installations` | GET | `/v2/marketplace/installations` |

## Voice — `swfte_voice_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_voice_calls_list` | GET | `/v2/voice/calls` |
| `swfte_voice_calls_in_progress` | GET | `/v2/voice/calls/in-progress` |
| `swfte_voice_call_get` | GET | `/v2/voice/calls/{callSid}` |
| `swfte_voice_call_transcript` | GET | `/v2/voice/calls/{callSid}/transcript` |
| `swfte_voice_call_recording` | GET | `/v2/voice/calls/{callSid}/recording` |

## Audit — `swfte_audit_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_audit_events` | GET | `/v2/audit/events` |
| `swfte_audit_resource_events` | GET | `/v2/audit/events/{resourceType}/{resourceId}` |
| `swfte_audit_my_events` | GET | `/v2/audit/events/me` |

## Cost Control — `swfte_cost_*`

| Tool | Method | Path |
|---|---|---|
| `swfte_cost_routing_rules_list` | GET | `/v2/cost-control/routing-rules` |
| `swfte_cost_routing_rule_create` | POST | `/v2/cost-control/routing-rules` |
| `swfte_cost_usage_caps_list` | GET | `/v2/cost-control/usage-caps` |
| `swfte_cost_usage_cap_workspace_set` | PUT | `/v2/cost-control/usage-caps/workspace` |
| `swfte_cost_usage_stats` | GET | `/v2/cost-control/usage-stats` |

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

Full API reference: [swfte.com/developers](https://www.swfte.com/developers).
