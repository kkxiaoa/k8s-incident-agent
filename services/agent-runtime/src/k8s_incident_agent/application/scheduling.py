from collections.abc import Awaitable
from contextlib import suppress
from typing import Protocol
from uuid import UUID


class RunScheduler(Protocol):
    def schedule(self, run_id: UUID) -> Awaitable[None]: ...


async def schedule_committed_run(scheduler: RunScheduler, run_id: UUID) -> None:
    # Startup queued-Run reconciliation is the durable recovery path.
    with suppress(Exception):
        await scheduler.schedule(run_id)
