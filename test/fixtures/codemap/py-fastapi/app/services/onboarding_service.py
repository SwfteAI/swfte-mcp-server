"""Account onboarding. Tenants may point the welcome flow at their own workflow."""
from __future__ import annotations

import os
from typing import List

from app.settings import settings
from app.swfte_sdk import get_client

# Per-deployment digest workflow; empty in dev.
DIGEST_WF = os.environ.get("SWFTE_DIGEST_WF", "")


def start(account_id: str, plan: str) -> str:
    client = get_client()
    invocation = client.workflows.invoke("wf_Onb2Rd", {"accountId": account_id, "plan": plan})
    return invocation.execution_id


def start_trial(account_id: str) -> str:
    client = get_client()
    invocation = client.workflows.invoke("wf_Onb2Rd", inputs={"accountId": account_id, "trial": True})
    return invocation.execution_id


def onboarding_statuses() -> List[str]:
    return [run.status_raw for run in get_client().workflows.get_execution_history("wf_Onb2Rd")]


def start_custom(account_id: str) -> str:
    client = get_client()
    invocation = client.workflows.invoke(os.environ["SWFTE_ONBOARDING_WF"], {"accountId": account_id})
    return invocation.execution_id


def send_welcome(account_id: str, email: str) -> str:
    client = get_client()
    invocation = client.workflows.invoke(settings.welcome_workflow_id, {"accountId": account_id, "email": email})
    return invocation.execution_id


def send_digest(account_id: str) -> None:
    if DIGEST_WF:
        get_client().workflows.invoke(DIGEST_WF, {"accountId": account_id})
