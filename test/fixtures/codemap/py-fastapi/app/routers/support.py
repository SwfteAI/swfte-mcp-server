from __future__ import annotations

import asyncio
from typing import Dict

from fastapi import APIRouter, Header
from pydantic import BaseModel

from app.swfte_clients.helpdesk_agent import chat_helpdesk_agent
from app.swfte_sdk import get_client

router = APIRouter(prefix="/support", tags=["support"])


class Question(BaseModel):
    message: str


@router.post("/sales")
async def ask_sales(body: Question, x_user_id: str = Header(...)) -> Dict[str, str]:
    client = get_client()
    reply = await asyncio.to_thread(lambda: client.agents.chat("ag_Sales6", body.message, user_id=x_user_id))
    return {"answer": reply.response}


@router.post("/helpdesk")
def ask_helpdesk(body: Question, x_user_id: str = Header(...)) -> Dict[str, str]:
    res = chat_helpdesk_agent({"message": body.message}, x_user_id)
    return {"answer": res["output"]["content"]}
