"""API routes for the minimal runtime."""

from __future__ import annotations

import ipaddress
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status
from fastapi.responses import FileResponse

from code_review_agent.apps.repo_analyst import RepoAnalystRequest, RepoAnalystService
from code_review_agent.runtime import (
    AgentRuntime,
    CreateRunRequest,
    RunNotFoundError,
    WorkspaceValidationError,
)

router = APIRouter()
UI_INDEX_PATH = Path(__file__).resolve().parent.parent / "web" / "index.html"


def get_runtime(request: Request) -> AgentRuntime:
    """Get the runtime service from application state."""
    return request.app.state.runtime


def get_repo_analyst_service(request: Request) -> RepoAnalystService:
    """Get the repo analyst service from application state."""
    return request.app.state.repo_analyst_service


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
    return await service.list_runs()


@router.get("/repo-analyst/runs/{run_id}")
async def get_repo_analyst_run(run_id: str, request: Request):
    """Get one repo analyst run result."""
    _enforce_api_key(request)
    service = get_repo_analyst_service(request)
    try:
        return await service.get_run(run_id)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc


@router.get("/repo-analyst/runs/{run_id}/events")
async def get_repo_analyst_run_events(run_id: str, request: Request):
    """Get runtime events for one repo analyst run."""
    _enforce_api_key(request)
    service = get_repo_analyst_service(request)
    try:
        return await service.get_events(run_id)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc
