"""Built-in file tools for repository analysis."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from code_review_agent.sandbox.path import resolve_workspace_path

from .base import Tool, ToolContext, ToolExecutionError, ToolExecutionResult


IGNORED_DIR_NAMES = {".git", "__pycache__", ".pytest_cache"}


def _is_hidden_path(path: Path) -> bool:
    """Treat dot-prefixed path segments as hidden."""
    return any(part.startswith(".") for part in path.parts if part not in {".", ".."})


def _should_skip_path(path: Path, include_hidden: bool) -> bool:
    """Skip hidden and ignored cache paths by default."""
    if any(part in IGNORED_DIR_NAMES for part in path.parts):
        return True
    if not include_hidden and _is_hidden_path(path):
        return True
    return False


def _to_workspace_relative(workspace_root: Path, path: Path) -> str:
    """Return a POSIX path relative to the workspace root."""
    return path.relative_to(workspace_root).as_posix()


def _truncate_text(text: str, max_chars: int) -> tuple[str, bool]:
    """Truncate text to the requested character limit."""
    if len(text) <= max_chars:
        return text, False
    return text[:max_chars].rstrip() + "\n...[truncated]", True


class ListFilesArguments(BaseModel):
    """Arguments for listing files in the workspace."""

    model_config = ConfigDict(extra="forbid")

    path: str = "."
    recursive: bool = True
    glob: str | None = None
    limit: int = Field(default=200, ge=1, le=5000)
    include_hidden: bool = False


class ReadFileArguments(BaseModel):
    """Arguments for reading a text file."""

    model_config = ConfigDict(extra="forbid")

    path: str
    start_line: int | None = Field(default=None, ge=1)
    end_line: int | None = Field(default=None, ge=1)
    max_chars: int = Field(default=12000, ge=1, le=50000)

    @model_validator(mode="after")
    def validate_line_range(self) -> "ReadFileArguments":
        """Require start_line <= end_line when both are provided."""
        if (
            self.start_line is not None
            and self.end_line is not None
            and self.start_line > self.end_line
        ):
            raise ValueError("start_line must be less than or equal to end_line")
        return self


class SearchTextArguments(BaseModel):
    """Arguments for text search in the workspace."""

    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1)
    path: str = "."
    case_sensitive: bool = False
    glob: str | None = None
    limit: int = Field(default=50, ge=1, le=1000)
    context_lines: int = Field(default=0, ge=0, le=20)
    include_hidden: bool = False

    @field_validator("query")
    @classmethod
    def validate_query(cls, value: str) -> str:
        """Reject empty or whitespace-only queries."""
        if not value.strip():
            raise ValueError("query cannot be blank")
        return value


class ListFilesTool(Tool):
    """List files under the workspace root."""

    name = "list_files"
    description = "List files in the repository workspace."
    arguments_model = ListFilesArguments

    async def _execute(
        self,
        context: ToolContext,
        arguments: ListFilesArguments,
    ) -> ToolExecutionResult:
        base_path = resolve_workspace_path(context.workspace_root, arguments.path)
        if not base_path.exists():
            raise ToolExecutionError(f"path does not exist: {arguments.path}")

        if base_path.is_file():
            if _should_skip_path(
                base_path.relative_to(context.workspace_root),
                arguments.include_hidden,
            ):
                files: list[str] = []
            else:
                files = [_to_workspace_relative(context.workspace_root, base_path)]
        else:
            files = self._collect_files(context.workspace_root, base_path, arguments)

        truncated = len(files) > arguments.limit
        files = files[: arguments.limit]

        if files:
            content = "\n".join(files)
        else:
            content = "No files found."

        return ToolExecutionResult.success(
            tool_name=self.name,
            content=content,
            data={
                "files": files,
                "truncated": truncated,
                "count": len(files),
            },
        )

    def _collect_files(
        self,
        workspace_root: Path,
        base_path: Path,
        arguments: ListFilesArguments,
    ) -> list[str]:
        files: list[str] = []

        if arguments.recursive:
            iterator = base_path.rglob(arguments.glob or "*")
        elif arguments.glob:
            iterator = base_path.glob(arguments.glob)
        else:
            iterator = base_path.iterdir()

        for candidate in iterator:
            if not candidate.is_file():
                continue

            relative_path = candidate.relative_to(workspace_root)
            if _should_skip_path(relative_path, arguments.include_hidden):
                continue

            files.append(relative_path.as_posix())

        files.sort()
        return files


class ReadFileTool(Tool):
    """Read a text file from the workspace."""

    name = "read_file"
    description = "Read a text file from the repository workspace."
    arguments_model = ReadFileArguments

    async def _execute(
        self,
        context: ToolContext,
        arguments: ReadFileArguments,
    ) -> ToolExecutionResult:
        file_path = resolve_workspace_path(context.workspace_root, arguments.path)
        if not file_path.exists():
            raise ToolExecutionError(f"file does not exist: {arguments.path}")
        if not file_path.is_file():
            raise ToolExecutionError(f"path is not a file: {arguments.path}")

        raw_bytes = file_path.read_bytes()
        replaced_characters = False
        try:
            text = raw_bytes.decode("utf-8")
        except UnicodeDecodeError:
            text = raw_bytes.decode("utf-8", errors="replace")
            replaced_characters = True

        lines = text.splitlines()
        total_lines = len(lines)

        start_line = arguments.start_line or 1
        end_line = arguments.end_line or total_lines
        end_line = min(end_line, total_lines)

        if total_lines == 0:
            numbered_text = ""
        else:
            selected = lines[start_line - 1 : end_line]
            numbered_text = "\n".join(
                f"{line_no}: {line}"
                for line_no, line in enumerate(selected, start=start_line)
            )

        relative_path = _to_workspace_relative(context.workspace_root, file_path)
        header = f"File: {relative_path}\nLines: {start_line}-{end_line}\n"
        truncated_body, truncated = _truncate_text(numbered_text, arguments.max_chars)
        rendered = header + ("\n" + truncated_body if truncated_body else "\n")

        return ToolExecutionResult.success(
            tool_name=self.name,
            content=rendered,
            data={
                "path": relative_path,
                "start_line": start_line,
                "end_line": end_line,
                "truncated": truncated,
            },
            metadata={"replaced_characters": replaced_characters},
        )


class SearchTextTool(Tool):
    """Search text in repository files."""

    name = "search_text"
    description = "Search for text in repository files."
    arguments_model = SearchTextArguments

    async def _execute(
        self,
        context: ToolContext,
        arguments: SearchTextArguments,
    ) -> ToolExecutionResult:
        search_root = resolve_workspace_path(context.workspace_root, arguments.path)
        if not search_root.exists():
            raise ToolExecutionError(f"path does not exist: {arguments.path}")

        if shutil.which("rg") and arguments.context_lines == 0:
            try:
                matches = self._search_with_rg(
                    context.workspace_root,
                    search_root,
                    arguments,
                )
                backend = "rg"
                metadata = {}
            except OSError as exc:
                matches, metadata = self._search_with_python(
                    context.workspace_root,
                    search_root,
                    arguments,
                )
                backend = "python"
                metadata["rg_error"] = str(exc)
        else:
            matches, metadata = self._search_with_python(
                context.workspace_root,
                search_root,
                arguments,
            )
            backend = "python"

        truncated = len(matches) > arguments.limit
        matches = matches[: arguments.limit]
        content = "\n".join(
            f"{match['path']}:{match['line_number']}: {match['line_text']}"
            for match in matches
        )
        if not content:
            content = "No matches found."

        return ToolExecutionResult.success(
            tool_name=self.name,
            content=content,
            data={
                "matches": matches,
                "truncated": truncated,
                "backend": backend,
            },
            metadata=metadata,
        )

    def _search_with_rg(
        self,
        workspace_root: Path,
        search_root: Path,
        arguments: SearchTextArguments,
    ) -> list[dict[str, Any]]:
        command = [
            "rg",
            "--vimgrep",
            "--color",
            "never",
            "--no-heading",
            "-F",
        ]

        if arguments.case_sensitive:
            command.append("--case-sensitive")
        else:
            command.append("--ignore-case")

        if arguments.include_hidden:
            command.append("--hidden")

        if arguments.glob:
            command.extend(["-g", arguments.glob])

        for ignored_dir in IGNORED_DIR_NAMES:
            command.extend(["-g", f"!{ignored_dir}/**"])

        command.extend([arguments.query, str(search_root)])

        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            cwd=workspace_root,
        )

        if completed.returncode not in {0, 1}:
            raise ToolExecutionError(
                f"rg exited with code {completed.returncode}: {completed.stderr.strip()}",
            )

        matches: list[dict[str, Any]] = []
        for line in completed.stdout.splitlines():
            parts = line.split(":", 3)
            if len(parts) != 4:
                continue
            raw_path, raw_line, _column, line_text = parts
            file_path = Path(raw_path)
            if not file_path.is_absolute():
                file_path = (workspace_root / file_path).resolve(strict=False)

            matches.append(
                {
                    "path": _to_workspace_relative(workspace_root, file_path),
                    "line_number": int(raw_line),
                    "line_text": line_text,
                },
            )

        return matches

    def _search_with_python(
        self,
        workspace_root: Path,
        search_root: Path,
        arguments: SearchTextArguments,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        matches: list[dict[str, Any]] = []
        skipped_files = 0

        if search_root.is_file():
            candidates = [search_root]
        else:
            candidates = []
            for candidate in search_root.rglob("*"):
                if candidate.is_dir():
                    continue
                relative_path = candidate.relative_to(workspace_root)
                if _should_skip_path(relative_path, arguments.include_hidden):
                    continue
                if arguments.glob and not candidate.match(arguments.glob):
                    continue
                candidates.append(candidate)

        if not arguments.case_sensitive:
            query = arguments.query.casefold()
        else:
            query = arguments.query

        for file_path in candidates:
            relative_path = file_path.relative_to(workspace_root)
            if _should_skip_path(relative_path, arguments.include_hidden):
                continue

            try:
                text = file_path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                try:
                    text = file_path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    skipped_files += 1
                    continue
            except OSError:
                skipped_files += 1
                continue

            lines = text.splitlines()
            for index, line in enumerate(lines, start=1):
                haystack = line if arguments.case_sensitive else line.casefold()
                if query not in haystack:
                    continue

                if arguments.context_lines > 0:
                    context_prefix = max(1, index - arguments.context_lines)
                    context_suffix = min(len(lines), index + arguments.context_lines)
                    line_text = "\n".join(
                        f"{line_no}: {lines[line_no - 1]}"
                        for line_no in range(context_prefix, context_suffix + 1)
                    )
                else:
                    line_text = line

                matches.append(
                    {
                        "path": relative_path.as_posix(),
                        "line_number": index,
                        "line_text": line_text,
                    },
                )

        return matches, {"skipped_files": skipped_files}
