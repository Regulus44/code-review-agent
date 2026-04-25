"""Parsing helpers for repository analyst reports."""

from __future__ import annotations

import json

from code_review_agent.harness import AgentRunResult

from .types import RepoAnalystReport


class RepoAnalystParseError(ValueError):
    """Raised when the final agent output is not a valid report."""


def parse_repo_analyst_report(result: AgentRunResult) -> RepoAnalystReport:
    """Parse and validate the final assistant output as a structured report."""
    if result.final_message is None or not result.final_message.content:
        raise RepoAnalystParseError("missing final assistant content")

    raw_text = result.final_message.content.strip()
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise RepoAnalystParseError("repo analyst output is not valid JSON") from exc

    try:
        return RepoAnalystReport.model_validate(payload)
    except Exception as exc:
        raise RepoAnalystParseError("repo analyst report schema validation failed") from exc

