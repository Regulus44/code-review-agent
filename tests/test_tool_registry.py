"""Tests for tool registry and execution results."""

from typing import Any

import pytest
from pydantic import BaseModel, ConfigDict, Field

from code_review_agent.formatters import OpenAIChatFormatter
from code_review_agent.messages import ToolCall
from code_review_agent.runtime import (
    build_default_tool_descriptors,
    build_default_tool_registry,
)
from code_review_agent.settings import get_settings
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
    """Dummy arguments for registry tests."""

    model_config = ConfigDict(extra="forbid")

    value: str = Field(min_length=1)


class EchoTool(Tool):
    """Simple tool for registry tests."""

    name = "echo"
    description = "Echo the provided value."
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
    """Tool that raises an execution error."""

    name = "broken"
    description = "Always fails."
    arguments_model = EchoArguments

    async def _execute(
        self,
        context: ToolContext,
        arguments: EchoArguments,
    ) -> ToolExecutionResult:
        raise ToolExecutionError(f"boom: {arguments.value}")


def test_registry_registers_and_exports_model_schemas(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(EchoTool())

    tools = registry.list_tools()
    assert len(tools) == 1
    assert registry.get("echo") is tools[0]

    schemas = registry.get_model_schemas()
    assert schemas[0]["name"] == "echo"
    assert schemas[0]["description"] == "Echo the provided value."

    formatted = OpenAIChatFormatter().format_tools(schemas)
    assert formatted is not None
    assert formatted[0]["function"]["name"] == "echo"


def test_registry_rejects_duplicate_registration() -> None:
    registry = ToolRegistry()
    registry.register(EchoTool())

    with pytest.raises(ValueError):
        registry.register(EchoTool())


def test_default_tool_registry_respects_enabled_tools() -> None:
    registry = build_default_tool_registry(("list_files", "read_file"))

    assert [tool.name for tool in registry.list_tools()] == ["list_files", "read_file"]


def test_default_tool_descriptors_mark_disabled_tools() -> None:
    descriptors = build_default_tool_descriptors(("list_files",))
    by_name = {tool.name: tool for tool in descriptors}

    assert by_name["list_files"].enabled is True
    assert by_name["read_file"].enabled is False
    assert by_name["read_file"].disabled_reason == "not_in_enabled_tools"
    assert by_name["run_command"].enabled is False


def test_default_tool_registry_rejects_unknown_enabled_tool() -> None:
    with pytest.raises(ValueError, match="unknown enabled tools"):
        build_default_tool_registry(("missing_tool",))


def test_default_tool_registry_uses_enabled_tools_setting(monkeypatch) -> None:
    monkeypatch.setenv("ENABLED_TOOLS", "list_files,search_text")
    get_settings.cache_clear()

    registry = build_default_tool_registry()

    assert [tool.name for tool in registry.list_tools()] == [
        "list_files",
        "search_text",
    ]

    get_settings.cache_clear()


def test_tool_execution_result_converts_to_message_result() -> None:
    success = ToolExecutionResult.success(
        tool_name="echo",
        content="ok",
        data={"value": "ok"},
    )
    error = ToolExecutionResult.error(
        tool_name="echo",
        content="bad",
        metadata={"error_type": "example"},
    )

    success_message = success.to_message_result("call_success")
    error_message = error.to_message_result("call_error")

    assert success_message.is_error is False
    assert success_message.name == "echo"
    assert error_message.is_error is True
    assert error_message.tool_call_id == "call_error"


@pytest.mark.anyio
async def test_registry_invokes_tool_successfully(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(EchoTool())
    context = ToolContext(workspace_root=tmp_path, run_id="run_1")

    result = await registry.invoke(
        ToolCall(id="call_1", name="echo", arguments={"value": "hi"}),
        context,
    )

    assert result.status == "success"
    assert result.content == "echo: hi"
    assert result.data == {"value": "hi", "run_id": "run_1"}


@pytest.mark.anyio
async def test_registry_returns_error_for_unknown_tool(tmp_path) -> None:
    registry = ToolRegistry()
    context = ToolContext(workspace_root=tmp_path)

    result = await registry.invoke(
        ToolCall(id="call_1", name="missing", arguments={"value": "hi"}),
        context,
    )

    assert result.status == "error"
    assert "is not registered" in result.content
    assert result.metadata["error_type"] == "tool_not_found"


@pytest.mark.anyio
async def test_registry_returns_error_for_invalid_arguments(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(EchoTool())
    context = ToolContext(workspace_root=tmp_path)

    result = await registry.invoke(
        ToolCall(id="call_1", name="echo", arguments={}),
        context,
    )

    assert result.status == "error"
    assert "Invalid arguments" in result.content
    assert result.metadata["error_type"] == "tool_arguments_error"


@pytest.mark.anyio
async def test_registry_returns_error_for_tool_execution_failure(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(BrokenTool())
    context = ToolContext(workspace_root=tmp_path)

    result = await registry.invoke(
        ToolCall(id="call_1", name="broken", arguments={"value": "oops"}),
        context,
    )

    assert result.status == "error"
    assert "Tool 'broken' failed" in result.content
    assert result.metadata["error_type"] == "tool_execution_error"
