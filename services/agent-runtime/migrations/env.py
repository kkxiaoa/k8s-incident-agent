from alembic import context
from sqlalchemy import create_engine
from sqlalchemy.engine import URL

from k8s_incident_agent.config import Settings
from k8s_incident_agent.persistence.database import (
    configure_sqlite_engine,
    prepare_business_database_file,
)
from k8s_incident_agent.persistence.models import Base
from k8s_incident_agent.runtime.lock import RuntimeLock
from k8s_incident_agent.runtime.paths import RuntimePaths

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


if context.is_offline_mode():
    raise RuntimeError("Offline migrations are not supported")

run_migrations_online()
