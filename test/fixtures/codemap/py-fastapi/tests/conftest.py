from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
# The stub SDK must win over any installed swfte-sdk; the project root makes `app` importable.
sys.path.insert(0, str(HERE / "stubs"))
sys.path.insert(1, str(HERE.parent))
os.environ.setdefault("SWFTE_API_KEY", "test-key-not-real")

import swfte  # noqa: E402  (the stub, via the path above)

from app.swfte_sdk import get_client  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_sdk():
    swfte.reset()
    get_client.cache_clear()
    yield swfte
    get_client.cache_clear()
