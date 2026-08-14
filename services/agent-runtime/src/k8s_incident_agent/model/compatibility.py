import argparse
import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
from importlib.metadata import version
from time import perf_counter
from typing import Any, Literal, Protocol, Self, cast
from uuid import UUID

import httpx
from langchain.agents import create_agent  # pyright: ignore[reportUnknownVariableType]
from langchain.agents.structured_output import StructuredOutputError, ToolStrategy
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, LLMResult
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from k8s_incident_agent.config import ConfigurationInvalidError, Settings
from k8s_incident_agent.model.discovery import discover_models
from k8s_incident_agent.model.errors import ModelError, ModelErrorCode
from k8s_incident_agent.model.factory import (
    DeepSeekModelSelection,
    create_deepseek_model,
)


class ThinkingMode(StrEnum):
    ENABLED = "enabled"
    DISABLED = "disabled"


class ProbeName(StrEnum):
    PRECONDITION = "precondition"
    DISCOVERY = "discovery"
    TOOL_CALLING = "tool_calling"
    STRUCTURED_OUTPUT = "structured_output"
    REASONING_ROUNDTRIP = "reasoning_roundtrip"


class ProbeStatus(StrEnum):
    PASS = "pass"
    FAIL = "fail"


class ProbeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    model_name: Literal["deepseek-v4-flash", "deepseek-v4-pro"]
    thinking: ThinkingMode


class ProbeEvidenceInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    resource: Literal["runtime"]
    expected_phase: Literal["diagnostic"]


class CapabilityProbeResult(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    capability: Literal["agent_roundtrip"]
    passed: Literal[True]
    confidence: float = Field(ge=0, le=1)


class PackageVersions(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    langchain: str = Field(min_length=1)
    langchain_deepseek: str = Field(
        min_length=1,
        serialization_alias="langchain-deepseek",
    )
    langgraph: str = Field(min_length=1)


class ProbeOutcome(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: ProbeName
    status: ProbeStatus
    error_code: ModelErrorCode | None = None

    @model_validator(mode="after")
    def validate_error_code(self) -> Self:
        if self.status is ProbeStatus.PASS and self.error_code is not None:
            raise ValueError("passing probes must not include an error code")
        if self.status is ProbeStatus.FAIL and self.error_code is None:
            raise ValueError("failed probes require an error code")
        return self


class TokenUsage(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)


class CapabilityReport(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    provider: Literal["deepseek"]
    model: str = Field(min_length=1)
    thinking: ThinkingMode
    packages: PackageVersions
    probes: list[ProbeOutcome] = Field(min_length=1)
    duration_ms: int = Field(ge=0)
    usage: TokenUsage | None

    @property
    def passed(self) -> bool:
        return all(probe.status is ProbeStatus.PASS for probe in self.probes)

    @property
    def exit_code(self) -> int:
        return 0 if self.passed else 1


def _read_probe_evidence(
    resource: Literal["runtime"],
    expected_phase: Literal["diagnostic"],
) -> str:
    """Return fixed, non-sensitive evidence for the compatibility probe."""
    return "probe-evidence-ready"


probe_evidence_tool = StructuredTool.from_function(
    func=_read_probe_evidence,
    name="read_probe_evidence",
    description="Read fixed non-sensitive evidence for the compatibility probe.",
    args_schema=ProbeEvidenceInput,
)


class _ProbeObserver(BaseCallbackHandler):
    def __init__(self) -> None:
        self.llm_calls = 0
        self.llm_errors = 0
        self.saw_tool_call = False
        self.saw_reasoning_content = False
        self.saw_usage = False
        self.input_tokens = 0
        self.output_tokens = 0
        self.total_tokens = 0

    def on_llm_end(
        self,
        response: LLMResult,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        self.llm_calls += 1
        for generation_group in response.generations:
            for generation in generation_group:
                if not isinstance(generation, ChatGeneration):
                    continue
                message = generation.message
                if not isinstance(message, AIMessage):
                    continue
                if message.tool_calls:
                    self.saw_tool_call = True
                reasoning_content = message.additional_kwargs.get("reasoning_content")
                if isinstance(reasoning_content, str) and reasoning_content:
                    self.saw_reasoning_content = True
                usage = message.usage_metadata
                if usage is not None:
                    self.saw_usage = True
                    self.input_tokens += usage["input_tokens"]
                    self.output_tokens += usage["output_tokens"]
                    self.total_tokens += usage["total_tokens"]

    def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        **kwargs: Any,
    ) -> None:
        self.llm_errors += 1

    def usage(self) -> TokenUsage | None:
        if not self.saw_usage:
            return None
        return TokenUsage(
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            total_tokens=self.total_tokens,
        )


@dataclass(frozen=True, slots=True)
class _AgentFlowResult:
    outcomes: list[ProbeOutcome]
    usage: TokenUsage | None


class _AgentRunner(Protocol):
    async def ainvoke(
        self,
        input: dict[str, object],
        config: dict[str, object],
    ) -> dict[str, object]: ...


_SYSTEM_PROMPT = (
    "Run only the registered read-only capability probe, then return the requested "
    "structured result."
)
_USER_PROMPT = (
    "Call read_probe_evidence with resource runtime and expected_phase diagnostic. "
    "After the tool result, return capability agent_roundtrip, passed true, and "
    "confidence 1.0."
)


def _package_versions() -> PackageVersions:
    return PackageVersions(
        langchain=version("langchain"),
        langchain_deepseek=version("langchain-deepseek"),
        langgraph=version("langgraph"),
    )


def _outcome(
    name: ProbeName,
    passed: bool,
    error_code: ModelErrorCode,
) -> ProbeOutcome:
    if passed:
        return ProbeOutcome(name=name, status=ProbeStatus.PASS)
    return ProbeOutcome(
        name=name,
        status=ProbeStatus.FAIL,
        error_code=error_code,
    )


def _report(
    config: ProbeConfig,
    outcomes: list[ProbeOutcome],
    started_at: float,
    usage: TokenUsage | None = None,
) -> CapabilityReport:
    duration_ms = max(0, round((perf_counter() - started_at) * 1000))
    return CapabilityReport(
        provider="deepseek",
        model=config.model_name,
        thinking=config.thinking,
        packages=_package_versions(),
        probes=outcomes,
        duration_ms=duration_ms,
        usage=usage,
    )


def _classify_agent_failure(error: Exception) -> ModelErrorCode:
    status_code = getattr(error, "status_code", None)
    if not isinstance(status_code, int):
        return ModelErrorCode.PROVIDER_UNAVAILABLE
    if status_code in (401, 403):
        return ModelErrorCode.AUTHENTICATION_FAILED
    if status_code == 429:
        return ModelErrorCode.PROVIDER_RATE_LIMITED
    if 400 <= status_code <= 499:
        return ModelErrorCode.PROVIDER_CONTRACT_INVALID
    return ModelErrorCode.PROVIDER_UNAVAILABLE


def _failed_agent_flow(
    config: ProbeConfig,
    observer: _ProbeObserver,
    *,
    structured_output_error: bool,
    agent_error_code: ModelErrorCode | None = None,
) -> _AgentFlowResult:
    reached_follow_up = (
        observer.saw_tool_call and observer.llm_calls + observer.llm_errors >= 2
    )
    outcomes = [
        _outcome(
            ProbeName.TOOL_CALLING,
            reached_follow_up,
            agent_error_code or ModelErrorCode.TOOL_ARGUMENTS_INVALID,
        )
    ]

    reasoning_failed = (
        config.thinking is ThinkingMode.ENABLED
        and reached_follow_up
        and observer.saw_reasoning_content
    )

    if reasoning_failed:
        structured_error_code = ModelErrorCode.REASONING_ROUNDTRIP_FAILED
    elif structured_output_error:
        structured_error_code = ModelErrorCode.STRUCTURED_OUTPUT_INVALID
    elif agent_error_code is not None:
        structured_error_code = agent_error_code
    else:
        structured_error_code = ModelErrorCode.PROVIDER_UNAVAILABLE
    outcomes.append(
        _outcome(
            ProbeName.STRUCTURED_OUTPUT,
            False,
            structured_error_code,
        )
    )

    if config.thinking is ThinkingMode.ENABLED:
        outcomes.append(
            _outcome(
                ProbeName.REASONING_ROUNDTRIP,
                False,
                ModelErrorCode.REASONING_ROUNDTRIP_FAILED,
            )
        )
    return _AgentFlowResult(outcomes=outcomes, usage=observer.usage())


async def _run_agent_flow(
    settings: Settings,
    config: ProbeConfig,
    http_client: httpx.Client,
    http_async_client: httpx.AsyncClient,
) -> _AgentFlowResult:
    observer = _ProbeObserver()
    model = create_deepseek_model(
        settings,
        selection=DeepSeekModelSelection(
            model_name=config.model_name,
            thinking=config.thinking is ThinkingMode.ENABLED,
        ),
        http_client=http_client,
        http_async_client=http_async_client,
    )
    raw_agent = cast(
        object,
        create_agent(
            model,
            tools=[probe_evidence_tool],
            system_prompt=_SYSTEM_PROMPT,
            response_format=ToolStrategy(
                CapabilityProbeResult,
                tool_message_content="capability result accepted",
                handle_errors=False,
            ),
        ),
    )
    agent = cast(_AgentRunner, raw_agent)

    try:
        raw_state = await agent.ainvoke(
            {"messages": [{"role": "user", "content": _USER_PROMPT}]},
            config={"callbacks": [observer]},
        )

    except StructuredOutputError:
        return _failed_agent_flow(
            config,
            observer,
            structured_output_error=True,
        )
    except Exception as error:
        return _failed_agent_flow(
            config,
            observer,
            structured_output_error=False,
            agent_error_code=_classify_agent_failure(error),
        )

    state = raw_state
    raw_messages = state.get("messages")
    messages = (
        [
            message
            for message in cast(list[object], raw_messages)
            if isinstance(message, BaseMessage)
        ]
        if isinstance(raw_messages, list)
        else []
    )
    tool_roundtrip_passed = (
        observer.saw_tool_call
        and observer.llm_calls >= 2
        and any(
            isinstance(message, ToolMessage)
            and message.name == probe_evidence_tool.name
            and message.status == "success"
            and message.content == "probe-evidence-ready"
            for message in messages
        )
    )
    structured_response = state.get("structured_response")
    structured_output_passed = (
        isinstance(structured_response, CapabilityProbeResult)
        and structured_response.passed
    )

    outcomes = [
        _outcome(
            ProbeName.TOOL_CALLING,
            tool_roundtrip_passed,
            ModelErrorCode.TOOL_ARGUMENTS_INVALID,
        ),
        _outcome(
            ProbeName.STRUCTURED_OUTPUT,
            structured_output_passed,
            ModelErrorCode.STRUCTURED_OUTPUT_INVALID,
        ),
    ]
    if config.thinking is ThinkingMode.ENABLED:
        reasoning_roundtrip_passed = (
            tool_roundtrip_passed
            and structured_output_passed
            and observer.saw_reasoning_content
        )
        outcomes.append(
            _outcome(
                ProbeName.REASONING_ROUNDTRIP,
                reasoning_roundtrip_passed,
                ModelErrorCode.REASONING_ROUNDTRIP_FAILED,
            )
        )
    return _AgentFlowResult(outcomes=outcomes, usage=observer.usage())


async def run_compatibility_probe(
    settings: Settings,
    config: ProbeConfig,
    *,
    discovery_client: httpx.AsyncClient | None = None,
    http_client: httpx.Client | None = None,
    http_async_client: httpx.AsyncClient | None = None,
) -> CapabilityReport:
    started_at = perf_counter()
    try:
        await discover_models(
            settings,
            expected_model=config.model_name,
            client=discovery_client,
        )
    except ModelError as error:
        return _report(
            config,
            [
                ProbeOutcome(
                    name=ProbeName.DISCOVERY,
                    status=ProbeStatus.FAIL,
                    error_code=error.code,
                )
            ],
            started_at,
        )

    outcomes = [ProbeOutcome(name=ProbeName.DISCOVERY, status=ProbeStatus.PASS)]
    owns_sync_client = http_client is None
    owns_async_client = http_async_client is None
    resolved_sync_client = http_client or httpx.Client()
    resolved_async_client = http_async_client or httpx.AsyncClient()
    try:
        agent_result = await _run_agent_flow(
            settings,
            config,
            resolved_sync_client,
            resolved_async_client,
        )
    finally:
        if owns_sync_client:
            resolved_sync_client.close()
        if owns_async_client:
            await resolved_async_client.aclose()

    outcomes.extend(agent_result.outcomes)
    return _report(
        config,
        outcomes,
        started_at,
        usage=agent_result.usage,
    )


def _precondition_report(
    config: ProbeConfig,
    started_at: float,
) -> CapabilityReport:
    return _report(
        config,
        [
            ProbeOutcome(
                name=ProbeName.PRECONDITION,
                status=ProbeStatus.FAIL,
                error_code=ModelErrorCode.CONFIGURATION_INVALID,
            )
        ],
        started_at,
    )


def _parse_args(argv: Sequence[str] | None) -> ProbeConfig:
    parser = argparse.ArgumentParser(prog="model-compat")
    parser.add_argument(
        "--model",
        required=True,
        choices=("deepseek-v4-flash", "deepseek-v4-pro"),
    )
    parser.add_argument(
        "--thinking",
        required=True,
        choices=(ThinkingMode.DISABLED.value, ThinkingMode.ENABLED.value),
    )
    arguments = parser.parse_args(argv)
    return ProbeConfig(
        model_name=arguments.model,
        thinking=ThinkingMode(arguments.thinking),
    )


def main(argv: Sequence[str] | None = None) -> int:
    started_at = perf_counter()
    config = _parse_args(argv)
    try:
        settings = Settings(
            model_provider="deepseek",
            model_name="deepseek-v4-flash",
            model_thinking=False,
        )
        settings.require_deepseek_api_key()
    except (ConfigurationInvalidError, ValidationError):
        report = _precondition_report(config, started_at)
    else:
        report = asyncio.run(run_compatibility_probe(settings, config))

    print(report.model_dump_json(by_alias=True))
    return report.exit_code
