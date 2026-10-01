from __future__ import annotations

import datetime as dt
from typing import Any, Dict

from app.db import automations_for, pending_invoices
from app.swfte_clients.invoice_extract import invoke_invoice_extract
from app.swfte_sdk import get_client
from app.tasks.celery_app import celery_app


@celery_app.task(name="reports.weekly")
def run_weekly_report() -> str:
    week = dt.date.today().strftime("%G-W%V")
    run = get_client().workflows.invoke_and_wait("wf_Rpt9Wk", {"week": week, "teams": ["all"]}, timeout=900)
    return str(run.outputs["highlights"])


@celery_app.task(name="invoices.sync")
def sync_invoices() -> float:
    total = 0.0
    for row in pending_invoices():
        res = invoke_invoice_extract({"fileUrl": row.file_url, "currency": row.currency})
        total += float(res["output"]["total"])
    ping_ops.delay(f"synced invoices, total {total:.2f}")
    return total


@celery_app.task(name="ops.ping")
def ping_ops(text: str) -> None:
    get_client().agents.chat("ag_Ops3Bt", text, user_id="scheduler")


@celery_app.task(name="automations.run")
def run_tenant_automations(tenant: str) -> int:
    client = get_client()
    count = 0
    for row in automations_for(tenant):
        client.workflows.invoke(row.workflow_id, {"tenant": tenant, "rowId": row.id})
        count += 1
    return count


@celery_app.task(name="automations.run-one")
def run_for(workflow_id: str, payload: Dict[str, Any]) -> str:
    return get_client().workflows.invoke(workflow_id, payload).execution_id
