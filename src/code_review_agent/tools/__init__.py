"""Tool abstractions and built-in tools."""

from .base import (
    Tool,
    ToolArgumentsError,
    ToolContext,
    ToolError,
    ToolExecutionError,
    ToolExecutionResult,
    ToolNotFoundError,
)
from .command_tools import RunCommandTool
from .discovery import ToolDescriptor, describe_registry, describe_tool
from .file_tools import ListFilesTool, ReadFileTool, SearchTextTool
from .policy import filter_tool_registry
from .registry import ToolRegistry
from .truncation import truncate_text

__all__ = [
    "ListFilesTool",
    "ReadFileTool",
    "RunCommandTool",
    "SearchTextTool",
    "Tool",
    "ToolArgumentsError",
    "ToolContext",
    "ToolError",
    "ToolExecutionError",
    "ToolExecutionResult",
    "ToolNotFoundError",
    "ToolRegistry",
    "ToolDescriptor",
    "describe_registry",
    "describe_tool",
    "filter_tool_registry",
    "truncate_text",
]
