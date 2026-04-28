"""Base model interfaces and response types."""

from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from code_review_agent.messages import Message, ToolCall


class ModelError(Exception):
    """Base exception for model provider failures."""


class ModelConfigurationError(ModelError):
    """Raised when a model is misconfigured."""


class ModelAPIError(ModelError):
    """Raised when a provider API request fails."""


class ModelResponseParseError(ModelError):
    """Raised when a provider response cannot be parsed."""


class ModelUsage(BaseModel):
    """Token usage returned by the model provider."""

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    prompt_cache_hit_tokens: int | None = None
    prompt_cache_miss_tokens: int | None = None


class ChatRequest(BaseModel):
    """Provider-neutral chat completion request."""

    model_config = ConfigDict(extra="forbid")

    messages: list[Message]
    tools: list[dict[str, Any]] | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    stream: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_messages(self) -> "ChatRequest":
        """Require at least one message in every request."""
        if not self.messages:
            raise ValueError("chat requests require at least one message")
        return self


class ChatResponse(BaseModel):
    """Provider-neutral chat completion response."""

    model_config = ConfigDict(extra="forbid")

    message: Message
    provider: str
    model: str
    usage: ModelUsage | None = None
    finish_reason: str | None = None
    raw: dict[str, Any] | None = None

    @property
    def tool_calls(self) -> list[ToolCall]:
        """Return tool calls requested by the assistant message."""
        return self.message.tool_calls


class ChatModel(ABC):
    """Async provider-neutral chat model interface."""

    provider: str
    model_name: str

    @abstractmethod
    async def complete(self, request: ChatRequest) -> ChatResponse:
        """Execute one chat completion request."""
