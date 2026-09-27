"""Churn risk. Written before the shared client existed, so it builds its own."""
from __future__ import annotations

import os

from swfte import SwfteClient as S


def flag_customer(customer_id: str) -> str:
    return S().workflows.invoke("wf_Chn7Rs", {"customerId": customer_id}).execution_id


def risk_band(customer_id: str) -> str:
    sw = S(api_key=os.environ.get("SWFTE_API_KEY"))
    done = sw.workflows.invoke_and_wait("wf_Chn7Rs", {"customerId": customer_id, "window": "90d"})
    return str(done.outputs["risk"])


def retention_note(customer_id: str, note: str) -> str:
    return S().agents.chat("ag_Ret2Cx", note, user_id=customer_id).response
