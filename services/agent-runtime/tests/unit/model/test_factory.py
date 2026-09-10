import json
from typing import cast

import httpx
import openai
import pytest
from langchain_deepseek import ChatDeepSeek

from k8s_incident_agent.config import Settings
from k8s_incident_agent.model.factory import (
    DeepSeekModelSelection,
    create_deepseek_model,
)


def make_settings(
    monkeypatch: pytest.MonkeyPatch,
    *,
    max_retries: int = 2,
) -> Settings:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-factory-key")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://provider.example/api")
    monkeypatch.setenv("MODEL_MAX_RETRIES", str(max_retries))
    return Settings(_env_file=None)  # pyright: ignore[reportCallIssue]


def completion_response() -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 0,
            "model": "deepseek-flash",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "ok"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "total_tokens": 2,
            },
        },
    )


def request_json(request: httpx.Request) -> dict[str, object]:
    payload = cast(object, json.loads(request.content))
    assert isinstance(payload, dict)
    return cast(dict[str, object], payload)


async def test_default_factory_projects_runtime_settings_once_and_disables_thinking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(monkeypatch)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return completion_response()

    with httpx.Client(transport=httpx.MockTransport(handler)) as sync_client:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as async_client:
            model = create_deepseek_model(
                settings,
                http_client=sync_client,
                http_async_client=async_client,
            )
            result = model.invoke("probe")

    assert isinstance(model, ChatDeepSeek)
    assert result.text == "ok"
    assert model.model_name == "deepseek-flash"
    assert model.api_base == "https://provider.example/api"
    assert model.request_timeout == 60
    assert model.max_retries == 2
    assert model.extra_body == {"thinking": {"type": "disabled"}}

    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == "https://provider.example/api/chat/completions"
    assert request.extensions["timeout"] == {
        "connect": 60.0,
        "read": 60.0,
        "write": 60.0,
        "pool": 60.0,
    }
    payload = request_json(request)
    assert payload["model"] == "deepseek-flash"
    assert payload["thinking"] == {"type": "disabled"}
    assert "base_url" not in payload
    assert "timeout" not in payload
    assert "max_retries" not in payload


async def test_explicit_selection_enables_thinking_in_actual_async_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(monkeypatch)
    requests: list[httpx.Request] = []
    selection = DeepSeekModelSelection(
        model_name="deepseek-flash",
        thinking=True,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return completion_response()

    with httpx.Client(transport=httpx.MockTransport(handler)) as sync_client:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as async_client:
            model = create_deepseek_model(
                settings,
                selection=selection,
                http_client=sync_client,
                http_async_client=async_client,
            )
            result = await model.ainvoke("probe")

    assert result.text == "ok"
    assert len(requests) == 1
    payload = request_json(requests[0])
    assert payload["model"] == selection.model_name
    assert payload["thinking"] == {"type": "enabled"}


async def test_model_repr_and_adapter_error_do_not_render_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(monkeypatch, max_retries=0)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout(
            "transport detail with test-factory-key",
            request=request,
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as sync_client:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as async_client:
            model = create_deepseek_model(
                settings,
                http_client=sync_client,
                http_async_client=async_client,
            )

            with pytest.raises(openai.APITimeoutError) as error:
                await model.ainvoke("probe")

    assert "test-factory-key" not in repr(model)
    assert "test-factory-key" not in repr(model.model_dump())
    assert "test-factory-key" not in repr(error.value)
    assert "test-factory-key" not in str(error.value)
