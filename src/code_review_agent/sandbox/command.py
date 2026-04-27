"""Allowlisted command execution helpers."""

from __future__ import annotations

import asyncio
import os
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from code_review_agent.tools.truncation import truncate_text

from .path import resolve_workspace_path


SHELL_METACHARS = ("|", "&&", ";", ">", "<", "`", "$(")
DANGEROUS_PROGRAMS = {
    "bash",
    "cmd",
    "curl",
    "del",
    "format",
    "powershell",
    "pwsh",
    "rm",
    "sh",
    "wget",
    "wsl",
}
GIT_ALLOWED_ARGS = {
    ("status",),
    ("status", "--short"),
    ("diff",),
    ("diff", "--stat"),
    ("diff", "--name-only"),
    ("log", "--oneline"),
}
WINDOWS_ABSOLUTE_RE = re.compile(r"^[a-zA-Z]:[\\/]")
HEAD_RANGE_RE = re.compile(r"^HEAD~([1-9]\d?)$")
LOG_LIMIT_RE = re.compile(r"^-[1-9]\d?$")


class CommandPolicyError(ValueError):
    """Raised when a command violates the allowlist policy."""


@dataclass(frozen=True)
class CommandPolicyDecision:
    """A successful policy decision."""

    policy_id: str
    normalized_program: str


@dataclass(frozen=True)
class CommandRunResult:
    """Raw command execution result before converting to a tool result."""

    program: str
    args: list[str]
    cwd: Path
    exit_code: int | None
    duration_ms: int
    stdout: str
    stderr: str
    stdout_truncated: bool
    stderr_truncated: bool
    timed_out: bool
    policy_id: str
    execution_error: str | None = None


def _exception_detail(exc: BaseException) -> str:
    """Return a non-empty exception detail for command diagnostics."""
    message = str(exc).strip()
    if message:
        return f"{exc.__class__.__name__}: {message}"
    return f"{exc.__class__.__name__}: {exc!r}"


class CommandPolicy:
    """Minimal allowlist policy for local repository commands."""

    def validate(self, program: str, args: list[str]) -> CommandPolicyDecision:
        """Validate the requested command and return the matching policy."""
        normalized_program = self._normalize_program(program)
        self._reject_common_unsafe_tokens([program, *args])

        if normalized_program in DANGEROUS_PROGRAMS:
            raise CommandPolicyError(f"program is not allowed: {program}")

        if normalized_program == "git":
            return self._validate_git(args)

        if normalized_program == "python":
            return self._validate_python(args)

        raise CommandPolicyError(f"program is not allowlisted: {program}")

    def _normalize_program(self, program: str) -> str:
        candidate = program.strip()
        if not candidate:
            raise CommandPolicyError("program cannot be blank")
        if "/" in candidate or "\\" in candidate or Path(candidate).is_absolute():
            raise CommandPolicyError("program path is not allowed")

        lowered = candidate.lower()
        if lowered.endswith(".exe"):
            lowered = lowered[:-4]
        return lowered

    def _reject_common_unsafe_tokens(self, tokens: list[str]) -> None:
        for token in tokens:
            if any(marker in token for marker in SHELL_METACHARS):
                raise CommandPolicyError(
                    f"shell metacharacters are not allowed: {token}",
                )
            if ".." in token:
                raise CommandPolicyError("path traversal is not allowed in arguments")
            if Path(token).is_absolute() or WINDOWS_ABSOLUTE_RE.match(token):
                raise CommandPolicyError("absolute paths are not allowed in arguments")

    def _validate_git(self, args: list[str]) -> CommandPolicyDecision:
        if tuple(args) in GIT_ALLOWED_ARGS:
            return CommandPolicyDecision(
                policy_id="git-readonly-v1",
                normalized_program="git",
            )

        if len(args) == 3 and args[:2] == ["log", "--oneline"]:
            self._validate_log_limit(args[2])
            return CommandPolicyDecision(
                policy_id="git-readonly-v1",
                normalized_program="git",
            )

        if len(args) == 4 and args[:2] == ["log", "--oneline"] and args[2] == "-n":
            self._validate_positive_limit(args[3])
            return CommandPolicyDecision(
                policy_id="git-readonly-v1",
                normalized_program="git",
            )

        if args and args[0] == "diff":
            self._validate_git_diff(args[1:])
            return CommandPolicyDecision(
                policy_id="git-readonly-v1",
                normalized_program="git",
            )

        raise CommandPolicyError("git command is not allowlisted")

    def _validate_git_diff(self, args: list[str]) -> None:
        if not args:
            return

        remaining = list(args)
        if remaining[0] in {"--stat", "--name-only"}:
            remaining.pop(0)
        elif HEAD_RANGE_RE.match(remaining[0]):
            self._validate_head_range(remaining.pop(0))
            if remaining and remaining[0] in {"--stat", "--name-only"}:
                remaining.pop(0)
        else:
            raise CommandPolicyError("git diff target is not allowlisted")

        if not remaining:
            return

        if remaining[0] != "--":
            raise CommandPolicyError(
                "git diff only allows pathspecs after --; "
                "use 'git diff -- <path>' instead of 'git diff <path>'"
            )

        if len(remaining) == 1:
            raise CommandPolicyError("git diff -- requires at least one pathspec")

    def _validate_head_range(self, value: str) -> None:
        match = HEAD_RANGE_RE.match(value)
        if not match:
            raise CommandPolicyError("git HEAD range is not allowlisted")
        if int(match.group(1)) > 50:
            raise CommandPolicyError("git HEAD range limit must be 1..50")

    def _validate_log_limit(self, value: str) -> None:
        match = LOG_LIMIT_RE.match(value)
        if not match:
            raise CommandPolicyError("git log limit is not allowlisted")
        if int(value[1:]) > 50:
            raise CommandPolicyError("git log limit must be 1..50")

    def _validate_positive_limit(self, value: str) -> None:
        try:
            parsed = int(value)
        except ValueError as exc:
            raise CommandPolicyError("git log limit is not a number") from exc
        if parsed < 1 or parsed > 50:
            raise CommandPolicyError("git log limit must be 1..50")

    def _validate_python(self, args: list[str]) -> CommandPolicyDecision:
        if len(args) < 2 or args[0] != "-m" or args[1] != "pytest":
            raise CommandPolicyError("only 'python -m pytest' is allowlisted")
        return CommandPolicyDecision(
            policy_id="python-pytest-v1",
            normalized_program="python",
        )


def truncate_output(text: str, max_chars: int) -> tuple[str, bool]:
    """Truncate command output and mark whether truncation happened."""
    return truncate_text(text, max_chars)


def _decode_output(data: bytes | str | None) -> str:
    """Decode subprocess output to string, handling None and str edge cases."""
    if data is None:
        return ""
    if isinstance(data, str):
        return data
    return data.decode("utf-8", errors="replace")


def _run_command_sync(
    program: str,
    args: list[str],
    cwd: Path,
    timeout_seconds: int,
) -> CommandRunResult:
    """Synchronous subprocess.run fallback for Windows event loop compatibility."""
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            [program, *args],
            cwd=cwd,
            env=os.environ.copy(),
            capture_output=True,
            text=False,
            timeout=timeout_seconds,
            shell=False,
        )
        duration_ms = int((time.perf_counter() - started) * 1000)
        return CommandRunResult(
            program=program,
            args=args,
            cwd=cwd,
            exit_code=completed.returncode,
            duration_ms=duration_ms,
            stdout=_decode_output(completed.stdout),
            stderr=_decode_output(completed.stderr),
            stdout_truncated=False,
            stderr_truncated=False,
            timed_out=False,
            policy_id="",
        )
    except subprocess.TimeoutExpired as exc:
        duration_ms = int((time.perf_counter() - started) * 1000)
        return CommandRunResult(
            program=program,
            args=args,
            cwd=cwd,
            exit_code=None,
            duration_ms=duration_ms,
            stdout=_decode_output(exc.stdout),
            stderr=_decode_output(exc.stderr),
            stdout_truncated=False,
            stderr_truncated=False,
            timed_out=True,
            policy_id="",
        )
    except OSError as exc:
        duration_ms = int((time.perf_counter() - started) * 1000)
        return CommandRunResult(
            program=program,
            args=args,
            cwd=cwd,
            exit_code=None,
            duration_ms=duration_ms,
            stdout="",
            stderr="",
            stdout_truncated=False,
            stderr_truncated=False,
            timed_out=False,
            policy_id="",
            execution_error=_exception_detail(exc),
        )


async def run_allowed_command(
    *,
    workspace_root: Path,
    program: str,
    args: list[str],
    cwd: str,
    timeout_seconds: int,
    max_output_chars: int,
    policy: CommandPolicy | None = None,
) -> CommandRunResult:
    """Run one allowlisted command inside the workspace."""
    active_policy = policy or CommandPolicy()
    decision = active_policy.validate(program, args)
    try:
        resolved_cwd = resolve_workspace_path(workspace_root, cwd)
    except Exception as exc:
        from code_review_agent.tools.base import ToolExecutionError

        if not isinstance(exc, ToolExecutionError):
            raise
        raise CommandPolicyError(str(exc)) from exc
    if not resolved_cwd.exists():
        raise CommandPolicyError(f"cwd does not exist: {cwd}")
    if not resolved_cwd.is_dir():
        raise CommandPolicyError(f"cwd is not a directory: {cwd}")

    started = time.perf_counter()
    try:
        process = await asyncio.create_subprocess_exec(
            program,
            *args,
            cwd=resolved_cwd,
            env=os.environ.copy(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except NotImplementedError:
        result = await asyncio.to_thread(
            _run_command_sync,
            program,
            args,
            resolved_cwd,
            timeout_seconds,
        )
        stdout, stdout_truncated = truncate_output(result.stdout, max_output_chars)
        stderr, stderr_truncated = truncate_output(result.stderr, max_output_chars)
        return CommandRunResult(
            program=program,
            args=args,
            cwd=resolved_cwd,
            exit_code=result.exit_code,
            duration_ms=result.duration_ms,
            stdout=stdout,
            stderr=stderr,
            stdout_truncated=stdout_truncated,
            stderr_truncated=stderr_truncated,
            timed_out=result.timed_out,
            policy_id=decision.policy_id,
            execution_error=result.execution_error,
        )
    except OSError as exc:
        duration_ms = int((time.perf_counter() - started) * 1000)
        return CommandRunResult(
            program=program,
            args=args,
            cwd=resolved_cwd,
            exit_code=None,
            duration_ms=duration_ms,
            stdout="",
            stderr="",
            stdout_truncated=False,
            stderr_truncated=False,
            timed_out=False,
            policy_id=decision.policy_id,
            execution_error=_exception_detail(exc),
        )

    timed_out = False
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            process.communicate(),
            timeout=timeout_seconds,
        )
    except asyncio.CancelledError:
        process.kill()
        await process.communicate()
        raise
    except asyncio.TimeoutError:
        timed_out = True
        process.kill()
        stdout_bytes, stderr_bytes = await process.communicate()

    duration_ms = int((time.perf_counter() - started) * 1000)
    stdout, stdout_truncated = truncate_output(
        stdout_bytes.decode("utf-8", errors="replace"),
        max_output_chars,
    )
    stderr, stderr_truncated = truncate_output(
        stderr_bytes.decode("utf-8", errors="replace"),
        max_output_chars,
    )

    return CommandRunResult(
        program=program,
        args=args,
        cwd=resolved_cwd,
        exit_code=process.returncode,
        duration_ms=duration_ms,
        stdout=stdout,
        stderr=stderr,
        stdout_truncated=stdout_truncated,
        stderr_truncated=stderr_truncated,
        timed_out=timed_out,
        policy_id=decision.policy_id,
    )
