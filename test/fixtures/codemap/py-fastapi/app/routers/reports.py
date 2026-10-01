from __future__ import annotations

from typing import Dict, List

from fastapi import APIRouter

from app.swfte_sdk import get_client

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/runs")
def report_runs() -> List[Dict[str, str]]:
    runs = get_client().workflows.get_execution_history("wf_Rpt9Wk")
    return [{"id": r.id, "status": r.status_raw} for r in runs]


@router.post("/intake")
def open_intake() -> Dict[str, str]:
    get_client().chatflows.start_session("cf_Intake2")
    return {"status": "started"}
