from typing import Annotated

from langchain_core.messages import AnyMessage
from langgraph.graph.message import (  # pyright: ignore[reportMissingTypeStubs]
    add_messages,
)
from typing_extensions import TypedDict

from k8s_incident_agent.domain.models import JsonValue


class IncidentGraphInput(TypedDict):
    run_id: str


class IncidentGraphState(IncidentGraphInput, total=False):
    incident_id: str
    trigger_summary: str
    target: dict[str, str]
    messages: Annotated[list[AnyMessage], add_messages]
    structured_response: dict[str, JsonValue]
    model_calls: int
    tool_calls: int
    terminal_error_code: str
    terminal_error_retryable: bool
