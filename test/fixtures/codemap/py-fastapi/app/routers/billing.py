from __future__ import annotations

from typing import Dict

from fastapi import APIRouter

from app.swfte_sdk import get_client

router = APIRouter(prefix="/billing", tags=["billing"])


@router.post("/invoices/{invoice_id}/charge")
def charge(invoice_id: str, amount: float) -> Dict[str, str]:
    invocation = get_client().workflows.invoke("wf_Bil6Rn", {"invoiceId": invoice_id, "amount": amount})
    return {"executionId": invocation.execution_id}


@router.post("/invoices/{invoice_id}/charge-sync")
def charge_and_wait(invoice_id: str) -> Dict[str, bool]:
    done = get_client().workflows.invoke_and_wait("wf_Bil6Rn", {"invoiceId": invoice_id}, timeout=90)
    return {"paid": bool(done.outputs["paid"])}
