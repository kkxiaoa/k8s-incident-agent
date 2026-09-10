import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import cast

import httpx
import pytest
from pydantic import ValidationError

from k8s_incident_agent.config import Settings
from k8s_incident_agent.model import compatibility
from k8s_incident_agent.model.compatibility import (
    CapabilityProbeResult,
    CapabilityReport,
    PackageVersions,
    ProbeConfig,
    ProbeName,
    ProbeOutcome,
    ProbeStatus,
    ThinkingMode,
    TokenUsage,
    probe_evidence_tool,
    run_compatibility_probe,
)
from k8s_incident_agent.model.errors import ModelErrorCode

INVALID_TOOL_ARGUMENTS: list[dict[str, object]] = [
    {"expected_phase": "diagnostic"},
    {"resource": "runtime"},
    {
        "resource": "runtime",
        "expected_phase": "diagnostic",
        "unexpected": "value",
    },
    {"resource": 1, "expected_phase": "diagnostic"},
]

INVALID_PROBE_RESULTS: list[object] = [
    {"passed": True, "confidence": 1.0},
    {"capability": "agent_roundtrip", "confidence": 1.0},
    {"capability": "agent_roundtrip", "passed": True},
    {
        "capability": "agent_roundtrip",
        "passed": True,
        "confidence": 1.0,
        "unexpected": "value",
    },
    {"capability": "agent_roundtrip", "passed": True, "confidence": 1.1},
    {"capability": "agent_roundtrip", "passed": True, "confidence": "high"},
]


def make_settings(
    monkeypatch: pytest.MonkeyPatch,
    *,
    max_retries: int = 0,
) -> Settings:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-compatibility-key")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://provider.example/api")
    monkeypatch.setenv("MODEL_MAX_RETRIES", str(max_retries))
    return Settings(_env_file=None)  # pyright: ignore[reportCallIssue]


def request_json(request: httpx.Request) -> dict[str, object]:
    payload = cast(object, json.loads(request.content))
    assert isinstance(payload, dict)
    return cast(dict[str, object], payload)


def chat_response(
    *,
    tool_name: str,
    arguments: dict[str, object],
    tool_call_id: str,
    reasoning_content: str | None = None,
) -> httpx.Response:
    message: dict[str, object] = {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": tool_call_id,
                "type": "function",
                "function": {
                    "name": tool_name,
                    "arguments": json.dumps(arguments),
                },
            }
        ],
    }
    if reasoning_content is not None:
        message["reasoning_content"] = reasoning_content
    return httpx.Response(
        200,
        json={
            "id": f"chatcmpl-{tool_call_id}",
            "object": "chat.completion",
            "created": 0,
            "model": "deepseek-flash",
            "choices": [
                {
                    "index": 0,
                    "message": message,
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "total_tokens": 2,
            },
        },
    )


def passing_report(config: ProbeConfig) -> CapabilityReport:
    return CapabilityReport(
        provider="deepseek",
        model=config.model_name,
        thinking=config.thinking,
        packages=PackageVersions(
            langchain="1.3.14",
            langchain_deepseek="1.1.0",
            langgraph="1.2.10",
        ),
        probes=[
            ProbeOutcome(name=ProbeName.DISCOVERY, status=ProbeStatus.PASS),
            ProbeOutcome(name=ProbeName.TOOL_CALLING, status=ProbeStatus.PASS),
            ProbeOutcome(name=ProbeName.STRUCTURED_OUTPUT, status=ProbeStatus.PASS),
        ],
        duration_ms=1,
        usage=TokenUsage(input_tokens=2, output_tokens=2, total_tokens=4),
    )


@pytest.mark.parametrize("arguments", INVALID_TOOL_ARGUMENTS)
def test_probe_tool_rejects_missing_extra_and_wrong_typed_arguments(
    arguments: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        probe_evidence_tool.invoke(arguments)


@pytest.mark.parametrize("payload", INVALID_PROBE_RESULTS)
def test_capability_probe_result_is_strict(payload: object) -> None:
    with pytest.raises(ValidationError):
        CapabilityProbeResult.model_validate(payload)


def test_report_schema_contains_only_sanitized_gate_fields() -> None:
    config = ProbeConfig(
        model_name="deepseek-flash",
        thinking=ThinkingMode.DISABLED,
    )
    report = passing_report(config)

    serialized = report.model_dump(mode="json", by_alias=True)

    assert set(serialized) == {
        "provider",
        "model",
        "thinking",
        "packages",
        "probes",
        "duration_ms",
        "usage",
    }
    assert set(cast(dict[str, object], serialized["packages"])) == {
        "langchain",
        "langchain-deepseek",
        "langgraph",
    }
    assert set(cast(dict[str, object], serialized["usage"])) == {
        "input_tokens",
        "output_tokens",
        "total_tokens",
    }
    first_probe = cast(list[dict[str, object]], serialized["probes"])[0]
    assert set(first_probe) == {"name", "status", "error_code"}

    unsafe_payload = report.model_dump(mode="python")
    unsafe_payload["api_key"] = "test-compatibility-key"
    unsafe_payload["prompt"] = "sensitive prompt"
    unsafe_payload["tool_input"] = "sensitive tool input"
    unsafe_payload["reasoning_content"] = "sensitive reasoning"
    with pytest.raises(ValidationError):
        CapabilityReport.model_validate(unsafe_payload)


async def test_non_thinking_probe_uses_real_agent_tool_and_structured_output_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(monkeypatch)
    config = ProbeConfig(
        model_name="deepseek-flash",
        thinking=ThinkingMode.DISABLED,
    )
    chat_requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(
                200,
                json={"data": [{"id": "deepseek-flash"}]},
            )

        chat_requests.append(request_json(request))
        if len(chat_requests) == 1:
            return chat_response(
                tool_name="read_probe_evidence",
                arguments={
                    "resource": "runtime",
                    "expected_phase": "diagnostic",
                },
                tool_call_id="call-evidence",
            )
        return chat_response(
            tool_name="CapabilityProbeResult",
            arguments={
                "capability": "agent_roundtrip",
                "passed": True,
                "confidence": 1.0,
            },
            tool_call_id="call-result",
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as sync_client:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as async_client:
            report = await run_compatibility_probe(
                settings,
                config,
                discovery_client=async_client,
                http_client=sync_client,
                http_async_client=async_client,
            )

    assert report.passed
    assert len(chat_requests) == 2
    second_messages = cast(list[dict[str, object]], chat_requests[1]["messages"])
    tool_messages = [
        message for message in second_messages if message["role"] == "tool"
    ]
    assert len(tool_messages) == 1
    assert tool_messages[0]["content"] == "probe-evidence-ready"
    assert report.usage == TokenUsage(
        input_tokens=2,
        output_tokens=2,
        total_tokens=4,
    )
    rendered = report.model_dump_json(by_alias=True)
    assert "test-compatibility-key" not in rendered
    assert "probe-evidence-ready" not in rendered


@pytest.mark.parametrize(
    ("status_code", "expected_error_code"),
    [
        (400, ModelErrorCode.PROVIDER_CONTRACT_INVALID),
        (401, ModelErrorCode.AUTHENTICATION_FAILED),
        (403, ModelErrorCode.AUTHENTICATION_FAILED),
        (404, ModelErrorCode.PROVIDER_CONTRACT_INVALID),
        (429, ModelErrorCode.PROVIDER_RATE_LIMITED),
        (500, ModelErrorCode.PROVIDER_UNAVAILABLE),
    ],
)
async def test_chat_provider_errors_keep_their_failure_category(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    expected_error_code: ModelErrorCode,
) -> None:
    settings = make_settings(monkeypatch)
    config = ProbeConfig(
        model_name="deepseek-flash",
        thinking=ThinkingMode.DISABLED,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(
                200,
                json={"data": [{"id": "deepseek-flash"}]},
            )
        return httpx.Response(
            status_code,
            json={"error": {"message": "sanitized provider error"}},
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as sync_client:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as async_client:
            report = await run_compatibility_probe(
                settings,
                config,
                discovery_client=async_client,
                http_client=sync_client,
                http_async_client=async_client,
            )

    assert not report.passed
    agent_outcomes = [
        outcome for outcome in report.probes if outcome.name is not ProbeName.DISCOVERY
    ]
    assert len(agent_outcomes) == 2
    assert all(outcome.status is ProbeStatus.FAIL for outcome in agent_outcomes)
    assert all(outcome.error_code is expected_error_code for outcome in agent_outcomes)
    assert "sanitized provider error" not in report.model_dump_json(by_alias=True)


async def test_missing_reasoning_replay_uses_distinct_failure_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = make_settings(monkeypatch)
    config = ProbeConfig(
        model_name="deepseek-flash",
        thinking=ThinkingMode.ENABLED,
    )
    reasoning_marker = "synthetic-reasoning-marker"
    chat_requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(
                200,
                json={"data": [{"id": "deepseek-flash"}]},
            )

        payload = request_json(request)
        chat_requests.append(payload)
        if len(chat_requests) == 1:
            return chat_response(
                tool_name="read_probe_evidence",
                arguments={
                    "resource": "runtime",
                    "expected_phase": "diagnostic",
                },
                tool_call_id="call-evidence",
                reasoning_content=reasoning_marker,
            )

        messages = cast(list[dict[str, object]], payload["messages"])
        reasoning_was_replayed = any(
            message.get("role") == "assistant"
            and message.get("reasoning_content") == reasoning_marker
            for message in messages
        )
        if not reasoning_was_replayed:
            return httpx.Response(
                400,
                json={"error": {"message": "reasoning replay required"}},
            )
        return chat_response(
            tool_name="CapabilityProbeResult",
            arguments={
                "capability": "agent_roundtrip",
                "passed": True,
                "confidence": 1.0,
            },
            tool_call_id="call-result",
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as sync_client:
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        ) as async_client:
            report = await run_compatibility_probe(
                settings,
                config,
                discovery_client=async_client,
                http_client=sync_client,
                http_async_client=async_client,
            )

    assert not report.passed
    reasoning_outcome = next(
        outcome
        for outcome in report.probes
        if outcome.name is ProbeName.REASONING_ROUNDTRIP
    )
    assert reasoning_outcome.status is ProbeStatus.FAIL
    assert reasoning_outcome.error_code is ModelErrorCode.REASONING_ROUNDTRIP_FAILED
    assert reasoning_marker not in report.model_dump_json(by_alias=True)


def test_failed_hard_probe_makes_cli_exit_nonzero(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-compatibility-key")
    config = ProbeConfig(
        model_name="deepseek-flash",
        thinking=ThinkingMode.DISABLED,
    )
    failed_report = passing_report(config).model_copy(
        update={
            "probes": [
                ProbeOutcome(
                    name=ProbeName.STRUCTURED_OUTPUT,
                    status=ProbeStatus.FAIL,
                    error_code=ModelErrorCode.STRUCTURED_OUTPUT_INVALID,
                )
            ]
        }
    )

    async def fake_run(
        _: Settings,
        __: ProbeConfig,
    ) -> CapabilityReport:
        return failed_report

    runner = cast(
        Callable[[Settings, ProbeConfig], Awaitable[CapabilityReport]],
        fake_run,
    )
    monkeypatch.setattr(compatibility, "run_compatibility_probe", runner)

    exit_code = compatibility.main(
        ["--model", "deepseek-flash", "--thinking", "disabled"]
    )

    output_lines = capsys.readouterr().out.splitlines()
    assert exit_code == 1
    assert len(output_lines) == 1
    payload = cast(dict[str, object], json.loads(output_lines[0]))
    probes = cast(list[dict[str, object]], payload["probes"])
    assert probes[0]["status"] == "fail"


def test_cli_without_key_reports_precondition_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.chdir(tmp_path)
    for variable in (
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_BASE_URL",
        "MODEL_PROVIDER",
        "MODEL_NAME",
        "MODEL_THINKING",
        "MODEL_TIMEOUT_SECONDS",
        "MODEL_MAX_RETRIES",
    ):
        monkeypatch.delenv(variable, raising=False)

    exit_code = compatibility.main(
        ["--model", "deepseek-flash", "--thinking", "disabled"]
    )

    output_lines = capsys.readouterr().out.splitlines()
    assert exit_code == 1
    assert len(output_lines) == 1
    payload = cast(dict[str, object], json.loads(output_lines[0]))
    probes = cast(list[dict[str, object]], payload["probes"])
    assert probes[0]["status"] == "fail"
    assert probes[0]["error_code"] == "configuration_invalid"
    assert payload["usage"] is None
