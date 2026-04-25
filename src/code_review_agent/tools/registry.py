"""Tool registration and invocation."""

from __future__ import annotations

from typing import Any

from code_review_agent.messages import ToolCall

from .base import (
    Tool,
    ToolArgumentsError,
    ToolContext,
    ToolExecutionError,
    ToolExecutionResult,
    ToolNotFoundError,
)


class ToolRegistry:
    """Registry for local built-in tools."""

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        """Register a tool by name."""
        if tool.name in self._tools:
            raise ValueError(f"tool already registered: {tool.name}")
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool:
        """Get a registered tool by name."""
        try:
            return self._tools[name]
        except KeyError as exc:
            raise ToolNotFoundError(f"tool is not registered: {name}") from exc

    def list_tools(self) -> list[Tool]:
        """List registered tools."""
        return list(self._tools.values())

    def get_model_schemas(self) -> list[dict[str, Any]]:
        """Export tool schemas in the format expected by the formatter."""
        return [tool.to_model_schema() for tool in self._tools.values()]

    async def invoke(
        self,
        tool_call: ToolCall,
        context: ToolContext,
    ) -> ToolExecutionResult:
        """Execute a tool call and normalize all failures into results."""
        try:
            tool = self.get(tool_call.name)
        except ToolNotFoundError as exc:
            return ToolExecutionResult.error(
                tool_name=tool_call.name,
                content=f"Tool '{tool_call.name}' is not registered.",
                data={"arguments": tool_call.arguments},
                metadata={"error_type": "tool_not_found", "detail": str(exc)},
            )

        try:
            return await tool.execute(context, tool_call.arguments)
        except ToolArgumentsError as exc:
            return ToolExecutionResult.error(
                tool_name=tool.name,
                content=f"Invalid arguments for tool '{tool.name}': {exc}",
                data={"arguments": tool_call.arguments},
                metadata={"error_type": "tool_arguments_error"},
            )
        except ToolExecutionError as exc:
            return ToolExecutionResult.error(
                tool_name=tool.name,
                content=f"Tool '{tool.name}' failed: {exc}",
                data={"arguments": tool_call.arguments},
                metadata={"error_type": "tool_execution_error"},
            )
        except Exception as exc:  # pragma: no cover - defensive fallback
            return ToolExecutionResult.error(
                tool_name=tool.name,
                content=f"Tool '{tool.name}' failed unexpectedly: {exc}",
                data={"arguments": tool_call.arguments},
                metadata={"error_type": "unexpected_tool_error"},
            )

