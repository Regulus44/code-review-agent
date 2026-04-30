"""Tests for Session API endpoints."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from code_review_agent.api.app import create_app


@pytest.fixture
async def client():
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.mark.anyio
async def test_create_session(client: AsyncClient):
    resp = await client.post("/sessions", json={
        "workspace_root": ".",
        "mode": "overview",
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
        "workspace_root": ".", "mode": "overview",
    })
    resp = await client.get("/sessions")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1


@pytest.mark.anyio
async def test_get_session(client: AsyncClient):
    create_resp = await client.post("/sessions", json={
        "workspace_root": ".", "mode": "overview",
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
        "workspace_root": ".", "mode": "overview", "max_iterations": 2,
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
        "workspace_root": ".", "mode": "overview",
    })
    session_id = create_resp.json()["id"]

    resp = await client.post(f"/sessions/{session_id}/turns", json={})
    assert resp.status_code == 400


@pytest.mark.anyio
async def test_list_turns(client: AsyncClient):
    create_resp = await client.post("/sessions", json={
        "workspace_root": ".", "mode": "overview", "max_iterations": 2,
    })
    session_id = create_resp.json()["id"]

    resp = await client.get(f"/sessions/{session_id}/turns")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.anyio
async def test_get_messages(client: AsyncClient):
    create_resp = await client.post("/sessions", json={
        "workspace_root": ".", "mode": "overview",
    })
    session_id = create_resp.json()["id"]

    resp = await client.get(f"/sessions/{session_id}/messages")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.anyio
async def test_archive_session(client: AsyncClient):
    create_resp = await client.post("/sessions", json={
        "workspace_root": ".", "mode": "overview",
    })
    session_id = create_resp.json()["id"]

    resp = await client.delete(f"/sessions/{session_id}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "archived"


@pytest.mark.anyio
async def test_health_still_works(client: AsyncClient):
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
