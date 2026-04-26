"""Tests for the SQLite runtime store."""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("aiosqlite")

from code_review_agent.harness import AgentRunResult
from code_review_agent.messages import assistant_message
from code_review_agent.runtime import RunEvent, RunRecord
from code_review_agent.storage import SqliteRunStore


@pytest.fixture
def anyio_backend() -> str:
    """Run AnyIO tests on asyncio only."""
    return "asyncio"


def make_database_url(db_path: Path) -> str:
    return f"sqlite+aiosqlite:///{db_path.as_posix()}"


@pytest.mark.anyio
async def test_sqlite_store_persists_runs_and_events(tmp_path: Path) -> None:
    db_path = tmp_path / "runtime.db"
    database_url = make_database_url(db_path)

    run = RunRecord(
        id="run_one",
        status="queued",
        user_input="inspect repo",
        workspace_root=str(tmp_path),
        max_iterations=8,
        provider="deepseek",
        model="deepseek-chat",
        tool_names=["list_files", "read_file"],
    )
    event = RunEvent(
        index=1,
        type="status_change",
        event_type="run.queued",
        data={"status": "queued"},
        payload={"status": "queued"},
        trace_id="trace_1",
        span_id="span_1",
        parent_span_id=None,
        status="queued",
        duration_ms=12,
    )

    store = SqliteRunStore(database_url)
    await store.create_run(run)
    await store.append_event(run.id, event)
    await store.update_status(run.id, "running")
    await store.attach_result(
        run.id,
        AgentRunResult(
            status="completed",
            final_message=assistant_message(content="done"),
        ),
    )
    await store.update_status(run.id, "completed")
    await store.aclose()

    reloaded = SqliteRunStore(database_url)
    loaded_run = await reloaded.get_run(run.id)
    loaded_events = await reloaded.get_events(run.id)
    await reloaded.aclose()

    assert loaded_run.status == "completed"
    assert loaded_run.provider == "deepseek"
    assert loaded_run.model == "deepseek-chat"
    assert loaded_run.tool_names == ["list_files", "read_file"]
    assert loaded_run.result is not None
    assert loaded_run.result.final_message is not None
    assert loaded_run.result.final_message.content == "done"
    assert [item.type for item in loaded_events] == ["status_change"]
    assert loaded_events[0].event_type == "run.queued"
    assert loaded_events[0].trace_id == "trace_1"
    assert loaded_events[0].span_id == "span_1"
    assert loaded_events[0].duration_ms == 12


@pytest.mark.anyio
async def test_sqlite_store_lists_runs_in_reverse_creation_order(tmp_path: Path) -> None:
    db_path = tmp_path / "runtime.db"
    store = SqliteRunStore(make_database_url(db_path))

    run_one = RunRecord(
        id="run_one",
        status="queued",
        user_input="one",
        workspace_root=str(tmp_path),
        max_iterations=8,
    )
    run_two = RunRecord(
        id="run_two",
        status="queued",
        user_input="two",
        workspace_root=str(tmp_path),
        max_iterations=8,
    )

    await store.create_run(run_one)
    await store.create_run(run_two)
    runs = await store.list_runs()
    await store.aclose()

    assert [item.id for item in runs] == ["run_two", "run_one"]
