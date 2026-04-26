"""OpenAI-compatible message and tool formatter."""

import json
from typing import Any, Sequence

from code_review_agent.messages import Message, Role, ToolCall, assistant_message
from code_review_agent.models.base import ModelResponseParseError


class OpenAIChatFormatter:
    """Formatter for OpenAI-compatible chat completion APIs."""

    def format_messages(self, messages: Sequence[Message]) -> list[dict[str, Any]]:
        """Convert internal messages to OpenAI-compatible messages."""
        return [self._format_message(message) for message in messages]

    def format_tools(
        self,
        tools: Sequence[dict[str, Any]] | None,
    ) -> list[dict[str, Any]] | None:
        """Convert JSON-schema tool definitions to provider tool payloads."""
        if not tools:
            return None

        formatted = []
        for tool in tools:
            if tool.get("type") == "function" and "function" in tool:
                formatted.append(dict(tool))
            else:
                formatted.append({"type": "function", "function": dict(tool)})
        return formatted

    def parse_assistant_message(self, payload: dict[str, Any]) -> Message:
        """Parse a provider assistant message."""
        if payload.get("role") != "assistant":
            raise ModelResponseParseError(
                f"expected assistant message, got {payload.get('role')!r}",
            )

        return assistant_message(
            content=payload.get("content"),
            reasoning_content=payload.get("reasoning_content"),
            tool_calls=self.parse_tool_calls(payload),
            raw=payload,
        )

    def parse_tool_calls(self, payload: dict[str, Any]) -> list[ToolCall]:
        """Parse OpenAI-compatible tool calls."""
        parsed = []
        for tool_call in payload.get("tool_calls") or []:
            function = tool_call.get("function") or {}
            raw_arguments = function.get("arguments") or "{}"
            try:
                arguments = json.loads(raw_arguments)
            except json.JSONDecodeError as exc:
                raise ModelResponseParseError(
                    "model returned malformed tool call arguments JSON",
                ) from exc

            if not isinstance(arguments, dict):
                raise ModelResponseParseError(
                    "tool call arguments must decode to a JSON object",
                )

            parsed.append(
                ToolCall(
                    id=tool_call["id"],
                    name=function["name"],
                    arguments=arguments,
                    raw_arguments=raw_arguments,
                ),
            )
        return parsed

    def _format_message(self, message: Message) -> dict[str, Any]:
        if message.role == Role.TOOL:
            formatted_tool_message = {
                "role": "tool",
                "tool_call_id": message.tool_call_id,
                "content": message.content,
            }
            if message.name:
                formatted_tool_message["name"] = message.name
            return formatted_tool_message

        formatted: dict[str, Any] = {
            "role": message.role.value,
            "content": message.content,
        }
        if message.name:
            formatted["name"] = message.name

        if message.tool_calls:
            formatted["tool_calls"] = [
                {
                    "id": tool_call.id,
                    "type": "function",
                    "function": {
                        "name": tool_call.name,
                        "arguments": tool_call.raw_arguments
                        if tool_call.raw_arguments is not None
                        else json.dumps(tool_call.arguments, ensure_ascii=False),
                    },
                }
                for tool_call in message.tool_calls
            ]

        if message.reasoning_content is not None:
            formatted["reasoning_content"] = message.reasoning_content

        return formatted
