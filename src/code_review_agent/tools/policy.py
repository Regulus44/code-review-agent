"""Tool policy helpers."""

from __future__ import annotations

from .registry import ToolRegistry


def filter_tool_registry(registry: ToolRegistry, tool_names: list[str]) -> ToolRegistry:
    """Create a registry containing only the named tools.

    Raises ``ToolNotFoundError`` if any requested tool name is not registered.
    """
    filtered = ToolRegistry()
    for name in tool_names:
        filtered.register(registry.get(name))
    return filtered
