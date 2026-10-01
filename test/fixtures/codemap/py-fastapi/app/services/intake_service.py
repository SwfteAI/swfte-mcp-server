"""Customer intake chatflow sessions."""
from __future__ import annotations

from typing import Any, Dict

from app.swfte_sdk import get_client


def open_web_session() -> None:
    # The browser picks the session up from the chatflow's own channel; nothing to return.
    get_client().chatflows.start_session("cf_Intake2", channel="WEB")


def open_sms_session(phone: str) -> Dict[str, Any]:
    return get_client().chatflows.start_session("cf_Intake2", "SMS", context={"phone": phone})
