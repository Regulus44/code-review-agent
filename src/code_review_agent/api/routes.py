"""API routes for the minimal runtime."""

from __future__ import annotations

import ipaddress
import json
import os
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from code_review_agent.apps.repo_analyst import RepoAnalystRequest, RepoAnalystService
from code_review_agent.models import ModelProviderDescriptor, list_model_providers
from code_review_agent.runtime import (
    AgentRuntime,
    CreateRunRequest,
    RunAlreadyTerminalError,
    RunNotFoundError,
    WorkspaceValidationError,
)
from code_review_agent.runtime.types import RunEvent
from code_review_agent.runtime.session_service import (
    SessionConflictError,
    SessionService,
)
from code_review_agent.session.store import (
    SessionNotFoundError as AppSessionNotFoundError,
    TurnNotFoundError,
)
from code_review_agent.session.types import RepoAnalystMode
from code_review_agent.settings import get_settings
from code_review_agent.tools import ToolDescriptor

router = APIRouter()
UI_INDEX_PATH = Path(__file__).resolve().parent.parent / "web" / "index.html"


def get_runtime(request: Request) -> AgentRuntime:
    """Get the runtime service from application state."""
    return request.app.state.runtime


def get_repo_analyst_service(request: Request) -> RepoAnalystService:
    """Get the repo analyst service from application state."""
    return request.app.state.repo_analyst_service


def get_session_service(request: Request) -> SessionService:
    """Get the session service from application state."""
    return request.app.state.session_service


def _request_host(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return ""


def _is_loopback_host(host: str) -> bool:
    if not host:
        return False
    if host in {"localhost", "testclient"}:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _enforce_api_key(request: Request) -> None:
    configured_api_key = getattr(request.app.state, "api_key", None)
    if not configured_api_key:
        return

    if _is_loopback_host(_request_host(request)):
        return

    provided_key = request.headers.get("x-api-key")
    if provided_key != configured_api_key:
        raise HTTPException(status_code=401, detail="invalid or missing API key")


@router.get("/health")
async def health() -> dict[str, str]:
    """Simple health endpoint."""
    return {"status": "ok"}


@router.get("/debug/runtime-config")
async def debug_runtime_config(request: Request):
    """Return non-sensitive runtime configuration for local debugging."""
    _enforce_api_key(request)
    settings = get_settings()
    return {
        "default_provider": settings.default_provider,
        "default_model": settings.default_model,
        "deepseek_base_url": settings.deepseek_base_url,
        "runtime_workspace_root": settings.runtime_workspace_root,
        "pid": os.getpid(),
        "cwd": str(Path.cwd()),
    }


@router.get("/", include_in_schema=False)
async def index() -> FileResponse:
    """Serve the built-in repo analyst UI."""
    return FileResponse(UI_INDEX_PATH)


@router.get("/runs")
async def list_runs(request: Request):
    """List all runs."""
    _enforce_api_key(request)
    runtime = get_runtime(request)
    return await runtime.list_runs()


@router.get("/tools", response_model=list[ToolDescriptor])
async def list_tools(request: Request) -> list[ToolDescriptor]:
    """List tools exposed by the current runtime registry."""
    _enforce_api_key(request)
    runtime = get_runtime(request)
    return runtime.list_tools()


@router.get("/models/providers", response_model=list[ModelProviderDescriptor])
async def list_providers(request: Request) -> list[ModelProviderDescriptor]:
    """List model providers and model names known to the runtime."""
    _enforce_api_key(request)
    return list_model_providers()


@router.post("/runs", status_code=status.HTTP_202_ACCEPTED)
async def create_run(
    payload: CreateRunRequest,
    background_tasks: BackgroundTasks,
    request: Request,
):
    """Create a run and execute it in the background."""
    _enforce_api_key(request)
    runtime = get_runtime(request)
    try:
        run = await runtime.create_run(payload)
    except WorkspaceValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    background_tasks.add_task(runtime.execute_run, run.id)
    return run


@router.get("/runs/{run_id}")
async def get_run(run_id: str, request: Request):
    """Get one run by id."""
    _enforce_api_key(request)
    runtime = get_runtime(request)
    try:
        return await runtime.get_run(run_id)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc


@router.get("/runs/{run_id}/events")
async def get_run_events(run_id: str, request: Request):
    """Get all events for one run."""
    _enforce_api_key(request)
    runtime = get_runtime(request)
    try:
        return await runtime.get_events(run_id)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str, request: Request):
    """Cancel one generic runtime run."""
    _enforce_api_key(request)
    runtime = get_runtime(request)
    try:
        return await runtime.cancel_run(run_id)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc
    except RunAlreadyTerminalError as exc:
        raise HTTPException(status_code=409, detail="run is already terminal") from exc


@router.post("/repo-analyst/runs", status_code=status.HTTP_202_ACCEPTED)
async def create_repo_analyst_run(
    payload: RepoAnalystRequest,
    background_tasks: BackgroundTasks,
    request: Request,
):
    """Create and execute a repo analyst run."""
    _enforce_api_key(request)
    service = get_repo_analyst_service(request)
    try:
        run = await service.create_run(payload)
    except WorkspaceValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    background_tasks.add_task(service.execute_run, run.id)
    return await service.get_run(run.id)


@router.get("/repo-analyst/runs")
async def list_repo_analyst_runs(request: Request):
    """List repo analyst runs."""
    _enforce_api_key(request)
    service = get_repo_analyst_service(request)
    return await service.list_run_summaries()


@router.get("/repo-analyst/runs/{run_id}")
async def get_repo_analyst_run(
    run_id: str,
    request: Request,
    include_raw: bool = False,
):
    """Get one repo analyst run result."""
    _enforce_api_key(request)
    service = get_repo_analyst_service(request)
    try:
        return await service.get_run(run_id, include_raw=include_raw)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc


@router.get("/repo-analyst/runs/{run_id}/raw")
async def get_repo_analyst_run_raw(run_id: str, request: Request):
    """Get one repo analyst run with the raw agent result attached."""
    _enforce_api_key(request)
    service = get_repo_analyst_service(request)
    try:
        return await service.get_run(run_id, include_raw=True)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc


@router.get("/repo-analyst/runs/{run_id}/events")
async def get_repo_analyst_run_events(
    run_id: str,
    request: Request,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    include_payload: bool = False,
    max_payload_chars: int = Query(default=5000, ge=500, le=50000),
):
    """Get lightweight runtime event summaries for one repo analyst run."""
    _enforce_api_key(request)
    service = get_repo_analyst_service(request)
    try:
        return await service.get_event_summaries(
            run_id,
            limit=limit,
            offset=offset,
            include_payload=include_payload,
            max_payload_chars=max_payload_chars,
        )
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc


@router.post("/repo-analyst/runs/{run_id}/cancel")
async def cancel_repo_analyst_run(run_id: str, request: Request):
    """Cancel one repo analyst run."""
    _enforce_api_key(request)
    service = get_repo_analyst_service(request)
    try:
        return await service.cancel_run(run_id)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc
    except RunAlreadyTerminalError as exc:
        raise HTTPException(status_code=409, detail="run is already terminal") from exc


# ── Session API ──────────────────────────────────────────────────────────────


def _validate_session_workspace(request: Request, workspace_root: str) -> None:
    """Validate that workspace_root is under the allowed runtime root.

    Raises ``HTTPException(400)`` on invalid or disallowed workspace paths.
    """
    runtime = get_runtime(request)
    allowed_path = runtime.allowed_workspace_root
    if allowed_path is None:
        return
    try:
        resolved = Path(workspace_root).resolve(strict=False)
        resolved.relative_to(allowed_path)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="workspace_root is outside the allowed runtime root",
        )


class CreateSessionRequest(BaseModel):
    """Request body for POST /sessions."""

    model_config = ConfigDict(extra="forbid")

    workspace_root: str
    mode: RepoAnalystMode = "review"
    max_iterations: int = Field(default=100, ge=1, le=200)
    max_tokens: int | None = Field(default=None, ge=1)
    provider: str | None = None
    model: str | None = None
    tool_names: list[str] | None = None
    system_prompt: str | None = None
    title: str | None = None


class CreateSessionTurnRequest(BaseModel):
    """Request body for POST /sessions/{id}/turns."""

    model_config = ConfigDict(extra="forbid")

    message: str = Field(..., min_length=1)


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
async def create_session(payload: CreateSessionRequest, request: Request):
    """Create a new persistent session."""
    _enforce_api_key(request)
    _validate_session_workspace(request, payload.workspace_root)
    svc = get_session_service(request)
    try:
        record = await svc.create_session(**payload.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return record


@router.get("/sessions")
async def list_sessions(request: Request):
    """List all sessions as lightweight summaries."""
    _enforce_api_key(request)
    svc = get_session_service(request)
    return await svc.list_sessions()


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, request: Request):
    """Get one session by id."""
    _enforce_api_key(request)
    svc = get_session_service(request)
    record = await svc.get_session(session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="session not found")
    return record


@router.post("/sessions/{session_id}/turns", status_code=status.HTTP_202_ACCEPTED)
async def create_turn(session_id: str, payload: CreateSessionTurnRequest, request: Request):
    """Start a new turn in a session — triggers agent execution."""
    _enforce_api_key(request)
    svc = get_session_service(request)
    try:
        turn = await svc.start_turn(session_id, payload.message)
    except AppSessionNotFoundError as exc:
        raise HTTPException(status_code=404, detail="session not found") from exc
    except SessionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return turn


@router.get("/sessions/{session_id}/turns")
async def list_turns(session_id: str, request: Request):
    """List all turns for a session."""
    _enforce_api_key(request)
    svc = get_session_service(request)
    return await svc.list_turns(session_id)


@router.get("/sessions/{session_id}/turns/{turn_id}/events")
async def get_turn_events(
    session_id: str,
    turn_id: str,
    request: Request,
    after_index: int = Query(default=None, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    include_payload: bool = Query(default=False),
    max_payload_chars: int = Query(default=5000, ge=0, le=50000),
):
    """Get runtime events for a turn.

    Parameters:
        after_index: Only return events with index > after_index.
        limit: Maximum events to return (1-500).
        include_payload: If false, event payloads are stripped.
        max_payload_chars: Truncate payloads to this length when include_payload is true.
    """
    _enforce_api_key(request)
    store = request.app.state.session_service._store
    turn = await store.get_turn(turn_id)
    if turn is None or turn.session_id != session_id:
        raise HTTPException(status_code=404, detail="turn not found")
    events = await store.get_turn_events(
        turn_id, after_index=after_index, limit=limit,
    )
    if not include_payload:
        return [_strip_event_payload(e) for e in events]
    return [_truncate_event_payload(e, max_payload_chars) for e in events]


@router.get("/sessions/{session_id}/turns/{turn_id}/diagnostics")
async def get_turn_diagnostics(
    session_id: str,
    turn_id: str,
    request: Request,
):
    """Get diagnostics for a turn, computed from stored events."""
    _enforce_api_key(request)
    store = request.app.state.session_service._store
    turn = await store.get_turn(turn_id)
    if turn is None or turn.session_id != session_id:
        raise HTTPException(status_code=404, detail="turn not found")

    from code_review_agent.models import ModelUsage
    from code_review_agent.runtime.turn_events import build_diagnostics

    events = await store.get_turn_events(turn_id)
    usage = ModelUsage.model_validate(json.loads(turn.usage_json)) if turn.usage_json else None
    return build_diagnostics(
        result=None,
        events=events,
        started_at=turn.started_at,
        finished_at=turn.finished_at,
        failure_reason=turn.failure_reason,
        usage=usage,
    )


def _strip_event_payload(event: RunEvent) -> RunEvent:
    return event.model_copy(update={"payload": {}, "data": {}})


def _truncate_event_payload(event: RunEvent, max_chars: int) -> RunEvent:
    if not event.payload:
        return event
    truncated = {}
    for k, v in event.payload.items():
        s = str(v) if not isinstance(v, str) else v
        truncated[k] = s[:max_chars] if len(s) > max_chars else v
    return event.model_copy(update={"payload": truncated})


@router.post("/sessions/{session_id}/turns/{turn_id}/cancel")
async def cancel_turn(session_id: str, turn_id: str, request: Request):
    """Cancel a running or queued turn."""
    _enforce_api_key(request)
    svc = get_session_service(request)
    try:
        return await svc.cancel_turn(session_id, turn_id)
    except TurnNotFoundError as exc:
        raise HTTPException(status_code=404, detail="turn not found") from exc
    except SessionConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: str,
    request: Request,
    since_sequence: int = Query(default=0, ge=0),
    after_sequence: int = Query(default=None, ge=0),
):
    """Get messages for a session, optionally starting from a sequence number.

    Use ``after_sequence`` for strict > semantics (recommended).
    ``since_sequence`` uses >= semantics (kept for backward compatibility).
    If both are given, ``after_sequence`` wins.
    """
    _enforce_api_key(request)
    svc = get_session_service(request)
    effective_since = since_sequence
    if after_sequence is not None:
        effective_since = after_sequence + 1
    return await svc.get_messages_with_sequence(session_id, since_sequence=effective_since)


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str, request: Request):
    """Archive a session."""
    _enforce_api_key(request)
    svc = get_session_service(request)
    try:
        return await svc.archive_session(session_id)
    except AppSessionNotFoundError as exc:
        raise HTTPException(status_code=404, detail="session not found") from exc
