"""Tests for allowlisted command sandbox helpers."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest

from code_review_agent.sandbox import (
    CommandPolicy,
    CommandPolicyError,
    run_allowed_command,
    truncate_output,
)
from code_review_agent.sandbox.command import _decode_output


@pytest.fixture
def anyio_backend() -> str:
    """Run AnyIO tests on asyncio only."""
    return "asyncio"


def test_command_policy_allows_readonly_git_commands() -> None:
    policy = CommandPolicy()

    decision = policy.validate("git", ["status", "--short"])

    assert decision.policy_id == "git-readonly-v1"
    assert decision.normalized_program == "git"


@pytest.mark.parametrize(
    "args",
    [
        ["log", "--oneline", "-10"],
        ["log", "--oneline", "-n", "20"],
        ["diff", "HEAD~3"],
        ["diff", "HEAD~3", "--stat"],
        ["diff", "HEAD~3", "--name-only"],
        ["diff", "HEAD~3", "--", ":!tmp/*", ":!runtime.db"],
    ],
)
def test_command_policy_allows_review_git_commands(args: list[str]) -> None:
    policy = CommandPolicy()

    decision = policy.validate("git", args)

    assert decision.policy_id == "git-readonly-v1"


def test_command_policy_allows_python_pytest() -> None:
    policy = CommandPolicy()

    decision = policy.validate("python", ["-m", "pytest", "tests/test_file_tools.py"])

    assert decision.policy_id == "python-pytest-v1"
    assert decision.normalized_program == "python"


@pytest.mark.parametrize(
    ("program", "args"),
    [
        ("cmd", ["/c", "dir"]),
        ("powershell", ["Get-ChildItem"]),
        ("git", ["checkout", "main"]),
        ("git", ["log", "--oneline", "-99"]),
        ("git", ["diff", "HEAD~99"]),
        ("git", ["diff", "main"]),
        ("python", ["-c", "print('unsafe')"]),
        ("unknown-tool", []),
    ],
)
def test_command_policy_blocks_non_allowlisted_commands(
    program: str,
    args: list[str],
) -> None:
    policy = CommandPolicy()

    with pytest.raises(CommandPolicyError):
        policy.validate(program, args)


@pytest.mark.parametrize(
    "args",
    [
        ["status", "&&", "git", "diff"],
        ["status", "../outside"],
        ["status", "C:\\Windows"],
        ["status", ">"],
    ],
)
def test_command_policy_blocks_shell_and_escape_arguments(args: list[str]) -> None:
    policy = CommandPolicy()

    with pytest.raises(CommandPolicyError):
        policy.validate("git", args)


def test_truncate_output_marks_truncation() -> None:
    truncated, was_truncated = truncate_output("abcdef", 3)

    assert truncated == "abc\n...[truncated]"
    assert was_truncated is True


@pytest.mark.anyio
async def test_run_allowed_command_rejects_cwd_escape(tmp_path: Path) -> None:
    with pytest.raises(CommandPolicyError):
        await run_allowed_command(
            workspace_root=tmp_path,
            program="git",
            args=["status"],
            cwd="../outside",
            timeout_seconds=1,
            max_output_chars=1000,
        )


@pytest.mark.anyio
async def test_run_allowed_command_handles_timeout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class SlowProcess:
        returncode = None
        killed = False

        async def communicate(self) -> tuple[bytes, bytes]:
            if self.killed:
                self.returncode = -9
                return b"partial stdout", b"partial stderr"
            await asyncio.sleep(10)
            return b"", b""

        def kill(self) -> None:
            self.killed = True

    async def fake_create_subprocess_exec(*args, **kwargs) -> SlowProcess:
        return SlowProcess()

    monkeypatch.setattr(
        asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    result = await run_allowed_command(
        workspace_root=tmp_path,
        program="git",
        args=["status"],
        cwd=".",
        timeout_seconds=1,
        max_output_chars=1000,
    )

    assert result.timed_out is True
    assert result.exit_code == -9
    assert result.stdout == "partial stdout"
    assert result.stderr == "partial stderr"


@pytest.mark.anyio
async def test_run_allowed_command_kills_process_when_cancelled(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process_holder: dict[str, object] = {}

    class CancellableProcess:
        returncode = None
        killed = False

        async def communicate(self) -> tuple[bytes, bytes]:
            if self.killed:
                self.returncode = -9
                return b"", b""
            await asyncio.sleep(10)
            return b"", b""

        def kill(self) -> None:
            self.killed = True

    async def fake_create_subprocess_exec(*args, **kwargs) -> CancellableProcess:
        process = CancellableProcess()
        process_holder["process"] = process
        return process

    monkeypatch.setattr(
        asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    task = asyncio.create_task(
        run_allowed_command(
            workspace_root=tmp_path,
            program="git",
            args=["status"],
            cwd=".",
            timeout_seconds=120,
            max_output_chars=1000,
        ),
    )
    await asyncio.sleep(0.01)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    process = process_holder["process"]
    assert process.killed is True
    assert process.returncode == -9


def test_decode_output_handles_none() -> None:
    assert _decode_output(None) == ""


def test_decode_output_handles_str() -> None:
    assert _decode_output("hello") == "hello"


def test_decode_output_handles_bytes() -> None:
    assert _decode_output(b"hello") == "hello"


def test_decode_output_handles_invalid_utf8() -> None:
    result = _decode_output(b"\xff\xfe")
    assert isinstance(result, str)


@pytest.mark.anyio
async def test_run_allowed_command_falls_back_on_not_implemented_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def raise_not_implemented(*args, **kwargs):
        raise NotImplementedError

    monkeypatch.setattr(
        asyncio,
        "create_subprocess_exec",
        raise_not_implemented,
    )

    import subprocess

    original_run = subprocess.run

    def fake_subprocess_run(cmd, **kwargs):
        if cmd[0] == "git":
            return subprocess.CompletedProcess(
                args=cmd,
                returncode=0,
                stdout=b"M file.py\n",
                stderr=b"",
            )
        return original_run(cmd, **kwargs)

    monkeypatch.setattr(
        "code_review_agent.sandbox.command.subprocess.run",
        fake_subprocess_run,
    )

    result = await run_allowed_command(
        workspace_root=tmp_path,
        program="git",
        args=["status", "--short"],
        cwd=".",
        timeout_seconds=10,
        max_output_chars=1000,
    )

    assert result.exit_code == 0
    assert "M file.py" in result.stdout
    assert result.timed_out is False
    assert result.execution_error is None


@pytest.mark.anyio
async def test_run_allowed_command_fallback_handles_timeout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def raise_not_implemented(*args, **kwargs):
        raise NotImplementedError

    monkeypatch.setattr(
        asyncio,
        "create_subprocess_exec",
        raise_not_implemented,
    )

    import subprocess

    def fake_subprocess_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, timeout=kwargs.get("timeout", 10))

    monkeypatch.setattr(
        "code_review_agent.sandbox.command.subprocess.run",
        fake_subprocess_run,
    )

    result = await run_allowed_command(
        workspace_root=tmp_path,
        program="git",
        args=["status", "--short"],
        cwd=".",
        timeout_seconds=5,
        max_output_chars=1000,
    )

    assert result.timed_out is True
    assert result.exit_code is None


@pytest.mark.anyio
async def test_run_allowed_command_fallback_handles_oserror(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def raise_not_implemented(*args, **kwargs):
        raise NotImplementedError

    monkeypatch.setattr(
        asyncio,
        "create_subprocess_exec",
        raise_not_implemented,
    )

    import subprocess

    def fake_subprocess_run(cmd, **kwargs):
        raise OSError("command not found")

    monkeypatch.setattr(
        "code_review_agent.sandbox.command.subprocess.run",
        fake_subprocess_run,
    )

    result = await run_allowed_command(
        workspace_root=tmp_path,
        program="git",
        args=["status", "--short"],
        cwd=".",
        timeout_seconds=5,
        max_output_chars=1000,
    )

    assert result.execution_error is not None
    assert "OSError" in result.execution_error
    assert result.exit_code is None
