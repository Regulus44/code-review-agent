"""Structured results for agent runs."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from code_review_agent.messages import Message, ToolCall
from code_review_agent.models import ModelUsage

AgentRunStatus = Literal["completed", "failed", "max_iterations", "cancelled", "model_output_truncated"]


class AgentStep(BaseModel):
    """A single structured step in an agent run."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["model_response", "tool_call"]
    index: int
    message: Message | None = None
    tool_call: ToolCall | None = None
    tool_result_status: str | None = None
    tool_result_content: str | None = None
    usage: ModelUsage | None = None
    finish_reason: str | None = None
    iteration: int | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    duration_ms: int | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class AgentRunResult(BaseModel):
    """Final structured result for an agent run."""

    model_config = ConfigDict(extra="forbid")

    status: AgentRunStatus
    final_message: Message | None = None
    messages: list[Message] = Field(default_factory=list)
    steps: list[AgentStep] = Field(default_factory=list)
    iterations: int = 0
    usage: ModelUsage | None = None
    failure_reason: str | None = None
