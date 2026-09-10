import asyncio
from pathlib import Path
from typing import cast
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from langchain_core.language_models import BaseChatModel

from k8s_incident_agent.config import Settings
from k8s_incident_agent.domain.models import ModelSnapshot
from k8s_incident_agent.model import availability
from k8s_incident_agent.model.availability import DiagnosticModelAvailability
from k8s_incident_agent.model.discovery import discover_models
from k8s_incident_agent.model.errors import ModelError, ModelErrorCode
from k8s_incident_agent.runtime.paths import RuntimePaths

SNAPSHOT = ModelSnapshot(
    provider="deepseek",
    model_id="deepseek-flash",
    thinking_mode=False,
    prompt_version="test",
)


@pytest.mark.parametrize(
    "reason",
    [
        ModelErrorCode.CONFIGURATION_INVALID,
        ModelErrorCode.AUTHENTICATION_FAILED,
        ModelErrorCode.MODEL_NOT_FOUND,
        ModelErrorCode.PROVIDER_RATE_LIMITED,
        ModelErrorCode.PROVIDER_UNAVAILABLE,
        ModelErrorCode.PROVIDER_CONTRACT_INVALID,
    ],
)
async def test_discovery_failure_blocks_only_model_without_constructing_fake_snapshot(
    reason: ModelErrorCode,
) -> None:
    factory = Mock()
    capability = DiagnosticModelAvailability(
        probe=AsyncMock(side_effect=ModelError(reason, "safe failure")),
        create_model=factory,
        snapshot=SNAPSHOT,
    )
    await capability.start()
    try:
        assert capability.error is reason
        assert capability.get_model() is None
        assert capability.get_snapshot() is None
        factory.assert_not_called()
    finally:
        await capability.close()


async def test_bounded_background_recheck_recovers_and_detects_later_outage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(availability, "_RECHECK_INTERVAL_SECONDS", 0.001)
    model = cast(BaseChatModel, object())
    failure = ModelError(ModelErrorCode.PROVIDER_UNAVAILABLE, "safe failure")
    probe = AsyncMock(side_effect=failure)
    factory = Mock(return_value=model)
    capability = DiagnosticModelAvailability(
        probe=probe, create_model=factory, snapshot=SNAPSHOT
    )
    await capability.start()
    try:
        assert capability.get_snapshot() is None
        probe.side_effect = None
        async with asyncio.timeout(1):
            while capability.get_model() is None:
                await asyncio.sleep(0.001)
        assert capability.get_model() is model
        assert capability.get_snapshot() == SNAPSHOT
        assert capability.error is None
        factory.assert_called_once()

        probe.side_effect = failure
        async with asyncio.timeout(1):
            while capability.get_model() is not None:
                await asyncio.sleep(0.001)
        assert capability.get_snapshot() is None
        assert capability.error is ModelErrorCode.PROVIDER_UNAVAILABLE
    finally:
        await capability.close()
    calls = probe.await_count
    await asyncio.sleep(0.01)
    assert probe.await_count == calls


async def test_timeout_bounds_entire_probe_and_shutdown_cancels_pending_recheck(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(availability, "_PROBE_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(availability, "_RECHECK_INTERVAL_SECONDS", 0.001)
    entered = asyncio.Event()
    cancelled = asyncio.Event()

    async def stalled_probe() -> object:
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    capability = DiagnosticModelAvailability(
        probe=stalled_probe, create_model=Mock(), snapshot=SNAPSHOT
    )
    async with asyncio.timeout(1):
        await capability.start()
    assert cancelled.is_set()
    assert capability.error is ModelErrorCode.PROVIDER_UNAVAILABLE
    entered.clear()
    cancelled.clear()
    await asyncio.wait_for(entered.wait(), 1)
    await capability.close()
    assert cancelled.is_set()


async def test_corrupt_http_encoding_degrades_and_recovers_without_restart(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(availability, "_RECHECK_INTERVAL_SECONDS", 0.001)
    paths = RuntimePaths.prepare(tmp_path / "runtime")
    settings = Settings(
        _env_file=None,  # pyright: ignore[reportCallIssue]
        RUNTIME_DATA_DIR=paths,  # pyright: ignore[reportCallIssue]
        deepseek_api_key="test-key",
    )
    assert settings.runtime_paths == paths
    corrupt = False

    def provider(_: httpx.Request) -> httpx.Response:
        if corrupt:
            return httpx.Response(
                200,
                headers={"Content-Encoding": "gzip"},
                stream=httpx.ByteStream(b"malformed upstream gzip"),
            )
        return httpx.Response(200, json={"data": [{"id": "deepseek-flash"}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(provider)) as client:
        model = cast(BaseChatModel, object())
        capability = DiagnosticModelAvailability(
            probe=lambda: discover_models(settings, client=client),
            create_model=Mock(return_value=model),
            snapshot=SNAPSHOT,
        )
        await capability.start()
        try:
            assert capability.get_model() is model
            corrupt = True
            async with asyncio.timeout(1):
                while capability.get_model() is not None:
                    await asyncio.sleep(0.001)
            assert capability.error is ModelErrorCode.PROVIDER_CONTRACT_INVALID
            assert capability.get_snapshot() is None

            corrupt = False
            async with asyncio.timeout(1):
                while capability.get_model() is None:
                    await asyncio.sleep(0.001)
            assert capability.error is None
            assert capability.get_model() is model
            assert capability.get_snapshot() == SNAPSHOT
        finally:
            await capability.close()
