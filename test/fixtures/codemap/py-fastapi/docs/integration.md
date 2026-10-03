# Swfte integration notes

The app talks to Swfte in three ways. New code should use the generated clients in
`app/swfte_clients/` (see `swfte.json`).

## Generated client

```python
from app.swfte_clients.lead_scoring import invoke_lead_scoring

res = invoke_lead_scoring({"company": "Acme", "domain": "acme.test"})
print(res["output"]["tier"])
```

## SDK

```python
from swfte import SwfteClient

client = SwfteClient()
client.workflows.invoke("wf_Onb2Rd", {"accountId": "a-1", "plan": "pro"})
client.agents.chat("ag_Sales6", "Which plan fits a 40-person team?", user_id="docs")
```

## Raw HTTP (legacy)

```python
requests.post("https://api.swfte.com/agents/v2/workflows/wf_Rpt9Wk/invoke", json={"week": "2026-W39"})
```

## Widget

```html
<iframe src="https://app.swfte.com/chat/ag_Portal7"></iframe>
```
