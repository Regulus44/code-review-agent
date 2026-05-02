"""Minimal runtime service and default runtime factory."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from code_review_agent.context import ContextBudget
from code_review_agent.harness import Agent, AgentRunResult
from code_review_agent.models import (
    ChatModel,
    create_model,
    normalize_provider,
)
from code_review_agent.observability import (
    log_structured_event,
    make_run_event,
    new_span_id,
    new_trace_id,
)
from code_review_agent.session import InMemorySession
from code_review_agent.settings import get_settings
from code_review_agent.storage import SqliteRunStore
from code_review_agent.tools import (
    ListFilesTool,
    ReadFileTool,
    RunCommandTool,
    SearchTextTool,
    Tool,
    ToolContext,
    ToolDescriptor,
    ToolRegistry,
    describe_registry,
    describe_tool,
    filter_tool_registry,
)

from .store import InMemoryRunStore, RunStore
from .turn_events import (
    ObservableChatModel,
    aclose_model_if_needed,
    build_diagnostics,
    convert_agent_steps_to_events,
)
from .types import (
    CreateRunRequest,
    RunEvent,
    RunRecord,
)


ModelFactory = Callable[..., ChatModel]
ToolRegistryFactory = Callable[[], ToolRegistry]
ToolDiscoveryFactory = Callable[[], list[ToolDescriptor]]
ToolFactory = Callable[[], Tool]

DEFAULT_SYSTEM_PROMPT = (
    "You are a repository analysis and code review agent. "
    "Use tools when you need grounded file information. "
    "Base every conclusion on the repository contents."
)
TERMINAL_RUN_STATUSES = {"completed", "failed", "max_iterations", "cancelled", "model_output_truncated"}
CANCELLED_BY_USER = "cancelled_by_user"
DEFAULT_CONTEXT_BUDGET = ContextBudget()
REPO_ANALYST_OVERVIEW_CONTEXT_BUDGET = ContextBudget(
    max_prompt_chars=140_000,
    recent_full_message_count=12,
    max_single_tool_message_chars=20_000,
    historical_tool_preview_chars=2_000,
    max_total_tool_content_chars=80_000,
)
REPO_ANALYST_REVIEW_CONTEXT_BUDGET = ContextBudget(
    max_prompt_chars=120_000,
    recent_full_message_count=12,
    max_single_tool_message_chars=20_000,
    historical_tool_preview_chars=2_000,
    max_total_tool_content_chars=80_000,
)
BUILTIN_TOOL_FACTORIES: dict[str, ToolFactory] = {
    "list_files": ListFilesTool,
    "read_file": ReadFileTool,
    "search_text": SearchTextTool,
    "run_command": RunCommandTool,
}


class WorkspaceValidationError(ValueError):
    """Raised when workspace_root fails runtime policy checks."""


class RunAlreadyTerminalError(RuntimeError):
    """Raised when a terminal run cannot be cancelled."""

    def __init__(self, run_id: str, status: str) -> None:
        super().__init__(f"run {run_id} is already terminal: {status}")
        self.run_id = run_id
        self.status = status


class AgentRuntime:
    """Minimal runtime service that creates and executes agent runs."""

    def __init__(
        self,
        *,
        model_factory: ModelFactory,
        tool_registry_factory: ToolRegistryFactory,
        tool_discovery_factory: ToolDiscoveryFactory | None = None,
        store: RunStore | None = None,
        agent_name: str = "code-review-agent",
        default_system_prompt: str = DEFAULT_SYSTEM_PROMPT,
        default_max_iterations: int = 8,
        default_provider: str = "deepseek",
        run_timeout_seconds: int = 300,
        max_concurrent_runs: int = 4,
        allowed_workspace_root: Path | None = None,
    ) -> None:
        self.model_factory = model_factory
        self.tool_registry_factory = tool_registry_factory
        self.tool_discovery_factory = tool_discovery_factory
        self.store = store or InMemoryRunStore()
        self.agent_name = agent_name
        self.default_system_prompt = default_system_prompt
        self.default_max_iterations = default_max_iterations
        self.default_provider = default_provider
        self.run_timeout_seconds = run_timeout_seconds
        self.max_concurrent_runs = max_concurrent_runs
        self.allowed_workspace_root = (
            allowed_workspace_root.resolve(strict=False)
            if allowed_workspace_root is not None
            else None
        )
        self._active_runs = 0
        self._active_runs_lock = asyncio.Lock()
        self._running_tasks: dict[str, asyncio.Task] = {}
        self._running_tasks_lock = asyncio.Lock()
        self._logger = logging.getLogger(__name__)

    async def create_run(self, request: CreateRunRequest) -> RunRecord:
        """Create a queued run record."""
        resolved_workspace = self._resolve_workspace_root(request.workspace_root)
        run = RunRecord(
            id=uuid4().hex,
            status="queued",
            app_name=request.app_name,
            user_input=request.user_input,
            workspace_root=str(resolved_workspace),
            system_prompt=request.system_prompt or self.default_system_prompt,
            max_iterations=request.max_iterations or self.default_max_iterations,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            provider=self._resolve_run_provider(request.provider),
            model=request.model,
            tool_names=self._resolve_run_tool_names(request.tool_names),
        )
        created = await self.store.create_run(run)
        queued_event = await self.store.append_event(
            created.id,
            make_run_event(
                index=1,
                legacy_type="status_change",
                event_type="run.queued",
                payload={"status": "queued"},
                status="queued",
                trace_id=created.id,
                span_id=new_span_id(),
            ),
        )
        log_structured_event(self._logger, run_id=created.id, event=queued_event)
        return created

    async def get_run(self, run_id: str) -> RunRecord:
        """Fetch one run record."""
        run = await self.store.get_run(run_id)
        return await self._decorate_run(run)

    async def get_run_summary(self, run_id: str) -> RunRecord:
        """Fetch one run record without loading raw agent result data."""
        run = await self.store.get_run_summary(run_id)
        return run

    async def list_runs(self) -> list[RunRecord]:
        """List all runs."""
        return await self.store.list_runs()

    async def list_run_summaries(self) -> list[RunRecord]:
        """List runs without loading raw agent result data."""
        return await self.store.list_run_summaries()

    async def get_events(self, run_id: str) -> list[RunEvent]:
        """Fetch runtime events for a run."""
        return await self.store.get_events(run_id)

    async def get_event_summaries(
        self,
        run_id: str,
        *,
        limit: int = 100,
        offset: int = 0,
        include_payload: bool = False,
        max_payload_chars: int = 5000,
    ) -> list[RunEvent]:
        """Fetch lightweight runtime event summaries."""
        return await self.store.get_event_summaries(
            run_id,
            limit=limit,
            offset=offset,
            include_payload=include_payload,
            max_payload_chars=max_payload_chars,
        )

    async def get_result_size(self, run_id: str) -> int | None:
        """Return serialized result size when known."""
        return await self.store.get_result_size(run_id)

    def list_tools(self) -> list[ToolDescriptor]:
        """List tools visible through the runtime discovery surface."""
        if self.tool_discovery_factory is not None:
            return self.tool_discovery_factory()
        return describe_registry(self.tool_registry_factory())

    def _resolve_run_tool_names(self, requested_tool_names: list[str] | None) -> list[str]:
        """Resolve the tool names snapshot for a new run."""
        descriptors = self.list_tools()
        enabled_names = {tool.name for tool in descriptors if tool.enabled}
        ordered_enabled_names = [tool.name for tool in descriptors if tool.enabled]
        if requested_tool_names is None:
            return ordered_enabled_names

        seen: set[str] = set()
        resolved: list[str] = []
        for name in requested_tool_names:
            if name not in seen:
                resolved.append(name)
                seen.add(name)

        unavailable = sorted(set(resolved) - enabled_names)
        if unavailable:
            raise WorkspaceValidationError(
                f"tool_names include unknown or disabled tools: {', '.join(unavailable)}",
            )
        return resolved

    def _resolve_run_provider(self, provider: str | None) -> str:
        """Resolve and validate the provider snapshot for a new run."""
        try:
            return normalize_provider(provider or self.default_provider)
        except Exception as exc:
            raise WorkspaceValidationError(str(exc)) from exc

    def _context_budget_for_run(self, run: RunRecord) -> ContextBudget:
        """Return the model request context budget for this run."""
        if run.app_name == "repo_analyst":
            system_prompt = run.system_prompt or ""
            if "summary, changed_files, test_result, findings, risks, next_steps" in system_prompt:
                return REPO_ANALYST_REVIEW_CONTEXT_BUDGET
            return REPO_ANALYST_OVERVIEW_CONTEXT_BUDGET
        return DEFAULT_CONTEXT_BUDGET

    async def cancel_run(self, run_id: str) -> RunRecord:
        """Request cancellation for a queued or running run."""
        run = await self.store.get_run(run_id)
        if run.status in TERMINAL_RUN_STATUSES:
            raise RunAlreadyTerminalError(run_id, run.status)

        if run.status == "queued":
            await self._append_lifecycle_event(
                run_id=run_id,
                event_type="run.cancel_requested",
                payload={"status": "queued", "failure_reason": CANCELLED_BY_USER},
                status="queued",
                failure_reason=CANCELLED_BY_USER,
            )
            await self.store.update_status(
                run_id,
                "cancelled",
                failure_reason=CANCELLED_BY_USER,
            )
            await self.store.attach_result(
                run_id,
                AgentRunResult(status="cancelled", failure_reason=CANCELLED_BY_USER),
            )
            await self._append_lifecycle_event(
                run_id=run_id,
                event_type="run.cancelled",
                payload={"status": "cancelled", "failure_reason": CANCELLED_BY_USER},
                status="cancelled",
                failure_reason=CANCELLED_BY_USER,
            )
            return await self.get_run(run_id)

        await self._append_lifecycle_event(
            run_id=run_id,
            event_type="run.cancel_requested",
            payload={"status": run.status, "failure_reason": CANCELLED_BY_USER},
            status=run.status,
            failure_reason=CANCELLED_BY_USER,
        )
        async with self._running_tasks_lock:
            task = self._running_tasks.get(run_id)
        if task is not None:
            task.cancel()
        return await self.get_run(run_id)

    async def execute_run(self, run_id: str) -> RunRecord:
        """Execute one queued run."""
        run = await self.store.get_run(run_id)
        if run.status in TERMINAL_RUN_STATUSES:
            return await self.get_run(run_id)

        if await self._reject_for_concurrency(run_id):
            return await self.get_run(run_id)

        await self._register_running_task(run_id)
        model: ChatModel | None = None
        started_at = time.perf_counter()
        trace_id = new_trace_id()
        root_span_id = new_span_id()
        next_event_index = await self._next_event_index(run_id)

        async def emit(
            *,
            legacy_type: str,
            event_type: str,
            payload: dict | None = None,
            timestamp: datetime | None = None,
            status: str | None = None,
            duration_ms: int | None = None,
            failure_reason: str | None = None,
            span_id: str | None = None,
            parent_span_id: str | None = None,
        ) -> RunEvent:
            nonlocal next_event_index
            event = make_run_event(
                index=next_event_index,
                legacy_type=legacy_type,
                event_type=event_type,
                payload=payload,
                timestamp=timestamp,
                status=status,
                duration_ms=duration_ms,
                failure_reason=failure_reason,
                trace_id=trace_id,
                span_id=span_id or new_span_id(),
                parent_span_id=parent_span_id,
            )
            await self.store.append_event(run_id, event)
            log_structured_event(self._logger, run_id=run_id, event=event)
            next_event_index += 1
            return event

        try:
            await self.store.update_status(run_id, "running")
            await emit(
                legacy_type="status_change",
                event_type="run.started",
                payload={"status": "running"},
                status="running",
                span_id=root_span_id,
            )

            model = ObservableChatModel(
                self._create_model(run.provider, run.model),
                emit=emit,
                root_span_id=root_span_id,
            )
            registry = self.tool_registry_factory()
            if run.tool_names is not None:
                registry = filter_tool_registry(registry, run.tool_names)
            agent = Agent(
                name=self.agent_name,
                model=model,
                tool_registry=registry,
                session=InMemorySession(),
                system_prompt=run.system_prompt,
                max_iterations=run.max_iterations,
                temperature=run.temperature,
                max_tokens=run.max_tokens,
                context_budget=self._context_budget_for_run(run),
            )

            result = await asyncio.wait_for(
                agent.run(
                    run.user_input,
                    ToolContext(
                        workspace_root=Path(run.workspace_root),
                        run_id=run.id,
                    ),
                ),
                timeout=self.run_timeout_seconds,
            )

            await self.store.attach_result(run_id, result)
            await convert_agent_steps_to_events(
                steps=result.steps,
                emit=emit,
                root_span_id=root_span_id,
                include_model_events=False,
            )
            await self.store.update_status(
                run_id,
                result.status,
                failure_reason=result.failure_reason,
            )
            await emit(
                legacy_type="status_change",
                event_type=f"run.{result.status}",
                payload={
                    "status": result.status,
                    "failure_reason": result.failure_reason,
                },
                status=result.status,
                failure_reason=result.failure_reason,
                span_id=root_span_id,
            )
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            usage = result.usage.model_dump() if result.usage else None
            self._log_runtime_summary(
                run_id=run_id,
                status=result.status,
                latency_ms=elapsed_ms,
                failure_reason=result.failure_reason,
                token_usage=usage,
            )
            return await self.get_run(run_id)
        except asyncio.CancelledError:
            await self.store.attach_result(
                run_id,
                AgentRunResult(status="cancelled", failure_reason=CANCELLED_BY_USER),
            )
            await self.store.update_status(
                run_id,
                "cancelled",
                failure_reason=CANCELLED_BY_USER,
            )
            await emit(
                legacy_type="status_change",
                event_type="run.cancelled",
                payload={"status": "cancelled", "failure_reason": CANCELLED_BY_USER},
                status="cancelled",
                failure_reason=CANCELLED_BY_USER,
                span_id=root_span_id,
            )
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            self._log_runtime_summary(
                run_id=run_id,
                status="cancelled",
                latency_ms=elapsed_ms,
                failure_reason=CANCELLED_BY_USER,
                token_usage=None,
            )
            return await self.get_run(run_id)
        except asyncio.TimeoutError:
            await self.store.update_status(
                run_id,
                "failed",
                failure_reason="run_timeout",
            )
            await emit(
                legacy_type="status_change",
                event_type="run.timeout",
                payload={"status": "failed", "failure_reason": "run_timeout"},
                status="failed",
                failure_reason="run_timeout",
                span_id=root_span_id,
            )
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            self._log_runtime_summary(
                run_id=run_id,
                status="failed",
                latency_ms=elapsed_ms,
                failure_reason="run_timeout",
                token_usage=None,
            )
            return await self.get_run(run_id)
        except Exception as exc:
            await self.store.update_status(run_id, "failed", failure_reason=str(exc))
            await emit(
                legacy_type="status_change",
                event_type="run.failed",
                payload={"status": "failed", "failure_reason": str(exc)},
                status="failed",
                failure_reason=str(exc),
                span_id=root_span_id,
            )
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            self._log_runtime_summary(
                run_id=run_id,
                status="failed",
                latency_ms=elapsed_ms,
                failure_reason=str(exc),
                token_usage=None,
            )
            return await self.get_run(run_id)
        finally:
            if model is not None:
                await aclose_model_if_needed(model)
            await self._unregister_running_task(run_id)
            await self._release_active_slot()

    async def aclose(self) -> None:
        """Close runtime resources."""
        await self.store.aclose()

    def _create_model(self, provider: str | None, model_name: str | None) -> ChatModel:
        """Create a model while preserving legacy no-arg factory support."""
        try:
            return self.model_factory(provider, model_name)
        except TypeError:
            return self.model_factory()

    async def _next_event_index(self, run_id: str) -> int:
        events = await self.store.get_events(run_id)
        return len(events) + 1

    async def _reject_for_concurrency(self, run_id: str) -> bool:
        should_reject = False
        async with self._active_runs_lock:
            if self._active_runs >= self.max_concurrent_runs:
                should_reject = True
            else:
                self._active_runs += 1

        if not should_reject:
            return False

        await self.store.update_status(
            run_id,
            "failed",
            failure_reason="concurrency_limit_exceeded",
        )
        event = make_run_event(
            index=(await self._next_event_index(run_id)),
            legacy_type="status_change",
            event_type="run.rejected",
            payload={
                "status": "failed",
                "failure_reason": "concurrency_limit_exceeded",
            },
            status="failed",
            failure_reason="concurrency_limit_exceeded",
            trace_id=run_id,
            span_id=new_span_id(),
        )
        await self.store.append_event(run_id, event)
        log_structured_event(self._logger, run_id=run_id, event=event)
        self._log_runtime_summary(
            run_id=run_id,
            status="failed",
            latency_ms=0,
            failure_reason="concurrency_limit_exceeded",
            token_usage=None,
        )
        return True

    async def _release_active_slot(self) -> None:
        async with self._active_runs_lock:
            if self._active_runs > 0:
                self._active_runs -= 1

    async def _register_running_task(self, run_id: str) -> None:
        current_task = asyncio.current_task()
        if current_task is None:
            return
        async with self._running_tasks_lock:
            self._running_tasks[run_id] = current_task

    async def _unregister_running_task(self, run_id: str) -> None:
        async with self._running_tasks_lock:
            self._running_tasks.pop(run_id, None)

    async def _append_lifecycle_event(
        self,
        *,
        run_id: str,
        event_type: str,
        payload: dict | None = None,
        status: str | None = None,
        failure_reason: str | None = None,
    ) -> RunEvent:
        event = make_run_event(
            index=(await self._next_event_index(run_id)),
            legacy_type="status_change",
            event_type=event_type,
            payload=payload,
            status=status,
            failure_reason=failure_reason,
            trace_id=run_id,
            span_id=new_span_id(),
        )
        appended = await self.store.append_event(run_id, event)
        log_structured_event(self._logger, run_id=run_id, event=appended)
        return appended

    def _resolve_workspace_root(self, workspace_root: str) -> Path:
        resolved = Path(workspace_root).resolve(strict=False)

        if not resolved.exists():
            raise WorkspaceValidationError("workspace_root does not exist")
        if not resolved.is_dir():
            raise WorkspaceValidationError("workspace_root must be a directory")

        if self.allowed_workspace_root is not None:
            try:
                resolved.relative_to(self.allowed_workspace_root)
            except ValueError as exc:
                raise WorkspaceValidationError(
                    "workspace_root is outside the allowed runtime root",
                ) from exc

        return resolved

    async def _decorate_run(self, run: RunRecord) -> RunRecord:
        decorated = run.model_copy(deep=True)
        events = await self.store.get_events(run.id)
        decorated.diagnostics = build_diagnostics(
            result=decorated.result or AgentRunResult(status="completed"),
            events=events,
            started_at=decorated.started_at,
            finished_at=decorated.finished_at,
            failure_reason=decorated.failure_reason,
        )
        return decorated

    def _log_runtime_summary(
        self,
        *,
        run_id: str,
        status: str,
        latency_ms: int,
        failure_reason: str | None,
        token_usage: dict | None,
    ) -> None:
        payload = {
            "run_id": run_id,
            "status": status,
            "latency_ms": latency_ms,
            "token_usage": token_usage,
            "failure_reason": failure_reason,
        }
        self._logger.info("runtime_summary %s", json.dumps(payload, ensure_ascii=False))


def _resolve_enabled_tool_names(
    enabled_tools: tuple[str, ...] | list[str] | set[str] | None = None,
) -> set[str]:
    """Resolve and validate the configured enabled tool names."""
    configured = (
        get_settings().enabled_tools
        if enabled_tools is None
        else tuple(enabled_tools)
    )
    if configured is None:
        return set(BUILTIN_TOOL_FACTORIES)

    unknown_tools = sorted(set(configured) - set(BUILTIN_TOOL_FACTORIES))
    if unknown_tools:
        raise ValueError(f"unknown enabled tools: {', '.join(unknown_tools)}")
    return set(configured)




def build_default_tool_registry(
    enabled_tools: tuple[str, ...] | list[str] | set[str] | None = None,
) -> ToolRegistry:
    """Create the default registry used by the runtime API."""
    enabled_tool_names = _resolve_enabled_tool_names(enabled_tools)
    registry = ToolRegistry()
    for name, factory in BUILTIN_TOOL_FACTORIES.items():
        if name in enabled_tool_names:
            registry.register(factory())
    return registry


def build_default_tool_descriptors(
    enabled_tools: tuple[str, ...] | list[str] | set[str] | None = None,
) -> list[ToolDescriptor]:
    """Describe all built-in tools and mark disabled tools from settings."""
    enabled_tool_names = _resolve_enabled_tool_names(enabled_tools)
    descriptors: list[ToolDescriptor] = []
    for name, factory in BUILTIN_TOOL_FACTORIES.items():
        enabled = name in enabled_tool_names
        descriptors.append(
            describe_tool(
                factory(),
                enabled=enabled,
                disabled_reason=None if enabled else "not_in_enabled_tools",
            ),
        )
    return descriptors


def build_default_runtime() -> AgentRuntime:
    """Create the default runtime using DeepSeek and local file tools."""
    settings = get_settings()
    enabled_tools = settings.enabled_tools
    _resolve_enabled_tool_names(enabled_tools)
    try:
        store: RunStore = SqliteRunStore(settings.database_url)
    except ModuleNotFoundError:
        logging.getLogger(__name__).warning(
            "aiosqlite is missing; falling back to in-memory runtime store",
        )
        store = InMemoryRunStore()
    return AgentRuntime(
        model_factory=create_model,
        tool_registry_factory=lambda: build_default_tool_registry(enabled_tools),
        tool_discovery_factory=lambda: build_default_tool_descriptors(enabled_tools),
        store=store,
        default_provider=settings.default_provider,
        run_timeout_seconds=settings.run_timeout_seconds,
        max_concurrent_runs=settings.max_concurrent_runs,
        allowed_workspace_root=Path(settings.runtime_workspace_root),
    )
