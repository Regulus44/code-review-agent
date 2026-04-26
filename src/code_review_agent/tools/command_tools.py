"""Built-in command execution tools."""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator

from code_review_agent.sandbox.command import (
    CommandPolicyError,
    CommandRunResult,
    run_allowed_command,
)

from .base import Tool, ToolContext, ToolExecutionResult


class RunCommandArguments(BaseModel):
    """Arguments for running an allowlisted command."""

    model_config = ConfigDict(extra="forbid")

    program: str = Field(description="Executable name, for example git or python.")
    args: list[str] = Field(
        default_factory=list,
        description="Command arguments as separate tokens. Shell syntax is not allowed.",
    )
    cwd: str = Field(default=".", description="Relative working directory.")
    timeout_seconds: int = Field(default=30, ge=1, le=120)
    max_output_chars: int = Field(default=12000, ge=1000, le=50000)

    @field_validator("program")
    @classmethod
    def validate_program(cls, value: str) -> str:
        """Reject blank program names early."""
        if not value.strip():
            raise ValueError("program cannot be blank")
        return value.strip()


class RunCommandTool(Tool):
    """Run a small set of allowlisted repository commands."""

    name = "run_command"
    description = (
        "Run an allowlisted read-only repository command. Supported commands include "
        "git status, git diff variants, git log --oneline, and python -m pytest."
    )
    arguments_model = RunCommandArguments

    async def _execute(
        self,
        context: ToolContext,
        arguments: RunCommandArguments,
    ) -> ToolExecutionResult:
        try:
            command_result = await run_allowed_command(
                workspace_root=context.workspace_root,
                program=arguments.program,
                args=arguments.args,
                cwd=arguments.cwd,
                timeout_seconds=arguments.timeout_seconds,
                max_output_chars=arguments.max_output_chars,
            )
        except CommandPolicyError as exc:
            return ToolExecutionResult.error(
                tool_name=self.name,
                content=f"Command blocked by policy: {exc}",
                data={
                    "program": arguments.program,
                    "args": arguments.args,
                    "cwd": arguments.cwd,
                    "exit_code": None,
                    "duration_ms": 0,
                    "stdout": "",
                    "stderr": "",
                    "stdout_truncated": False,
                    "stderr_truncated": False,
                    "timed_out": False,
                    "policy_id": None,
                    "blocked": True,
                    "blocked_reason": str(exc),
                },
                metadata={"error_type": "command_policy_error"},
            )

        if command_result.execution_error:
            return ToolExecutionResult.error(
                tool_name=self.name,
                content=f"Command failed to start: {command_result.execution_error}",
                data=self._result_data(context.workspace_root, command_result),
                metadata={"error_type": "command_start_error"},
            )

        if command_result.timed_out:
            return ToolExecutionResult.error(
                tool_name=self.name,
                content=self._render_content(command_result),
                data=self._result_data(context.workspace_root, command_result),
                metadata={"error_type": "command_timeout"},
            )

        return ToolExecutionResult.success(
            tool_name=self.name,
            content=self._render_content(command_result),
            data=self._result_data(context.workspace_root, command_result),
        )

    def _result_data(
        self,
        workspace_root: Path,
        result: CommandRunResult,
    ) -> dict[str, object]:
        return {
            "program": result.program,
            "args": result.args,
            "cwd": result.cwd.relative_to(workspace_root).as_posix() or ".",
            "exit_code": result.exit_code,
            "duration_ms": result.duration_ms,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "stdout_truncated": result.stdout_truncated,
            "stderr_truncated": result.stderr_truncated,
            "timed_out": result.timed_out,
            "policy_id": result.policy_id,
        }

    def _render_content(self, result: CommandRunResult) -> str:
        command = " ".join([result.program, *result.args]).strip()
        lines = [
            f"Command: {command}",
            f"Exit code: {result.exit_code}",
            f"Duration: {result.duration_ms} ms",
            f"Timed out: {result.timed_out}",
        ]
        if result.stdout:
            lines.extend(["", "stdout:", result.stdout])
        if result.stderr:
            lines.extend(["", "stderr:", result.stderr])
        if not result.stdout and not result.stderr:
            lines.extend(["", "No output."])
        return "\n".join(lines)
