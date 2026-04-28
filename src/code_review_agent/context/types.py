"""Types for request context budgeting."""

from __future__ import annotations

from dataclasses import dataclass, field

from code_review_agent.messages import Message


@dataclass(frozen=True)
class ContextBudget:
    """Character-based budget used before each model request."""

    max_prompt_chars: int = 120_000
    recent_full_message_count: int = 12
    max_single_tool_message_chars: int = 20_000
    historical_tool_preview_chars: int = 2_000
    max_total_tool_content_chars: int = 80_000


@dataclass(frozen=True)
class ContextBuildResult:
    """Result of building a bounded model request context."""

    messages: list[Message]
    original_message_count: int
    final_message_count: int
    original_chars: int
    final_chars: int
    summarized_tool_messages: int = 0
    dropped_messages: int = 0
    original_tool_content_chars: int = 0
    final_tool_content_chars: int = 0
    notes: list[str] = field(default_factory=list)

    def to_metadata(self) -> dict[str, int | list[str]]:
        """Return a compact metadata payload for observability events."""
        return {
            "context_original_message_count": self.original_message_count,
            "context_final_message_count": self.final_message_count,
            "context_original_chars": self.original_chars,
            "context_final_chars": self.final_chars,
            "context_summarized_tool_messages": self.summarized_tool_messages,
            "context_dropped_messages": self.dropped_messages,
            "context_original_tool_content_chars": self.original_tool_content_chars,
            "context_final_tool_content_chars": self.final_tool_content_chars,
            "context_notes": self.notes,
        }
