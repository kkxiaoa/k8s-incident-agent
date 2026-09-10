import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Final

from langchain_core.language_models import BaseChatModel

from k8s_incident_agent.domain.models import ModelSnapshot
from k8s_incident_agent.model.errors import ModelError, ModelErrorCode

_PROBE_TIMEOUT_SECONDS: Final = 10.0
_RECHECK_INTERVAL_SECONDS: Final = 30.0


class DiagnosisUnavailableError(RuntimeError):
    pass


class DiagnosticModelAvailability:
    def __init__(
        self,
        *,
        probe: Callable[[], Awaitable[object]],
        create_model: Callable[[], BaseChatModel],
        snapshot: ModelSnapshot,
    ) -> None:
        self._probe = probe
        self._create_model = create_model
        self._snapshot = snapshot
        self._model: BaseChatModel | None = None
        self._error = ModelErrorCode.PROVIDER_UNAVAILABLE
        self._task: asyncio.Task[None] | None = None

    @property
    def error(self) -> ModelErrorCode | None:
        return None if self._model is not None else self._error

    def get_model(self) -> BaseChatModel | None:
        return self._model

    def get_snapshot(self) -> ModelSnapshot | None:
        return self._snapshot if self._model is not None else None

    async def start(self) -> None:
        await self._refresh()
        self._task = asyncio.create_task(
            self._recheck(), name="diagnostic-model-recheck"
        )

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _refresh(self) -> None:
        try:
            # Bound the whole discovery cycle, including the producer's retries.
            async with asyncio.timeout(_PROBE_TIMEOUT_SECONDS):
                await self._probe()
            if self._model is None:
                self._model = self._create_model()
        except ModelError as error:
            self._model = None
            self._error = error.code
        except TimeoutError:
            self._model = None
            self._error = ModelErrorCode.PROVIDER_UNAVAILABLE

    async def _recheck(self) -> None:
        while True:
            await asyncio.sleep(_RECHECK_INTERVAL_SECONDS)
            await self._refresh()
