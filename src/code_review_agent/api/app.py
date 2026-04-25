"""FastAPI application factory for the minimal runtime API."""

from __future__ import annotations

from fastapi import FastAPI

from code_review_agent.apps.repo_analyst import RepoAnalystService
from code_review_agent.runtime import AgentRuntime, build_default_runtime

from .routes import router


def create_app(runtime: AgentRuntime | None = None) -> FastAPI:
    """Create the runtime API application."""
    app = FastAPI(title="Code Review Agent API", version="0.1.0")
    app.state.runtime = runtime or build_default_runtime()
    app.state.repo_analyst_service = RepoAnalystService(app.state.runtime)
    app.include_router(router)
    return app
