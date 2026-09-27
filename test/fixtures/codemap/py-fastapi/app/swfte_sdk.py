"""One shared Swfte SDK client for the app."""
from __future__ import annotations

import os
from functools import lru_cache

from swfte import SwfteClient


@lru_cache(maxsize=1)
def get_client() -> SwfteClient:
    return SwfteClient(
        api_key=os.environ.get("SWFTE_API_KEY"),
        workspace_id=os.environ.get("SWFTE_WORKSPACE_ID"),
    )
