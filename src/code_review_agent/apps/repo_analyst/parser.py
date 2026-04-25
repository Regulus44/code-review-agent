"""Parsing helpers for repository analyst reports."""

from __future__ import annotations

import json
import re

from code_review_agent.harness import AgentRunResult

from .types import RepoAnalystReport


class RepoAnalystParseError(ValueError):
    """Raised when the final agent output is not a valid report."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


_JSON_FENCE_PATTERN = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.IGNORECASE | re.DOTALL)


def _extract_first_json_object(text: str) -> str | None:
    """Extract the first balanced JSON object from free-form text."""
    start = -1
    depth = 0
    in_string = False
    escaped = False

    for index, char in enumerate(text):
        if start < 0:
            if char == "{":
                start = index
                depth = 1
            continue

        if in_string:
            if escaped:
                escaped = False
                continue
            if char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
            continue
        if char == "{":
            depth += 1
            continue
        if char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]

    return None


def _candidate_json_texts(raw_text: str) -> list[str]:
    """Build candidate JSON strings from model output."""
    candidates: list[str] = [raw_text]

    for block in _JSON_FENCE_PATTERN.findall(raw_text):
        block_text = block.strip()
        if block_text:
            candidates.append(block_text)

    extracted = _extract_first_json_object(raw_text)
    if extracted:
        candidates.append(extracted.strip())

    # Keep insertion order while removing duplicates.
    deduped: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        if item not in seen:
            seen.add(item)
            deduped.append(item)
    return deduped


def parse_repo_analyst_report(result: AgentRunResult) -> RepoAnalystReport:
    """Parse and validate the final assistant output as a structured report."""
    if result.final_message is None or not result.final_message.content:
        raise RepoAnalystParseError(
            "missing_final_content",
            "missing final assistant content",
        )

    raw_text = result.final_message.content.strip()
    payload = None
    parse_error: json.JSONDecodeError | None = None
    for candidate in _candidate_json_texts(raw_text):
        try:
            payload = json.loads(candidate)
            break
        except json.JSONDecodeError as exc:
            parse_error = exc

    if payload is None:
        raise RepoAnalystParseError(
            "invalid_json",
            "repo analyst output is not valid JSON",
        ) from parse_error

    try:
        return RepoAnalystReport.model_validate(payload)
    except Exception as exc:
        raise RepoAnalystParseError(
            "schema_validation_failed",
            "repo analyst report schema validation failed",
        ) from exc
