"""Tests for the minimal runtime service."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import BaseModel, ConfigDict, Field

from code_review_agent.messages import ToolCall, assistant_message
from code_review_agent.models import ChatResponse, ChatModel, ModelUsage
from code_review_agent.runtime import AgentRuntime, CreateRunRequest
from code_review_agent.tools import Tool, ToolExecutionError, ToolExecutionResult, ToolRegistry


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

    run = runtime.create_run(
        CreateRunRequest(
            user_input="Inspect this repo.",
            workspace_root=str(tmp_path),
        ),
    )
    executed = await runtime.execute_run(run.id)
    events = runtime.get_events(run.id)

    assert run.status == "queued"
    assert executed.status == "completed"
    assert executed.result is not None
    assert executed.result.final_message is not None
    assert executed.result.final_message.content == "Done"
    assert [event.type for event in events] == [
        "status_change",
        "status_change",
        "model_response",
        "tool_call",
        "model_response",
        "status_change",
    ]


@pytest.mark.anyio
async def test_runtime_marks_failed_when_workspace_is_invalid(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="unused")]),
        tool_registry_factory=build_registry,
    )

    run = runtime.create_run(
        CreateRunRequest(
            user_input="Inspect this repo.",
            workspace_root=str(tmp_path / "missing"),
        ),
    )
    executed = await runtime.execute_run(run.id)

    assert executed.status == "failed"
    assert executed.failure_reason is not None
    assert "workspace_root does not exist" in executed.failure_reason


@pytest.mark.anyio
async def test_runtime_lists_runs_in_reverse_creation_order(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="ok")]),
        tool_registry_factory=build_registry,
    )

    first = runtime.create_run(
        CreateRunRequest(user_input="one", workspace_root=str(tmp_path)),
    )
    second = runtime.create_run(
        CreateRunRequest(user_input="two", workspace_root=str(tmp_path)),
    )

    runs = runtime.list_runs()

    assert [run.id for run in runs] == [second.id, first.id]

