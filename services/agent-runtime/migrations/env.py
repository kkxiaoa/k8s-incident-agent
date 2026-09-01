from alembic import context
from sqlalchemy import Connection, create_engine
from sqlalchemy.engine import URL

from k8s_incident_agent.config import Settings
from k8s_incident_agent.persistence.database import (
    configure_sqlite_engine,
    prepare_business_database_file,
)
from k8s_incident_agent.persistence.models import Base
from k8s_incident_agent.runtime.lock import RuntimeLock
from k8s_incident_agent.runtime.paths import (
    FilesystemIdentity,
    RuntimePaths,
    require_filesystem_identity,
)

config = context.config
target_metadata = Base.metadata


def _runtime_paths() -> RuntimePaths:
    configured_paths = config.attributes.get("runtime_paths")
    if configured_paths is None:
        return Settings().runtime_paths
    if not isinstance(configured_paths, RuntimePaths):
        raise TypeError("runtime_paths Alembic attribute must be RuntimePaths")
    return configured_paths


def run_migrations_online() -> None:
    paths = _runtime_paths()
    configured_lock = config.attributes.get("caller_runtime_lock")
    expected_root = config.attributes.get("expected_runtime_root_identity")
    reset_connection = config.attributes.get("reset_connection")
    if reset_connection is not None:
        if not isinstance(reset_connection, Connection):
            raise TypeError("reset_connection Alembic attribute must be Connection")
        if not isinstance(configured_lock, RuntimeLock):
            raise RuntimeError("Reset migration requires a caller-held Runtime lock")
        if not isinstance(expected_root, FilesystemIdentity):
            raise TypeError("expected_runtime_root_identity must be FilesystemIdentity")
        _run_reset_migrations(
            paths,
            configured_lock,
            expected_root,
            reset_connection,
        )
        return

    if configured_lock is not None or expected_root is not None:
        raise TypeError("Reset migration attributes must be configured together")

    lock = RuntimeLock(paths.runtime_lock)
    lock.acquire()

    try:
        prepare_business_database_file(paths)
        engine = create_engine(
            URL.create(drivername="sqlite", database=str(paths.business_database))
        )
        configure_sqlite_engine(engine, paths)
        try:
            with engine.connect() as connection:
                context.configure(
                    connection=connection, target_metadata=target_metadata
                )
                with context.begin_transaction():
                    context.run_migrations()
        finally:
            engine.dispose()
    finally:
        lock.release()


def _run_reset_migrations(
    paths: RuntimePaths,
    lock: RuntimeLock,
    expected_root: FilesystemIdentity,
    connection: Connection,
) -> None:
    _require_reset_migration_guard(paths, lock, expected_root)
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        _require_reset_migration_guard(paths, lock, expected_root)
        context.run_migrations()
        _require_reset_migration_guard(paths, lock, expected_root)
    _require_reset_migration_guard(paths, lock, expected_root)


def _require_reset_migration_guard(
    paths: RuntimePaths,
    lock: RuntimeLock,
    expected_root: FilesystemIdentity,
) -> None:
    lock.require_held(paths.runtime_lock)
    require_filesystem_identity(paths.root, expected_root)


if context.is_offline_mode():
    raise RuntimeError("Offline migrations are not supported")

run_migrations_online()
