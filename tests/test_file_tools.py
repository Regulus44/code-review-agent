"""Tests for built-in file tools."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from code_review_agent.tools import (
    ListFilesTool,
    ReadFileTool,
    SearchTextTool,
    ToolContext,
    ToolExecutionError,
)


@pytest.fixture
def anyio_backend() -> str:
    """Run AnyIO tests on asyncio only."""
    return "asyncio"


def _write_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


@pytest.mark.anyio
async def test_list_files_lists_relative_paths_and_ignores_cache_dirs(
    tmp_path: Path,
) -> None:
    _write_file(tmp_path / "src" / "main.py", "print('hi')\n")
    _write_file(tmp_path / "src" / "helper.py", "pass\n")
    _write_file(tmp_path / ".git" / "config", "[core]\n")
    _write_file(tmp_path / "__pycache__" / "x.pyc", "binary\n")

    tool = ListFilesTool()
    context = ToolContext(workspace_root=tmp_path)

    result = await tool.execute(context, {"path": ".", "recursive": True})

    assert result.status == "success"
    assert result.data is not None
    assert result.data["files"] == ["src/helper.py", "src/main.py"]
    assert result.data["count"] == 2
    assert result.data["truncated"] is False


@pytest.mark.anyio
async def test_list_files_supports_non_recursive_glob_limit_and_hidden(
    tmp_path: Path,
) -> None:
    _write_file(tmp_path / "a.py", "a\n")
    _write_file(tmp_path / "b.txt", "b\n")
    _write_file(tmp_path / ".hidden.py", "hidden\n")
    _write_file(tmp_path / "sub" / "nested.py", "nested\n")

    tool = ListFilesTool()
    context = ToolContext(workspace_root=tmp_path)

    result = await tool.execute(
        context,
        {
            "path": ".",
            "recursive": False,
            "glob": "*.py",
            "limit": 1,
            "include_hidden": True,
        },
    )

    assert result.data is not None
    assert result.data["files"] == [".hidden.py"]
    assert result.data["count"] == 1
    assert result.data["truncated"] is True


@pytest.mark.anyio
async def test_read_file_reads_ranges_and_truncates(tmp_path: Path) -> None:
    _write_file(
        tmp_path / "src" / "main.py",
        "line1\nline2\nline3\nline4\n",
    )

    tool = ReadFileTool()
    context = ToolContext(workspace_root=tmp_path)

    result = await tool.execute(
        context,
        {"path": "src/main.py", "start_line": 2, "end_line": 3, "max_chars": 12},
    )

    assert result.status == "success"
    assert "File: src/main.py" in result.content
    assert "2: line2" in result.content
    assert result.data is not None
    assert result.data["path"] == "src/main.py"
    assert result.data["start_line"] == 2
    assert result.data["end_line"] == 3
    assert result.data["truncated"] is True


@pytest.mark.anyio
async def test_read_file_marks_replaced_characters_for_non_utf8_bytes(
    tmp_path: Path,
) -> None:
    file_path = tmp_path / "bad.txt"
    file_path.write_bytes(b"ok\n\xff\n")

    tool = ReadFileTool()
    context = ToolContext(workspace_root=tmp_path)

    result = await tool.execute(context, {"path": "bad.txt"})

    assert result.status == "success"
    assert result.metadata["replaced_characters"] is True


@pytest.mark.anyio
async def test_read_file_rejects_missing_directory_and_escape_paths(
    tmp_path: Path,
) -> None:
    _write_file(tmp_path / "src" / "main.py", "ok\n")

    tool = ReadFileTool()
    context = ToolContext(workspace_root=tmp_path)

    with pytest.raises(ToolExecutionError):
        await tool.execute(context, {"path": "missing.py"})

    with pytest.raises(ToolExecutionError):
        await tool.execute(context, {"path": "src"})

    with pytest.raises(ToolExecutionError):
        await tool.execute(context, {"path": "../outside.py"})


@pytest.mark.anyio
async def test_search_text_uses_python_fallback_with_context_and_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_file(
        tmp_path / "src" / "main.py",
        "alpha\nneedle here\nomega\nneedle again\n",
    )
    _write_file(tmp_path / ".git" / "ignored.txt", "needle ignored\n")
    monkeypatch.setattr(shutil, "which", lambda _: None)

    tool = SearchTextTool()
    context = ToolContext(workspace_root=tmp_path)

    result = await tool.execute(
        context,
        {
            "query": "needle",
            "path": ".",
            "limit": 1,
            "context_lines": 1,
        },
    )

    assert result.status == "success"
    assert result.data is not None
    assert result.data["backend"] == "python"
    assert result.data["truncated"] is True
    assert result.data["matches"][0]["path"] == "src/main.py"
    assert "1: alpha" in result.data["matches"][0]["line_text"]
    assert "2: needle here" in result.data["matches"][0]["line_text"]
    assert result.metadata["skipped_files"] == 0


@pytest.mark.anyio
async def test_search_text_uses_rg_when_available(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_file(tmp_path / "src" / "main.py", "needle here\n")
    observed: dict[str, object] = {}

    def fake_run(*args, **kwargs) -> subprocess.CompletedProcess[str]:
        observed["command"] = args[0]
        observed["cwd"] = kwargs["cwd"]
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="src/main.py:2:1:needle here\n",
            stderr="",
        )

    monkeypatch.setattr(shutil, "which", lambda name: "rg" if name == "rg" else None)
    monkeypatch.setattr(subprocess, "run", fake_run)

    tool = SearchTextTool()
    context = ToolContext(workspace_root=tmp_path)

    result = await tool.execute(
        context,
        {"query": "needle", "path": ".", "glob": "*.py", "limit": 10},
    )

    assert result.status == "success"
    assert result.data is not None
    assert result.data["backend"] == "rg"
    assert result.data["matches"] == [
        {"path": "src/main.py", "line_number": 2, "line_text": "needle here"},
    ]
    assert observed["cwd"] == tmp_path
    assert "--vimgrep" in observed["command"]
    assert "-g" in observed["command"]


@pytest.mark.anyio
async def test_search_text_respects_case_sensitivity(tmp_path: Path) -> None:
    _write_file(tmp_path / "src" / "main.py", "Needle\nneedle\n")

    tool = SearchTextTool()
    context = ToolContext(workspace_root=tmp_path)

    insensitive = await tool.execute(
        context,
        {"query": "needle", "case_sensitive": False},
    )
    sensitive = await tool.execute(
        context,
        {"query": "needle", "case_sensitive": True},
    )

    assert insensitive.data is not None
    assert sensitive.data is not None
    assert len(insensitive.data["matches"]) == 2
    assert len(sensitive.data["matches"]) == 1
