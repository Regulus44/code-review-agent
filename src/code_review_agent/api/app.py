"""FastAPI application factory for the minimal runtime API."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from code_review_agent.apps.repo_analyst import RepoAnalystService
from code_review_agent.runtime import AgentRuntime, build_default_runtime
from code_review_agent.runtime.session_service import SessionService
from code_review_agent.session.store import SessionStore
from code_review_agent.settings import get_settings
from code_review_agent.skills import LlmSkillRouter, load_builtin_skill_catalog
from code_review_agent.storage import SqliteSessionStore

from .routes import router

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def create_app(
    runtime: AgentRuntime | None = None,
    session_store: SessionStore | None = None,
    *,
    enable_skill_routing: bool = True,
) -> FastAPI:
    """Create the runtime API application.

    Parameters:
        runtime: If ``None``, uses ``build_default_runtime()``.
        session_store: If ``None``, creates ``SqliteSessionStore`` from settings.
                       Tests can inject ``InMemorySessionStore`` for isolation.
    """
    settings = get_settings()
    app = FastAPI(title="Code Review Agent API", version="0.1.0")
    runtime = runtime or build_default_runtime()
    app.state.runtime = runtime
    app.state.repo_analyst_service = RepoAnalystService(runtime)
    app.state.api_key = settings.api_key

    store = session_store or SqliteSessionStore(settings.database_url)
    skill_catalog = load_builtin_skill_catalog()
    app.state.session_service = SessionService(
        store=store,
        model_factory=runtime.model_factory,
        tool_registry_factory=runtime.tool_registry_factory,
        run_timeout_seconds=runtime.run_timeout_seconds,
        skill_catalog=skill_catalog,
        skill_router=LlmSkillRouter(skill_catalog) if enable_skill_routing else None,
    )
    app.state.skill_catalog = skill_catalog

    assets_dir = WEB_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    app.include_router(router)

    @app.on_event("startup")
    async def recover_sessions() -> None:
        stale = await store.recover_stale_sessions()
        if stale:
            import logging
            logging.getLogger(__name__).info("Recovered %d stale turns on startup", stale)

    @app.on_event("shutdown")
    async def shutdown_runtime() -> None:
        await app.state.runtime.aclose()
        await store.aclose()

    return app
