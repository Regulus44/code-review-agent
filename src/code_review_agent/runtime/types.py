"""Runtime types for agent runs and events."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from code_review_agent.harness import AgentRunResult
from code_review_agent.models import ModelUsage

RunStatus = Literal[
    "queued",
    "running",
    "completed",
    "failed",
    "max_iterations",
    "cancelled",
    "model_output_truncated",
]


def utc_now() -> datetime:
    """Return the current UTC time."""
    return datetime.now(timezone.utc)


class RunEvent(BaseModel):
    """A minimal runtime event."""

    model_config = ConfigDict(extra="forbid")

    index: int
    type: str
    event_type: str | None = None
    timestamp: datetime = Field(default_factory=utc_now)
    data: dict[str, Any] = Field(default_factory=dict)
    payload: dict[str, Any] = Field(default_factory=dict)
    trace_id: str | None = None
    span_id: str | None = None
    parent_span_id: str | None = None
    status: str | None = None
    duration_ms: int | None = None
    failure_reason: str | None = None

    @model_validator(mode="after")
    def _normalize_payload_and_event_type(self) -> "RunEvent":
        if not self.event_type:
            self.event_type = self.type
        if not self.payload and self.data:
            self.payload = dict(self.data)
        if not self.data and self.payload:
            self.data = dict(self.payload)
        return self


class RunStepTiming(BaseModel):
    """Timing details for one model/tool step."""

    model_config = ConfigDict(extra="forbid")

    event_type: str
    label: str
    iteration: int | None = None
    duration_ms: int


class RunDiagnostics(BaseModel):
    """Execution summary for one run."""

    model_config = ConfigDict(extra="forbid")

    total_duration_ms: int | None = None
    iterations: int | None = None
    model_call_count: int = 0
    tool_call_count: int = 0
    event_count: int = 0
    token_usage: ModelUsage | None = None
    failure_reason: str | None = None
    slowest_steps: list[RunStepTiming] = Field(default_factory=list)


class RunRecord(BaseModel):
    """Stored state for one runtime run."""

    model_config = ConfigDict(extra="forbid")

    id: str
    status: RunStatus
    app_name: str | None = None
    user_input: str
    workspace_root: str
    created_at: datetime = Field(default_factory=utc_now)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    system_prompt: str | None = None
    max_iterations: int
    temperature: float | None = None
    max_tokens: int | None = None
    provider: str | None = None
    model: str | None = None
    tool_names: list[str] | None = None
    failure_reason: str | None = None
    result: AgentRunResult | None = None
    diagnostics: RunDiagnostics | None = None


class CreateRunRequest(BaseModel):
    """API request for creating a run."""

    model_config = ConfigDict(extra="forbid")

    user_input: str
    workspace_root: str
    app_name: str | None = None
    system_prompt: str | None = None
    max_iterations: int | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    provider: str | None = None
    model: str | None = None
    tool_names: list[str] | None = None
