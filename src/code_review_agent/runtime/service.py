"""Minimal runtime service and default runtime factory."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from code_review_agent.harness import Agent, AgentRunResult, AgentStep
from code_review_agent.models import (
    ChatModel,
    ChatRequest,
    ChatResponse,
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
)

from .store import InMemoryRunStore, RunStore
from .types import (
    CreateRunRequest,
    RunDiagnostics,
    RunEvent,
    RunRecord,
    RunStepTiming,
)


ModelFactory = Callable[..., ChatModel]
ToolRegistryFactory = Callable[[], ToolRegistry]
ToolDiscoveryFactory = Callable[[], list[ToolDescriptor]]
ToolFactory = Callable[[], Tool]
EventEmitter = Callable[..., Awaitable[RunEvent]]

DEFAULT_SYSTEM_PROMPT = (
    "You are a repository analysis and code review agent. "
    "Use tools when you need grounded file information. "
    "Base every conclusion on the repository contents."
)
TERMINAL_RUN_STATUSES = {"completed", "failed", "max_iterations", "cancelled", "model_output_truncated"}
CANCELLED_BY_USER = "cancelled_by_user"
BUILTIN_TOOL_FACTORIES: dict[str, ToolFactory] = {
    "list_files": ListFilesTool,
    "read_file": ReadFileTool,
    "search_text": SearchTextTool,
    "run_command": RunCommandTool,
}


def _exception_detail(exc: BaseException) -> str:
    """Return a non-empty exception detail for runtime diagnostics."""
    message = str(exc).strip()
    if message:
        return f"{exc.__class__.__name__}: {message}"
    return f"{exc.__class__.__name__}: {exc!r}"


class _ObservableChatModel(ChatModel):
    """Emit live model request/response events around a chat model."""

    def __init__(
        self,
        model: ChatModel,
        *,
        emit: EventEmitter,
        root_span_id: str,
    ) -> None:
        self._model = model
        self._emit = emit
        self._root_span_id = root_span_id
        self._request_count = 0
        self.provider = model.provider
        self.model_name = model.model_name

    async def complete(self, request: ChatRequest) -> ChatResponse:
        """Emit live observability events for one model request."""
        self._request_count += 1
        request_index = self._request_count
        span_id = new_span_id()
        started_at = datetime.utcnow()
        started_perf = time.perf_counter()
        payload = {
            "request_index": request_index,
            "provider": self.provider,
            "model": self.model_name,
            "requested_model": self.model_name,
            "message_count": len(request.messages),
            "tool_count": len(request.tools or []),
        }
        await self._emit(
            legacy_type="model_request",
            event_type="model.request",
            payload=payload,
            timestamp=started_at,
            status="running",
            span_id=span_id,
            parent_span_id=self._root_span_id,
        )

        try:
            response = await self._model.complete(request)
        except asyncio.CancelledError:
            duration_ms = int((time.perf_counter() - started_perf) * 1000)
            await self._emit(
                legacy_type="model_request",
                event_type="model.cancelled",
                payload={
                    **payload,
                    "failure_reason": "model_request_cancelled",
                },
                timestamp=datetime.utcnow(),
                status="cancelled",
                duration_ms=duration_ms,
                failure_reason="model_request_cancelled",
                parent_span_id=span_id,
            )
            raise
        except Exception as exc:
            duration_ms = int((time.perf_counter() - started_perf) * 1000)
            detail = _exception_detail(exc)
            await self._emit(
                legacy_type="model_response",
                event_type="model.error",
                payload={
                    **payload,
                    "failure_reason": detail,
                },
                timestamp=datetime.utcnow(),
                status="error",
                duration_ms=duration_ms,
                failure_reason=detail,
                parent_span_id=span_id,
            )
            raise

        duration_ms = int((time.perf_counter() - started_perf) * 1000)
        await self._emit(
            legacy_type="model_response",
            event_type="model.response",
            payload={
                **payload,
                "provider": response.provider,
                "model": response.model,
                "returned_model": response.model,
                "finish_reason": response.finish_reason,
                "usage": response.usage.model_dump() if response.usage else None,
                "message": response.message.model_dump(),
            },
            timestamp=datetime.utcnow(),
            status="success",
            duration_ms=duration_ms,
            parent_span_id=span_id,
        )
        return response

    async def aclose(self) -> None:
        """Close the wrapped model if it owns resources."""
        await _close_model_if_needed(self._model)


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

    async def list_runs(self) -> list[RunRecord]:
        """List all runs."""
        return await self.store.list_runs()

    async def get_events(self, run_id: str) -> list[RunEvent]:
        """Fetch runtime events for a run."""
        return await self.store.get_events(run_id)

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

            model = _ObservableChatModel(
                self._create_model(run.provider, run.model),
                emit=emit,
                root_span_id=root_span_id,
            )
            registry = self.tool_registry_factory()
            if run.tool_names is not None:
                registry = _filter_tool_registry(registry, run.tool_names)
            agent = Agent(
                name=self.agent_name,
                model=model,
                tool_registry=registry,
                session=InMemorySession(),
                system_prompt=run.system_prompt,
                max_iterations=run.max_iterations,
                temperature=run.temperature,
                max_tokens=run.max_tokens,
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
            await self._append_step_events(
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
                await _close_model_if_needed(model)
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

    async def _append_step_events(
        self,
        *,
        steps: list[AgentStep],
        emit: EventEmitter,
        root_span_id: str,
        include_model_events: bool = True,
    ) -> None:
        """Convert agent steps into normalized observability events."""
        if not steps:
            return

        iteration_span_ids: dict[int, str] = {}
        iteration_last_timestamp: dict[int, datetime | None] = {}
        current_iteration: int | None = None

        for step in steps:
            iteration = step.iteration or 0
            if current_iteration != iteration:
                if current_iteration is not None:
                    previous_span_id = iteration_span_ids[current_iteration]
                    await emit(
                        legacy_type="agent_iteration",
                        event_type="agent.iteration.finished",
                        payload={"iteration": current_iteration},
                        timestamp=iteration_last_timestamp.get(current_iteration),
                        status="completed",
                        span_id=previous_span_id,
                        parent_span_id=root_span_id,
                    )

                current_iteration = iteration
                current_span_id = iteration_span_ids.setdefault(iteration, new_span_id())
                await emit(
                    legacy_type="agent_iteration",
                    event_type="agent.iteration.started",
                    payload={"iteration": iteration},
                    timestamp=step.started_at,
                    status="running",
                    span_id=current_span_id,
                    parent_span_id=root_span_id,
                )

            iteration_span_id = iteration_span_ids.setdefault(iteration, new_span_id())
            step_payload = {"step_index": step.index, "iteration": iteration}

            if step.type == "model_response":
                step_payload.update(step.metadata or {})
                if include_model_events:
                    if step.started_at is not None:
                        await emit(
                            legacy_type="model_request",
                            event_type="model.request",
                            payload=step_payload,
                            timestamp=step.started_at,
                            status="running",
                            parent_span_id=iteration_span_id,
                        )
                    await emit(
                        legacy_type="model_response",
                        event_type="model.response",
                        payload={
                            **step_payload,
                            "finish_reason": step.finish_reason,
                            "usage": step.usage.model_dump() if step.usage else None,
                            "message": step.message.model_dump() if step.message else None,
                        },
                        timestamp=step.finished_at or step.started_at,
                        duration_ms=step.duration_ms,
                        status="success",
                        parent_span_id=iteration_span_id,
                    )
            else:
                step_payload.update(step.metadata or {})
                step_payload["tool_call"] = (
                    step.tool_call.model_dump() if step.tool_call else None
                )
                if step.started_at is not None:
                    await emit(
                        legacy_type="tool_call",
                        event_type="tool.started",
                        payload=step_payload,
                        timestamp=step.started_at,
                        status="running",
                        parent_span_id=iteration_span_id,
                    )
                await emit(
                    legacy_type="tool_call",
                    event_type="tool.finished",
                    payload={
                        **step_payload,
                        "tool_result_status": step.tool_result_status,
                        "tool_result_content": step.tool_result_content,
                    },
                    timestamp=step.finished_at or step.started_at,
                    duration_ms=step.duration_ms,
                    status=step.tool_result_status or "unknown",
                    failure_reason=step.tool_result_content
                    if step.tool_result_status == "error"
                    else None,
                    parent_span_id=iteration_span_id,
                )

            iteration_last_timestamp[iteration] = step.finished_at or step.started_at

        if current_iteration is not None:
            final_iteration_span_id = iteration_span_ids[current_iteration]
            await emit(
                legacy_type="agent_iteration",
                event_type="agent.iteration.finished",
                payload={"iteration": current_iteration},
                timestamp=iteration_last_timestamp.get(current_iteration),
                status="completed",
                span_id=final_iteration_span_id,
                parent_span_id=root_span_id,
            )

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
        decorated.diagnostics = self._build_run_diagnostics(decorated, events)
        return decorated

    def _build_run_diagnostics(
        self,
        run: RunRecord,
        events: list[RunEvent],
    ) -> RunDiagnostics:
        total_duration_ms: int | None = None
        if run.started_at and run.finished_at:
            total_duration_ms = int(
                (run.finished_at - run.started_at).total_seconds() * 1000,
            )

        model_events = [
            event
            for event in events
            if (event.event_type or event.type) == "model.response"
        ]
        tool_events = [
            event
            for event in events
            if (event.event_type or event.type) == "tool.finished"
        ]
        timed_events = [
            event
            for event in events
            if event.duration_ms is not None
            and (event.event_type or event.type) in {"model.response", "tool.finished"}
        ]
        timed_events.sort(key=lambda event: event.duration_ms or 0, reverse=True)

        slowest_steps = [
            RunStepTiming(
                event_type=event.event_type or event.type,
                label=self._step_label(event),
                iteration=(event.payload or event.data).get("iteration"),
                duration_ms=event.duration_ms or 0,
            )
            for event in timed_events[:3]
        ]

        return RunDiagnostics(
            total_duration_ms=total_duration_ms,
            iterations=run.result.iterations if run.result else None,
            model_call_count=len(model_events),
            tool_call_count=len(tool_events),
            event_count=len(events),
            token_usage=run.result.usage.model_copy(deep=True)
            if run.result and run.result.usage
            else None,
            failure_reason=run.failure_reason,
            slowest_steps=slowest_steps,
        )

    def _step_label(self, event: RunEvent) -> str:
        payload = event.payload or event.data
        event_type = event.event_type or event.type
        if event_type == "tool.finished":
            return str(payload.get("tool_name") or "tool")
        if event_type == "model.response":
            provider = payload.get("provider")
            model = (
                payload.get("returned_model")
                or payload.get("model")
                or payload.get("requested_model")
            )
            if provider and model:
                return f"{provider}/{model}"
            if model:
                return str(model)
            return "model"
        return event_type

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


async def _close_model_if_needed(model: ChatModel) -> None:
    """Close model resources when the model exposes `aclose`."""
    close_method = getattr(model, "aclose", None)
    if close_method is None:
        return

    result = close_method()
    if inspect.isawaitable(result):
        await result


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


def _filter_tool_registry(registry: ToolRegistry, tool_names: list[str]) -> ToolRegistry:
    """Create a registry containing only the named tools."""
    filtered = ToolRegistry()
    for name in tool_names:
        filtered.register(registry.get(name))
    return filtered


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
