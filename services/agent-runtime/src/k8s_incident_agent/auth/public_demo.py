import asyncio
import time
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from contextlib import asynccontextmanager, suppress
from typing import Literal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from k8s_incident_agent.auth.sessions import (
    SESSION_COOKIE,
    OperatorAuthenticationError,
    OperatorSession,
    OperatorSessions,
)
from k8s_incident_agent.persistence.models import (
    OperatorSessionRow,
    PublicDemoBudgetRow,
    RunRow,
)


class PublicDemoLimitedError(RuntimeError):
    pass


class RunOwnershipError(RuntimeError):
    pass


def has_cookie(headers: list[str], name: str) -> bool:
    return any(
        part.strip().partition("=")[0] == name
        for header in headers
        for part in header.split(";")
    )


async def require_operator_current(
    database: AsyncSession,
    requester: OperatorSession,
    now: int,
) -> None:
    row = await database.get(
        OperatorSessionRow,
        requester.token_hash,
    )
    if row is None or row.revoked or row.expires_at <= now:
        raise OperatorAuthenticationError


def owns_run(run: RunRow, requester: OperatorSession | None) -> bool:
    return (
        isinstance(requester, OperatorSession)
        and run.request_source == "operator"
        and run.operator_ref == requester.operator_ref
    )


class PublicDemoAccess:
    def __init__(
        self,
        *,
        sessions: async_sessionmaker[AsyncSession],
        operator: OperatorSessions,
        mode: Literal["private", "public_demo"] = "private",
        now: Callable[[], float] = time.time,
    ) -> None:
        self.sessions, self.operator, self.now = sessions, operator, now
        self.mode: Literal["private", "public_demo"] = mode
        self._streams = 0
        self._reads = 0

    async def resolve(self, cookies: list[str]) -> OperatorSession | None:
        if has_cookie(cookies, SESSION_COOKIE):
            try:
                return await self.operator.authenticate(cookies)
            except OperatorAuthenticationError:
                if self.mode == "private":
                    raise
                return None
        if self.mode == "private":
            raise OperatorAuthenticationError
        return None

    async def read_budget(self, requester: OperatorSession | None) -> None:
        if isinstance(requester, OperatorSession):
            return
        async with self.sessions.begin() as database:
            await database.execute(text("BEGIN IMMEDIATE"))
            now = int(self.now())
            row = await database.get(PublicDemoBudgetRow, "reads")
            if row is None:
                row = PublicDemoBudgetRow(
                    category="reads", used=0, window_started_at=now
                )
                database.add(row)
            if now >= row.window_started_at + 60:
                row.used, row.window_started_at = 0, now
            if row.used >= 600:
                raise PublicDemoLimitedError
            row.used += 1

    @asynccontextmanager
    async def reading(self, requester: OperatorSession | None) -> AsyncGenerator[None]:
        if isinstance(requester, OperatorSession):
            yield
            return
        if self._reads >= 8:
            raise PublicDemoLimitedError
        self._reads += 1
        try:
            await self.read_budget(requester)
            yield
        finally:
            self._reads -= 1

    @asynccontextmanager
    async def stream_slot(
        self, requester: OperatorSession | None
    ) -> AsyncGenerator[None]:
        if isinstance(requester, OperatorSession):
            yield
            return
        if self._streams >= 16:
            raise PublicDemoLimitedError
        self._streams += 1
        try:
            yield
        finally:
            self._streams -= 1

    def open_stream(
        self, requester: OperatorSession | None, source: AsyncGenerator[bytes]
    ) -> AsyncIterator[bytes]:
        if isinstance(requester, OperatorSession):
            return self.operator.stream(requester, source)
        return self._stream(source)

    async def _stream(self, source: AsyncGenerator[bytes]) -> AsyncIterator[bytes]:
        pending: asyncio.Task[bytes] | None = None
        deadline = self.now() + 300
        try:
            while self.mode == "public_demo" and self.now() < deadline:
                if pending is None:
                    pending = asyncio.create_task(anext(source))
                done, _ = await asyncio.wait({pending}, timeout=1)
                if done:
                    chunk, pending = pending.result(), None
                    yield chunk
        except (OperatorAuthenticationError, StopAsyncIteration):
            return
        finally:
            if pending is not None:
                pending.cancel()
                with suppress(asyncio.CancelledError, StopAsyncIteration):
                    await pending
            await source.aclose()
