"""Session-level data models for persistent agent sessions."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from code_review_agent.runtime.types import utc_now

RepoAnalystMode = Literal["overview", "review"]

SessionStatus = Literal["idle", "running", "archived"]

TurnStatus = Literal[
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "max_iterations",
    "model_output_truncated",
]


class SessionRecord(BaseModel):
    """Persistent session record."""

    model_config = ConfigDict(extra="forbid")

    id: str
    status: SessionStatus = "idle"
    title: str | None = None
    last_user_input: str | None = None
    workspace_root: str
    mode: RepoAnalystMode = "overview"
    system_prompt: str | None = None
    provider: str | None = None
    model: str | None = None
    tool_names: list[str] | None = None
    max_iterations: int = 8
    max_tokens: int | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    archived_at: datetime | None = None


class SessionTurn(BaseModel):
    """One turn within a session — maps to a single user input and agent execution."""

    model_config = ConfigDict(extra="forbid")

    id: str
    session_id: str
    run_id: str | None = None
    turn_index: int
    user_input: str
    status: TurnStatus = "queued"
    failure_reason: str | None = None
    usage_json: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    started_at: datetime | None = None
    finished_at: datetime | None = None


class SessionSummary(BaseModel):
    """Lightweight session list item — no messages."""

    model_config = ConfigDict(extra="forbid")

    id: str
    status: SessionStatus
    title: str | None = None
    mode: str
    last_user_input: str | None = None
    workspace_root: str
    message_count: int = 0
    turn_count: int = 0
    created_at: datetime
    updated_at: datetime
