"""Tests for the minimal agent loop."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel, ConfigDict, Field

from code_review_agent.harness import Agent
from code_review_agent.messages import Message, Role, ToolCall, assistant_message
from code_review_agent.models import (
    ChatRequest,
    ChatResponse,
    ChatModel,
    ModelAPIError,
    ModelUsage,
)
from code_review_agent.session import InMemorySession
from code_review_agent.tools import (
    Tool,
    ToolContext,
    ToolExecutionError,
    ToolExecutionResult,
    ToolRegistry,
)


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

    async def _execute(
        self,
        context: ToolContext,
        arguments: EchoArguments,
    ) -> ToolExecutionResult:
        return ToolExecutionResult.success(
            tool_name=self.name,
            content=f"echo: {arguments.value}",
            data={"value": arguments.value, "run_id": context.run_id},
        )


class BrokenTool(Tool):
    """Tool that always fails."""

    name = "broken"
    description = "Always fail."
    arguments_model = EchoArguments

    async def _execute(
        self,
        context: ToolContext,
        arguments: EchoArguments,
    ) -> ToolExecutionResult:
        raise ToolExecutionError(f"boom: {arguments.value}")


class FakeModel(ChatModel):
    """Model with scripted responses for harness tests."""

    provider = "fake"
    model_name = "fake-model"

    def __init__(self, scripted: list[ChatResponse | Exception]) -> None:
        self._scripted = scripted
        self.requests: list[ChatRequest] = []

    async def complete(self, request: ChatRequest) -> ChatResponse:
        self.requests.append(request.model_copy(deep=True))
        if not self._scripted:
            raise AssertionError("no scripted responses left")

        current = self._scripted.pop(0)
        if isinstance(current, Exception):
            raise current
        return current


def make_response(
    *,
    content: str | None = None,
    reasoning_content: str | None = None,
    tool_calls: list[ToolCall] | None = None,
    usage: ModelUsage | None = None,
    finish_reason: str | None = "stop",
) -> ChatResponse:
    """Create a fake chat response."""
    return ChatResponse(
        message=assistant_message(
            content=content,
            reasoning_content=reasoning_content,
            tool_calls=tool_calls or [],
        ),
        provider="fake",
        model="fake-model",
        usage=usage,
        finish_reason=finish_reason,
    )


@pytest.mark.anyio
async def test_agent_completes_without_tools(tmp_path) -> None:
    model = FakeModel(
        [
            make_response(
                content="Final answer",
                usage=ModelUsage(
                    prompt_tokens=5,
                    completion_tokens=3,
                    total_tokens=8,
                    prompt_cache_hit_tokens=2,
                    prompt_cache_miss_tokens=3,
                ),
            ),
        ],
    )
    agent = Agent(
        name="reviewer",
        model=model,
        session=InMemorySession(),
        system_prompt="You are a code reviewer.",
    )

    result = await agent.run("Review this repository.", ToolContext(workspace_root=tmp_path))

    assert result.status == "completed"
    assert result.final_message is not None
    assert result.final_message.content == "Final answer"
    assert [message.role.value for message in result.messages] == [
        "system",
        "user",
        "assistant",
    ]
    assert len(result.steps) == 1
    assert result.steps[0].type == "model_response"
    assert result.usage is not None
    assert result.usage.total_tokens == 8
    assert result.usage.prompt_cache_hit_tokens == 2
    assert result.usage.prompt_cache_miss_tokens == 3
    assert result.steps[0].metadata["context_original_message_count"] == 2
    assert result.steps[0].metadata["context_final_message_count"] == 2


@pytest.mark.anyio
async def test_agent_executes_tool_call_then_returns_final_message(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(EchoTool())
    model = FakeModel(
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
    )
    agent = Agent(
        name="reviewer",
        model=model,
        tool_registry=registry,
        session=InMemorySession(),
        system_prompt="You are a code reviewer.",
    )

    result = await agent.run(
        "Inspect the repo.",
        ToolContext(workspace_root=tmp_path, run_id="run-1"),
    )

    assert result.status == "completed"
    assert result.final_message is not None
    assert result.final_message.content == "Done"
    assert [message.role.value for message in result.messages] == [
        "system",
        "user",
        "assistant",
        "tool",
        "assistant",
    ]
    assert len(result.steps) == 3
    assert result.steps[0].type == "model_response"
    assert result.steps[1].type == "tool_call"
    assert result.steps[1].tool_result_status == "success"
    assert result.steps[2].type == "model_response"
    assert result.usage is not None
    assert result.usage.prompt_tokens == 9
    assert result.usage.completion_tokens == 4
    assert result.usage.total_tokens == 13
    assert model.requests[1].messages[-1].role.value == "tool"
    assert model.requests[1].messages[-1].content == "echo: hello"


@pytest.mark.anyio
async def test_agent_executes_multiple_tool_calls_in_order(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(EchoTool())
    model = FakeModel(
        [
            make_response(
                tool_calls=[
                    ToolCall(id="call_1", name="echo", arguments={"value": "first"}),
                    ToolCall(id="call_2", name="echo", arguments={"value": "second"}),
                ],
                finish_reason="tool_calls",
            ),
            make_response(content="All done"),
        ],
    )
    agent = Agent(
        name="reviewer",
        model=model,
        tool_registry=registry,
        session=InMemorySession(),
    )

    result = await agent.run("Inspect", ToolContext(workspace_root=tmp_path))

    tool_steps = [step for step in result.steps if step.type == "tool_call"]
    assert result.status == "completed"
    assert len(tool_steps) == 2
    assert tool_steps[0].tool_call is not None
    assert tool_steps[1].tool_call is not None
    assert tool_steps[0].tool_call.id == "call_1"
    assert tool_steps[1].tool_call.id == "call_2"
    assert [message.content for message in result.messages if message.role.value == "tool"] == [
        "echo: first",
        "echo: second",
    ]


@pytest.mark.anyio
async def test_agent_returns_max_iterations_status(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(EchoTool())
    model = FakeModel(
        [
            make_response(
                tool_calls=[
                    ToolCall(id="call_1", name="echo", arguments={"value": "one"}),
                ],
                finish_reason="tool_calls",
            ),
            make_response(
                tool_calls=[
                    ToolCall(id="call_2", name="echo", arguments={"value": "two"}),
                ],
                finish_reason="tool_calls",
            ),
        ],
    )
    agent = Agent(
        name="reviewer",
        model=model,
        tool_registry=registry,
        session=InMemorySession(),
        max_iterations=2,
    )

    result = await agent.run("Inspect", ToolContext(workspace_root=tmp_path))

    assert result.status == "max_iterations"
    assert result.failure_reason == "max_iterations_reached"
    assert result.iterations == 2
    assert len(result.steps) == 4


@pytest.mark.anyio
async def test_agent_returns_failed_when_model_errors(tmp_path) -> None:
    model = FakeModel([ModelAPIError("provider down")])
    agent = Agent(
        name="reviewer",
        model=model,
        session=InMemorySession(),
    )

    result = await agent.run("Inspect", ToolContext(workspace_root=tmp_path))

    assert result.status == "failed"
    assert result.failure_reason == "provider down"
    assert result.iterations == 0
    assert [message.role.value for message in result.messages] == ["user"]


@pytest.mark.anyio
async def test_agent_fails_if_tool_calls_returned_without_registry(tmp_path) -> None:
    model = FakeModel(
        [
            make_response(
                tool_calls=[
                    ToolCall(id="call_1", name="echo", arguments={"value": "x"}),
                ],
                finish_reason="tool_calls",
            ),
        ],
    )
    agent = Agent(name="reviewer", model=model, session=InMemorySession())

    result = await agent.run("Inspect", ToolContext(workspace_root=tmp_path))

    assert result.status == "failed"
    assert result.failure_reason == "tool_calls_returned_without_registry"
    assert len(result.steps) == 1


@pytest.mark.anyio
async def test_agent_continues_after_tool_error_result(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(BrokenTool())
    model = FakeModel(
        [
            make_response(
                tool_calls=[
                    ToolCall(id="call_1", name="broken", arguments={"value": "x"}),
                ],
                finish_reason="tool_calls",
            ),
            make_response(content="Recovered"),
        ],
    )
    agent = Agent(
        name="reviewer",
        model=model,
        tool_registry=registry,
        session=InMemorySession(),
    )

    result = await agent.run("Inspect", ToolContext(workspace_root=tmp_path))

    assert result.status == "completed"
    assert result.final_message is not None
    assert result.final_message.content == "Recovered"
    assert result.steps[1].tool_result_status == "error"
    assert "Tool 'broken' failed" in result.steps[1].tool_result_content
    assert [message.role.value for message in result.messages] == [
        "user",
        "assistant",
        "tool",
        "assistant",
    ]


@pytest.mark.anyio
async def test_agent_can_reuse_session_without_reset(tmp_path) -> None:
    model = FakeModel(
        [
            make_response(content="First answer"),
            make_response(content="Second answer"),
        ],
    )
    agent = Agent(
        name="reviewer",
        model=model,
        session=InMemorySession(),
        system_prompt="You are a code reviewer.",
    )
    context = ToolContext(workspace_root=tmp_path)

    first = await agent.run("First question", context, reset_session=True)
    second = await agent.run("Second question", context, reset_session=False)

    assert first.status == "completed"
    assert second.status == "completed"
    assert [message.role.value for message in second.messages] == [
        "system",
        "user",
        "assistant",
        "user",
        "assistant",
    ]


@pytest.mark.anyio
async def test_agent_usage_aggregation_ignores_missing_usage(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(EchoTool())
    model = FakeModel(
        [
            make_response(
                tool_calls=[
                    ToolCall(id="call_1", name="echo", arguments={"value": "hello"}),
                ],
                usage=ModelUsage(prompt_tokens=5, completion_tokens=2, total_tokens=7),
                finish_reason="tool_calls",
            ),
            make_response(content="Done", usage=None),
        ],
    )
    agent = Agent(
        name="reviewer",
        model=model,
        tool_registry=registry,
        session=InMemorySession(),
    )

    result = await agent.run("Inspect", ToolContext(workspace_root=tmp_path))

    assert result.status == "completed"
    assert result.usage is not None
    assert result.usage.prompt_tokens == 5
    assert result.usage.completion_tokens == 2
    assert result.usage.total_tokens == 7


@pytest.mark.anyio
async def test_agent_preserves_reasoning_content_in_model_request(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(EchoTool())
    reasoning = "private reasoning " * 200
    model = FakeModel(
        [
            make_response(
                reasoning_content=reasoning,
                tool_calls=[
                    ToolCall(id="call_1", name="echo", arguments={"value": "hello"}),
                ],
                finish_reason="tool_calls",
            ),
            make_response(content="Done"),
        ],
    )
    agent = Agent(
        name="reviewer",
        model=model,
        tool_registry=registry,
        session=InMemorySession(),
    )

    result = await agent.run("Inspect", ToolContext(workspace_root=tmp_path))

    assert result.status == "completed"
    assert model.requests[1].messages[1].role == Role.ASSISTANT
    assert model.requests[1].messages[1].reasoning_content == reasoning


@pytest.mark.anyio
async def test_agent_summarizes_old_large_tool_messages_for_model_request(tmp_path) -> None:
    session = InMemorySession()
    session.append(Message(role=Role.USER, content="Earlier task"))
    for index in range(8):
        session.append(
            assistant_message(
                tool_calls=[
                    ToolCall(
                        id=f"old_call_{index}",
                        name="echo",
                        arguments={"value": str(index)},
                    ),
                ],
            ),
        )
        session.append(
            Message(
                role=Role.TOOL,
                content="x" * 5000,
                name="echo",
                tool_call_id=f"old_call_{index}",
            ),
        )

    model = FakeModel([make_response(content="Done")])
    agent = Agent(name="reviewer", model=model, session=session)

    result = await agent.run(
        "Current task",
        ToolContext(workspace_root=tmp_path),
        reset_session=False,
    )

    assert result.status == "completed"
    old_tool_messages = [
        message
        for message in model.requests[0].messages
        if message.role == Role.TOOL and message.tool_call_id == "old_call_0"
    ]
    assert old_tool_messages
    assert old_tool_messages[0].content is not None
    assert old_tool_messages[0].content.startswith(
        "Tool result summarized for model context budget.",
    )
    assert model.requests[0].metadata["context_summarized_tool_messages"] >= 1


@pytest.mark.anyio
async def test_agent_circuit_breaks_on_consecutive_tool_errors(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(BrokenTool())
    # Generate 5 consecutive broken tool calls — one per iteration
    responses = [
        make_response(
            tool_calls=[ToolCall(id=f"call_{i}", name="broken", arguments={"value": str(i)})],
            finish_reason="tool_calls",
        )
        for i in range(5)
    ]
    model = FakeModel(responses)
    agent = Agent(
        name="reviewer",
        model=model,
        tool_registry=registry,
        session=InMemorySession(),
        max_iterations=10,
    )

    result = await agent.run("Inspect", ToolContext(workspace_root=tmp_path))

    assert result.status == "failed"
    assert "consecutive_tool_failures" in (result.failure_reason or "")
    assert result.iterations == 5
    tool_steps = [s for s in result.steps if s.type == "tool_call"]
    assert len(tool_steps) == 5
    for ts in tool_steps:
        assert ts.tool_result_status == "error"


@pytest.mark.anyio
async def test_agent_resets_error_counter_on_success(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(BrokenTool())
    registry.register(EchoTool())
    # 3 broken + 1 echo success + 3 more broken => only 3 consecutive, no trip
    responses = [
        make_response(
            tool_calls=[ToolCall(id=f"broken_{i}", name="broken", arguments={"value": str(i)})],
            finish_reason="tool_calls",
        )
        for i in range(3)
    ] + [
        make_response(
            tool_calls=[ToolCall(id="good", name="echo", arguments={"value": "ok"})],
            finish_reason="tool_calls",
        ),
    ] + [
        make_response(
            tool_calls=[ToolCall(id=f"broken_{i}", name="broken", arguments={"value": str(i)})],
            finish_reason="tool_calls",
        )
        for i in range(3, 6)
    ] + [
        make_response(content="done"),
    ]
    model = FakeModel(responses)
    agent = Agent(
        name="reviewer",
        model=model,
        tool_registry=registry,
        session=InMemorySession(),
        max_iterations=10,
    )

    result = await agent.run("Inspect", ToolContext(workspace_root=tmp_path))

    assert result.status == "completed"
    assert result.final_message is not None
    assert result.final_message.content == "done"
    tool_steps = [s for s in result.steps if s.type == "tool_call"]
    assert len(tool_steps) == 7


@pytest.mark.anyio
async def test_agent_obeys_custom_max_consecutive_tool_errors(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(BrokenTool())
    responses = [
        make_response(
            tool_calls=[ToolCall(id=f"call_{i}", name="broken", arguments={"value": str(i)})],
            finish_reason="tool_calls",
        )
        for i in range(3)
    ]
    model = FakeModel(responses)
    agent = Agent(
        name="reviewer",
        model=model,
        tool_registry=registry,
        session=InMemorySession(),
        max_consecutive_tool_errors=3,
        max_iterations=10,
    )

    result = await agent.run("Inspect", ToolContext(workspace_root=tmp_path))

    assert result.status == "failed"
    assert "consecutive_tool_failures" in (result.failure_reason or "")
    assert result.iterations == 3
