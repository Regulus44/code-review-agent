"""Types for request context budgeting."""

from __future__ import annotations

from dataclasses import dataclass, field

from code_review_agent.messages import Message


@dataclass(frozen=True)
class ContextBudget:
    """Character and token budgets used before each model request."""

    max_prompt_chars: int = 250_000
    max_prompt_tokens: int | None = None
    recent_full_message_count: int = 12
    max_single_tool_message_chars: int = 20_000
    historical_tool_preview_chars: int = 2_000
    max_total_tool_content_chars: int = 400_000
    overflow_tool_preview_chars: int = 500
    max_overflow_tool_preview_chars: int = 20_000


@dataclass(frozen=True)
class ContextBuildResult:
    """Result of building a bounded model request context."""

    messages: list[Message]
    original_message_count: int
    final_message_count: int
    original_chars: int
    final_chars: int
    original_estimated_tokens: int
    final_estimated_tokens: int
    max_prompt_tokens: int | None = None
    summarized_tool_messages: int = 0
    dropped_messages: int = 0
    original_tool_content_chars: int = 0
    final_tool_content_chars: int = 0
    notes: list[str] = field(default_factory=list)

    def to_metadata(self) -> dict[str, float | int | list[str] | None]:
        """Return a compact metadata payload for observability events."""
        token_budget_utilization = (
            self.final_estimated_tokens / self.max_prompt_tokens
            if self.max_prompt_tokens
            else None
        )
        return {
            "context_original_message_count": self.original_message_count,
            "context_final_message_count": self.final_message_count,
            "context_original_chars": self.original_chars,
            "context_final_chars": self.final_chars,
            "context_original_estimated_tokens": self.original_estimated_tokens,
            "context_final_estimated_tokens": self.final_estimated_tokens,
            "context_max_prompt_tokens": self.max_prompt_tokens,
            "context_token_budget_utilization": token_budget_utilization,
            "context_summarized_tool_messages": self.summarized_tool_messages,
            "context_dropped_messages": self.dropped_messages,
            "context_original_tool_content_chars": self.original_tool_content_chars,
            "context_final_tool_content_chars": self.final_tool_content_chars,
            "context_notes": self.notes,
        }
