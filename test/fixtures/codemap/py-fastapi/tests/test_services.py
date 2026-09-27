from __future__ import annotations

from unittest.mock import MagicMock

import swfte
from swfte import SwfteClient

from app.services import churn_service, contract_service, invoice_service, lead_service, onboarding_service, report_service
from app.services.support_service import SupportService


def _typed_result(output):
    return {"ok": True, "status": "COMPLETED", "execution_id": "ex-1", "output": output, "reply": None, "raw": {}}


def test_score_reads_score_and_tier(monkeypatch):
    seen = {}

    def fake(inputs, **kwargs):
        seen.update(inputs)
        return _typed_result({"score": 0.91, "tier": "A", "reasons": ["funded"]})

    monkeypatch.setattr(lead_service, "invoke_lead_scoring", fake)
    assert lead_service.LeadService().score("Acme", "acme.test") == {"score": 0.91, "tier": "A"}
    assert seen == {"company": "Acme", "domain": "acme.test"}


def test_enrich_goes_through_the_sdk():
    execution_id = lead_service.LeadService().enrich("acme.test")
    assert execution_id == "ex-1"
    assert swfte.CALLS == [("workflows.invoke", "wf_Enr4Ch", {"domain": "acme.test"})]


def test_onboarding_start_with_a_mock_client(monkeypatch):
    mock_client = MagicMock()
    mock_client.workflows.invoke.return_value.execution_id = "ex-42"
    monkeypatch.setattr(onboarding_service, "get_client", lambda: mock_client)
    assert onboarding_service.start("a-1", "pro") == "ex-42"
    mock_client.workflows.invoke.assert_called_once_with("wf_Onb2Rd", {"accountId": "a-1", "plan": "pro"})


def test_custom_onboarding_reads_the_env(monkeypatch):
    monkeypatch.setenv("SWFTE_ONBOARDING_WF", "wf_TenantX1")
    onboarding_service.start_custom("a-2")
    assert swfte.CALLS[-1][1] == "wf_TenantX1"


def test_contract_review_keeps_the_high_risk_clauses(monkeypatch):
    clauses = [{"id": 1, "severity": "high"}, {"id": 2, "severity": "low"}]
    monkeypatch.setattr(contract_service.cr, "invoke_contract_review", lambda inputs, **kw: _typed_result({"clauses": clauses}))
    assert contract_service.high_risk_clauses("https://docs.test/c.pdf") == [clauses[0]]


def test_reconcile_reads_total():
    swfte.OUTPUTS["wf_Inv3Xt"] = {"total": 120.5}
    assert invoice_service.reconcile("https://files.test/i.pdf") == 120.5


def test_weekly_report_reads_highlights_and_revenue():
    swfte.OUTPUTS["wf_Rpt9Wk"] = {"highlights": ["record week"], "metrics": {"revenue": 1000}}
    assert report_service.ReportService().weekly("2026-W39", ["emea"]) == {"headline": "record week", "revenue": 1000}


def test_failures_lists_failed_runs():
    assert report_service.ReportService().failures() == ["ex-old-2"]


def test_churn_risk_band():
    swfte.OUTPUTS["wf_Chn7Rs"] = {"risk": "high"}
    assert churn_service.risk_band("c-9") == "high"


def test_support_pitch_uses_the_sales_agent():
    reply = SupportService().pitch("hello")
    assert reply == "stub reply to: hello"
    assert swfte.CALLS[-1][:2] == ("agents.chat", "ag_Sales6")


def test_stub_client_records_calls():
    stub = SwfteClient(api_key="x")
    stub.agents.chat("ag_Sales6", "hi", user_id="t")
    stub.workflows.invoke("wf_Lead5Sc", {"company": "Acme", "domain": "acme.test"})
    assert [c[1] for c in swfte.CALLS] == ["ag_Sales6", "wf_Lead5Sc"]
