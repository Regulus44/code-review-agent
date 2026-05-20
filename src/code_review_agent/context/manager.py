"""Context manager for bounded model request windows."""

from __future__ import annotations

from dataclasses import dataclass

from code_review_agent.messages import Message, Role

from .token_estimator import estimate_messages_tokens
from .types import ContextBudget, ContextBuildResult


@dataclass(frozen=True)
class _MessageGroup:
    """A trimming unit that should not be split across context compaction."""

    indices: tuple[int, ...]


class ContextManager:
    """Build model request messages without mutating the stored session."""

    def build(
        self,
        messages: list[Message],
        budget: ContextBudget | None = None,
    ) -> ContextBuildResult:
        """Return a bounded request context and metrics."""
        budget = budget or ContextBudget()
        original_messages = [message.model_copy(deep=True) for message in messages]
        original_chars = self.messages_context_chars(original_messages)
        original_tokens = estimate_messages_tokens(original_messages)
        original_tool_chars = self.tool_content_chars(original_messages)

        compacted, summarized_count, notes = self._compact_tool_messages(
            original_messages,
            budget,
        )
        if self._exceeds_budget(compacted, budget):
            compacted, dropped_count, trim_notes = self._trim_to_context_window(
                compacted,
                budget,
            )
            notes.extend(note for note in trim_notes if note not in notes)
            if dropped_count:
                notes.append("old_messages_dropped_to_fit_prompt_budget")
        else:
            dropped_count = 0

        final_chars = self.messages_context_chars(compacted)
        final_tokens = estimate_messages_tokens(compacted)
        return ContextBuildResult(
            messages=compacted,
            original_message_count=len(messages),
            final_message_count=len(compacted),
            original_chars=original_chars,
            final_chars=final_chars,
            original_estimated_tokens=original_tokens,
            final_estimated_tokens=final_tokens,
            max_prompt_tokens=budget.max_prompt_tokens,
            summarized_tool_messages=summarized_count,
            dropped_messages=dropped_count,
            original_tool_content_chars=original_tool_chars,
            final_tool_content_chars=self.tool_content_chars(compacted),
            notes=notes,
        )

    def _compact_tool_messages(
        self,
        messages: list[Message],
        budget: ContextBudget,
    ) -> tuple[list[Message], int, list[str]]:
        """Summarize large tool results while preserving non-tool messages."""
        recent_start = max(0, len(messages) - budget.recent_full_message_count)
        compacted: list[Message] = []
        summarized_count = 0
        notes: list[str] = []
        total_tool_chars = 0
        overflow_tool_preview_used = 0

        for index, message in enumerate(messages):
            if message.role != Role.TOOL or message.content is None:
                compacted.append(message)
                continue

            is_historical = index < recent_start
            limit = (
                budget.historical_tool_preview_chars
                if is_historical
                else budget.max_single_tool_message_chars
            )
            remaining_total_budget = max(
                0,
                budget.max_total_tool_content_chars - total_tool_chars,
            )
            if remaining_total_budget > 0:
                effective_limit = min(limit, remaining_total_budget)
                overflow_mode = False
            else:
                remaining_overflow = max(
                    0,
                    budget.max_overflow_tool_preview_chars - overflow_tool_preview_used,
                )
                effective_limit = min(budget.overflow_tool_preview_chars, remaining_overflow)
                overflow_mode = True

            if len(message.content) > effective_limit:
                summarized_count += 1
                reason = (
                    "historical_tool_result"
                    if is_historical
                    else "large_recent_tool_result"
                )
                if remaining_total_budget == 0 and effective_limit == 0:
                    reason = "overflow_tool_preview_budget_exceeded"
                elif remaining_total_budget == 0:
                    reason = "total_tool_history_budget_exceeded"
                if overflow_mode:
                    remaining_overflow = max(
                        0,
                        budget.max_overflow_tool_preview_chars
                        - overflow_tool_preview_used,
                    )
                    message, reason, used = self._summarize_overflow_tool_message(
                        message,
                        preview_chars=effective_limit,
                        reason=reason,
                        remaining_overflow_chars=remaining_overflow,
                    )
                    overflow_tool_preview_used += used
                else:
                    message = self._summarize_tool_message(
                        message,
                        preview_chars=effective_limit,
                        reason=reason,
                    )
                if reason not in notes:
                    notes.append(reason)

            total_tool_chars += len(message.content or "")
            compacted.append(message)

        return compacted, summarized_count, notes

    def _summarize_overflow_tool_message(
        self,
        message: Message,
        *,
        preview_chars: int,
        reason: str,
        remaining_overflow_chars: int,
    ) -> tuple[Message, str, int]:
        """Summarize a tool result while counting wrapper text against overflow."""
        if remaining_overflow_chars <= 0:
            return (
                self._omit_tool_message(
                    message,
                    reason="overflow_tool_preview_budget_exceeded",
                ),
                "overflow_tool_preview_budget_exceeded",
                0,
            )

        low = 0
        high = preview_chars
        best: Message | None = None
        best_len = 0
        while low <= high:
            mid = (low + high) // 2
            candidate = self._summarize_tool_message(
                message,
                preview_chars=mid,
                reason=reason,
            )
            candidate_len = len(candidate.content or "")
            if candidate_len <= remaining_overflow_chars:
                best = candidate
                best_len = candidate_len
                low = mid + 1
            else:
                high = mid - 1

        if best is not None:
            return best, reason, best_len

        return (
            self._omit_tool_message(
                message,
                reason="overflow_tool_preview_budget_exceeded",
            ),
            "overflow_tool_preview_budget_exceeded",
            0,
        )

    def _summarize_tool_message(
        self,
        message: Message,
        *,
        preview_chars: int,
        reason: str,
    ) -> Message:
        """Create a compact tool message that remains useful to the model."""
        original = message.content or ""
        preview = original[:preview_chars].rstrip() if preview_chars > 0 else ""
        content = (
            "Tool result summarized for model context budget.\n"
            f"reason: {reason}\n"
            f"tool_name: {message.name or ''}\n"
            f"tool_call_id: {message.tool_call_id}\n"
            f"original_chars: {len(original)}\n"
            f"preview_chars: {len(preview)}\n"
        )
        if preview:
            content += (
                "\n"
                f"{preview}\n\n"
                "...[tool result truncated; rerun the tool with a narrower "
                "query/path if exact output is needed]"
            )
        else:
            content += "\n...[tool result omitted because tool history budget was exhausted]"
        return message.model_copy(update={"content": content})

    def _omit_tool_message(self, message: Message, *, reason: str) -> Message:
        """Create the shortest useful placeholder once overflow budget is gone."""
        original = message.content or ""
        content = (
            f"Tool result omitted. reason: {reason}; "
            f"tool_name: {message.name or ''}; original_chars: {len(original)}"
        )
        return message.model_copy(update={"content": content})

    def _trim_to_context_window(
        self,
        messages: list[Message],
        budget: ContextBudget,
    ) -> tuple[list[Message], int, list[str]]:
        """Keep stable task header plus the latest contiguous suffix by groups."""
        if not messages:
            return [], 0, []

        notes: list[str] = []
        groups = self._message_groups(messages)
        header_group_positions = self._header_group_positions(messages, groups)
        selected_group_positions = set(header_group_positions)

        selected = self._messages_for_group_positions(
            messages,
            groups,
            selected_group_positions,
        )
        if self._exceeds_budget(selected, budget):
            notes.append("stable_header_exceeds_prompt_budget")
            selected_group_positions = {
                position
                for position in header_group_positions
                if self._group_has_role(messages, groups[position], Role.SYSTEM)
            }
            selected = self._messages_for_group_positions(
                messages,
                groups,
                selected_group_positions,
            )
            if self._exceeds_budget(selected, budget):
                notes.append("stable_system_exceeds_prompt_budget")

        for group_position in range(len(groups) - 1, -1, -1):
            if group_position in selected_group_positions:
                continue

            candidate_positions = selected_group_positions | {group_position}
            candidate = self._messages_for_group_positions(
                messages,
                groups,
                candidate_positions,
            )
            if not self._exceeds_budget(candidate, budget):
                selected_group_positions.add(group_position)
                continue

            if not selected_group_positions:
                selected_group_positions.add(group_position)
                continue

            break

        selected = self._messages_for_group_positions(
            messages,
            groups,
            selected_group_positions,
        )
        return selected, len(messages) - len(selected), notes

    def _message_groups(self, messages: list[Message]) -> list[_MessageGroup]:
        """Group assistant tool calls with their consecutive tool results."""
        groups: list[_MessageGroup] = []
        index = 0
        while index < len(messages):
            message = messages[index]
            if message.role == Role.ASSISTANT and message.tool_calls:
                tool_call_ids = {tool_call.id for tool_call in message.tool_calls}
                group_indices = [index]
                index += 1
                while (
                    index < len(messages)
                    and messages[index].role == Role.TOOL
                    and messages[index].tool_call_id in tool_call_ids
                ):
                    group_indices.append(index)
                    index += 1
                groups.append(_MessageGroup(tuple(group_indices)))
                continue

            groups.append(_MessageGroup((index,)))
            index += 1

        return groups

    def _header_group_positions(
        self,
        messages: list[Message],
        groups: list[_MessageGroup],
    ) -> list[int]:
        """Return stable header group positions useful for cache reuse."""
        header_group_positions: list[int] = []
        first_user_seen = False
        for position, group in enumerate(groups):
            group_messages = [messages[index] for index in group.indices]
            if any(message.role == Role.SYSTEM for message in group_messages):
                header_group_positions.append(position)
            elif (
                not first_user_seen
                and len(group_messages) == 1
                and group_messages[0].role == Role.USER
            ):
                header_group_positions.append(position)
                first_user_seen = True
        return header_group_positions

    def _messages_for_group_positions(
        self,
        messages: list[Message],
        groups: list[_MessageGroup],
        group_positions: set[int],
    ) -> list[Message]:
        """Flatten selected groups in original order."""
        selected_indices: set[int] = set()
        for position in sorted(group_positions):
            selected_indices.update(groups[position].indices)
        return [
            message
            for index, message in enumerate(messages)
            if index in selected_indices
        ]

    def _group_has_role(
        self,
        messages: list[Message],
        group: _MessageGroup,
        role: Role,
    ) -> bool:
        """Return whether a group contains a message role."""
        return any(messages[index].role == role for index in group.indices)

    def messages_context_chars(self, messages: list[Message]) -> int:
        """Approximate the formatted request context size in characters."""
        return sum(self.message_context_chars(message) for message in messages)

    def _exceeds_budget(self, messages: list[Message], budget: ContextBudget) -> bool:
        """Return whether messages exceed either configured prompt budget."""
        if self.messages_context_chars(messages) > budget.max_prompt_chars:
            return True
        return (
            budget.max_prompt_tokens is not None
            and estimate_messages_tokens(messages) > budget.max_prompt_tokens
        )

    def message_context_chars(self, message: Message) -> int:
        """Approximate one message's formatted size."""
        total = len(message.role.value)
        total += len(message.content or "")
        total += len(message.reasoning_content or "")
        total += len(message.name or "")
        total += len(message.tool_call_id or "")
        for tool_call in message.tool_calls:
            total += len(tool_call.id)
            total += len(tool_call.name)
            total += len(tool_call.raw_arguments or str(tool_call.arguments))
        return total

    def tool_content_chars(self, messages: list[Message]) -> int:
        """Return total tool content size in characters."""
        return sum(
            len(message.content or "")
            for message in messages
            if message.role == Role.TOOL
        )
