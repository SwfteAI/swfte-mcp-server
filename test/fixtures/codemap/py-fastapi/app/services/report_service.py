"""Weekly revenue report."""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from app.swfte_sdk import get_client

log = logging.getLogger(__name__)

# Only used in log lines and the admin page; nothing is requested from it.
REPORT_DOCS = "https://api.swfte.com/agents/v2/workflows/wf_Rpt9Wk/invoke"


def archive(execution: Any) -> None:
    log.info("archived report run %s", getattr(execution, "id", "?"))


class ReportService:
    def __init__(self) -> None:
        self.client = get_client()

    def weekly(self, week: str, teams: List[str]) -> Dict[str, Any]:
        run = self.client.workflows.invoke_and_wait(
            "wf_Rpt9Wk",
            {"week": week, "teams": teams},
            timeout=600,
            poll_interval=5,
        )
        return {"headline": run.outputs["highlights"][0], "revenue": run.outputs["metrics"]["revenue"]}

    def dry_run(self, week: str) -> str:
        execution = self.client.workflows.execute("wf_Rpt9Wk", {"week": week, "testingFlag": True})
        return execution.status_raw

    def failures(self) -> List[str]:
        failed = []
        for ex in self.client.workflows.get_execution_history("wf_Rpt9Wk"):
            if ex.status_raw == "FAILED":
                failed.append(ex.id)
        return failed

    def run_and_archive(self, week: str) -> None:
        log.info("starting report, see %s", REPORT_DOCS)
        archive(self.client.workflows.invoke_and_wait("wf_Rpt9Wk", {"week": week}))
