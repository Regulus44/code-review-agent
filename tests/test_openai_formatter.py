"""Tests for OpenAI-compatible formatting."""

import pytest

from code_review_agent.formatters import OpenAIChatFormatter
from code_review_agent.messages import (
    ToolCall,
    ToolResult,
    assistant_message,
    system_message,
    tool_message,
    user_message,
)
from code_review_agent.models import ModelResponseParseError


def test_format_messages_supports_chat_and_tool_messages() -> None:
    formatter = OpenAIChatFormatter()
    messages = [
        system_message("You review code."),
        user_message("Please review."),
        assistant_message(
            tool_calls=[
                ToolCall(
                    id="call_1",
                    name="read_file",
                    arguments={"path": "main.py"},
                ),
            ],
        ),
        tool_message(
            ToolResult(
                tool_call_id="call_1",
                name="read_file",
                content="print('hi')",
            ),
        ),
    ]

    formatted = formatter.format_messages(messages)

    assert formatted[0] == {"role": "system", "content": "You review code."}
    assert formatted[1] == {"role": "user", "content": "Please review."}
    assert formatted[2]["tool_calls"][0]["function"]["name"] == "read_file"
    assert formatted[2]["tool_calls"][0]["function"]["arguments"] == (
        '{"path": "main.py"}'
    )
    assert formatted[3]["role"] == "tool"
    assert formatted[3]["tool_call_id"] == "call_1"


def test_format_tools_wraps_plain_function_schema() -> None:
    formatter = OpenAIChatFormatter()
    tools = [
        {
            "name": "read_file",
            "description": "Read a repository file.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    ]

    formatted = formatter.format_tools(tools)

    assert formatted == [{"type": "function", "function": tools[0]}]


def test_parse_text_assistant_message() -> None:
    formatter = OpenAIChatFormatter()

    message = formatter.parse_assistant_message(
        {"role": "assistant", "content": "Looks good."},
    )

    assert message.content == "Looks good."
    assert message.tool_calls == []


def test_parse_and_format_reasoning_content_roundtrip() -> None:
    formatter = OpenAIChatFormatter()

    parsed = formatter.parse_assistant_message(
        {
            "role": "assistant",
            "content": "Final answer",
            "reasoning_content": "internal reasoning",
        },
    )
    formatted = formatter.format_messages([parsed])[0]

    assert parsed.reasoning_content == "internal reasoning"
    assert formatted["reasoning_content"] == "internal reasoning"
    assert formatted["content"] == "Final answer"


def test_parse_assistant_tool_calls() -> None:
    formatter = OpenAIChatFormatter()

    message = formatter.parse_assistant_message(
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "arguments": '{"path": "main.py"}',
                    },
                },
            ],
        },
    )

    assert message.tool_calls[0].id == "call_1"
    assert message.tool_calls[0].name == "read_file"
    assert message.tool_calls[0].arguments == {"path": "main.py"}


def test_parse_malformed_tool_arguments_fails() -> None:
    formatter = OpenAIChatFormatter()

    with pytest.raises(ModelResponseParseError):
        formatter.parse_assistant_message(
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{not-json",
                        },
                    },
                ],
            },
        )
