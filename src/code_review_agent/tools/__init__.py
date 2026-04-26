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
from .registry import ToolRegistry

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
]
