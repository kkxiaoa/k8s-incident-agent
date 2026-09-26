import errno
import os
import stat
from dataclasses import dataclass
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, Engine, event, inspect, text
from sqlalchemy.engine import URL
from sqlalchemy.engine.interfaces import DBAPIConnection
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import ConnectionPoolEntry

from k8s_incident_agent.runtime.paths import (
    PRIVATE_FILE_MODE,
    RuntimePaths,
    sqlite_sidecars,
    validate_existing_private_file,
)

_SERVICE_ROOT = Path(__file__).resolve().parents[3]


class DatabaseSchemaNotCurrentError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class BusinessDatabase:
    engine: AsyncEngine
    session_factory: async_sessionmaker[AsyncSession]

    async def dispose(self) -> None:
        await self.engine.dispose()


def prepare_business_database_file(paths: RuntimePaths) -> None:
    for sidecar in sqlite_sidecars(paths.business_database):
        validate_existing_private_file(sidecar)

    flags = os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW
    try:
        file_descriptor = os.open(
            paths.business_database,
            flags,
            PRIVATE_FILE_MODE,
        )
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ValueError("Business database must not be a symbolic link") from error
        raise
    try:
        file_stat = os.fstat(file_descriptor)
        if (
            not stat.S_ISREG(file_stat.st_mode)
            or stat.S_IMODE(file_stat.st_mode) != PRIVATE_FILE_MODE
        ):
            raise ValueError("Business database must be a private regular file")
    finally:
        os.close(file_descriptor)


def configure_sqlite_engine(engine: Engine, paths: RuntimePaths) -> None:
    def configure_connection(
        dbapi_connection: DBAPIConnection,
        _connection_record: ConnectionPoolEntry,
    ) -> None:
        for sidecar in sqlite_sidecars(paths.business_database):
            validate_existing_private_file(sidecar)
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys = ON")
            cursor.execute("PRAGMA journal_mode = WAL")
            journal_mode = cursor.fetchone()
            if journal_mode is None or str(journal_mode[0]).lower() != "wal":
                raise RuntimeError("SQLite WAL mode is required")
        finally:
            cursor.close()

        validate_existing_private_file(paths.business_database)
        for sidecar in sqlite_sidecars(paths.business_database):
            validate_existing_private_file(sidecar)

    event.listen(engine, "connect", configure_connection)


async def create_business_database(paths: RuntimePaths) -> BusinessDatabase:
    prepare_business_database_file(paths)
    engine = create_async_engine(
        URL.create(
            drivername="sqlite+aiosqlite",
            database=str(paths.business_database),
        )
    )
    configure_sqlite_engine(engine.sync_engine, paths)
    database = BusinessDatabase(
        engine=engine,
        session_factory=async_sessionmaker(engine, expire_on_commit=False),
    )
    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
    except BaseException:
        await engine.dispose()
        raise
    return database


def alembic_script_directory() -> ScriptDirectory:
    return ScriptDirectory.from_config(Config(str(_SERVICE_ROOT / "alembic.ini")))


async def require_alembic_head(database: BusinessDatabase) -> None:
    expected_heads = set(alembic_script_directory().get_heads())
    async with database.engine.connect() as connection:
        has_version_table = await connection.run_sync(_has_alembic_version_table)
        if not has_version_table:
            raise DatabaseSchemaNotCurrentError(
                "Business database schema is not at the required Alembic head"
            )
        result = await connection.execute(
            text("SELECT version_num FROM alembic_version")
        )
        actual_heads = {str(version) for version in result.scalars()}

    if actual_heads != expected_heads:
        raise DatabaseSchemaNotCurrentError(
            "Business database schema is not at the required Alembic head"
        )


def _has_alembic_version_table(connection: Connection) -> bool:
    return inspect(connection).has_table("alembic_version")
