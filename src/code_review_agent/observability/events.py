"""Structured observability event helpers."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from code_review_agent.runtime.types import RunEvent


def new_trace_id() -> str:
    """Create a trace id."""
    return uuid4().hex


def new_span_id() -> str:
    """Create a span id."""
    return uuid4().hex[:16]


def make_run_event(
    *,
    index: int,
    legacy_type: str,
    event_type: str,
    timestamp: datetime | None = None,
    payload: dict[str, Any] | None = None,
    trace_id: str | None = None,
    span_id: str | None = None,
    parent_span_id: str | None = None,
    status: str | None = None,
    duration_ms: int | None = None,
    failure_reason: str | None = None,
) -> RunEvent:
    """Create a normalized runtime event from observability fields."""
    body = payload or {}
    return RunEvent(
        index=index,
        type=legacy_type,
        event_type=event_type,
        timestamp=timestamp or datetime.now(timezone.utc),
        data=body,
        payload=body,
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        status=status,
        duration_ms=duration_ms,
        failure_reason=failure_reason,
    )


def log_structured_event(
    logger: logging.Logger,
    *,
    run_id: str,
    event: RunEvent,
) -> None:
    """Write one structured event log line."""
    payload = {
        "run_id": run_id,
        "index": event.index,
        "event_type": event.event_type or event.type,
        "status": event.status,
        "duration_ms": event.duration_ms,
        "failure_reason": event.failure_reason,
        "trace_id": event.trace_id,
        "span_id": event.span_id,
        "parent_span_id": event.parent_span_id,
        "payload": event.payload or event.data,
        "timestamp": event.timestamp.isoformat(),
    }
    logger.info("runtime_observation %s", json.dumps(payload, ensure_ascii=False))
