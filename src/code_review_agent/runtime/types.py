"""Runtime types for agent runs and events."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from code_review_agent.harness import AgentRunResult

RunStatus = Literal["queued", "running", "completed", "failed", "max_iterations"]


def utc_now() -> datetime:
    """Return the current UTC time."""
    return datetime.now(timezone.utc)


class RunEvent(BaseModel):
    """A minimal runtime event."""

    model_config = ConfigDict(extra="forbid")

    index: int
    type: Literal["status_change", "model_response", "tool_call"]
    timestamp: datetime = Field(default_factory=utc_now)
    data: dict[str, Any] = Field(default_factory=dict)


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
    failure_reason: str | None = None
    result: AgentRunResult | None = None


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
