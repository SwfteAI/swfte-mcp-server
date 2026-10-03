"""Forwards audit events to the audit-log workflow."""
from __future__ import annotations

from typing import Any, Dict

import swfte

_client = None


def _sdk() -> "swfte.SwfteClient":
    global _client
    if _client is None:
        _client = swfte.SwfteClient()
    return _client


def record(event: Dict[str, Any]) -> str:
    # Old path, kept for reference until the migration finishes:
    # requests.post("https://api.swfte.com/agents/v2/workflows/wf_Aud1Lg/invoke", json=event)
    invocation = _sdk().workflows.invoke("wf_Aud1Lg", {"event": event["type"], "actor": event["actor"]})
    return invocation.execution_id


def record_login(user_id: str) -> None:
    swfte.SwfteClient().workflows.invoke("wf_Aud1Lg", {"event": "login", "actor": user_id})
