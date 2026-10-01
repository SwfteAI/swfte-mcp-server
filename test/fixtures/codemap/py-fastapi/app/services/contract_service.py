"""Contract review (generated client pinned to version 3 in swfte.json)."""
from __future__ import annotations

from typing import Any, Dict, List

from app.swfte_clients import contract_review as cr
from app.swfte_clients.contract_review import invoke_contract_review
from app.swfte_sdk import get_client


def review(document_url: str, jurisdiction: str) -> Dict[str, Any]:
    res = invoke_contract_review({"documentUrl": document_url, "jurisdiction": jurisdiction})
    return {"risk": res["output"]["risk"], "summary": res["output"]["summary"]}


def review_all(urls: List[str]) -> List[Any]:
    def one(url: str) -> Any:
        return invoke_contract_review({"documentUrl": url, "jurisdiction": "US-DE"})

    return [one(u) for u in urls]


def review_with_fallback(url: str) -> Any:
    attempt = lambda jurisdiction: invoke_contract_review({"documentUrl": url, "jurisdiction": jurisdiction})  # noqa: E731
    try:
        return attempt("US-DE")
    except cr.SwfteRequestError:
        return attempt("US-NY")


def high_risk_clauses(url: str) -> List[Dict[str, Any]]:
    res = cr.invoke_contract_review({"documentUrl": url, "jurisdiction": "UK"})
    return [c for c in res["output"]["clauses"] if c.get("severity") == "high"]


def recent_reviews() -> List[str]:
    history = get_client().workflows.get_execution_history("wf_Ctr8Rv")
    return [run.status_raw for run in history]
