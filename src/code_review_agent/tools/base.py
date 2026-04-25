"""Core tool abstractions."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from code_review_agent.messages import ToolResult


class ToolError(Exception):
    """Base exception for tool layer failures."""


class ToolExecutionError(ToolError):
    """Raised when a tool cannot complete successfully."""


class ToolNotFoundError(ToolError):
    """Raised when a requested tool is not registered."""


class ToolArgumentsError(ToolError):
    """Raised when tool arguments are invalid."""


class ToolContext(BaseModel):
    """Execution context shared by all tools."""

    model_config = ConfigDict(extra="forbid")

    workspace_root: Path
    run_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("workspace_root")
    @classmethod
    def validate_workspace_root(cls, value: Path) -> Path:
        """Require a real directory as workspace root."""
        resolved = value.resolve()
        if not resolved.exists():
            raise ValueError(f"workspace_root does not exist: {resolved}")
        if not resolved.is_dir():
            raise ValueError(f"workspace_root is not a directory: {resolved}")
        return resolved


class ToolExecutionResult(BaseModel):
    """Structured result returned by tool execution."""

    model_config = ConfigDict(extra="forbid")

    tool_name: str
    status: Literal["success", "error"]
    content: str
    data: dict[str, Any] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def success(
        cls,
        *,
        tool_name: str,
        content: str,
        data: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "ToolExecutionResult":
        """Create a successful tool result."""
        return cls(
            tool_name=tool_name,
            status="success",
            content=content,
            data=data,
            metadata=metadata or {},
        )

    @classmethod
    def error(
        cls,
        *,
        tool_name: str,
        content: str,
        data: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> "ToolExecutionResult":
        """Create an error tool result."""
        return cls(
            tool_name=tool_name,
            status="error",
            content=content,
            data=data,
            metadata=metadata or {},
        )

    def to_message_result(self, tool_call_id: str) -> ToolResult:
        """Convert to the provider-neutral tool result message payload."""
        return ToolResult(
            tool_call_id=tool_call_id,
            name=self.tool_name,
            content=self.content,
            is_error=self.status == "error",
        )


class Tool(ABC):
    """Base class for built-in and future external tools."""

    name: str
    description: str
    arguments_model: type[BaseModel]

    @property
    def parameters(self) -> dict[str, Any]:
        """Return the JSON schema exposed to the model."""
        return self.arguments_model.model_json_schema()

    def to_model_schema(self) -> dict[str, Any]:
        """Return the plain function schema used by `ChatRequest.tools`."""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
        }

    async def execute(
        self,
        context: ToolContext,
        arguments: dict[str, Any] | None,
    ) -> ToolExecutionResult:
        """Validate arguments then execute the tool."""
        try:
            validated_arguments = self.arguments_model.model_validate(
                arguments or {},
            )
        except ValidationError as exc:
            raise ToolArgumentsError(str(exc)) from exc

        return await self._execute(context, validated_arguments)

    @abstractmethod
    async def _execute(
        self,
        context: ToolContext,
        arguments: BaseModel,
    ) -> ToolExecutionResult:
        """Execute the tool with validated arguments."""
