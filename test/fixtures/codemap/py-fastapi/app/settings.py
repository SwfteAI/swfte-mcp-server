"""Runtime settings, read once from the environment at import."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Settings:
    swfte_base_url: str = field(default_factory=lambda: _env("SWFTE_BASE_URL", "https://api.swfte.com/agents"))
    welcome_workflow_id: str = field(default_factory=lambda: _env("SWFTE_WELCOME_WF"))
    billing_workflow_id: str = field(default_factory=lambda: _env("SWFTE_BILLING_WF"))
    support_agent_id: str = field(default_factory=lambda: _env("SWFTE_SUPPORT_AGENT_ID"))
    portal_agent_id: str = field(default_factory=lambda: _env("SWFTE_PORTAL_AGENT_ID"))
    embed_key: str = field(default_factory=lambda: _env("SWFTE_EMBED_KEY"))
    broker_url: str = field(default_factory=lambda: _env("CELERY_BROKER_URL", "redis://localhost:6379/0"))


settings = Settings()
