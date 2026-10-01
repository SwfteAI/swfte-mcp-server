# Acme customer portal

Spring Boot 3.4 app on the Swfte Java SDK (`com.swfte:swfte-sdk:1.1.1`).

## Calling a workflow

```java
SwfteClient client = SwfteClient.builder().apiKey(System.getenv("SWFTE_API_KEY")).build();
WorkflowInvocation inv = client.workflows().invoke("wf_JvOrd1", Map.of("orderId", "o-1"));
AgentChatResponse reply = client.agents().chat("ag_JvSup1", "Where is my order?");
```

## Raw HTTP (legacy importer)

```java
rest.postForObject("https://api.swfte.com/agents/v2/workflows/wf_JvRisk4/invoke", body, Map.class);
```

## Embeds

```html
<iframe src="https://app.swfte.com/chat/ag_JvPortal"></iframe>
```

Configuration lives in `application.yml`; ids that change per deployment come from
`SWFTE_BILLING_WF`, `SWFTE_ESCALATION_AGENT_ID`, `SWFTE_SUPPORT_AGENT_ID` and `SWFTE_REPORT_WF`.
