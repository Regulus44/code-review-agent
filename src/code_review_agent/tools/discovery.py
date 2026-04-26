"""Tool discovery helpers for API and UI surfaces."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict

from .base import Tool
from .registry import ToolRegistry


class ToolDescriptor(BaseModel):
    """Public metadata for one runtime tool."""

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    parameters: dict[str, Any]
    enabled: bool = True
    source: str = "builtin"
    category: str = "custom"
    risk_level: str = "low"
    disabled_reason: str | None = None


BUILTIN_TOOL_METADATA: dict[str, dict[str, str]] = {
    "list_files": {
        "source": "builtin",
        "category": "filesystem",
        "risk_level": "low",
    },
    "read_file": {
        "source": "builtin",
        "category": "filesystem",
        "risk_level": "medium",
    },
    "search_text": {
        "source": "builtin",
        "category": "search",
        "risk_level": "medium",
    },
    "run_command": {
        "source": "builtin",
        "category": "command",
        "risk_level": "high",
    },
}


def describe_tool(
    tool: Tool,
    *,
    enabled: bool = True,
    disabled_reason: str | None = None,
) -> ToolDescriptor:
    """Build a public descriptor for one tool."""
    metadata = BUILTIN_TOOL_METADATA.get(
        tool.name,
        {"source": "custom", "category": "custom", "risk_level": "low"},
    )
    return ToolDescriptor(
        name=tool.name,
        description=tool.description,
        parameters=tool.parameters,
        enabled=enabled,
        source=metadata["source"],
        category=metadata["category"],
        risk_level=metadata["risk_level"],
        disabled_reason=disabled_reason,
    )


def describe_registry(registry: ToolRegistry) -> list[ToolDescriptor]:
    """Describe all tools currently registered in a runtime registry."""
    return [describe_tool(tool) for tool in registry.list_tools()]
