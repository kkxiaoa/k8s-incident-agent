from dataclasses import dataclass

import httpx
from langchain_deepseek import ChatDeepSeek

from k8s_incident_agent.config import Settings


@dataclass(frozen=True, slots=True)
class DeepSeekModelSelection:
    model_name: str
    thinking: bool


def create_deepseek_model(
    settings: Settings,
    *,
    selection: DeepSeekModelSelection | None = None,
    http_client: httpx.Client | None = None,
    http_async_client: httpx.AsyncClient | None = None,
) -> ChatDeepSeek:
    resolved_selection = selection or DeepSeekModelSelection(
        model_name=settings.model_name,
        thinking=settings.model_thinking,
    )
    thinking_type = "enabled" if resolved_selection.thinking else "disabled"

    return ChatDeepSeek(
        model=resolved_selection.model_name,
        api_key=settings.require_deepseek_api_key(),
        base_url=str(settings.deepseek_base_url).rstrip("/"),
        timeout=settings.model_timeout_seconds,
        max_retries=settings.model_max_retries,
        extra_body={"thinking": {"type": thinking_type}},
        http_client=http_client,
        http_async_client=http_async_client,
    )
