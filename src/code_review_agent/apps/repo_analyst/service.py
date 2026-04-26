"""Service layer for the repository analyst app."""

from __future__ import annotations

from code_review_agent.runtime import (
    AgentRuntime,
    CreateRunRequest,
    RunEvent,
    RunNotFoundError,
    WorkspaceValidationError,
)

from .parser import (
    RepoAnalystParseError,
    parse_repo_analyst_report,
    parse_repo_review_report,
)
from .prompt import (
    DEFAULT_REPO_ANALYST_QUESTION,
    DEFAULT_REPO_REVIEW_QUESTION,
    build_repo_analyst_prompt,
)
from .types import (
    RepoAnalystMode,
    RepoAnalystParseDiagnostics,
    RepoAnalystRequest,
    RepoAnalystRunResult,
)

APP_NAME = "repo_analyst"
REPO_ANALYST_OVERVIEW_TOOLS = ["list_files", "read_file", "search_text"]
REPO_ANALYST_REVIEW_TOOLS = [
    "list_files",
    "read_file",
    "search_text",
    "run_command",
]
REPO_ANALYST_KNOWN_TOOLS = set(REPO_ANALYST_OVERVIEW_TOOLS) | set(
    REPO_ANALYST_REVIEW_TOOLS,
)


class RepoAnalystService:
    """Facade over the generic runtime for repository analysis runs."""

    def __init__(self, runtime: AgentRuntime) -> None:
        self.runtime = runtime

    async def create_run(self, request: RepoAnalystRequest):
        """Create a new repository analyst run."""
        default_question = (
            DEFAULT_REPO_REVIEW_QUESTION
            if request.mode == "review"
            else DEFAULT_REPO_ANALYST_QUESTION
        )
        question = (
            request.question.strip()
            if request.question and request.question.strip()
            else default_question
        )
        return await self.runtime.create_run(
            CreateRunRequest(
                user_input=question,
                workspace_root=request.workspace_root,
                app_name=APP_NAME,
                system_prompt=build_repo_analyst_prompt(question, mode=request.mode),
                max_iterations=request.max_iterations,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
                provider=request.provider,
                model=request.model,
                tool_names=self._resolve_tool_names(
                    request.mode,
                    request.enabled_tools,
                ),
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

    async def cancel_run(self, run_id: str) -> RepoAnalystRunResult:
        """Cancel one repo analyst run."""
        run = await self.runtime.get_run(run_id)
        if run.app_name != APP_NAME:
            raise RunNotFoundError(run_id)
        cancelled = await self.runtime.cancel_run(run_id)
        return self._to_app_result(cancelled)

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
        mode = self._run_mode(run)
        question = run.user_input
        report = None
        review_report = None
        failure_reason = run.failure_reason
        parse_diagnostics: RepoAnalystParseDiagnostics | None = None

        if run.result is not None and run.status in {"completed", "max_iterations"}:
            try:
                if mode == "review":
                    review_report = parse_repo_review_report(run.result)
                else:
                    report = parse_repo_analyst_report(run.result)
            except RepoAnalystParseError as exc:
                report = None
                review_report = None
                parse_diagnostics = RepoAnalystParseDiagnostics(
                    code=exc.code,
                    message=exc.message,
                )
                if run.status == "completed":
                    failure_reason = self._parse_failure_reason(mode, exc.code)

        return RepoAnalystRunResult(
            id=run.id,
            status=run.status,
            mode=mode,
            report_type=mode,
            workspace_root=run.workspace_root,
            question=question,
            created_at=run.created_at,
            started_at=run.started_at,
            finished_at=run.finished_at,
            report=report,
            review_report=review_report,
            result=run.result,
            failure_reason=failure_reason,
            parse_diagnostics=parse_diagnostics,
            diagnostics=run.diagnostics,
            provider=run.provider,
            model=run.model,
            tool_names=run.tool_names,
        )

    def _run_mode(self, run) -> RepoAnalystMode:
        system_prompt = run.system_prompt or ""
        if "summary, changed_files, test_result, findings, risks, next_steps" in system_prompt:
            return "review"
        return "overview"

    def _parse_failure_reason(self, mode: RepoAnalystMode, code: str) -> str:
        prefix = "invalid_repo_review_report" if mode == "review" else "invalid_repo_analyst_report"
        if code == "invalid_json":
            return f"{prefix}_json"
        if code == "schema_validation_failed":
            return f"{prefix}_schema"
        return prefix

    def _resolve_tool_names(
        self,
        mode: RepoAnalystMode,
        requested_tool_names: list[str] | None = None,
    ) -> list[str]:
        tools = self.runtime.list_tools()
        enabled_names = [tool.name for tool in tools if tool.enabled]
        enabled_name_set = set(enabled_names)
        builtin_names = {tool.name for tool in tools if tool.source == "builtin"}

        if requested_tool_names is not None:
            resolved: list[str] = []
            seen: set[str] = set()
            for name in requested_tool_names:
                if name not in seen:
                    resolved.append(name)
                    seen.add(name)

            unknown_tools = sorted(set(resolved) - builtin_names)
            if unknown_tools:
                raise WorkspaceValidationError(
                    f"enabled_tools include unknown tools: {', '.join(unknown_tools)}",
                )

            disabled_tools = sorted(set(resolved) - enabled_name_set)
            if disabled_tools:
                raise WorkspaceValidationError(
                    f"enabled_tools include disabled tools: {', '.join(disabled_tools)}",
                )

            return resolved

        if not enabled_names:
            return []

        policy_names = (
            REPO_ANALYST_REVIEW_TOOLS
            if mode == "review"
            else REPO_ANALYST_OVERVIEW_TOOLS
        )
        selected = [name for name in policy_names if name in enabled_names]
        if selected or set(enabled_names) & REPO_ANALYST_KNOWN_TOOLS:
            return selected

        # Test and embedded runtimes may provide custom tools instead of the
        # built-in repo tools. In that case, preserve the runtime's enabled set.
        return enabled_names
