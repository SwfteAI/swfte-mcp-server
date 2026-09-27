"""Helpdesk (generated agent client) and sales/ops agents (SDK)."""
from __future__ import annotations

from typing import Optional, Tuple

from app.swfte_clients.helpdesk_agent import chat_helpdesk_agent
from app.swfte_sdk import get_client

SALES_AGENT = "ag_Sales6"


class SupportService:
    def __init__(self) -> None:
        self.client = get_client()

    def answer(self, question: str, user_id: str) -> str:
        res = chat_helpdesk_agent({"message": question}, user_id=user_id)
        return res["output"]["content"]

    def follow_up(self, question: str, user_id: str, conversation_id: str) -> Optional[str]:
        res = chat_helpdesk_agent({"message": question, "conversationId": conversation_id}, user_id=user_id)
        # `reply` sits on the envelope next to `output`; it is not an output field.
        return res["reply"]

    def pitch(self, message: str) -> str:
        reply = self.client.agents.chat("ag_Sales6", message, user_id="crm-sync")
        return reply.response

    def ops(self, text: str, user_id: str, conversation_id: Optional[str] = None) -> Tuple[str, Optional[str]]:
        reply = self.client.agents.chat(
            agent_id="ag_Ops3Bt",
            message=text,
            user_id=user_id,
            conversation_id=conversation_id,
        )
        return reply.response, reply.conversation_id

    def pitch_by_constant(self, message: str) -> str:
        return self.client.agents.chat(SALES_AGENT, message).response
