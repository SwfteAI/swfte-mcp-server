from __future__ import annotations

from app import embeds
from app.services import raw_gateway


class _Resp:
    status_code = 202

    def raise_for_status(self) -> None:
        return None


def test_score_lead_raw_posts_to_the_invoke_url(monkeypatch):
    calls = []
    monkeypatch.setattr(raw_gateway.requests, "post", lambda url, **kw: calls.append((url, kw["json"])) or _Resp())
    assert raw_gateway.score_lead_raw("Acme", "acme.test") == 202
    assert calls == [("https://api.swfte.com/agents/v2/workflows/wf_Lead5Sc/invoke", {"company": "Acme", "domain": "acme.test"})]


def test_weekly_report_raw_folds_the_host_constant(monkeypatch):
    urls = []
    monkeypatch.setattr(raw_gateway.httpx, "post", lambda url, **kw: urls.append(url) or _Resp())
    raw_gateway.weekly_report_raw("2026-W39")
    assert urls == ["https://api.swfte.com/agents/v2/workflows/wf_Rpt9Wk/invoke"]


def test_embed_snippets_name_their_agents():
    assert "ag_Help4Py" in embeds.HELPDESK_WIDGET
    assert "ag_Portal7" in embeds.portal_iframe()
    assert 'agentId: "ag_Sales6", theme: "dark"' in embeds.sales_widget("dark")
    assert embeds.iframe_for("ag_Any1").startswith('<iframe src="https://app.swfte.com/chat/ag_Any1"')
