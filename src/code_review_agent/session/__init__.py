"""Session abstractions."""

from .base import Session
from .in_memory import InMemorySession

__all__ = [
    "InMemorySession",
    "Session",
    "SessionRecord",
    "SessionStatus",
    "SessionSummary",
    "SessionTurn",
    "TurnStatus",
]


def __getattr__(name: str):
    if name in (
        "SessionRecord",
        "SessionStatus",
        "SessionSummary",
        "SessionTurn",
        "TurnStatus",
    ):
        from . import types as _types

        return getattr(_types, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
