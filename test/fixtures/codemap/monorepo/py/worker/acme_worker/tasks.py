"""Celery tasks that call Swfte."""
import os

import httpx
import requests
from celery import shared_task
from swfte import SwfteClient

from acme_worker.settings import settings
from acme_worker.swfte_clients.lead_enrich import invoke_lead_enrich

SWFTE_BASE = os.environ.get("SWFTE_BASE_URL", "https://api.swfte.com/agents")
ARCHIVE_KEY_ID = "__CANARY_aws__"

client = SwfteClient(api_key=os.environ["SWFTE_API_KEY"])


@shared_task
def enrich_lead(email: str, company: str = "") -> float:
    """Score one lead with the generated client."""
    result = invoke_lead_enrich({"email": email, "company": company})
    return result["output"]["score"]


@shared_task
def enrich_segment(email: str) -> str:
    result = invoke_lead_enrich({"email": email}, timeout_s=60)
    return result["output"]["firmographics"]["size"]


@shared_task
def draft_weekly(topic: str) -> str:
    invocation = client.workflows.invoke("wf_8K2mQ4", {"sources": ["https://acme.test/blog"], "topic": topic})
    return invocation.execution_id


@shared_task
def audit_site(url: str) -> int:
    done = client.workflows.invoke_and_wait("wf_Seo3Pz", {"url": url}, timeout=120, poll_interval=5)
    return len(done.outputs["issues"])


@shared_task
def invoice_failures() -> int:
    runs = client.workflows.get_execution_history("wf_Inv7Tr2")
    return sum(1 for r in runs if r.status == "FAILED")


@shared_task
def support_digest(text: str) -> str:
    reply = client.agents.chat("ag_Supp9x", text, user_id="worker")
    return reply.response


@shared_task
def backfill(topic: str) -> str:
    invocation = client.workflows.invoke(os.environ["SWFTE_BACKFILL_WORKFLOW_ID"], {"sources": [], "topic": topic})
    return invocation.execution_id


@shared_task
def nightly_digest() -> str:
    invocation = client.workflows.invoke(settings.digest_workflow_id, {"sources": [], "topic": "nightly"})
    return invocation.execution_id


@shared_task
def relay_lead(email: str) -> int:
    resp = httpx.post(f"{SWFTE_BASE}/v2/workflows/wf_Lead5Q/invoke", json={"email": email}, headers={"X-API-Key": os.environ["SWFTE_API_KEY"]})
    return resp.status_code


@shared_task
def translate(text: str, visitor_id: str) -> str:
    resp = requests.post(
        "https://api.swfte.com/agents/v1/public/agents/ag_Pub8Nq/chat",
        json={"message": text, "visitorId": visitor_id},
        headers={"X-Swfte-Embed-Key": os.environ.get("SWFTE_EMBED_KEY", "")},
        timeout=30,
    )
    return resp.json().get("content", "")


def archive_prefix() -> str:
    """Docstring example, never executed: client.workflows.invoke("wf_8K2mQ4", {"sources": [], "topic": "x"})."""
    return ARCHIVE_KEY_ID[:4]
