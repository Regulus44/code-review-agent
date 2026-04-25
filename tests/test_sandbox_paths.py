"""Tests for workspace path resolution."""

from pathlib import Path

import pytest

from code_review_agent.sandbox import resolve_workspace_path
from code_review_agent.tools import ToolExecutionError


def test_resolve_workspace_path_accepts_relative_path(tmp_path) -> None:
    target = resolve_workspace_path(tmp_path, "src/main.py")

    assert target == (tmp_path / "src" / "main.py").resolve(strict=False)


def test_resolve_workspace_path_rejects_absolute_path(tmp_path) -> None:
    absolute = str((tmp_path / "src" / "main.py").resolve(strict=False))

    with pytest.raises(ToolExecutionError):
        resolve_workspace_path(tmp_path, absolute)


def test_resolve_workspace_path_rejects_escape(tmp_path) -> None:
    with pytest.raises(ToolExecutionError):
        resolve_workspace_path(tmp_path, "../outside.py")

