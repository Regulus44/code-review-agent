"""Minimal runtime service and default runtime factory."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import time
from pathlib import Path
from typing import Callable
from uuid import uuid4

from code_review_agent.harness import Agent, AgentStep
from code_review_agent.models import ChatModel, DeepSeekModel
from code_review_agent.session import InMemorySession
from code_review_agent.settings import get_settings
from code_review_agent.storage import SqliteRunStore
from code_review_agent.tools import (
    ListFilesTool,
    ReadFileTool,
    SearchTextTool,
    ToolContext,
    ToolRegistry,
)

from .store import InMemoryRunStore, RunStore
from .types import CreateRunRequest, RunEvent, RunRecord


ModelFactory = Callable[[], ChatModel]
ToolRegistryFactory = Callable[[], ToolRegistry]

DEFAULT_SYSTEM_PROMPT = (
    "You are a repository analysis and code review agent. "
    "Use tools when you need grounded file information. "
    "Base every conclusion on the repository contents."
)


class WorkspaceValidationError(ValueError):
    """Raised when workspace_root fails runtime policy checks."""


class AgentRuntime:
    """Minimal runtime service that creates and executes agent runs."""

    def __init__(
        self,
        *,
        model_factory: ModelFactory,
        tool_registry_factory: ToolRegistryFactory,
        store: RunStore | None = None,
        agent_name: str = "code-review-agent",
        default_system_prompt: str = DEFAULT_SYSTEM_PROMPT,
        default_max_iterations: int = 8,
        run_timeout_seconds: int = 300,
        max_concurrent_runs: int = 4,
        allowed_workspace_root: Path | None = None,
    ) -> None:
        self.model_factory = model_factory
        self.tool_registry_factory = tool_registry_factory
        self.store = store or InMemoryRunStore()
        self.agent_name = agent_name
        self.default_system_prompt = default_system_prompt
        self.default_max_iterations = default_max_iterations
        self.run_timeout_seconds = run_timeout_seconds
        self.max_concurrent_runs = max_concurrent_runs
        self.allowed_workspace_root = (
            allowed_workspace_root.resolve(strict=False)
            if allowed_workspace_root is not None
            else None
        )
        self._active_runs = 0
        self._active_runs_lock = asyncio.Lock()
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
        )
        created = await self.store.create_run(run)
        await self.store.append_event(
            created.id,
            RunEvent(index=1, type="status_change", data={"status": "queued"}),
        )
        self._log_runtime_event(
            run_id=created.id,
            status="queued",
            latency_ms=0,
            failure_reason=None,
            token_usage=None,
        )
        return created

    async def get_run(self, run_id: str) -> RunRecord:
        """Fetch one run record."""
        return await self.store.get_run(run_id)

    async def list_runs(self) -> list[RunRecord]:
        """List all runs."""
        return await self.store.list_runs()

    async def get_events(self, run_id: str) -> list[RunEvent]:
        """Fetch runtime events for a run."""
        return await self.store.get_events(run_id)

    async def execute_run(self, run_id: str) -> RunRecord:
        """Execute one queued run."""
        run = await self.store.get_run(run_id)

        if await self._reject_for_concurrency(run_id):
            return await self.store.get_run(run_id)

        model: ChatModel | None = None
        started_at = time.perf_counter()
        try:
            await self.store.update_status(run_id, "running")
            await self.store.append_event(
                run_id,
                RunEvent(
                    index=(await self._next_event_index(run_id)),
                    type="status_change",
                    data={"status": "running"},
                ),
            )

            model = self.model_factory()
            registry = self.tool_registry_factory()
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
            await self._append_step_events(run_id, result.steps)
            await self.store.update_status(
                run_id,
                result.status,
                failure_reason=result.failure_reason,
            )
            await self.store.append_event(
                run_id,
                RunEvent(
                    index=(await self._next_event_index(run_id)),
                    type="status_change",
                    data={
                        "status": result.status,
                        "failure_reason": result.failure_reason,
                    },
                ),
            )
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            usage = result.usage.model_dump() if result.usage else None
            self._log_runtime_event(
                run_id=run_id,
                status=result.status,
                latency_ms=elapsed_ms,
                failure_reason=result.failure_reason,
                token_usage=usage,
            )
            return await self.store.get_run(run_id)
        except asyncio.TimeoutError:
            await self.store.update_status(
                run_id,
                "failed",
                failure_reason="run_timeout",
            )
            await self.store.append_event(
                run_id,
                RunEvent(
                    index=(await self._next_event_index(run_id)),
                    type="status_change",
                    data={"status": "failed", "failure_reason": "run_timeout"},
                ),
            )
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            self._log_runtime_event(
                run_id=run_id,
                status="failed",
                latency_ms=elapsed_ms,
                failure_reason="run_timeout",
                token_usage=None,
            )
            return await self.store.get_run(run_id)
        except Exception as exc:
            await self.store.update_status(run_id, "failed", failure_reason=str(exc))
            await self.store.append_event(
                run_id,
                RunEvent(
                    index=(await self._next_event_index(run_id)),
                    type="status_change",
                    data={"status": "failed", "failure_reason": str(exc)},
                ),
            )
            elapsed_ms = int((time.perf_counter() - started_at) * 1000)
            self._log_runtime_event(
                run_id=run_id,
                status="failed",
                latency_ms=elapsed_ms,
                failure_reason=str(exc),
                token_usage=None,
            )
            return await self.store.get_run(run_id)
        finally:
            if model is not None:
                await _close_model_if_needed(model)
            await self._release_active_slot()

    async def aclose(self) -> None:
        """Close runtime resources."""
        await self.store.aclose()

    async def _append_step_events(self, run_id: str, steps: list[AgentStep]) -> None:
        """Convert agent steps into runtime events."""
        next_index = await self._next_event_index(run_id)
        for step in steps:
            if step.type == "model_response":
                data = {
                    "step_index": step.index,
                    "finish_reason": step.finish_reason,
                    "usage": step.usage.model_dump() if step.usage else None,
                    "message": step.message.model_dump() if step.message else None,
                }
            else:
                data = {
                    "step_index": step.index,
                    "tool_call": step.tool_call.model_dump()
                    if step.tool_call
                    else None,
                    "tool_result_status": step.tool_result_status,
                    "tool_result_content": step.tool_result_content,
                }

            await self.store.append_event(
                run_id,
                RunEvent(index=next_index, type=step.type, data=data),
            )
            next_index += 1

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
        await self.store.append_event(
            run_id,
            RunEvent(
                index=(await self._next_event_index(run_id)),
                type="status_change",
                data={
                    "status": "failed",
                    "failure_reason": "concurrency_limit_exceeded",
                },
            ),
        )
        self._log_runtime_event(
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

    def _log_runtime_event(
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
        self._logger.info("runtime_event %s", json.dumps(payload, ensure_ascii=False))


async def _close_model_if_needed(model: ChatModel) -> None:
    """Close model resources when the model exposes `aclose`."""
    close_method = getattr(model, "aclose", None)
    if close_method is None:
        return

    result = close_method()
    if inspect.isawaitable(result):
        await result


def build_default_tool_registry() -> ToolRegistry:
    """Create the default registry used by the runtime API."""
    registry = ToolRegistry()
    registry.register(ListFilesTool())
    registry.register(ReadFileTool())
    registry.register(SearchTextTool())
    return registry


def build_default_runtime() -> AgentRuntime:
    """Create the default runtime using DeepSeek and local file tools."""
    settings = get_settings()
    try:
        store: RunStore = SqliteRunStore(settings.database_url)
    except ModuleNotFoundError:
        logging.getLogger(__name__).warning(
            "aiosqlite is missing; falling back to in-memory runtime store",
        )
        store = InMemoryRunStore()
    return AgentRuntime(
        model_factory=DeepSeekModel,
        tool_registry_factory=build_default_tool_registry,
        store=store,
        run_timeout_seconds=settings.run_timeout_seconds,
        max_concurrent_runs=settings.max_concurrent_runs,
        allowed_workspace_root=Path(settings.runtime_workspace_root),
    )
