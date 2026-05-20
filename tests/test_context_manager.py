"""Tests for context budgeting."""

from code_review_agent.context import (
    ContextBudget,
    ContextManager,
    estimate_string_chars,
    estimate_tokens_from_chars,
)
from code_review_agent.messages import Message, Role, ToolCall, assistant_message, system_message, user_message


def _tool_exchange(index: int, content: str) -> list[Message]:
    call_id = f"call_{index}"
    return [
        assistant_message(
            tool_calls=[
                ToolCall(id=call_id, name="read_file", arguments={"path": f"file_{index}.py"}),
            ],
        ),
        Message(
            role=Role.TOOL,
            content=content,
            name="read_file",
            tool_call_id=call_id,
        ),
    ]


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


def test_context_manager_estimates_cjk_tokens_with_safety_margin() -> None:
    assert estimate_tokens_from_chars(estimate_string_chars("hello")) == 2
    assert estimate_tokens_from_chars(estimate_string_chars("你好世界")) == 5


def test_context_manager_metadata_contains_estimated_tokens() -> None:
    manager = ContextManager()
    messages = [
        system_message("system"),
        user_message("请审查这个改动"),
        assistant_message("ok"),
    ]

    result = manager.build(messages, ContextBudget(max_prompt_tokens=1_000))
    metadata = result.to_metadata()

    assert result.original_estimated_tokens > 0
    assert result.final_estimated_tokens > 0
    assert metadata["context_original_estimated_tokens"] == result.original_estimated_tokens
    assert metadata["context_final_estimated_tokens"] == result.final_estimated_tokens
    assert metadata["context_max_prompt_tokens"] == 1_000
    assert isinstance(metadata["context_token_budget_utilization"], float)


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


def test_context_manager_does_not_split_tool_exchange_when_trimming() -> None:
    manager = ContextManager()
    messages = [system_message("system"), user_message("first task")]
    for index in range(4):
        messages.append(user_message(f"old question {index} " + ("x" * 300)))
        messages.append(assistant_message(f"old answer {index} " + ("y" * 300)))
    messages.extend(_tool_exchange(99, "current result"))

    result = manager.build(
        messages,
        ContextBudget(max_prompt_chars=180, recent_full_message_count=4),
    )

    assistant_call_ids = {
        tool_call.id
        for message in result.messages
        if message.role == Role.ASSISTANT
        for tool_call in message.tool_calls
    }
    tool_result_ids = {
        message.tool_call_id
        for message in result.messages
        if message.role == Role.TOOL
    }
    assert "call_99" in assistant_call_ids
    assert tool_result_ids == {"call_99"}
    assert tool_result_ids <= assistant_call_ids


def test_context_manager_notes_when_stable_header_exceeds_budget() -> None:
    manager = ContextManager()
    messages = [
        system_message("system"),
        user_message("x" * 1_000),
        user_message("current task"),
    ]

    result = manager.build(messages, ContextBudget(max_prompt_chars=100))

    assert "stable_header_exceeds_prompt_budget" in result.notes
    assert result.messages[0].role == Role.SYSTEM
    assert result.messages[-1].content == "current task"
    assert all(message.content != "x" * 1_000 for message in result.messages)


def test_context_manager_keeps_limited_overflow_preview_after_tool_budget_exhausted() -> None:
    manager = ContextManager()
    messages = [system_message("system"), user_message("task")]
    messages.extend(_tool_exchange(0, "a" * 2_000))
    messages.extend(_tool_exchange(1, "b" * 2_000))

    result = manager.build(
        messages,
        ContextBudget(
            max_prompt_chars=20_000,
            recent_full_message_count=20,
            max_single_tool_message_chars=300,
            max_total_tool_content_chars=250,
            overflow_tool_preview_chars=300,
            max_overflow_tool_preview_chars=700,
        ),
    )

    tool_messages = [message for message in result.messages if message.role == Role.TOOL]
    assert len(tool_messages) == 2
    assert "large_recent_tool_result" in result.notes
    assert "total_tool_history_budget_exceeded" in result.notes
    assert tool_messages[1].content is not None
    assert "reason: total_tool_history_budget_exceeded" in tool_messages[1].content
    assert "preview_chars: 0" not in tool_messages[1].content
    assert "b" * 20 in tool_messages[1].content


def test_context_manager_uses_short_placeholder_after_overflow_budget_exhausted() -> None:
    manager = ContextManager()
    messages = [system_message("system"), user_message("task")]
    for index in range(8):
        messages.extend(_tool_exchange(index, str(index) * 2_000))

    result = manager.build(
        messages,
        ContextBudget(
            max_prompt_chars=50_000,
            recent_full_message_count=40,
            max_single_tool_message_chars=300,
            max_total_tool_content_chars=250,
            overflow_tool_preview_chars=300,
            max_overflow_tool_preview_chars=600,
        ),
    )

    tool_messages = [message for message in result.messages if message.role == Role.TOOL]
    omitted_messages = [
        message
        for message in tool_messages
        if message.content and "reason: overflow_tool_preview_budget_exceeded" in message.content
    ]

    assert "overflow_tool_preview_budget_exceeded" in result.notes
    assert omitted_messages
    assert all("preview_chars:" not in (message.content or "") for message in omitted_messages)
    assert all(len(message.content or "") < 140 for message in omitted_messages)
    assert result.final_tool_content_chars < result.original_tool_content_chars // 2
