"""Tests for the run_command tool."""

from __future__ import annotations

from pathlib import Path

import pytest

from code_review_agent.messages import ToolCall
from code_review_agent.runtime.service import build_default_tool_registry
from code_review_agent.sandbox import CommandPolicyError, CommandRunResult
from code_review_agent.tools import RunCommandTool, ToolContext, ToolRegistry
from code_review_agent.tools.base import Tool


@pytest.fixture
def anyio_backend() -> str:
    """Run AnyIO tests on asyncio only."""
    return "asyncio"


def make_command_result(
    tmp_path: Path,
    *,
    exit_code: int | None = 0,
    timed_out: bool = False,
    execution_error: str | None = None,
) -> CommandRunResult:
    """Create a command result for tool tests."""
    return CommandRunResult(
        program="python",
        args=["-m", "pytest"],
        cwd=tmp_path,
        exit_code=exit_code,
        duration_ms=25,
        stdout="stdout text",
        stderr="stderr text",
        stdout_truncated=False,
        stderr_truncated=False,
        timed_out=timed_out,
        policy_id="python-pytest-v1",
        execution_error=execution_error,
    )


def test_default_tool_registry_includes_run_command() -> None:
    registry = build_default_tool_registry()

    assert registry.get("run_command").name == "run_command"
    assert any(schema["name"] == "run_command" for schema in registry.get_model_schemas())


@pytest.mark.anyio
async def test_run_command_tool_returns_success_for_nonzero_exit_code(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_run_allowed_command(**kwargs) -> CommandRunResult:
        return make_command_result(tmp_path, exit_code=1)

    monkeypatch.setattr(
        "code_review_agent.tools.command_tools.run_allowed_command",
        fake_run_allowed_command,
    )

    result = await RunCommandTool().execute(
        ToolContext(workspace_root=tmp_path),
        {"program": "python", "args": ["-m", "pytest"]},
    )

    assert result.status == "success"
    assert result.data is not None
    assert result.data["exit_code"] == 1
    assert result.data["policy_id"] == "python-pytest-v1"
    assert "Exit code: 1" in result.content


@pytest.mark.anyio
async def test_run_command_tool_returns_error_when_policy_blocks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_run_allowed_command(**kwargs) -> CommandRunResult:
        raise CommandPolicyError("git command is not allowlisted")

    monkeypatch.setattr(
        "code_review_agent.tools.command_tools.run_allowed_command",
        fake_run_allowed_command,
    )

    result = await RunCommandTool().execute(
        ToolContext(workspace_root=tmp_path),
        {"program": "git", "args": ["checkout", "main"]},
    )

    assert result.status == "error"
    assert result.data is not None
    assert result.data["blocked"] is True
    assert result.metadata["error_type"] == "command_policy_error"
    assert "Command blocked by policy" in result.content


@pytest.mark.anyio
async def test_run_command_tool_returns_error_on_timeout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_run_allowed_command(**kwargs) -> CommandRunResult:
        return make_command_result(tmp_path, exit_code=-9, timed_out=True)

    monkeypatch.setattr(
        "code_review_agent.tools.command_tools.run_allowed_command",
        fake_run_allowed_command,
    )

    result = await RunCommandTool().execute(
        ToolContext(workspace_root=tmp_path),
        {"program": "python", "args": ["-m", "pytest"]},
    )

    assert result.status == "error"
    assert result.data is not None
    assert result.data["timed_out"] is True
    assert result.metadata["error_type"] == "command_timeout"


@pytest.mark.anyio
async def test_run_command_tool_returns_error_when_command_cannot_start(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_run_allowed_command(**kwargs) -> CommandRunResult:
        return make_command_result(
            tmp_path,
            exit_code=None,
            execution_error="file not found",
        )

    monkeypatch.setattr(
        "code_review_agent.tools.command_tools.run_allowed_command",
        fake_run_allowed_command,
    )

    result = await RunCommandTool().execute(
        ToolContext(workspace_root=tmp_path),
        {"program": "python", "args": ["-m", "pytest"]},
    )

    assert result.status == "error"
    assert result.metadata["error_type"] == "command_start_error"
    assert "failed to start" in result.content


@pytest.mark.anyio
async def test_tool_registry_invokes_run_command(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_run_allowed_command(**kwargs) -> CommandRunResult:
        return make_command_result(tmp_path, exit_code=0)

    monkeypatch.setattr(
        "code_review_agent.tools.command_tools.run_allowed_command",
        fake_run_allowed_command,
    )

    registry = ToolRegistry()
    registry.register(RunCommandTool())

    result = await registry.invoke(
        ToolCall(
            id="call_1",
            name="run_command",
            arguments={"program": "python", "args": ["-m", "pytest"]},
        ),
        ToolContext(workspace_root=tmp_path),
    )

    assert result.status == "success"
    assert result.data is not None
    assert result.data["program"] == "python"


class EmptyErrorTool(Tool):
    """Tool that raises an exception with an empty string representation."""

    name = "empty_error"
    description = "Raise an empty exception."
    arguments_model = RunCommandTool.arguments_model

    async def _execute(self, context, arguments):
        raise RuntimeError()


@pytest.mark.anyio
async def test_tool_registry_unexpected_error_includes_exception_type(tmp_path: Path) -> None:
    registry = ToolRegistry()
    registry.register(EmptyErrorTool())

    result = await registry.invoke(
        ToolCall(id="call_1", name="empty_error", arguments={"program": "python"}),
        ToolContext(workspace_root=tmp_path),
    )

    assert result.status == "error"
    assert "RuntimeError" in result.content
    assert result.metadata["exception_type"] == "RuntimeError"
