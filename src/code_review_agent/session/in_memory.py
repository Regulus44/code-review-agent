"""In-memory session implementation."""

from __future__ import annotations

from code_review_agent.messages import Message

from .base import Session


class InMemorySession(Session):
    """Simple in-memory message session."""

    def __init__(self) -> None:
        self._messages: list[Message] = []

    def append(self, message: Message | list[Message]) -> None:
        """Append one or more copied messages."""
        if isinstance(message, Message):
            messages = [message]
        else:
            messages = message

        self._messages.extend(msg.model_copy(deep=True) for msg in messages)

    def get_messages(self) -> list[Message]:
        """Return a deep copy of session messages."""
        return [message.model_copy(deep=True) for message in self._messages]

    def clear(self) -> None:
        """Clear all stored messages."""
        self._messages.clear()

