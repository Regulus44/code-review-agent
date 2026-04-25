"""Service layer for the repository analyst app."""

from __future__ import annotations

from code_review_agent.runtime import AgentRuntime, CreateRunRequest, RunEvent, RunNotFoundError

from .parser import RepoAnalystParseError, parse_repo_analyst_report
from .prompt import DEFAULT_REPO_ANALYST_QUESTION, build_repo_analyst_prompt
from .types import (
    RepoAnalystParseDiagnostics,
    RepoAnalystRequest,
    RepoAnalystRunResult,
)

APP_NAME = "repo_analyst"


class RepoAnalystService:
    """Facade over the generic runtime for repository analysis runs."""

    def __init__(self, runtime: AgentRuntime) -> None:
        self.runtime = runtime

    async def create_run(self, request: RepoAnalystRequest):
        """Create a new repository analyst run."""
        question = request.question.strip() if request.question and request.question.strip() else DEFAULT_REPO_ANALYST_QUESTION
        return await self.runtime.create_run(
            CreateRunRequest(
                user_input=question,
                workspace_root=request.workspace_root,
                app_name=APP_NAME,
                system_prompt=build_repo_analyst_prompt(question),
                max_iterations=request.max_iterations,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
            ),
        )

    async def execute_run(self, run_id: str) -> RepoAnalystRunResult:
        """Execute the run and convert the result into app-specific output."""
        run = await self.runtime.execute_run(run_id)
        return self._to_app_result(run)

    async def get_run(self, run_id: str) -> RepoAnalystRunResult:
        """Get one app-specific run result."""
        run = await self.runtime.get_run(run_id)
        if run.app_name != APP_NAME:
            raise RunNotFoundError(run_id)
        return self._to_app_result(run)

    async def get_events(self, run_id: str) -> list[RunEvent]:
        """Return the underlying runtime events."""
        return await self.runtime.get_events(run_id)

    async def list_runs(self) -> list[RepoAnalystRunResult]:
        """List all repo analyst runs in app-specific shape."""
        runs = await self.runtime.list_runs()
        return [
            self._to_app_result(run)
            for run in runs
            if run.app_name == APP_NAME
        ]

    def _to_app_result(self, run):
        question = run.user_input
        report = None
        failure_reason = run.failure_reason
        parse_diagnostics: RepoAnalystParseDiagnostics | None = None

        if run.result is not None and run.status in {"completed", "max_iterations"}:
            try:
                report = parse_repo_analyst_report(run.result)
            except RepoAnalystParseError as exc:
                report = None
                parse_diagnostics = RepoAnalystParseDiagnostics(
                    code=exc.code,
                    message=exc.message,
                )
                if run.status == "completed":
                    if exc.code == "invalid_json":
                        failure_reason = "invalid_repo_analyst_report_json"
                    elif exc.code == "schema_validation_failed":
                        failure_reason = "invalid_repo_analyst_report_schema"
                    else:
                        failure_reason = "invalid_repo_analyst_report"

        return RepoAnalystRunResult(
            id=run.id,
            status=run.status,
            workspace_root=run.workspace_root,
            question=question,
            created_at=run.created_at,
            started_at=run.started_at,
            finished_at=run.finished_at,
            report=report,
            result=run.result,
            failure_reason=failure_reason,
            parse_diagnostics=parse_diagnostics,
        )
