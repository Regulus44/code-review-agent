"""Tests for provider-neutral messages."""

import pytest
from pydantic import ValidationError

from code_review_agent.messages import (
    Message,
    Role,
    ToolCall,
    ToolResult,
    assistant_message,
    system_message,
    tool_message,
    user_message,
)


def test_message_helpers_create_expected_roles() -> None:
    assert system_message("rules").role == Role.SYSTEM
    assert user_message("review this").role == Role.USER

    tool_call = ToolCall(id="call_1", name="read_file", arguments={"path": "a.py"})
    message = assistant_message(tool_calls=[tool_call])

    assert message.role == Role.ASSISTANT
    assert message.tool_calls == [tool_call]


def test_tool_message_requires_tool_call_id() -> None:
    result = ToolResult(tool_call_id="call_1", name="read_file", content="ok")
    message = tool_message(result)

    assert message.role == Role.TOOL
    assert message.tool_call_id == "call_1"
    assert message.content == "ok"


def test_invalid_tool_message_without_tool_call_id_fails() -> None:
    with pytest.raises(ValidationError):
        Message(role=Role.TOOL, content="missing id")


def test_only_assistant_can_include_tool_calls() -> None:
    with pytest.raises(ValidationError):
        Message(
            role=Role.USER,
            content="bad",
            tool_calls=[ToolCall(id="call_1", name="read_file")],
        )


def test_assistant_requires_content_or_tool_calls() -> None:
    with pytest.raises(ValidationError):
        Message(role=Role.ASSISTANT)

