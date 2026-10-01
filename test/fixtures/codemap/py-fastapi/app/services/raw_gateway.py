"""Direct HTTP calls to the Swfte API, for places the SDK did not cover when they were written."""
from __future__ import annotations

import os
from typing import Any, Dict

import httpx
import requests

from app.settings import settings

SWFTE_API = "https://api.swfte.com/agents"


def _headers() -> Dict[str, str]:
    return {"Authorization": f"Bearer {os.environ.get('SWFTE_API_KEY', '')}", "Content-Type": "application/json"}


def score_lead_raw(company: str, domain: str) -> int:
    resp = requests.post("https://api.swfte.com/agents/v2/workflows/wf_Lead5Sc/invoke", json={"company": company, "domain": domain}, headers=_headers(), timeout=30)
    return resp.status_code


def onboard_raw(account_id: str, version: str) -> None:
    payload = {"accountId": account_id, "plan": "starter"}
    httpx.post(f"https://api.swfte.com/agents/v2/workflows/wf_Onb2Rd/versions/{version}/invoke", json=payload, headers=_headers()).raise_for_status()


def weekly_report_raw(week: str) -> None:
    r = httpx.post(SWFTE_API + "/v2/workflows/wf_Rpt9Wk/invoke", json={"week": week}, headers=_headers())
    r.raise_for_status()


def sales_chat_raw(user_id: str, text: str) -> int:
    r = requests.post(f"{SWFTE_API}/v1/agents/ag_Sales6/chat/{user_id}", json={"message": text}, headers=_headers(), timeout=30)
    return r.status_code


def review_v2_raw(url: str) -> None:
    body = {"documentUrl": url, "jurisdiction": "US-DE"}
    httpx.post(f"{SWFTE_API}/v2/workflows/wf_Ctr8Rv/versions/2/invoke", json=body, headers=_headers()).raise_for_status()


def concierge_raw(message: str, visitor_id: str) -> int:
    resp = requests.post(
        f"{SWFTE_API}/v1/public/agents/ag_Pub5Py/chat",
        json={"message": message, "visitorId": visitor_id},
        headers={"X-Swfte-Embed-Key": settings.embed_key},
        timeout=15,
    )
    return resp.status_code


def faq_widget_raw(query: str) -> int:
    return httpx.post(f"{SWFTE_API}/v1/widgets/wg_Faq8Hp/public/invoke", json={"query": query}).status_code


def intake_session_raw() -> int:
    return requests.post(f"{SWFTE_API}/v2/chatflows/cf_Intake2/sessions", json={"channel": "API"}, headers=_headers()).status_code


async def churn_raw(customer_id: str) -> int:
    async with httpx.AsyncClient(base_url=SWFTE_API, headers=_headers()) as http:
        resp = await http.post("/v2/workflows/wf_Chn7Rs/invoke", json={"customerId": customer_id})
        return resp.status_code


def report_runs_raw() -> int:
    return requests.get(f"{SWFTE_API}/v2/workflows/wf_Rpt9Wk/executions", params={"limit": 10}, headers=_headers()).status_code


def bill_raw(invoice_id: str, amount: float) -> int:
    r = httpx.post(os.environ["SWFTE_BASE_URL"] + "/v2/workflows/wf_Bil6Rn/invoke", json={"invoiceId": invoice_id, "amount": amount}, headers=_headers())
    return r.status_code


def bill_configured_raw(invoice_id: str) -> int:
    r = httpx.post(f"{SWFTE_API}/v2/workflows/{settings.billing_workflow_id}/invoke", json={"invoiceId": invoice_id}, headers=_headers())
    return r.status_code


def escalate_raw(user_id: str, text: str) -> int:
    r = requests.post(
        f"{os.environ['SWFTE_BASE_URL']}/v1/agents/{os.environ['SWFTE_SUPPORT_AGENT_ID']}/chat/{user_id}",
        json={"message": text},
        headers=_headers(),
    )
    return r.status_code


def audit_raw(event: Dict[str, Any]) -> None:
    session = requests.Session()
    session.headers.update(_headers())
    session.post(SWFTE_API + "/v2/workflows/wf_Aud1Lg/invoke", json=event).raise_for_status()
