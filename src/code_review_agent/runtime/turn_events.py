"""Shared turn event utilities — used by both AgentRuntime and SessionService."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from datetime import datetime

from code_review_agent.harness.types import AgentRunResult, AgentStep
from code_review_agent.models import ChatModel, ChatRequest, ChatResponse, ModelUsage
from code_review_agent.observability import make_run_event, new_span_id, new_trace_id
from code_review_agent.runtime.types import (
    RunDiagnostics,
    RunEvent,
    RunStepTiming,
    utc_now,
)

EventEmitter = Callable[..., Awaitable[RunEvent]]


async def aclose_model_if_needed(model: ChatModel) -> None:
    close = getattr(model, "aclose", None)
    if close is not None:
        try:
            await close()
        except Exception:
            pass


def _exception_detail(exc: BaseException) -> str:
    detail = str(exc) or type(exc).__name__
    return detail[:500]


class ObservableChatModel(ChatModel):
    """Emit live model request/response events around a chat model."""

    def __init__(
        self,
        model: ChatModel,
        *,
        emit: EventEmitter,
        root_span_id: str,
    ) -> None:
        self._model = model
        self._emit = emit
        self._root_span_id = root_span_id
        self._request_count = 0
        self.provider = model.provider
        self.model_name = model.model_name

    async def complete(self, request: ChatRequest) -> ChatResponse:
        self._request_count += 1
        request_index = self._request_count
        span_id = new_span_id()
        started_at = utc_now()
        started_perf = time.perf_counter()
        payload = {
            "request_index": request_index,
            "provider": self.provider,
            "model": self.model_name,
            "requested_model": self.model_name,
            "message_count": len(request.messages),
            "tool_count": len(request.tools or []),
            "context": request.metadata or {},
        }
        await self._emit(
            legacy_type="model_request",
            event_type="model.request",
            payload=payload,
            timestamp=started_at,
            status="running",
            span_id=span_id,
            parent_span_id=self._root_span_id,
        )

        try:
            response = await self._model.complete(request)
        except asyncio.CancelledError:
            duration_ms = int((time.perf_counter() - started_perf) * 1000)
            await self._emit(
                legacy_type="model_request",
                event_type="model.cancelled",
                payload={**payload, "failure_reason": "model_request_cancelled"},
                timestamp=utc_now(),
                status="cancelled",
                duration_ms=duration_ms,
                failure_reason="model_request_cancelled",
                parent_span_id=span_id,
            )
            raise
        except Exception as exc:
            duration_ms = int((time.perf_counter() - started_perf) * 1000)
            detail = _exception_detail(exc)
            await self._emit(
                legacy_type="model_response",
                event_type="model.error",
                payload={**payload, "failure_reason": detail},
                timestamp=utc_now(),
                status="error",
                duration_ms=duration_ms,
                failure_reason=detail,
                parent_span_id=span_id,
            )
            raise

        duration_ms = int((time.perf_counter() - started_perf) * 1000)
        await self._emit(
            legacy_type="model_response",
            event_type="model.response",
            payload={
                **payload,
                "provider": response.provider,
                "model": response.model,
                "returned_model": response.model,
                "finish_reason": response.finish_reason,
                "usage": response.usage.model_dump() if response.usage else None,
                "message": response.message.model_dump(),
            },
            timestamp=utc_now(),
            status="success",
            duration_ms=duration_ms,
            parent_span_id=span_id,
        )
        return response

    async def aclose(self) -> None:
        await aclose_model_if_needed(self._model)


class TurnEventEmitter:
    """Emit structured events into a turn's event log.

    Stores events via ``store.append_turn_event(turn_id, event)``.
    """

    def __init__(self, store, turn_id: str) -> None:
        self._store = store
        self._turn_id = turn_id
        self._trace_id = new_trace_id()
        self._root_span_id = new_span_id()
        self._next_index = 0

    @property
    def trace_id(self) -> str:
        return self._trace_id

    @property
    def root_span_id(self) -> str:
        return self._root_span_id

    async def emit(
        self,
        *,
        legacy_type: str,
        event_type: str,
        payload: dict | None = None,
        timestamp: datetime | None = None,
        status: str | None = None,
        duration_ms: int | None = None,
        failure_reason: str | None = None,
        span_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> RunEvent:
        self._next_index += 1
        event = make_run_event(
            index=self._next_index,
            legacy_type=legacy_type,
            event_type=event_type,
            payload=payload,
            timestamp=timestamp,
            status=status,
            duration_ms=duration_ms,
            failure_reason=failure_reason,
            trace_id=self._trace_id,
            span_id=span_id or new_span_id(),
            parent_span_id=parent_span_id,
        )
        await self._store.append_turn_event(self._turn_id, event)
        return event

    def wrap_model(self, model: ChatModel) -> ObservableChatModel:
        return ObservableChatModel(model, emit=self.emit, root_span_id=self._root_span_id)


async def convert_agent_steps_to_events(
    steps: list[AgentStep],
    *,
    emit: EventEmitter,
    root_span_id: str,
    include_model_events: bool = True,
) -> None:
    """Convert agent steps into tool.started/finished/error events.

    Model events are optionally emitted for replay/conversion of stored AgentRunResult.steps.
    Session turn logging should pass ``include_model_events=False``
    since the live ObservableChatModel already emits model events.
    """
    if not steps:
        return

    iteration_span_ids: dict[int, str] = {}
    iteration_last_timestamp: dict[int, datetime | None] = {}
    current_iteration: int | None = None

    for step in steps:
        iteration = step.iteration or 0
        if current_iteration != iteration:
            if current_iteration is not None:
                previous_span_id = iteration_span_ids[current_iteration]
                await emit(
                    legacy_type="agent_iteration",
                    event_type="agent.iteration.finished",
                    payload={"iteration": current_iteration},
                    timestamp=iteration_last_timestamp.get(current_iteration),
                    status="completed",
                    span_id=previous_span_id,
                    parent_span_id=root_span_id,
                )

            current_iteration = iteration
            current_span_id = iteration_span_ids.setdefault(iteration, new_span_id())
            await emit(
                legacy_type="agent_iteration",
                event_type="agent.iteration.started",
                payload={"iteration": iteration},
                timestamp=step.started_at,
                status="running",
                span_id=current_span_id,
                parent_span_id=root_span_id,
            )

        iteration_span_id = iteration_span_ids.setdefault(iteration, new_span_id())
        step_payload = {"step_index": step.index, "iteration": iteration}

        if step.type == "model_response":
            step_payload.update(step.metadata or {})
            if include_model_events:
                if step.started_at is not None:
                    await emit(
                        legacy_type="model_request",
                        event_type="model.request",
                        payload=step_payload,
                        timestamp=step.started_at,
                        status="running",
                        parent_span_id=iteration_span_id,
                    )
                await emit(
                    legacy_type="model_response",
                    event_type="model.response",
                    payload={
                        **step_payload,
                        "finish_reason": step.finish_reason,
                        "usage": step.usage.model_dump() if step.usage else None,
                        "message": step.message.model_dump() if step.message else None,
                    },
                    timestamp=step.finished_at,
                    status="success",
                    duration_ms=step.duration_ms,
                    span_id=new_span_id(),
                    parent_span_id=iteration_span_id,
                )
            iteration_last_timestamp[iteration] = step.finished_at
            continue

        if step.type == "tool_call" and step.tool_call is not None:
            step_payload["tool_name"] = step.tool_call.name
            step_payload["tool_call_id"] = step.tool_call.id
            step_payload["arguments"] = step.tool_call.arguments

            if step.started_at is not None:
                await emit(
                    legacy_type="tool_call",
                    event_type="tool.started",
                    payload=step_payload,
                    timestamp=step.started_at,
                    status="running",
                    parent_span_id=iteration_span_id,
                )

            tool_status = step.tool_result_status or "error"
            if tool_status == "success":
                tool_status = "success"

            await emit(
                legacy_type="tool_result",
                event_type="tool.finished",
                payload={
                    **step_payload,
                    "tool_result_status": tool_status,
                    "tool_result": step.tool_result_content,
                },
                timestamp=step.finished_at,
                status=tool_status,
                duration_ms=step.duration_ms,
                failure_reason=step.tool_result_content if tool_status != "success" else None,
                parent_span_id=iteration_span_id,
            )
            iteration_last_timestamp[iteration] = step.finished_at

    if current_iteration is not None:
        await emit(
            legacy_type="agent_iteration",
            event_type="agent.iteration.finished",
            payload={"iteration": current_iteration},
            timestamp=iteration_last_timestamp.get(current_iteration),
            status="completed",
            span_id=iteration_span_ids[current_iteration],
            parent_span_id=root_span_id,
        )


def build_diagnostics(
    result: AgentRunResult | None,
    events: list[RunEvent],
    started_at: datetime | None = None,
    finished_at: datetime | None = None,
    failure_reason: str | None = None,
    iterations: int | None = None,
    usage: ModelUsage | dict | None = None,
) -> RunDiagnostics:
    """Build RunDiagnostics from events and optional run/turn summary data."""
    total_duration_ms: int | None = None
    if started_at and finished_at:
        total_duration_ms = int((finished_at - started_at).total_seconds() * 1000)

    model_events = [e for e in events if (e.event_type or e.type) == "model.response"]
    tool_events = [e for e in events if (e.event_type or e.type) == "tool.finished"]
    timed_events = [
        e
        for e in events
        if e.duration_ms is not None
        and (e.event_type or e.type) in {"model.response", "tool.finished"}
    ]
    timed_events.sort(key=lambda e: e.duration_ms or 0, reverse=True)

    slowest_steps = [
        RunStepTiming(
            event_type=e.event_type or e.type,
            label=_step_label(e),
            iteration=(e.payload or e.data).get("iteration"),
            duration_ms=e.duration_ms or 0,
        )
        for e in timed_events[:3]
    ]

    if iterations is None:
        iterations = result.iterations if result is not None else len(model_events)

    usage_value = usage
    if usage_value is None and result is not None:
        usage_value = result.usage
    if isinstance(usage_value, dict):
        usage_value = ModelUsage.model_validate(usage_value)

    return RunDiagnostics(
        total_duration_ms=total_duration_ms,
        iterations=iterations,
        model_call_count=len(model_events),
        tool_call_count=len(tool_events),
        event_count=len(events),
        token_usage=usage_value.model_copy(deep=True) if usage_value else None,
        failure_reason=failure_reason,
        slowest_steps=slowest_steps,
    )


def _step_label(event: RunEvent) -> str:
    payload = event.payload or event.data
    event_type = event.event_type or event.type
    if event_type == "tool.finished":
        return str(payload.get("tool_name") or "tool")
    if event_type == "model.response":
        provider = payload.get("provider")
        model = payload.get("returned_model") or payload.get("model") or payload.get("requested_model")
        if provider and model:
            return f"{provider}/{model}"
        if model:
            return str(model)
        return "model"
    return event_type
