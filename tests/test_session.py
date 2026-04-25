"""Tests for session implementations."""

from code_review_agent.messages import system_message, user_message
from code_review_agent.session import InMemorySession


def test_in_memory_session_appends_and_returns_copies() -> None:
    session = InMemorySession()
    first = system_message("rules")
    second = user_message("hello")

    session.append(first)
    session.append([second])

    messages = session.get_messages()
    assert [message.content for message in messages] == ["rules", "hello"]
    assert messages is not session.get_messages()
    assert messages[0] is not first


def test_in_memory_session_clear() -> None:
    session = InMemorySession()
    session.append(user_message("hello"))

    session.clear()

    assert session.get_messages() == []

