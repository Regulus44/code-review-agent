"""Minimal path helpers for file-based tools."""

from __future__ import annotations

from pathlib import Path

from code_review_agent.tools.base import ToolExecutionError


def resolve_workspace_path(workspace_root: Path, relative_path: str) -> Path:
    """Resolve a relative path inside the workspace root.

    The first version keeps the boundary simple:
    - absolute paths are rejected
    - `..` escape is rejected
    - the final resolved path must stay under the workspace root
    """

    candidate = Path(relative_path or ".")
    if candidate.is_absolute():
        raise ToolExecutionError("absolute paths are not allowed")

    resolved_root = workspace_root.resolve()
    resolved_path = (resolved_root / candidate).resolve(strict=False)

    try:
        resolved_path.relative_to(resolved_root)
    except ValueError as exc:
        raise ToolExecutionError("path escapes the workspace root") from exc

    return resolved_path

