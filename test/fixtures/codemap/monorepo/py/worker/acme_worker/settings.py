"""Worker settings, filled from the config service at start-up."""
from dataclasses import dataclass


@dataclass
class Settings:
    digest_workflow_id: str = ""
    help_agent_id: str = ""


settings = Settings()
