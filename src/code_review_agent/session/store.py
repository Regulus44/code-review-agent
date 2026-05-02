"""Session store abstractions and in-memory implementation."""

from __future__ import annotations

from abc import ABC, abstractmethod
from threading import RLock

from code_review_agent.messages import Message
from code_review_agent.runtime.types import RunEvent
from code_review_agent.session.types import (
    SessionRecord,
    SessionStatus,
    SessionSummary,
    SessionTurn,
    TurnStatus,
    utc_now,
)


class SessionNotFoundError(KeyError):
    """Raised when a session does not exist in the store."""


class TurnNotFoundError(KeyError):
    """Raised when a turn does not exist in the store."""


class SessionStore(ABC):
    """Store interface for session records, turns, and messages."""

    @abstractmethod
    async def create_session(self, record: SessionRecord) -> SessionRecord:
        """Create a new session record."""

    @abstractmethod
    async def get_session(self, session_id: str) -> SessionRecord | None:
        """Get one session by id, or None if not found."""

    @abstractmethod
    async def list_sessions(self) -> list[SessionSummary]:
        """List all sessions as lightweight summaries."""

    @abstractmethod
    async def update_session(self, session_id: str, **fields) -> SessionRecord:
        """Update mutable fields on a session record."""

    @abstractmethod
    async def archive_session(self, session_id: str) -> SessionRecord:
        """Archive a session — sets status to archived and records archived_at."""

    @abstractmethod
    async def create_turn(self, turn: SessionTurn) -> SessionTurn:
        """Create a new turn record."""

    @abstractmethod
    async def get_turn(self, turn_id: str) -> SessionTurn | None:
        """Get one turn by id, or None if not found."""

    @abstractmethod
    async def list_turns(self, session_id: str) -> list[SessionTurn]:
        """List all turns for a session in turn_index order."""

    @abstractmethod
    async def update_turn(self, turn_id: str, **fields) -> SessionTurn:
        """Update mutable fields on a turn record."""

    @abstractmethod
    async def next_turn_index(self, session_id: str) -> int:
        """Return the next turn_index for a session (transaction-safe)."""

    @abstractmethod
    async def append_messages(
        self, session_id: str, messages: list[Message], turn_index: int
    ) -> None:
        """Append messages to a session, assigning sequential sequence numbers."""

    @abstractmethod
    async def get_messages(
        self, session_id: str, *, since_sequence: int = 0
    ) -> list[Message]:
        """Get messages for a session, optionally starting from a sequence number."""

    @abstractmethod
    async def get_messages_with_sequence(
        self, session_id: str, *, since_sequence: int = 0
    ) -> list[dict]:
        """Get messages with sequence numbers for API responses.

        Returns list of dicts with 'sequence', 'turn_index', and message fields.
        """

    @abstractmethod
    async def get_message_count(self, session_id: str) -> int:
        """Return the total number of messages in a session."""

    @abstractmethod
    async def recover_stale_sessions(self) -> int:
        """Mark stale running/queued turns as failed after server restart."""

    @abstractmethod
    async def append_turn_event(self, turn_id: str, event: RunEvent) -> RunEvent:
        """Append a runtime event to a turn's event log.

        Events are stored per-turn, ordered by ``event.index``.
        """

    @abstractmethod
    async def get_turn_events(
        self,
        turn_id: str,
        *,
        after_index: int | None = None,
        limit: int | None = None,
    ) -> list[RunEvent]:
        """Get events for a turn, optionally filtered by index range.

        Parameters:
            after_index: If given, only return events with index > after_index.
            limit: If given, return at most this many events.
        """

    async def aclose(self) -> None:
        """Close store resources."""
        return


class InMemorySessionStore(SessionStore):
    """In-memory session store for testing."""

    def __init__(self) -> None:
        self._sessions: dict[str, SessionRecord] = {}
        self._turns: dict[str, list[SessionTurn]] = {}
        self._messages: dict[str, list[tuple[int, int, Message]]] = {}
        self._events: dict[str, list[RunEvent]] = {}
        self._lock = RLock()

    async def create_session(self, record: SessionRecord) -> SessionRecord:
        with self._lock:
            self._sessions[record.id] = record.model_copy(deep=True)
            self._turns[record.id] = []
            self._messages[record.id] = []
            return record.model_copy(deep=True)

    async def get_session(self, session_id: str) -> SessionRecord | None:
        with self._lock:
            rec = self._sessions.get(session_id)
            return rec.model_copy(deep=True) if rec else None

    async def list_sessions(self) -> list[SessionSummary]:
        with self._lock:
            summaries = []
            for rec in self._sessions.values():
                summaries.append(
                    SessionSummary(
                        id=rec.id,
                        status=rec.status,
                        title=rec.title,
                        mode=rec.mode,
                        last_user_input=rec.last_user_input,
                        workspace_root=rec.workspace_root,
                        message_count=len(self._messages.get(rec.id, [])),
                        turn_count=len(self._turns.get(rec.id, [])),
                        created_at=rec.created_at,
                        updated_at=rec.updated_at,
                    )
                )
        summaries.sort(key=lambda s: s.created_at, reverse=True)
        return summaries

    async def update_session(self, session_id: str, **fields) -> SessionRecord:
        with self._lock:
            rec = self._sessions.get(session_id)
            if rec is None:
                raise SessionNotFoundError(session_id)
            for k, v in fields.items():
                if hasattr(rec, k):
                    setattr(rec, k, v)
            rec.updated_at = utc_now()
            return rec.model_copy(deep=True)

    async def archive_session(self, session_id: str) -> SessionRecord:
        with self._lock:
            rec = self._sessions.get(session_id)
            if rec is None:
                raise SessionNotFoundError(session_id)
            rec.status = "archived"
            rec.archived_at = utc_now()
            rec.updated_at = utc_now()
            return rec.model_copy(deep=True)

    async def create_turn(self, turn: SessionTurn) -> SessionTurn:
        with self._lock:
            if turn.session_id not in self._turns:
                raise SessionNotFoundError(turn.session_id)
            self._turns[turn.session_id].append(turn.model_copy(deep=True))
            return turn.model_copy(deep=True)

    async def get_turn(self, turn_id: str) -> SessionTurn | None:
        with self._lock:
            for turns in self._turns.values():
                for t in turns:
                    if t.id == turn_id:
                        return t.model_copy(deep=True)
            return None

    async def list_turns(self, session_id: str) -> list[SessionTurn]:
        with self._lock:
            turns = self._turns.get(session_id, [])
            return [t.model_copy(deep=True) for t in turns]

    async def update_turn(self, turn_id: str, **fields) -> SessionTurn:
        with self._lock:
            for turns in self._turns.values():
                for t in turns:
                    if t.id == turn_id:
                        for k, v in fields.items():
                            if hasattr(t, k):
                                setattr(t, k, v)
                        return t.model_copy(deep=True)
            raise TurnNotFoundError(turn_id)

    async def next_turn_index(self, session_id: str) -> int:
        with self._lock:
            turns = self._turns.get(session_id, [])
            if not turns:
                return 0
            return max(t.turn_index for t in turns) + 1

    async def append_messages(
        self, session_id: str, messages: list[Message], turn_index: int
    ) -> None:
        with self._lock:
            if session_id not in self._messages:
                raise SessionNotFoundError(session_id)
            existing = self._messages[session_id]
            next_seq = max((seq for seq, _, _ in existing), default=0) + 1
            for msg in messages:
                existing.append((next_seq, turn_index, msg.model_copy(deep=True)))
                next_seq += 1

    async def get_messages(
        self, session_id: str, *, since_sequence: int = 0
    ) -> list[Message]:
        with self._lock:
            entries = self._messages.get(session_id, [])
            return [
                msg.model_copy(deep=True)
                for seq, _, msg in entries
                if seq >= since_sequence
            ]

    async def get_messages_with_sequence(
        self, session_id: str, *, since_sequence: int = 0
    ) -> list[dict]:
        with self._lock:
            entries = self._messages.get(session_id, [])
            results = []
            for seq, ti, msg in entries:
                if seq < since_sequence:
                    continue
                d = msg.model_dump()
                d["sequence"] = seq
                d["turn_index"] = ti
                results.append(d)
            return results

    async def get_message_count(self, session_id: str) -> int:
        with self._lock:
            return len(self._messages.get(session_id, []))

    async def append_turn_event(self, turn_id: str, event: RunEvent) -> RunEvent:
        with self._lock:
            self._events.setdefault(turn_id, []).append(event.model_copy(deep=True))
            return event

    async def get_turn_events(
        self,
        turn_id: str,
        *,
        after_index: int | None = None,
        limit: int | None = None,
    ) -> list[RunEvent]:
        with self._lock:
            events = self._events.get(turn_id, [])
            if after_index is not None:
                events = [e for e in events if e.index > after_index]
            if limit is not None:
                events = events[:limit]
            return [e.model_copy(deep=True) for e in events]

    async def recover_stale_sessions(self) -> int:
        with self._lock:
            affected = 0
            now = utc_now()
            for turns in self._turns.values():
                for t in turns:
                    if t.status in ("running", "queued"):
                        t.status = "failed"
                        t.failure_reason = "server_restarted_during_turn"
                        t.finished_at = now
                        affected += 1
            for rec in self._sessions.values():
                if rec.status == "running":
                    rec.status = "idle"
                    rec.updated_at = now
            return affected
