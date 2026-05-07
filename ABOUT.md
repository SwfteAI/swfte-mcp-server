# About Swfte

[**Swfte**](https://www.swfte.com) is the unified AI infrastructure platform for teams who want to ship intelligent products without owning the plumbing. Through a single API and a single billing relationship, Swfte gives engineering teams access to **200+ frontier and open-source models** from OpenAI, Anthropic, Google Vertex AI, Mistral, Meta Llama, HuggingFace, and self-hosted GPU deployments — alongside a complete toolkit for **agents, multi-step workflows, conversational chat-flows, retrieval-augmented generation (RAG), tool calling, voice telephony, and Model Context Protocol (MCP) servers**.

We exist to remove the four taxes that slow AI teams down — **provider lock-in**, **glue code between LLM, RAG, agents, and voice**, **observability fragmentation**, and **cost unpredictability** — so your team can spend its cycles on the product, not the platform.

> Visit **[swfte.com](https://www.swfte.com)** to learn more, sign up for a free workspace, or talk to our team.

---

## What Swfte Does

Swfte is one platform with one API. Each capability is composable and reachable through the [Swfte API](https://www.swfte.com/developers); every endpoint is documented at [swfte.com/resources](https://www.swfte.com/resources).

| Capability | What it solves |
|---|---|
| **[Gateway](https://www.swfte.com/products/gateway)** | One model-agnostic API for chat completions, embeddings, image generation, audio transcription, and text-to-speech across 200+ models. Provider-agnostic routing, automatic fail-over, observability and cost tracking out of the box. |
| **[Agents](https://www.swfte.com/products/agents)** | Production-grade stateful agents with tool calling, knowledge bases, conversation memory, capability tiers, and persona A/B testing. |
| **[Workflows](https://www.swfte.com/products/workflows)** | Durable DAG execution with LLM, HTTP, tool, condition, loop, and human-in-the-loop nodes. Manual, scheduled, and webhook triggers. |
| **[ChatFlows](https://www.swfte.com/products/chatflows)** | Conversational form runtime — onboarding, lead-qualification, support, surveys — with field extraction, validation, branching, and multi-channel delivery (web, WhatsApp, Telegram, voice). |
| **[RAG & Knowledge](https://www.swfte.com/products/rag)** | Datasets, documents, hybrid retrieval, rerankers, custom vocabulary, and segment-level citations. |
| **[Voice](https://www.swfte.com/products/voice)** | Outbound and inbound voice agents on Twilio and WebRTC, sub-500 ms time-to-first-byte, recordings, transcripts, and full audit trails. |
| **[MCP Servers](https://www.swfte.com/products/mcp)** | Host or connect Model Context Protocol servers, dynamic tool discovery, batch execution, analytics, and managed deployment to Lambda or Fargate. |
| **[Modules & Marketplace](https://www.swfte.com/marketplace)** | Bundle agents, workflows, and tools as reusable modules. Publish, version, and install across workspaces in one click. |
| **[Cost Control](https://www.swfte.com/products/cost-control)** | Per-workspace and per-model usage caps, routing rules, and autoscaling for self-hosted deployments. |
| **[Audit & Compliance](https://www.swfte.com/products/security)** | Every action recorded, exportable, and queryable. SOC 2 in progress. |

---

## Why this MCP server exists

The [Model Context Protocol](https://modelcontextprotocol.io) is the open standard for connecting LLM-driven clients (Claude Desktop, Claude Code, Cursor, Cline, Zed, Smithery, …) to backend tools. By publishing `@swfte/mcp-server`, we make every Swfte API surface a first-class tool inside any of those clients — so agents can manage their own infrastructure, RAG pipelines can be built by chatting, and developers can debug voice deployments without leaving their editor.

Read more about how Swfte uses MCP at [swfte.com/products/mcp](https://www.swfte.com/products/mcp).

---

## Try Swfte

- **Sign up:** [swfte.com](https://www.swfte.com) — free tier, no credit card.
- **Read the docs:** [swfte.com/resources](https://www.swfte.com/resources) — guides, cookbooks, recipes.
- **Browse the API:** [swfte.com/developers](https://www.swfte.com/developers) — every endpoint, every model.
- **See pricing:** [swfte.com/pricing](https://www.swfte.com/pricing) — pay-as-you-go, transparent per-token + per-second compute.
- **Talk to us:** [swfte.com/contact](https://www.swfte.com/contact) — book a 30-minute architecture call with an engineer.
- **Security:** [swfte.com/security](https://www.swfte.com/security) — security posture, data handling, compliance.

---

## Open Source

| Repo | Language | What |
|---|---|---|
| [swfte-mcp-server](https://github.com/SwfteAI/swfte-mcp-server) | TypeScript | This package — official MCP server for the Swfte API. |
| [swfte-python](https://github.com/SwfteAI/swfte-python) | Python | Official Python SDK. |
| [swfte-node](https://github.com/SwfteAI/swfte-node) | TypeScript | Official Node SDK. |
| [swfte-java](https://github.com/SwfteAI/swfte-java) | Java | Official Java SDK. |
| [swfte-chat-widget](https://github.com/SwfteAI/swfte-chat-widget) | TypeScript | Embeddable chat bubble + AI search widget. |
| [swfte-chatflow-widget](https://github.com/SwfteAI/swfte-chatflow-widget) | TypeScript | Embeddable conversational-form widget. |

---

## Company

- **Founded:** 2024
- **Headquarters:** Remote-first, registered in the United Kingdom
- **Product home:** [swfte.com](https://www.swfte.com)
- **Open source:** [github.com/SwfteAI](https://github.com/SwfteAI)
- **Status & uptime:** [status.swfte.com](https://status.swfte.com)

Swfte is an independent company. The platform is built and operated by a small, focused team of AI infrastructure engineers across the UK and Europe. We are not affiliated with any model provider — we route to all of them.

---

## Contact

- **Sales & enterprise:** [sales@swfte.com](mailto:sales@swfte.com)
- **Developer support:** [developers@swfte.com](mailto:developers@swfte.com) · [swfte.com/developers](https://www.swfte.com/developers)
- **Security disclosure:** [security@swfte.com](mailto:security@swfte.com)
- **General:** [hello@swfte.com](mailto:hello@swfte.com)
- **Website:** [https://www.swfte.com](https://www.swfte.com)

---

*Last updated: 2026-05 · Copyright © 2024-2026 Swfte, Inc. All rights reserved.*
