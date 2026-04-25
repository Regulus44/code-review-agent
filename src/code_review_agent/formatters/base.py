"""Formatter protocols."""

from typing import Any, Protocol, Sequence

from code_review_agent.messages import Message, ToolCall


class MessageFormatter(Protocol):
    """Convert internal messages to/from provider payloads."""

    def format_messages(self, messages: Sequence[Message]) -> list[dict[str, Any]]:
        """Convert internal messages to provider chat messages."""

    def format_tools(
        self,
        tools: Sequence[dict[str, Any]] | None,
    ) -> list[dict[str, Any]] | None:
        """Convert internal tool schemas to provider tool schemas."""

    def parse_assistant_message(self, payload: dict[str, Any]) -> Message:
        """Convert a provider assistant message to an internal message."""

    def parse_tool_calls(self, payload: dict[str, Any]) -> list[ToolCall]:
        """Extract internal tool calls from a provider assistant message."""

