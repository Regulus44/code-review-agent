"""Session abstractions for agent conversations."""

from __future__ import annotations

from abc import ABC, abstractmethod

from code_review_agent.messages import Message


class Session(ABC):
    """Abstract conversation session."""

    @abstractmethod
    def append(self, message: Message | list[Message]) -> None:
        """Append one or more messages to the session."""

    @abstractmethod
    def get_messages(self) -> list[Message]:
        """Return a copy of session messages."""

    @abstractmethod
    def clear(self) -> None:
        """Clear the session."""

