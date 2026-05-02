"""Tests for session store implementations."""

from __future__ import annotations

import asyncio
import os
import tempfile

import pytest

from code_review_agent.messages import (
    Role,
    ToolCall,
    assistant_message,
    system_message,
    tool_message,
    user_message,
)
from code_review_agent.runtime.types import RunEvent
from code_review_agent.session.store import (
    InMemorySessionStore,
    SessionNotFoundError,
    TurnNotFoundError,
)
from code_review_agent.session.types import SessionRecord, SessionTurn


def _make_session(**overrides) -> SessionRecord:
    defaults = dict(
        id="sess-1",
        workspace_root="/tmp/workspace",
        mode="overview",
        max_iterations=8,
    )
    defaults.update(overrides)
    return SessionRecord(**defaults)


def _make_turn(session_id: str, **overrides) -> SessionTurn:
    defaults = dict(
        id="turn-1",
        session_id=session_id,
        turn_index=0,
        user_input="hello",
    )
    defaults.update(overrides)
    return SessionTurn(**defaults)


@pytest.fixture
def mem_store() -> InMemorySessionStore:
    return InMemorySessionStore()


def _sqlite_store():
    from code_review_agent.storage.session_store import SqliteSessionStore

    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    url = f"sqlite:///{path}"
    store = SqliteSessionStore(url)

    async def _cleanup():
        await store.aclose()
        os.unlink(path)

    return store, _cleanup


class TestInMemorySessionStore:
    @pytest.mark.anyio
    async def test_create_and_get_session(self, mem_store: InMemorySessionStore):
        record = _make_session()
        created = await mem_store.create_session(record)
        assert created.id == "sess-1"
        assert created.status == "idle"

        fetched = await mem_store.get_session("sess-1")
        assert fetched is not None
        assert fetched.id == "sess-1"

    @pytest.mark.anyio
    async def test_get_nonexistent_session(self, mem_store: InMemorySessionStore):
        assert await mem_store.get_session("nope") is None

    @pytest.mark.anyio
    async def test_list_sessions(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session(id="s1"))
        await mem_store.create_session(_make_session(id="s2"))
        summaries = await mem_store.list_sessions()
        assert len(summaries) == 2
        assert {s.id for s in summaries} == {"s1", "s2"}

    @pytest.mark.anyio
    async def test_update_session(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session())
        updated = await mem_store.update_session("sess-1", status="running")
        assert updated.status == "running"

    @pytest.mark.anyio
    async def test_update_nonexistent_session(self, mem_store: InMemorySessionStore):
        with pytest.raises(SessionNotFoundError):
            await mem_store.update_session("nope", status="running")

    @pytest.mark.anyio
    async def test_archive_session(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session())
        archived = await mem_store.archive_session("sess-1")
        assert archived.status == "archived"
        assert archived.archived_at is not None

    @pytest.mark.anyio
    async def test_create_and_get_turn(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session())
        turn = _make_turn("sess-1")
        created = await mem_store.create_turn(turn)
        assert created.id == "turn-1"
        assert created.status == "queued"

        fetched = await mem_store.get_turn("turn-1")
        assert fetched is not None
        assert fetched.user_input == "hello"

    @pytest.mark.anyio
    async def test_list_turns(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session())
        await mem_store.create_turn(_make_turn("sess-1", id="t0", turn_index=0))
        await mem_store.create_turn(_make_turn("sess-1", id="t1", turn_index=1))
        turns = await mem_store.list_turns("sess-1")
        assert len(turns) == 2
        assert turns[0].turn_index == 0
        assert turns[1].turn_index == 1

    @pytest.mark.anyio
    async def test_update_turn(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session())
        await mem_store.create_turn(_make_turn("sess-1"))
        updated = await mem_store.update_turn("turn-1", status="running")
        assert updated.status == "running"

    @pytest.mark.anyio
    async def test_update_nonexistent_turn(self, mem_store: InMemorySessionStore):
        with pytest.raises(TurnNotFoundError):
            await mem_store.update_turn("nope", status="running")

    @pytest.mark.anyio
    async def test_next_turn_index(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session())
        assert await mem_store.next_turn_index("sess-1") == 0
        await mem_store.create_turn(_make_turn("sess-1", turn_index=0))
        assert await mem_store.next_turn_index("sess-1") == 1

    @pytest.mark.anyio
    async def test_append_and_get_messages(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session())
        msgs = [
            system_message("you are a reviewer"),
            user_message("check this code"),
            assistant_message("looks good"),
        ]
        await mem_store.append_messages("sess-1", msgs, turn_index=0)
        fetched = await mem_store.get_messages("sess-1")
        assert len(fetched) == 3
        assert fetched[0].role == Role.SYSTEM
        assert fetched[1].role == Role.USER
        assert fetched[2].role == Role.ASSISTANT

    @pytest.mark.anyio
    async def test_get_messages_since_sequence(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session())
        msgs = [user_message(f"msg{i}") for i in range(5)]
        await mem_store.append_messages("sess-1", msgs, turn_index=0)
        fetched = await mem_store.get_messages("sess-1", since_sequence=4)
        assert len(fetched) == 2
        assert fetched[0].content == "msg3"

    @pytest.mark.anyio
    async def test_get_message_count(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session())
        assert await mem_store.get_message_count("sess-1") == 0
        await mem_store.append_messages(
            "sess-1", [user_message("hi")], turn_index=0,
        )
        assert await mem_store.get_message_count("sess-1") == 1

    @pytest.mark.anyio
    async def test_messages_with_tool_calls(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session())
        tc = ToolCall(id="tc-1", name="read_file", arguments={"path": "a.py"})
        msgs = [assistant_message(tool_calls=[tc])]
        await mem_store.append_messages("sess-1", msgs, turn_index=0)
        fetched = await mem_store.get_messages("sess-1")
        assert len(fetched) == 1
        assert len(fetched[0].tool_calls) == 1
        assert fetched[0].tool_calls[0].name == "read_file"

    @pytest.mark.anyio
    async def test_recover_stale_sessions(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session())
        await mem_store.create_turn(
            _make_turn("sess-1", id="t0", turn_index=0, status="running"),
        )
        await mem_store.create_turn(
            _make_turn("sess-1", id="t1", turn_index=1, status="queued"),
        )
        await mem_store.update_session("sess-1", status="running")

        affected = await mem_store.recover_stale_sessions()
        assert affected == 2

        session = await mem_store.get_session("sess-1")
        assert session.status == "idle"

        t0 = await mem_store.get_turn("t0")
        assert t0.status == "failed"
        assert t0.failure_reason == "server_restarted_during_turn"

        t1 = await mem_store.get_turn("t1")
        assert t1.status == "failed"

    @pytest.mark.anyio
    async def test_append_and_get_turn_events(self, mem_store: InMemorySessionStore):
        await mem_store.create_session(_make_session())
        await mem_store.create_turn(_make_turn("sess-1"))
        await mem_store.append_turn_event(
            "turn-1",
            RunEvent(
                index=1,
                type="model_response",
                event_type="model.response",
                payload={"message": "first"},
            ),
        )
        await mem_store.append_turn_event(
            "turn-1",
            RunEvent(
                index=2,
                type="tool_result",
                event_type="tool.finished",
                payload={"tool_name": "read_file"},
            ),
        )

        events = await mem_store.get_turn_events("turn-1", after_index=1, limit=1)

        assert len(events) == 1
        assert events[0].index == 2
        assert events[0].event_type == "tool.finished"
        assert events[0].payload["tool_name"] == "read_file"


class TestSqliteSessionStore:
    @pytest.mark.anyio
    async def test_create_and_get_session(self):
        store, cleanup = _sqlite_store()
        try:
            record = _make_session()
            created = await store.create_session(record)
            assert created.id == "sess-1"
            assert created.status == "idle"

            fetched = await store.get_session("sess-1")
            assert fetched is not None
            assert fetched.id == "sess-1"
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_list_sessions(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session(id="s1"))
            await store.create_session(_make_session(id="s2"))
            summaries = await store.list_sessions()
            assert len(summaries) == 2
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_update_session(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session())
            updated = await store.update_session("sess-1", status="running", last_user_input="hi")
            assert updated.status == "running"
            assert updated.last_user_input == "hi"
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_archive_session(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session())
            archived = await store.archive_session("sess-1")
            assert archived.status == "archived"
            assert archived.archived_at is not None
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_create_and_get_turn(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session())
            turn = _make_turn("sess-1")
            created = await store.create_turn(turn)
            assert created.id == "turn-1"

            fetched = await store.get_turn("turn-1")
            assert fetched is not None
            assert fetched.user_input == "hello"
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_list_turns(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session())
            await store.create_turn(_make_turn("sess-1", id="t0", turn_index=0))
            await store.create_turn(_make_turn("sess-1", id="t1", turn_index=1))
            turns = await store.list_turns("sess-1")
            assert len(turns) == 2
            assert turns[0].turn_index == 0
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_update_turn(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session())
            await store.create_turn(_make_turn("sess-1"))
            updated = await store.update_turn("turn-1", status="completed")
            assert updated.status == "completed"
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_next_turn_index(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session())
            assert await store.next_turn_index("sess-1") == 0
            await store.create_turn(_make_turn("sess-1", turn_index=0))
            assert await store.next_turn_index("sess-1") == 1
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_append_and_get_messages(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session())
            msgs = [
                system_message("you are a reviewer"),
                user_message("check this"),
                assistant_message("ok"),
            ]
            await store.append_messages("sess-1", msgs, turn_index=0)
            fetched = await store.get_messages("sess-1")
            assert len(fetched) == 3
            assert fetched[0].role == Role.SYSTEM
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_get_messages_since_sequence(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session())
            msgs = [user_message(f"msg{i}") for i in range(5)]
            await store.append_messages("sess-1", msgs, turn_index=0)
            fetched = await store.get_messages("sess-1", since_sequence=4)
            assert len(fetched) == 2
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_messages_with_tool_calls_and_raw(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session())
            tc = ToolCall(id="tc-1", name="read_file", arguments={"path": "a.py"}, raw_arguments='{"path":"a.py"}')
            msgs = [
                assistant_message(tool_calls=[tc], raw={"model": "deepseek-chat"}),
            ]
            await store.append_messages("sess-1", msgs, turn_index=0)
            fetched = await store.get_messages("sess-1")
            assert len(fetched) == 1
            assert len(fetched[0].tool_calls) == 1
            assert fetched[0].tool_calls[0].raw_arguments == '{"path":"a.py"}'
            assert fetched[0].raw == {"model": "deepseek-chat"}
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_recover_stale_sessions(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session())
            await store.create_turn(
                _make_turn("sess-1", id="t0", turn_index=0, status="running"),
            )
            await store.update_session("sess-1", status="running")

            affected = await store.recover_stale_sessions()
            assert affected >= 1

            session = await store.get_session("sess-1")
            assert session.status == "idle"

            t0 = await store.get_turn("t0")
            assert t0.status == "failed"
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_get_message_count(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session())
            assert await store.get_message_count("sess-1") == 0
            await store.append_messages("sess-1", [user_message("hi")], turn_index=0)
            assert await store.get_message_count("sess-1") == 1
        finally:
            await cleanup()

    @pytest.mark.anyio
    async def test_append_and_get_turn_events(self):
        store, cleanup = _sqlite_store()
        try:
            await store.create_session(_make_session())
            await store.create_turn(_make_turn("sess-1"))
            await store.append_turn_event(
                "turn-1",
                RunEvent(
                    index=1,
                    type="model_response",
                    event_type="model.response",
                    payload={"message": "first"},
                    duration_ms=10,
                ),
            )
            await store.append_turn_event(
                "turn-1",
                RunEvent(
                    index=2,
                    type="tool_result",
                    event_type="tool.finished",
                    payload={"tool_name": "search_text"},
                    duration_ms=5,
                ),
            )

            events = await store.get_turn_events("turn-1", after_index=0, limit=2)

            assert [event.index for event in events] == [1, 2]
            assert events[0].event_type == "model.response"
            assert events[1].payload["tool_name"] == "search_text"
        finally:
            await cleanup()
