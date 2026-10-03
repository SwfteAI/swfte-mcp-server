"""Tiny data-access layer; production swaps in Postgres, tests use the in-memory rows."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterator, List


@dataclass
class AutomationRow:
    id: int
    tenant: str
    workflow_id: str
    enabled: bool = True


@dataclass
class InvoiceRow:
    id: int
    file_url: str
    currency: str = "USD"


_AUTOMATIONS: List[AutomationRow] = []
_INVOICES: List[InvoiceRow] = []


def automations_for(tenant: str) -> Iterator[AutomationRow]:
    return (row for row in _AUTOMATIONS if row.tenant == tenant and row.enabled)


def pending_invoices() -> List[InvoiceRow]:
    return list(_INVOICES)


def save_score(lead_id: str, score: float) -> Dict[str, object]:
    return {"lead_id": lead_id, "score": score}
