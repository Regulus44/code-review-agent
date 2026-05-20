"""Heuristic token estimation for request context budgeting."""

from __future__ import annotations

import json
import math
import re
from typing import Any

from code_review_agent.messages import Message

CHARS_PER_TOKEN_ESTIMATE = 4
TOKEN_ESTIMATE_SAFETY_MARGIN = 1.2
NON_LATIN_RE = re.compile(
    "["
    "\u2E80-\u9FFF"
    "\uA000-\uA4FF"
    "\uAC00-\uD7AF"
    "\uF900-\uFAFF"
    "\U00020000-\U0002FA1F"
    "]"
)


def estimate_string_chars(text: str) -> int:
    """Return equivalent character count with CJK characters weighted as tokens."""
    non_latin_count = len(NON_LATIN_RE.findall(text))
    return len(text) + non_latin_count * (CHARS_PER_TOKEN_ESTIMATE - 1)


def estimate_tokens_from_chars(
    chars: int,
    *,
    safety_margin: float = TOKEN_ESTIMATE_SAFETY_MARGIN,
) -> int:
    """Estimate tokens from equivalent characters."""
    return math.ceil(max(0, chars) / CHARS_PER_TOKEN_ESTIMATE * safety_margin)


def estimate_message_chars(message: Message) -> int:
    """Estimate one message's provider-formatted size in equivalent characters."""
    total = estimate_string_chars(message.role.value)
    total += estimate_string_chars(message.content or "")
    total += estimate_string_chars(message.reasoning_content or "")
    total += estimate_string_chars(message.name or "")
    total += estimate_string_chars(message.tool_call_id or "")
    for tool_call in message.tool_calls:
        total += estimate_string_chars(tool_call.id)
        total += estimate_string_chars(tool_call.name)
        total += estimate_string_chars(
            tool_call.raw_arguments
            if tool_call.raw_arguments is not None
            else _stable_serialize(tool_call.arguments),
        )
    return total


def estimate_messages_chars(messages: list[Message]) -> int:
    """Estimate provider-formatted context size in equivalent characters."""
    return sum(estimate_message_chars(message) for message in messages)


def estimate_messages_tokens(messages: list[Message]) -> int:
    """Estimate prompt tokens for a list of messages."""
    return estimate_tokens_from_chars(estimate_messages_chars(messages))


def _stable_serialize(value: Any) -> str:
    """Serialize structured tool arguments for repeatable estimation."""
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except TypeError:
        return str(value)
