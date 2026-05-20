"""Tests for Session API endpoints."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from code_review_agent.api.app import create_app
from code_review_agent.models import ModelUsage
from code_review_agent.runtime.types import RunEvent, utc_now
from code_review_agent.session.store import InMemorySessionStore
from code_review_agent.session.types import SessionRecord, SessionTurn


@pytest.fixture
async def client():
    app = create_app(
        session_store=InMemorySessionStore(),
        enable_skill_routing=False,
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.mark.anyio
async def test_create_session(client: AsyncClient):
    resp = await client.post("/sessions", json={
        "workspace_root": ".",
        "max_iterations": 8,
    })
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "idle"
    assert data["mode"] == "overview"
    assert data["id"]


@pytest.mark.anyio
async def test_list_sessions(client: AsyncClient):
    await client.post("/sessions", json={
        "workspace_root": ".",
    })
    resp = await client.get("/sessions")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1


@pytest.mark.anyio
async def test_get_session(client: AsyncClient):
    create_resp = await client.post("/sessions", json={
        "workspace_root": ".",
    })
    session_id = create_resp.json()["id"]

    resp = await client.get(f"/sessions/{session_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == session_id


@pytest.mark.anyio
async def test_get_nonexistent_session(client: AsyncClient):
    resp = await client.get("/sessions/nope")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_create_turn(client: AsyncClient):
    create_resp = await client.post("/sessions", json={
        "workspace_root": ".", "max_iterations": 2,
    })
    session_id = create_resp.json()["id"]

    resp = await client.post(f"/sessions/{session_id}/turns", json={
        "message": "hello",
    })
    assert resp.status_code == 202
    data = resp.json()
    assert data["session_id"] == session_id
    assert data["user_input"] == "hello"
    assert data["turn_index"] == 0


@pytest.mark.anyio
async def test_create_turn_missing_message(client: AsyncClient):
    create_resp = await client.post("/sessions", json={
        "workspace_root": ".",
    })
    session_id = create_resp.json()["id"]

    resp = await client.post(f"/sessions/{session_id}/turns", json={})
    assert resp.status_code == 422


@pytest.mark.anyio
async def test_list_turns(client: AsyncClient):
    create_resp = await client.post("/sessions", json={
        "workspace_root": ".", "max_iterations": 2,
    })
    session_id = create_resp.json()["id"]

    resp = await client.get(f"/sessions/{session_id}/turns")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.anyio
async def test_get_messages(client: AsyncClient):
    create_resp = await client.post("/sessions", json={
        "workspace_root": ".",
    })
    session_id = create_resp.json()["id"]

    resp = await client.get(f"/sessions/{session_id}/messages")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.anyio
async def test_archive_session(client: AsyncClient):
    create_resp = await client.post("/sessions", json={
        "workspace_root": ".",
    })
    session_id = create_resp.json()["id"]

    resp = await client.delete(f"/sessions/{session_id}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "archived"


@pytest.mark.anyio
async def test_get_turn_events_strips_and_truncates_payload():
    store = InMemorySessionStore()
    await store.create_session(
        SessionRecord(id="sess-events", workspace_root=".", mode="overview"),
    )
    await store.create_turn(
        SessionTurn(
            id="turn-events",
            session_id="sess-events",
            turn_index=0,
            user_input="hello",
            status="running",
        ),
    )
    await store.append_turn_event(
        "turn-events",
        RunEvent(
            index=1,
            type="model_response",
            event_type="model.response",
            payload={"text": "abcdefghij"},
        ),
    )

    app = create_app(session_store=store, enable_skill_routing=False)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        stripped = await ac.get("/sessions/sess-events/turns/turn-events/events")
        assert stripped.status_code == 200
        assert stripped.json()[0]["payload"] == {}
        assert stripped.json()[0]["data"] == {}

        truncated = await ac.get(
            "/sessions/sess-events/turns/turn-events/events"
            "?include_payload=true&max_payload_chars=4",
        )
        assert truncated.status_code == 200
        assert truncated.json()[0]["payload"]["text"] == "abcd"


@pytest.mark.anyio
async def test_get_turn_events_rejects_wrong_session():
    store = InMemorySessionStore()
    await store.create_session(
        SessionRecord(id="sess-a", workspace_root=".", mode="overview"),
    )
    await store.create_session(
        SessionRecord(id="sess-b", workspace_root=".", mode="overview"),
    )
    await store.create_turn(
        SessionTurn(
            id="turn-a",
            session_id="sess-a",
            turn_index=0,
            user_input="hello",
        ),
    )

    app = create_app(session_store=store, enable_skill_routing=False)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/sessions/sess-b/turns/turn-a/events")

    assert response.status_code == 404


@pytest.mark.anyio
async def test_get_turn_diagnostics_allows_running_turn():
    store = InMemorySessionStore()
    usage = ModelUsage(prompt_tokens=10, completion_tokens=2, total_tokens=12)
    now = utc_now()
    await store.create_session(
        SessionRecord(id="sess-diag", workspace_root=".", mode="overview"),
    )
    await store.create_turn(
        SessionTurn(
            id="turn-diag",
            session_id="sess-diag",
            turn_index=0,
            user_input="hello",
            status="running",
            usage_json=usage.model_dump_json(),
            started_at=now,
        ),
    )
    await store.append_turn_event(
        "turn-diag",
        RunEvent(
            index=1,
            type="model_response",
            event_type="model.response",
            payload={"provider": "fake", "model": "fake-model", "iteration": 0},
            duration_ms=7,
        ),
    )

    app = create_app(session_store=store, enable_skill_routing=False)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/sessions/sess-diag/turns/turn-diag/diagnostics")

    assert response.status_code == 200
    data = response.json()
    assert data["model_call_count"] == 1
    assert data["tool_call_count"] == 0
    assert data["iterations"] == 1
    assert data["token_usage"]["total_tokens"] == 12


@pytest.mark.anyio
async def test_health_still_works(client: AsyncClient):
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
