import asyncio
import hashlib
import hmac
import re
import secrets
import time
from collections import deque
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from contextlib import suppress
from dataclasses import dataclass, field, replace

from sqlalchemy import delete, func, text, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from k8s_incident_agent.auth.verifier import PasswordVerifier
from k8s_incident_agent.persistence.models import OperatorSessionRow

SESSION_COOKIE = "__Host-k8s-incident-session"
CSRF_HEADER = "X-CSRF-Token"
SESSION_SECONDS = 30 * 60
_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")


class OperatorAuthenticationError(RuntimeError):
    pass


class OperatorOriginError(RuntimeError):
    pass


class OperatorCsrfError(RuntimeError):
    pass


class OperatorLoginLimitedError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class OperatorSession:
    operator_ref: str
    expires_at: int
    token_hash: str = field(repr=False)
    csrf_token: str = field(repr=False)
    token: str = field(repr=False)


class OperatorSessions:
    def __init__(
        self,
        *,
        sessions: async_sessionmaker[AsyncSession],
        verifier: PasswordVerifier,
        origin: str,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._sessions = sessions
        self._verifier = verifier
        self.origin = origin
        self._now = now
        self._attempts: deque[float] = deque()
        self._verification: asyncio.Task[bool] | None = None
        self._cleanup: asyncio.Task[None] | None = None

    async def start(self) -> None:
        # Restart is the credential-rotation boundary. Revocation is durable, so
        # restoring an older verifier cannot resurrect an earlier session.
        async with self._sessions.begin() as database:
            await database.execute(update(OperatorSessionRow).values(revoked=True))
            await database.execute(
                delete(OperatorSessionRow).where(
                    OperatorSessionRow.expires_at <= int(self._now())
                )
            )
        self._cleanup = asyncio.create_task(self._clean_expired())

    async def close(self) -> None:
        if self._cleanup is not None:
            self._cleanup.cancel()
            with suppress(asyncio.CancelledError):
                await self._cleanup
        if self._verification is not None:
            with suppress(Exception):
                await self._verification

    async def _clean_expired(self) -> None:
        while True:
            await asyncio.sleep(60)
            # Cleanup is retention only; request authentication always checks expiry.
            with suppress(SQLAlchemyError):
                async with self._sessions.begin() as database:
                    await database.execute(
                        delete(OperatorSessionRow).where(
                            OperatorSessionRow.expires_at <= int(self._now())
                        )
                    )

    def require_origin(self, origins: list[str]) -> None:
        if origins != [self.origin]:
            raise OperatorOriginError

    async def login(self, password: bytes) -> OperatorSession:
        now = self._now()
        while self._attempts and self._attempts[0] <= now - 60:
            self._attempts.popleft()
        if (self._verification is not None and not self._verification.done()) or len(
            self._attempts
        ) >= 5:
            raise OperatorLoginLimitedError
        self._attempts.append(now)
        task = asyncio.create_task(self._verifier.check(password))
        self._verification = task
        # Client cancellation must not release the single expensive native slot.
        # Retrieve errors even if the client has already gone away.
        task.add_done_callback(
            lambda finished: None if finished.cancelled() else finished.exception()
        )
        if not await asyncio.shield(task):
            raise OperatorAuthenticationError
        token = secrets.token_urlsafe(32)
        created_at = int(self._now())
        row = OperatorSessionRow(
            token_hash=hashlib.sha256(token.encode("ascii")).hexdigest(),
            operator_ref="sandbox-operator",
            created_at=created_at,
            expires_at=created_at + SESSION_SECONDS,
            revoked=False,
        )
        async with self._sessions.begin() as database:
            database.add(row)
        return self._principal(row, token)

    async def authenticate(self, cookie_headers: list[str]) -> OperatorSession:
        candidates: list[str] = []
        if sum(map(len, cookie_headers)) > 8192:
            raise OperatorAuthenticationError
        for header in cookie_headers:
            for part in header.split(";"):
                name, separator, value = part.strip().partition("=")
                if name == SESSION_COOKIE:
                    if not separator or not _TOKEN.fullmatch(value):
                        raise OperatorAuthenticationError
                    candidates.append(value)
        if len(candidates) != 1:
            raise OperatorAuthenticationError
        token = candidates[0]
        token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
        async with self._sessions() as database:
            row = await database.get(OperatorSessionRow, token_hash)
        if row is None or row.revoked or row.expires_at <= int(self._now()):
            raise OperatorAuthenticationError
        return self._principal(row, token)

    @staticmethod
    def _principal(row: OperatorSessionRow, token: str) -> OperatorSession:
        return OperatorSession(
            operator_ref=row.operator_ref,
            expires_at=row.expires_at,
            token_hash=row.token_hash,
            token=token,
            csrf_token=hmac.new(
                token.encode("ascii"), b"k8s-incident-agent.operator.csrf.v1", "sha256"
            ).hexdigest(),
        )

    @staticmethod
    def require_csrf(session: OperatorSession, candidates: list[str]) -> None:
        if (
            len(candidates) != 1
            or not re.fullmatch(r"[a-f0-9]{64}", candidates[0])
            or not hmac.compare_digest(candidates[0], session.csrf_token)
        ):
            raise OperatorCsrfError

    async def renew(self, session: OperatorSession) -> OperatorSession:
        async with self._sessions.begin() as database:
            # Waiting for another writer must not preserve a pre-expiry timestamp.
            await database.execute(text("BEGIN IMMEDIATE"))
            now = int(self._now())
            expires_at = await database.scalar(
                update(OperatorSessionRow)
                .where(
                    OperatorSessionRow.token_hash == session.token_hash,
                    OperatorSessionRow.revoked.is_(False),
                    OperatorSessionRow.expires_at > now,
                )
                .values(
                    expires_at=func.max(
                        OperatorSessionRow.expires_at, now + SESSION_SECONDS
                    )
                )
                .returning(OperatorSessionRow.expires_at)
            )
        if expires_at is None:
            raise OperatorAuthenticationError
        return replace(session, expires_at=expires_at)

    async def logout(self, session: OperatorSession) -> None:
        async with self._sessions.begin() as database:
            await database.execute(
                update(OperatorSessionRow)
                .where(OperatorSessionRow.token_hash == session.token_hash)
                .values(revoked=True)
            )

    async def stream(
        self, session: OperatorSession, source: AsyncGenerator[bytes]
    ) -> AsyncIterator[bytes]:
        pending: asyncio.Future[bytes] | None = None
        try:
            while True:
                async with self._sessions() as database:
                    row = await database.get(OperatorSessionRow, session.token_hash)
                if row is None or row.revoked or row.expires_at <= int(self._now()):
                    return
                if pending is None:
                    pending = asyncio.ensure_future(anext(source))
                done, _ = await asyncio.wait({pending}, timeout=1)
                if done:
                    try:
                        chunk = pending.result()
                    except StopAsyncIteration:
                        return
                    pending = None
                    # Recheck after waiting before exposing another event.
                    async with self._sessions() as database:
                        row = await database.get(OperatorSessionRow, session.token_hash)
                    if row is None or row.revoked or row.expires_at <= int(self._now()):
                        return
                    yield chunk
        finally:
            if pending is not None:
                pending.cancel()
                with suppress(asyncio.CancelledError, StopAsyncIteration):
                    await pending
            await source.aclose()
