"""Test stub of the ``swfte`` SDK: same call shapes as swfte-sdk 1.1, records calls, never opens a socket.

tests/conftest.py puts tests/stubs first on sys.path, so ``from swfte import SwfteClient`` in the app
resolves here during the test run only.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

__version__ = "0.0.0-stub"

CALLS: List[Tuple[str, str, Any]] = []
OUTPUTS: Dict[str, Dict[str, Any]] = {}


def reset() -> None:
    CALLS.clear()
    OUTPUTS.clear()


@dataclass
class WorkflowInvocation:
    execution_id: str
    workflow_id: Optional[str] = None
    status: Optional[str] = "QUEUED"


@dataclass
class WorkflowExecution:
    id: str
    workflow_id: str
    status_raw: str = "COMPLETED"
    outputs: Any = None


@dataclass
class AgentChatResponse:
    response: str
    conversation_id: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)


def _record(kind: str, ref: str, payload: Any) -> str:
    CALLS.append((kind, ref, payload))
    return f"ex-{len(CALLS)}"


class _Workflows:
    def invoke(self, workflow_id: str, inputs: Optional[Dict[str, Any]] = None, *, callsite: Optional[str] = None) -> WorkflowInvocation:
        return WorkflowInvocation(execution_id=_record("workflows.invoke", workflow_id, inputs), workflow_id=workflow_id)

    def invoke_and_wait(
        self,
        workflow_id: str,
        inputs: Optional[Dict[str, Any]] = None,
        timeout: float = 300,
        poll_interval: float = 2,
        raise_on_pause: bool = False,
        *,
        callsite: Optional[str] = None,
    ) -> WorkflowExecution:
        ex_id = _record("workflows.invoke_and_wait", workflow_id, inputs)
        return WorkflowExecution(id=ex_id, workflow_id=workflow_id, outputs=dict(OUTPUTS.get(workflow_id, {})))

    def execute(self, workflow_id: str, inputs: Optional[Dict[str, Any]] = None, skip_validation: bool = False, *, callsite: Optional[str] = None) -> WorkflowExecution:
        return WorkflowExecution(id=_record("workflows.execute", workflow_id, inputs), workflow_id=workflow_id)

    def get_execution_history(self, workflow_id: str) -> List[WorkflowExecution]:
        _record("workflows.get_execution_history", workflow_id, None)
        return [WorkflowExecution(id="ex-old-1", workflow_id=workflow_id), WorkflowExecution(id="ex-old-2", workflow_id=workflow_id, status_raw="FAILED")]


class _Agents:
    def chat(self, agent_id: str, message: str, user_id: Optional[str] = None, conversation_id: Optional[str] = None, *, callsite: Optional[str] = None) -> AgentChatResponse:
        _record("agents.chat", agent_id, message)
        return AgentChatResponse(response=f"stub reply to: {message}", conversation_id=conversation_id or "conv-1")


class _ChatFlows:
    def start_session(self, chatflow_id: str, channel: str = "WEB", context: Optional[Dict[str, Any]] = None, *, callsite: Optional[str] = None) -> Dict[str, Any]:
        _record("chatflows.start_session", chatflow_id, context)
        return {"sessionId": "sess-1", "chatFlowId": chatflow_id, "channel": channel}


class SwfteClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "https://api.swfte.com/agents/v2/gateway",
        timeout: int = 60,
        max_retries: int = 3,
        workspace_id: Optional[str] = None,
        api_base_url: Optional[str] = None,
    ) -> None:
        self.api_key = api_key
        self.workspace_id = workspace_id
        self.workflows = _Workflows()
        self.agents = _Agents()
        self.chatflows = _ChatFlows()
