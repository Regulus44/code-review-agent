"""Tests for the minimal runtime service."""

from __future__ import annotations

import asyncio
from pathlib import Path

import anyio
import pytest
from pydantic import BaseModel, ConfigDict, Field

from code_review_agent.messages import ToolCall, assistant_message
from code_review_agent.models import ChatResponse, ChatModel, ModelUsage
from code_review_agent.runtime import (
    AgentRuntime,
    CreateRunRequest,
    RunAlreadyTerminalError,
    WorkspaceValidationError,
    build_default_runtime,
    build_default_tool_registry,
)
from code_review_agent.settings import get_settings
from code_review_agent.tools import Tool, ToolExecutionResult, ToolRegistry


@pytest.fixture
def anyio_backend() -> str:
    """Run AnyIO tests on asyncio only."""
    return "asyncio"


class EchoArguments(BaseModel):
    """Arguments for a fake echo tool."""

    model_config = ConfigDict(extra="forbid")

    value: str = Field(min_length=1)


class EchoTool(Tool):
    """Tool that echoes a value."""

    name = "echo"
    description = "Echo a value."
    arguments_model = EchoArguments

    async def _execute(self, context, arguments: EchoArguments) -> ToolExecutionResult:
        return ToolExecutionResult.success(
            tool_name=self.name,
            content=f"echo: {arguments.value}",
            data={"value": arguments.value},
        )


class FakeModel(ChatModel):
    """Model with scripted responses for runtime tests."""

    provider = "fake"
    model_name = "fake-model"

    def __init__(self, scripted: list[ChatResponse | Exception]) -> None:
        self._scripted = scripted

    async def complete(self, request):
        current = self._scripted.pop(0)
        if isinstance(current, Exception):
            raise current
        return current


class SlowModel(ChatModel):
    """Model that sleeps before returning a response."""

    provider = "fake"
    model_name = "slow-model"

    def __init__(self, delay_seconds: float, content: str = "Done") -> None:
        self.delay_seconds = delay_seconds
        self.content = content

    async def complete(self, request):
        await anyio.sleep(self.delay_seconds)
        return make_response(content=self.content)


class CountingModel(ChatModel):
    """Model that records whether it was called."""

    provider = "fake"
    model_name = "counting-model"

    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, request):
        self.calls += 1
        return make_response(content="Done")


class RecordingModel(ChatModel):
    """Model that records the tools visible in the request."""

    provider = "fake"
    model_name = "recording-model"

    def __init__(self) -> None:
        self.tools = None

    async def complete(self, request):
        self.tools = request.tools
        return make_response(content="Done")


def make_response(
    *,
    content: str | None = None,
    tool_calls: list[ToolCall] | None = None,
    usage: ModelUsage | None = None,
    finish_reason: str | None = "stop",
) -> ChatResponse:
    """Create a fake chat response."""
    return ChatResponse(
        message=assistant_message(content=content, tool_calls=tool_calls or []),
        provider="fake",
        model="fake-model",
        usage=usage,
        finish_reason=finish_reason,
    )


def build_registry() -> ToolRegistry:
    """Create a registry for runtime tests."""
    registry = ToolRegistry()
    registry.register(EchoTool())
    return registry


@pytest.mark.anyio
async def test_runtime_create_and_execute_run(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel(
            [
                make_response(
                    tool_calls=[
                        ToolCall(id="call_1", name="echo", arguments={"value": "hello"}),
                    ],
                    usage=ModelUsage(prompt_tokens=5, completion_tokens=2, total_tokens=7),
                    finish_reason="tool_calls",
                ),
                make_response(
                    content="Done",
                    usage=ModelUsage(prompt_tokens=4, completion_tokens=2, total_tokens=6),
                ),
            ],
        ),
        tool_registry_factory=build_registry,
    )

    run = await runtime.create_run(
        CreateRunRequest(
            user_input="Inspect this repo.",
            workspace_root=str(tmp_path),
        ),
    )
    executed = await runtime.execute_run(run.id)
    events = await runtime.get_events(run.id)

    assert run.status == "queued"
    assert run.provider == "deepseek"
    assert executed.status == "completed"
    assert executed.result is not None
    assert executed.result.final_message is not None
    assert executed.result.final_message.content == "Done"
    event_types = [event.event_type for event in events]
    assert event_types[0] == "run.queued"
    assert "run.started" in event_types
    assert "agent.iteration.started" in event_types
    assert "model.request" in event_types
    assert "model.response" in event_types
    assert "tool.started" in event_types
    assert "tool.finished" in event_types
    assert event_types[-1] == "run.completed"
    assert executed.diagnostics is not None
    assert executed.diagnostics.model_call_count == 2
    assert executed.diagnostics.tool_call_count == 1
    assert executed.diagnostics.event_count == len(events)
    assert executed.diagnostics.slowest_steps


@pytest.mark.anyio
async def test_runtime_rejects_workspace_outside_allowed_root(tmp_path: Path) -> None:
    allowed_root = tmp_path / "allowed"
    disallowed_root = tmp_path / "outside"
    allowed_root.mkdir()
    disallowed_root.mkdir()

    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="unused")]),
        tool_registry_factory=build_registry,
        allowed_workspace_root=allowed_root,
    )

    with pytest.raises(WorkspaceValidationError):
        await runtime.create_run(
            CreateRunRequest(
                user_input="Inspect this repo.",
                workspace_root=str(disallowed_root),
            ),
        )


@pytest.mark.anyio
async def test_runtime_lists_runs_in_reverse_creation_order(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="ok")]),
        tool_registry_factory=build_registry,
    )

    first = await runtime.create_run(
        CreateRunRequest(user_input="one", workspace_root=str(tmp_path)),
    )
    second = await runtime.create_run(
        CreateRunRequest(user_input="two", workspace_root=str(tmp_path)),
    )

    runs = await runtime.list_runs()

    assert [run.id for run in runs] == [second.id, first.id]


@pytest.mark.anyio
async def test_runtime_marks_run_failed_on_timeout(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: SlowModel(delay_seconds=0.2),
        tool_registry_factory=build_registry,
        run_timeout_seconds=0,
    )
    run = await runtime.create_run(
        CreateRunRequest(
            user_input="Inspect this repo.",
            workspace_root=str(tmp_path),
        ),
    )

    executed = await runtime.execute_run(run.id)
    events = await runtime.get_events(run.id)

    assert executed.status == "failed"
    assert executed.failure_reason == "run_timeout"
    assert events[-1].data["failure_reason"] == "run_timeout"


@pytest.mark.anyio
async def test_runtime_rejects_when_concurrency_limit_exceeded(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: SlowModel(delay_seconds=0.2),
        tool_registry_factory=build_registry,
        max_concurrent_runs=1,
    )
    run_one = await runtime.create_run(
        CreateRunRequest(user_input="one", workspace_root=str(tmp_path)),
    )
    run_two = await runtime.create_run(
        CreateRunRequest(user_input="two", workspace_root=str(tmp_path)),
    )

    task_one = anyio.create_task_group()
    async with task_one:
        task_one.start_soon(runtime.execute_run, run_one.id)
        await anyio.sleep(0.01)
        second = await runtime.execute_run(run_two.id)
        assert second.status == "failed"
        assert second.failure_reason == "concurrency_limit_exceeded"


@pytest.mark.anyio
async def test_runtime_cancels_queued_run_and_does_not_execute_it(
    tmp_path: Path,
) -> None:
    model = CountingModel()
    runtime = AgentRuntime(
        model_factory=lambda: model,
        tool_registry_factory=build_registry,
    )
    run = await runtime.create_run(
        CreateRunRequest(user_input="queued", workspace_root=str(tmp_path)),
    )

    cancelled = await runtime.cancel_run(run.id)
    executed = await runtime.execute_run(run.id)
    events = await runtime.get_events(run.id)

    assert cancelled.status == "cancelled"
    assert cancelled.failure_reason == "cancelled_by_user"
    assert cancelled.result is not None
    assert cancelled.result.status == "cancelled"
    assert executed.status == "cancelled"
    assert model.calls == 0
    event_types = [event.event_type for event in events]
    assert "run.cancel_requested" in event_types
    assert event_types[-1] == "run.cancelled"


@pytest.mark.anyio
async def test_runtime_cancels_running_run(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: SlowModel(delay_seconds=10),
        tool_registry_factory=build_registry,
    )
    run = await runtime.create_run(
        CreateRunRequest(user_input="running", workspace_root=str(tmp_path)),
    )

    execution_task = asyncio.create_task(runtime.execute_run(run.id))
    await anyio.sleep(0.05)
    requested = await runtime.cancel_run(run.id)
    executed = await execution_task
    events = await runtime.get_events(run.id)

    assert requested.status == "running"
    assert executed.status == "cancelled"
    assert executed.failure_reason == "cancelled_by_user"
    assert executed.result is not None
    assert executed.result.status == "cancelled"
    event_types = [event.event_type for event in events]
    assert "run.started" in event_types
    assert "run.cancel_requested" in event_types
    assert event_types[-1] == "run.cancelled"


@pytest.mark.anyio
async def test_runtime_rejects_cancel_for_terminal_run(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="Done")]),
        tool_registry_factory=build_registry,
    )
    run = await runtime.create_run(
        CreateRunRequest(user_input="terminal", workspace_root=str(tmp_path)),
    )
    executed = await runtime.execute_run(run.id)

    with pytest.raises(RunAlreadyTerminalError) as exc_info:
        await runtime.cancel_run(run.id)

    assert executed.status == "completed"
    assert exc_info.value.status == "completed"


@pytest.mark.anyio
async def test_disabled_tools_are_not_visible_to_model(tmp_path: Path) -> None:
    model = RecordingModel()
    runtime = AgentRuntime(
        model_factory=lambda: model,
        tool_registry_factory=lambda: build_default_tool_registry(("list_files",)),
    )
    run = await runtime.create_run(
        CreateRunRequest(user_input="inspect", workspace_root=str(tmp_path)),
    )

    executed = await runtime.execute_run(run.id)

    assert run.tool_names == ["list_files"]
    assert executed.tool_names == ["list_files"]
    assert executed.status == "completed"
    assert model.tools is not None
    assert [tool["name"] for tool in model.tools] == ["list_files"]


@pytest.mark.anyio
async def test_runtime_rejects_unknown_or_disabled_run_tool_names(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="Done")]),
        tool_registry_factory=lambda: build_default_tool_registry(("list_files",)),
    )

    with pytest.raises(WorkspaceValidationError, match="unknown or disabled tools"):
        await runtime.create_run(
            CreateRunRequest(
                user_input="inspect",
                workspace_root=str(tmp_path),
                tool_names=["run_command"],
            ),
        )


def test_default_runtime_rejects_unknown_enabled_tool(monkeypatch) -> None:
    monkeypatch.setenv("ENABLED_TOOLS", "missing_tool")
    get_settings.cache_clear()

    with pytest.raises(ValueError, match="unknown enabled tools"):
        build_default_runtime()

    get_settings.cache_clear()


@pytest.mark.anyio
async def test_runtime_persists_requested_provider(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="Done")]),
        tool_registry_factory=build_registry,
    )

    run = await runtime.create_run(
        CreateRunRequest(
            user_input="inspect",
            workspace_root=str(tmp_path),
            provider="deepseek",
            model="deepseek-chat",
        ),
    )

    assert run.provider == "deepseek"
    assert run.model == "deepseek-chat"


@pytest.mark.anyio
async def test_runtime_rejects_unknown_provider(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="unused")]),
        tool_registry_factory=build_registry,
    )

    with pytest.raises(WorkspaceValidationError, match="unknown model provider"):
        await runtime.create_run(
            CreateRunRequest(
                user_input="inspect",
                workspace_root=str(tmp_path),
                provider="unknown",
            ),
        )
