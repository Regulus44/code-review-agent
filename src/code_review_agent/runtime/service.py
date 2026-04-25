"""Minimal runtime service and default runtime factory."""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Awaitable, Callable
from uuid import uuid4

from code_review_agent.harness import Agent, AgentStep
from code_review_agent.models import ChatModel, DeepSeekModel
from code_review_agent.session import InMemorySession
from code_review_agent.tools import (
    ListFilesTool,
    ReadFileTool,
    SearchTextTool,
    ToolContext,
    ToolRegistry,
)

from .store import InMemoryRunStore
from .types import CreateRunRequest, RunEvent, RunRecord


ModelFactory = Callable[[], ChatModel]
ToolRegistryFactory = Callable[[], ToolRegistry]

DEFAULT_SYSTEM_PROMPT = (
    "You are a repository analysis and code review agent. "
    "Use tools when you need grounded file information. "
    "Base every conclusion on the repository contents."
)


class AgentRuntime:
    """Minimal runtime service that creates and executes agent runs."""

    def __init__(
        self,
        *,
        model_factory: ModelFactory,
        tool_registry_factory: ToolRegistryFactory,
        store: InMemoryRunStore | None = None,
        agent_name: str = "code-review-agent",
        default_system_prompt: str = DEFAULT_SYSTEM_PROMPT,
        default_max_iterations: int = 8,
    ) -> None:
        self.model_factory = model_factory
        self.tool_registry_factory = tool_registry_factory
        self.store = store or InMemoryRunStore()
        self.agent_name = agent_name
        self.default_system_prompt = default_system_prompt
        self.default_max_iterations = default_max_iterations

    def create_run(self, request: CreateRunRequest) -> RunRecord:
        """Create a queued run record."""
        resolved_workspace = Path(request.workspace_root).resolve(strict=False)
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
        created = self.store.create_run(run)
        self.store.append_event(
            created.id,
            RunEvent(
                index=1,
                type="status_change",
                data={"status": "queued"},
            ),
        )
        return created

    def get_run(self, run_id: str) -> RunRecord:
        """Fetch one run record."""
        return self.store.get_run(run_id)

    def list_runs(self) -> list[RunRecord]:
        """List all runs."""
        return self.store.list_runs()

    def get_events(self, run_id: str) -> list[RunEvent]:
        """Fetch runtime events for a run."""
        return self.store.get_events(run_id)

    async def execute_run(self, run_id: str) -> RunRecord:
        """Execute one queued run."""
        run = self.store.get_run(run_id)
        self.store.update_status(run_id, "running")
        self.store.append_event(
            run_id,
            RunEvent(
                index=len(self.store.get_events(run_id)) + 1,
                type="status_change",
                data={"status": "running"},
            ),
        )

        model: ChatModel | None = None
        try:
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

            result = await agent.run(
                run.user_input,
                ToolContext(
                    workspace_root=Path(run.workspace_root),
                    run_id=run.id,
                ),
            )

            self.store.attach_result(run_id, result)
            self._append_step_events(run_id, result.steps)
            self.store.update_status(
                run_id,
                result.status,
                failure_reason=result.failure_reason,
            )
            self.store.append_event(
                run_id,
                RunEvent(
                    index=len(self.store.get_events(run_id)) + 1,
                    type="status_change",
                    data={
                        "status": result.status,
                        "failure_reason": result.failure_reason,
                    },
                ),
            )
            return self.store.get_run(run_id)
        except Exception as exc:
            self.store.update_status(run_id, "failed", failure_reason=str(exc))
            self.store.append_event(
                run_id,
                RunEvent(
                    index=len(self.store.get_events(run_id)) + 1,
                    type="status_change",
                    data={"status": "failed", "failure_reason": str(exc)},
                ),
            )
            return self.store.get_run(run_id)
        finally:
            if model is not None:
                await _close_model_if_needed(model)

    def _append_step_events(self, run_id: str, steps: list[AgentStep]) -> None:
        """Convert agent steps into runtime events."""
        next_index = len(self.store.get_events(run_id)) + 1
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

            self.store.append_event(
                run_id,
                RunEvent(index=next_index, type=step.type, data=data),
            )
            next_index += 1


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
    return AgentRuntime(
        model_factory=DeepSeekModel,
        tool_registry_factory=build_default_tool_registry,
    )
