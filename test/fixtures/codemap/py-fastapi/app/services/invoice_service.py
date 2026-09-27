"""Invoice extraction: generated client for the app, SDK for the long-running reconcile."""
from __future__ import annotations

from typing import Any, Dict, List

from app.swfte_clients.invoice_extract import invoke_invoice_extract
from app.swfte_sdk import get_client


def extract(file_url: str) -> Dict[str, Any]:
    res = invoke_invoice_extract({"fileUrl": file_url})
    return {"total": res["output"]["total"], "vendor": res["output"]["vendor"]}


def extract_lines(file_url: str, currency: str) -> List[Dict[str, Any]]:
    res = invoke_invoice_extract(inputs={"fileUrl": file_url, "currency": currency}, timeout_s=120.0)
    lines = []
    for line in res["output"]["lines"]:
        lines.append({"sku": line.get("sku"), "amount": line.get("amount")})
    return lines


def extract_total(file_url: str) -> float:
    res = invoke_invoice_extract({"fileUrl": file_url, "currency": "EUR"})
    out = res["output"]
    return float(out["total"])


def reconcile(file_url: str) -> float:
    done = get_client().workflows.invoke_and_wait("wf_Inv3Xt", {"fileUrl": file_url}, timeout=120)
    return float(done.outputs["total"])
