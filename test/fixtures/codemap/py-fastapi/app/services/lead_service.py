"""Lead scoring and enrichment.

Scoring goes through the generated lead-scoring client; enrichment still uses
the SDK directly. Example from the runbook (not executed):

    client.workflows.invoke("wf_Lead5Sc", {"company": "Acme", "domain": "acme.test"})
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List

from app.swfte_clients.lead_scoring import invoke_lead_scoring
from app.swfte_sdk import get_client


class LeadService:
    def score(self, company: str, domain: str) -> Dict[str, Any]:
        res = invoke_lead_scoring({"company": company, "domain": domain})
        return {"score": res["output"]["score"], "tier": res["output"]["tier"]}

    def score_with_size(self, company: str, domain: str, employees: int) -> str:
        payload = {"company": company, "domain": domain, "employees": employees}
        res = invoke_lead_scoring(payload)
        first_reason = res["output"]["reasons"][0]
        return first_reason

    def rescore(self, lead: Dict[str, Any]) -> bool:
        # A lead dict straight from the CRM; its keys are whatever the CRM sends.
        res = invoke_lead_scoring(lead)
        return res["status"] == "COMPLETED"

    def score_many(self, leads: Iterable[Dict[str, str]]) -> List[Any]:
        return [invoke_lead_scoring({"company": lead["company"], "domain": lead["domain"]}) for lead in leads]

    def score_verbose(self, company: str, domain: str, employees: int) -> float:
        res = invoke_lead_scoring(
            {
                "company": company,
                "domain": domain,
                "employees": employees,
            },
            timeout_s=60.0,
            poll_interval_s=1.0,
        )
        if not res["ok"]:
            raise RuntimeError(f"lead scoring ended {res['status']}")
        return float(res["output"]["score"])

    def enrich(self, domain: str) -> str:
        invocation = get_client().workflows.invoke("wf_Enr4Ch", {"domain": domain})
        return invocation.execution_id
