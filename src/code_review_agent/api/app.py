"""FastAPI application factory for the minimal runtime API."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from code_review_agent.apps.repo_analyst import RepoAnalystService
from code_review_agent.runtime import AgentRuntime, build_default_runtime
from code_review_agent.runtime.session_service import SessionService
from code_review_agent.settings import get_settings
from code_review_agent.storage import SqliteSessionStore

from .routes import router

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def create_app(runtime: AgentRuntime | None = None) -> FastAPI:
    """Create the runtime API application."""
    settings = get_settings()
    app = FastAPI(title="Code Review Agent API", version="0.1.0")
    runtime = runtime or build_default_runtime()
    app.state.runtime = runtime
    app.state.repo_analyst_service = RepoAnalystService(runtime)
    app.state.api_key = settings.api_key

    session_store = SqliteSessionStore(settings.database_url)
    app.state.session_service = SessionService(
        store=session_store,
        model_factory=runtime.model_factory,
        tool_registry_factory=runtime.tool_registry_factory,
        run_timeout_seconds=runtime.run_timeout_seconds,
    )

    assets_dir = WEB_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    app.include_router(router)

    @app.on_event("startup")
    async def recover_sessions() -> None:
        stale = await session_store.recover_stale_sessions()
        if stale:
            import logging
            logging.getLogger(__name__).info("Recovered %d stale turns on startup", stale)

    @app.on_event("shutdown")
    async def shutdown_runtime() -> None:
        await app.state.runtime.aclose()
        await session_store.aclose()

    return app
