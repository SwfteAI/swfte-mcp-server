from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Request

from app.swfte_sdk import get_client

router = APIRouter(prefix="/hooks", tags=["hooks"])


@router.post("/crm")
async def crm_event(request: Request) -> Dict[str, str]:
    payload: Dict[str, Any] = await request.json()
    invocation = get_client().workflows.invoke("wf_Aud1Lg", {"event": payload["event"], "actor": payload.get("actor", "crm")})
    return {"executionId": invocation.execution_id}
