"""Tests for context budgeting."""

from code_review_agent.context import ContextBudget, ContextManager
from code_review_agent.messages import Message, Role, ToolCall, assistant_message, system_message, user_message


def test_context_manager_keeps_small_context_unchanged() -> None:
    manager = ContextManager()
    messages = [
        system_message("system"),
        user_message("task"),
        assistant_message("answer"),
    ]

    result = manager.build(messages, ContextBudget(max_prompt_chars=10_000))

    assert [message.content for message in result.messages] == ["system", "task", "answer"]
    assert result.summarized_tool_messages == 0
    assert result.dropped_messages == 0


def test_context_manager_summarizes_historical_large_tool_message() -> None:
    manager = ContextManager()
    messages = [
        system_message("system"),
        user_message("task"),
        assistant_message(
            tool_calls=[ToolCall(id="call_old", name="read_file", arguments={})],
        ),
        Message(
            role=Role.TOOL,
            content="x" * 5_000,
            name="read_file",
            tool_call_id="call_old",
        ),
        user_message("follow-up"),
        assistant_message("answer"),
    ]

    result = manager.build(
        messages,
        ContextBudget(
            max_prompt_chars=20_000,
            recent_full_message_count=2,
            historical_tool_preview_chars=200,
        ),
    )

    tool_message = next(message for message in result.messages if message.role == Role.TOOL)
    assert tool_message.content is not None
    assert tool_message.content.startswith("Tool result summarized for model context budget.")
    assert "original_chars: 5000" in tool_message.content
    assert result.summarized_tool_messages == 1
    assert messages[3].content == "x" * 5_000


def test_context_manager_preserves_reasoning_content_when_trimming() -> None:
    manager = ContextManager()
    reasoning = "reasoning " * 100
    messages = [
        system_message("system"),
        user_message("task"),
        assistant_message(
            reasoning_content=reasoning,
            tool_calls=[ToolCall(id="call_1", name="search_text", arguments={})],
        ),
        Message(
            role=Role.TOOL,
            content="search result",
            name="search_text",
            tool_call_id="call_1",
        ),
        assistant_message("answer"),
    ]

    result = manager.build(messages, ContextBudget(max_prompt_chars=100_000))

    assistant = next(
        message for message in result.messages if message.role == Role.ASSISTANT and message.reasoning_content
    )
    assert assistant.reasoning_content == reasoning


def test_context_manager_drops_old_messages_but_keeps_header_and_recent_suffix() -> None:
    manager = ContextManager()
    messages = [system_message("system"), user_message("first task")]
    for index in range(10):
        messages.append(user_message(f"old question {index} " + ("x" * 500)))
        messages.append(assistant_message(f"old answer {index} " + ("y" * 500)))
    messages.append(user_message("current question"))
    messages.append(assistant_message("current answer"))

    result = manager.build(
        messages,
        ContextBudget(max_prompt_chars=2_000, recent_full_message_count=4),
    )

    assert result.messages[0].role == Role.SYSTEM
    assert result.messages[1].role == Role.USER
    assert result.messages[1].content == "first task"
    assert result.messages[-2].content == "current question"
    assert result.messages[-1].content == "current answer"
    assert result.dropped_messages > 0
