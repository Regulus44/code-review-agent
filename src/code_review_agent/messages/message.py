"""Provider-neutral message models.

The rest of the runtime talks in these types instead of vendor-specific chat
completion payloads. Formatters adapt them to each model provider.
"""

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Role(str, Enum):
    """Supported chat roles."""

    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class TextBlock(BaseModel):
    """A text content block.

    The block shape leaves room for future multimodal content without forcing
    the first implementation to expose provider payloads.
    """

    type: Literal["text"] = "text"
    text: str


class ToolCall(BaseModel):
    """A tool call requested by the model."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    raw_arguments: str | None = None


class ToolResult(BaseModel):
    """The result returned by a tool execution."""

    model_config = ConfigDict(extra="forbid")

    tool_call_id: str
    content: str
    name: str | None = None
    is_error: bool = False


class Message(BaseModel):
    """A single provider-neutral chat message."""

    model_config = ConfigDict(extra="forbid")

    role: Role
    content: str | None = None
    reasoning_content: str | None = None
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: list[ToolCall] = Field(default_factory=list)
    raw: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_shape(self) -> "Message":
        """Validate role-specific message invariants."""
        if self.role == Role.TOOL and not self.tool_call_id:
            raise ValueError("tool messages require tool_call_id")

        if self.role != Role.ASSISTANT and self.tool_calls:
            raise ValueError("only assistant messages can include tool_calls")

        if self.role != Role.TOOL and self.tool_call_id:
            raise ValueError("only tool messages can include tool_call_id")

        if self.role == Role.ASSISTANT:
            if self.content is None and not self.tool_calls:
                raise ValueError(
                    "assistant messages require content or tool_calls",
                )
        elif self.content is None:
            raise ValueError(f"{self.role.value} messages require content")

        return self


def system_message(content: str) -> Message:
    """Create a system message."""
    return Message(role=Role.SYSTEM, content=content)


def user_message(content: str, name: str | None = None) -> Message:
    """Create a user message."""
    return Message(role=Role.USER, content=content, name=name)


def assistant_message(
    content: str | None = None,
    reasoning_content: str | None = None,
    tool_calls: list[ToolCall] | None = None,
    raw: dict[str, Any] | None = None,
) -> Message:
    """Create an assistant message."""
    return Message(
        role=Role.ASSISTANT,
        content=content,
        reasoning_content=reasoning_content,
        tool_calls=tool_calls or [],
        raw=raw,
    )


def tool_message(result: ToolResult) -> Message:
    """Create a tool result message."""
    return Message(
        role=Role.TOOL,
        content=result.content,
        name=result.name,
        tool_call_id=result.tool_call_id,
    )
