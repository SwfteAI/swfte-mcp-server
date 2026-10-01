"""Operator CLI: replays normalisation batches against the draft workflow."""
from __future__ import annotations

from typing import Any, Dict, List

from app.swfte_sdk import get_client


class Replayer:
    def __init__(self) -> None:
        self.client = get_client()
        self.greeting = self.client.agents.chat("ag_Ops3Bt", "replayer starting", user_id="replayer").response

    def replay(self, rows: List[Dict[str, Any]]) -> str:
        execution = self.client.workflows.execute("wf_Nrm1Dt", {"rows": rows, "testingFlag": True}, skip_validation=True)
        return execution.status_raw

    def replay_all(self, batches: List[List[Dict[str, Any]]]) -> List[Any]:
        def send(batch: List[Dict[str, Any]]) -> Any:
            return self.client.workflows.invoke("wf_Nrm1Dt", {"rows": batch})

        return [send(b) for b in batches]
