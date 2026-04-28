"""Runtime store abstractions and in-memory implementation."""

from __future__ import annotations

from abc import ABC, abstractmethod
from threading import RLock

from .types import RunEvent, RunRecord, RunStatus, utc_now


class RunNotFoundError(KeyError):
    """Raised when a run does not exist in the store."""


class RunStore(ABC):
    """Store interface for run records and runtime events."""

    @abstractmethod
    async def create_run(self, run: RunRecord) -> RunRecord:
        """Create a new run record."""

    @abstractmethod
    async def get_run(self, run_id: str) -> RunRecord:
        """Get one run by id."""

    @abstractmethod
    async def list_runs(self) -> list[RunRecord]:
        """List all runs in reverse creation order."""

    async def get_run_summary(self, run_id: str) -> RunRecord:
        """Get one run without loading heavy raw result data."""
        run = await self.get_run(run_id)
        run.result = None
        return run

    async def list_run_summaries(self) -> list[RunRecord]:
        """List runs without loading heavy raw result data."""
        runs = await self.list_runs()
        for run in runs:
            run.result = None
        return runs

    async def get_result_size(self, run_id: str) -> int | None:
        """Return serialized result size when available."""
        run = await self.get_run(run_id)
        return len(run.result.model_dump_json()) if run.result else None

    @abstractmethod
    async def get_events(self, run_id: str) -> list[RunEvent]:
        """Get all events for one run."""

    async def get_event_summaries(
        self,
        run_id: str,
        *,
        limit: int = 100,
        offset: int = 0,
        include_payload: bool = False,
        max_payload_chars: int = 5000,
    ) -> list[RunEvent]:
        """Get event summaries with optional payload truncation."""
        events = await self.get_events(run_id)
        selected = events[offset : offset + limit]
        if include_payload:
            return [
                _truncate_event_payload(event, max_payload_chars)
                for event in selected
            ]
        return [_strip_event_payload(event) for event in selected]

    @abstractmethod
    async def append_event(self, run_id: str, event: RunEvent) -> RunEvent:
        """Append a runtime event."""

    @abstractmethod
    async def update_status(
        self,
        run_id: str,
        status: RunStatus,
        *,
        failure_reason: str | None = None,
    ) -> RunRecord:
        """Update run status and timestamps."""

    @abstractmethod
    async def attach_result(self, run_id: str, result) -> RunRecord:
        """Attach a final agent result to a run."""

    async def aclose(self) -> None:
        """Close store resources."""
        return


class InMemoryRunStore(RunStore):
    """A small in-memory store for run records and events."""

    def __init__(self) -> None:
        self._runs: dict[str, RunRecord] = {}
        self._events: dict[str, list[RunEvent]] = {}
        self._lock = RLock()

    async def create_run(self, run: RunRecord) -> RunRecord:
        """Create a new run record."""
        with self._lock:
            self._runs[run.id] = run.model_copy(deep=True)
            self._events[run.id] = []
            return self._runs[run.id].model_copy(deep=True)

    async def get_run(self, run_id: str) -> RunRecord:
        """Get one run by id."""
        with self._lock:
            try:
                return self._runs[run_id].model_copy(deep=True)
            except KeyError as exc:
                raise RunNotFoundError(run_id) from exc

    async def list_runs(self) -> list[RunRecord]:
        """List all runs ordered by creation time descending."""
        with self._lock:
            runs = [run.model_copy(deep=True) for run in self._runs.values()]
        runs.reverse()
        return runs

    async def get_events(self, run_id: str) -> list[RunEvent]:
        """Get all runtime events for a run."""
        with self._lock:
            try:
                return [event.model_copy(deep=True) for event in self._events[run_id]]
            except KeyError as exc:
                raise RunNotFoundError(run_id) from exc

    async def append_event(self, run_id: str, event: RunEvent) -> RunEvent:
        """Append a new event to a run."""
        with self._lock:
            if run_id not in self._events:
                raise RunNotFoundError(run_id)
            self._events[run_id].append(event.model_copy(deep=True))
            return self._events[run_id][-1].model_copy(deep=True)

    async def update_status(
        self,
        run_id: str,
        status: RunStatus,
        *,
        failure_reason: str | None = None,
    ) -> RunRecord:
        """Update the status and timestamps of a run."""
        with self._lock:
            if run_id not in self._runs:
                raise RunNotFoundError(run_id)

            run = self._runs[run_id]
            run.status = status
            if status == "running" and run.started_at is None:
                run.started_at = utc_now()
            if status in {
                "completed",
                "failed",
                "max_iterations",
                "cancelled",
                "model_output_truncated",
            }:
                run.finished_at = utc_now()
            if failure_reason is not None:
                run.failure_reason = failure_reason
            return run.model_copy(deep=True)

    async def attach_result(self, run_id: str, result) -> RunRecord:
        """Attach the final agent run result to a run."""
        with self._lock:
            if run_id not in self._runs:
                raise RunNotFoundError(run_id)

            run = self._runs[run_id]
            run.result = result.model_copy(deep=True)
            run.failure_reason = result.failure_reason
            return run.model_copy(deep=True)


def _strip_event_payload(event: RunEvent) -> RunEvent:
    return RunEvent(
        index=event.index,
        type=event.type,
        event_type=event.event_type,
        timestamp=event.timestamp,
        status=event.status,
        duration_ms=event.duration_ms,
        failure_reason=event.failure_reason,
        trace_id=event.trace_id,
        span_id=event.span_id,
        parent_span_id=event.parent_span_id,
    )


def _truncate_event_payload(event: RunEvent, max_payload_chars: int) -> RunEvent:
    copied = event.model_copy(deep=True)
    for field_name in ("payload", "data"):
        value = getattr(copied, field_name)
        text = str(value)
        if len(text) > max_payload_chars:
            setattr(
                copied,
                field_name,
                {
                    "truncated": True,
                    "original_chars": len(text),
                    "preview": text[:max_payload_chars],
                },
            )
    return copied
