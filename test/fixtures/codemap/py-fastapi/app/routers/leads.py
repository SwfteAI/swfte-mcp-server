from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter
from pydantic import BaseModel

from app.swfte_clients.lead_scoring import invoke_lead_scoring
from app.swfte_sdk import get_client

router = APIRouter(prefix="/leads", tags=["leads"])


class LeadIn(BaseModel):
    company: str
    domain: str


@router.post("/score")
def score(body: LeadIn) -> Dict[str, Any]:
    res = invoke_lead_scoring({"company": body.company, "domain": body.domain})
    return {"score": res["output"]["score"]}


@router.post("/{lead_id}/enrich")
async def enrich_lead(lead_id: str, body: LeadIn) -> Dict[str, str]:
    invocation = get_client().workflows.invoke("wf_Enr4Ch", {"domain": body.domain, "leadId": lead_id})
    return {"executionId": invocation.execution_id}
