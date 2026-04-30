"""Model provider interfaces and implementations."""

from __future__ import annotations

from .base import (
    ChatModel,
    ChatRequest,
    ChatResponse,
    ModelAPIError,
    ModelConfigurationError,
    ModelError,
    ModelResponseParseError,
    ModelUsage,
)
from .registry import (
    ModelProviderDescriptor,
    create_model,
    list_model_providers,
    normalize_provider,
)

__all__ = [
    "ChatModel",
    "ChatRequest",
    "ChatResponse",
    "DeepSeekModel",
    "MiMoModel",
    "ModelAPIError",
    "ModelConfigurationError",
    "ModelError",
    "ModelResponseParseError",
    "ModelUsage",
    "ModelProviderDescriptor",
    "OpenAICompatibleModel",
    "SiliconFlowModel",
    "create_model",
    "list_model_providers",
    "normalize_provider",
]


def __getattr__(name: str):
    """Lazily import provider implementations to avoid import cycles."""
    if name == "DeepSeekModel":
        from .deepseek import DeepSeekModel

        return DeepSeekModel
    if name == "OpenAICompatibleModel":
        from .openai_compat import OpenAICompatibleModel

        return OpenAICompatibleModel
    if name == "SiliconFlowModel":
        from .siliconflow import SiliconFlowModel

        return SiliconFlowModel
    if name == "MiMoModel":
        from .mimo import MiMoModel

        return MiMoModel
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
