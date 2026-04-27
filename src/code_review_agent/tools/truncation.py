"""Shared text truncation utilities for tool output."""


def truncate_text(
    text: str,
    max_chars: int,
    suffix: str = "\n...[truncated]",
) -> tuple[str, bool]:
    """Truncate text to the requested character limit.

    Returns (truncated_text, was_truncated).
    """
    if len(text) <= max_chars:
        return text, False
    return text[:max_chars].rstrip() + suffix, True
