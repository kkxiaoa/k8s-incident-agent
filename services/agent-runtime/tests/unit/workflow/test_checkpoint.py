from dataclasses import dataclass
from pathlib import Path

import aiosqlite
import pytest
from langchain_core.messages import HumanMessage
from langchain_core.runnables.config import RunnableConfig
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import (  # pyright: ignore[reportMissingTypeStubs]
    END,
    START,
    StateGraph,
)
from langgraph.graph.state import (  # pyright: ignore[reportMissingTypeStubs]
    CompiledStateGraph,
)
from typing_extensions import TypedDict

from k8s_incident_agent.workflow.checkpoint import open_checkpoint_store


class _CheckpointState(TypedDict, total=False):
    run_id: str
    message: HumanMessage
    target: dict[str, str]
    unexpected: object


@dataclass(frozen=True)
class _UnexpectedCheckpointType:
    value: str


def _safe_graph(
    checkpointer: AsyncSqliteSaver,
) -> CompiledStateGraph[
    _CheckpointState,
    None,
    _CheckpointState,
    _CheckpointState,
]:
    async def project(state: _CheckpointState) -> _CheckpointState:
        del state
        return {
            "message": HumanMessage(content="safe trigger"),
            "target": {"kind": "Deployment", "name": "broken-image"},
        }

    builder = StateGraph(_CheckpointState)
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "project", project
    )
    builder.add_edge(START, "project")
    builder.add_edge("project", END)
    return builder.compile(  # pyright: ignore[reportUnknownMemberType]
        checkpointer=checkpointer
    )


def _custom_type_graph(
    checkpointer: AsyncSqliteSaver,
) -> CompiledStateGraph[
    _CheckpointState,
    None,
    _CheckpointState,
    _CheckpointState,
]:
    async def preserve(state: _CheckpointState) -> dict[str, object]:
        del state
        return {}

    builder = StateGraph(_CheckpointState)
    builder.add_node(  # pyright: ignore[reportUnknownMemberType]
        "preserve", preserve
    )
    builder.add_edge(START, "preserve")
    builder.add_edge("preserve", END)
    return builder.compile(  # pyright: ignore[reportUnknownMemberType]
        checkpointer=checkpointer
    )


@pytest.mark.asyncio
async def test_checkpoint_store_reopens_safe_state_with_package_tables_only(
    tmp_path: Path,
) -> None:
    checkpoint_path = tmp_path / "checkpoints.sqlite3"
    config: RunnableConfig = {"configurable": {"thread_id": "run-1"}}

    async with open_checkpoint_store(checkpoint_path) as saver:
        graph = _safe_graph(saver)
        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"run_id": "run-1"},
            config,
            durability="sync",
        )

    assert checkpoint_path.stat().st_mode & 0o777 == 0o600
    async with aiosqlite.connect(checkpoint_path) as connection:
        cursor = await connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )
        table_names = {str(row[0]) for row in await cursor.fetchall()}
    assert table_names == {"checkpoints", "writes"}

    async with open_checkpoint_store(checkpoint_path) as saver:
        graph = _safe_graph(saver)
        state = await graph.aget_state(config)

    assert state.values == {
        "run_id": "run-1",
        "message": HumanMessage(content="safe trigger"),
        "target": {"kind": "Deployment", "name": "broken-image"},
    }


@pytest.mark.asyncio
async def test_checkpoint_store_does_not_reconstruct_unapproved_custom_type(
    tmp_path: Path,
) -> None:
    checkpoint_path = tmp_path / "checkpoints.sqlite3"
    config: RunnableConfig = {"configurable": {"thread_id": "custom-type"}}

    async with open_checkpoint_store(checkpoint_path) as saver:
        graph = _custom_type_graph(saver)
        await graph.ainvoke(  # pyright: ignore[reportUnknownMemberType]
            {"unexpected": _UnexpectedCheckpointType(value="safe value")},
            config,
            durability="sync",
        )

    async with open_checkpoint_store(checkpoint_path) as saver:
        graph = _custom_type_graph(saver)
        state = await graph.aget_state(config)

    assert state.values["unexpected"] == {"value": "safe value"}
    assert not isinstance(
        state.values["unexpected"],
        _UnexpectedCheckpointType,
    )


@pytest.mark.asyncio
async def test_checkpoint_store_rejects_symlink_and_non_private_file(
    tmp_path: Path,
) -> None:
    target = tmp_path / "target.sqlite3"
    target.touch(mode=0o600)
    symlink = tmp_path / "link.sqlite3"
    symlink.symlink_to(target)

    with pytest.raises(ValueError, match="private regular file"):
        async with open_checkpoint_store(symlink):
            pass

    target.chmod(0o644)
    with pytest.raises(ValueError, match="private regular file"):
        async with open_checkpoint_store(target):
            pass
