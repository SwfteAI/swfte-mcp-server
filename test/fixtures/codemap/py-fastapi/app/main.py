from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from app.routers import billing, contracts, leads, pages, reports, support, webhooks
from app.swfte_sdk import get_client


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Fail fast on a bad key: one cheap round trip to the ops bot.
    get_client().agents.chat("ag_Ops3Bt", "ping", user_id="startup")
    yield


app = FastAPI(title="Acme Ops", lifespan=lifespan)
for r in (leads.router, support.router, contracts.router, billing.router, reports.router, webhooks.router, pages.router):
    app.include_router(r)
