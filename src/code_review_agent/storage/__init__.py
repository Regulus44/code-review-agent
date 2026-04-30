"""Storage backends for runs and events."""

from .sqlite_store import SqliteRunStore

__all__ = ["SqliteRunStore", "SqliteSessionStore"]


def __getattr__(name: str):
    if name == "SqliteSessionStore":
        from .session_store import SqliteSessionStore

        return SqliteSessionStore
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
