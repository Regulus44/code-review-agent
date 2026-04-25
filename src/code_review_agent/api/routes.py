"""API routes for the minimal runtime."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status
from fastapi.responses import FileResponse

from code_review_agent.apps.repo_analyst import RepoAnalystRequest, RepoAnalystService
from code_review_agent.runtime import AgentRuntime, CreateRunRequest, RunNotFoundError

router = APIRouter()
UI_INDEX_PATH = Path(__file__).resolve().parent.parent / "web" / "index.html"


def get_runtime(request: Request) -> AgentRuntime:
    """Get the runtime service from application state."""
    return request.app.state.runtime


def get_repo_analyst_service(request: Request) -> RepoAnalystService:
    """Get the repo analyst service from application state."""
    return request.app.state.repo_analyst_service


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
    runtime = get_runtime(request)
    return runtime.list_runs()


@router.post("/runs", status_code=status.HTTP_202_ACCEPTED)
async def create_run(
    payload: CreateRunRequest,
    background_tasks: BackgroundTasks,
    request: Request,
):
    """Create a run and execute it in the background."""
    runtime = get_runtime(request)
    run = runtime.create_run(payload)
    background_tasks.add_task(runtime.execute_run, run.id)
    return run


@router.get("/runs/{run_id}")
async def get_run(run_id: str, request: Request):
    """Get one run by id."""
    runtime = get_runtime(request)
    try:
        return runtime.get_run(run_id)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc


@router.get("/runs/{run_id}/events")
async def get_run_events(run_id: str, request: Request):
    """Get all events for one run."""
    runtime = get_runtime(request)
    try:
        return runtime.get_events(run_id)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc


@router.post("/repo-analyst/runs", status_code=status.HTTP_202_ACCEPTED)
async def create_repo_analyst_run(
    payload: RepoAnalystRequest,
    background_tasks: BackgroundTasks,
    request: Request,
):
    """Create and execute a repo analyst run."""
    service = get_repo_analyst_service(request)
    run = service.create_run(payload)
    background_tasks.add_task(service.execute_run, run.id)
    return service.get_run(run.id)


@router.get("/repo-analyst/runs")
async def list_repo_analyst_runs(request: Request):
    """List repo analyst runs."""
    service = get_repo_analyst_service(request)
    return service.list_runs()


@router.get("/repo-analyst/runs/{run_id}")
async def get_repo_analyst_run(run_id: str, request: Request):
    """Get one repo analyst run result."""
    service = get_repo_analyst_service(request)
    try:
        return service.get_run(run_id)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc


@router.get("/repo-analyst/runs/{run_id}/events")
async def get_repo_analyst_run_events(run_id: str, request: Request):
    """Get runtime events for one repo analyst run."""
    service = get_repo_analyst_service(request)
    try:
        return service.get_events(run_id)
    except RunNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc
