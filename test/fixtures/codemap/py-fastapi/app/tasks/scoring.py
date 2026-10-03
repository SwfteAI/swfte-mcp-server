from __future__ import annotations

from typing import List

import requests
from celery import shared_task

from app.db import save_score
from app.swfte_clients.lead_scoring import invoke_lead_scoring
from app.swfte_sdk import get_client
from app.tasks.celery_app import celery_app


@celery_app.task(name="leads.score")
def score_lead_task(lead_id: str, company: str, domain: str) -> None:
    res = invoke_lead_scoring({"company": company, "domain": domain})
    save_score(lead_id, res["output"]["score"])


@shared_task(name="leads.enrich-nightly")
def nightly_enrich(domains: List[str]) -> int:
    client = get_client()
    for domain in domains:
        client.workflows.invoke("wf_Enr4Ch", {"domain": domain})
    return len(domains)


@celery_app.task(bind=True, max_retries=3, name="leads.refresh")
def refresh(self, lead_id: str, company: str, domain: str) -> str:
    try:
        return get_client().workflows.invoke("wf_Lead5Sc", {"company": company, "domain": domain, "leadId": lead_id}).execution_id
    except Exception as exc:  # pragma: no cover - retry path
        raise self.retry(exc=exc, countdown=60)


@shared_task(name="leads.enrich-raw")
def enrich_raw(domain: str) -> int:
    resp = requests.post(
        "https://api.swfte.com/agents/v2/workflows/wf_Enr4Ch/invoke",
        json={"domain": domain},
        timeout=30,
    )
    return resp.status_code
