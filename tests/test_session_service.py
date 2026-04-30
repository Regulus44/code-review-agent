"""Tests for SessionService."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from code_review_agent.harness.types import AgentRunResult, AgentRunStatus
from code_review_agent.messages import assistant_message, system_message, user_message
from code_review_agent.models import ModelUsage
from code_review_agent.runtime.session_service import (
    SessionConflictError,
    SessionService,
)
from code_review_agent.session.store import InMemorySessionStore, SessionNotFoundError
from code_review_agent.session.types import SessionRecord
from code_review_agent.tools import ToolRegistry


def _make_store() -> InMemorySessionStore:
    return InMemorySessionStore()


def _make_service(store=None) -> SessionService:
    store = store or _make_store()
    mock_model = AsyncMock()

    def model_factory(provider=None, model_name=None):
        return mock_model

    def tool_registry_factory():
        return ToolRegistry()

    return SessionService(
        store=store,
        model_factory=model_factory,
        tool_registry_factory=tool_registry_factory,
    )


async def _create_session_with_store(store, **overrides):
    defaults = dict(
        id="sess-1",
        workspace_root=".",
        mode="overview",
        max_iterations=2,
    )
    defaults.update(overrides)
    return await store.create_session(SessionRecord(**defaults))


class TestSessionServiceCreateSession:
    @pytest.mark.anyio
    async def test_create_session(self):
        svc = _make_service()
        record = await svc.create_session(
            workspace_root=".", mode="overview", max_iterations=8,
        )
        assert record.id
        assert record.status == "idle"
        assert record.mode == "overview"

    @pytest.mark.anyio
    async def test_create_session_with_id(self):
        svc = _make_service()
        record = await svc.create_session(
            id="custom-id", workspace_root=".", mode="review",
        )
        assert record.id == "custom-id"


class TestSessionServiceGetAndList:
    @pytest.mark.anyio
    async def test_get_session(self):
        store = _make_store()
        svc = _make_service(store)
        await _create_session_with_store(store)
        fetched = await svc.get_session("sess-1")
        assert fetched is not None
        assert fetched.id == "sess-1"

    @pytest.mark.anyio
    async def test_get_nonexistent_session(self):
        svc = _make_service()
        assert await svc.get_session("nope") is None

    @pytest.mark.anyio
    async def test_list_sessions(self):
        store = _make_store()
        svc = _make_service(store)
        await _create_session_with_store(store, id="s1")
        await _create_session_with_store(store, id="s2")
        summaries = await svc.list_sessions()
        assert len(summaries) == 2

    @pytest.mark.anyio
    async def test_archive_session(self):
        store = _make_store()
        svc = _make_service(store)
        await _create_session_with_store(store)
        archived = await svc.archive_session("sess-1")
        assert archived.status == "archived"


class TestSessionServiceTurns:
    @pytest.mark.anyio
    async def test_start_turn_creates_turn(self):
        store = _make_store()
        svc = _make_service(store)
        await _create_session_with_store(store)

        turn = await svc.start_turn("sess-1", "hello")
        assert turn.session_id == "sess-1"
        assert turn.user_input == "hello"
        assert turn.status == "queued"
        assert turn.turn_index == 0

        await asyncio.sleep(0.2)

        turns = await svc.list_turns("sess-1")
        assert len(turns) >= 1

    @pytest.mark.anyio
    async def test_start_turn_on_archived_session_fails(self):
        store = _make_store()
        svc = _make_service(store)
        await _create_session_with_store(store)
        await svc.archive_session("sess-1")

        with pytest.raises(SessionConflictError):
            await svc.start_turn("sess-1", "hello")

    @pytest.mark.anyio
    async def test_start_turn_on_nonexistent_session_fails(self):
        svc = _make_service()
        with pytest.raises(SessionNotFoundError):
            await svc.start_turn("nope", "hello")

    @pytest.mark.anyio
    async def test_concurrent_turn_fails(self):
        store = _make_store()
        svc = _make_service(store)
        await _create_session_with_store(store, max_iterations=100)

        await svc.start_turn("sess-1", "first")
        with pytest.raises(SessionConflictError):
            await svc.start_turn("sess-1", "second")

        await asyncio.sleep(0.5)

    @pytest.mark.anyio
    async def test_cancel_nonexistent_turn(self):
        store = _make_store()
        svc = _make_service(store)
        await _create_session_with_store(store)
        from code_review_agent.session.store import TurnNotFoundError
        with pytest.raises(TurnNotFoundError):
            await svc.cancel_turn("sess-1", "nope")


class TestSessionServiceRecovery:
    @pytest.mark.anyio
    async def test_recover_stale_sessions(self):
        store = _make_store()
        svc = _make_service(store)
        await _create_session_with_store(store)
        await store.update_session("sess-1", status="running")

        affected = await svc.recover_stale_sessions()
        assert affected >= 0

        session = await store.get_session("sess-1")
        assert session.status == "idle"
