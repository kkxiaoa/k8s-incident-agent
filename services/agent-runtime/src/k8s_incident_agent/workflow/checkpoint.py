import errno
import os
import stat
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

import aiosqlite
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from k8s_incident_agent.runtime.paths import (
    PRIVATE_FILE_MODE,
    validate_existing_private_file,
)


def _prepare_checkpoint_file(path: Path) -> None:
    validate_existing_private_file(path)
    flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, PRIVATE_FILE_MODE)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ValueError(
                "Checkpoint database must not be a symbolic link"
            ) from error
        raise
    try:
        file_stat = os.fstat(descriptor)
        if (
            not stat.S_ISREG(file_stat.st_mode)
            or stat.S_IMODE(file_stat.st_mode) != PRIVATE_FILE_MODE
        ):
            raise ValueError("Checkpoint database must be a private regular file")
    finally:
        os.close(descriptor)


@asynccontextmanager
async def open_checkpoint_store(path: Path) -> AsyncGenerator[AsyncSqliteSaver]:
    _prepare_checkpoint_file(path)
    async with aiosqlite.connect(path) as connection:
        saver = AsyncSqliteSaver(
            connection,
            serde=JsonPlusSerializer(
                pickle_fallback=False,
                allowed_msgpack_modules=None,
            ),
        )
        await saver.setup()
        validate_existing_private_file(path)
        yield saver
