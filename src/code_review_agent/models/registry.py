"""Model provider registry."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from code_review_agent.settings import get_settings

from .base import ChatModel, ModelConfigurationError
from .deepseek import DeepSeekModel


class ModelProviderDescriptor(BaseModel):
    """Public metadata for one model provider."""

    model_config = ConfigDict(extra="forbid")

    name: str
    default_model: str
    configured: bool
    base_url: str
    models: list[str]


SUPPORTED_PROVIDERS = {"deepseek"}


def normalize_provider(provider: str | None) -> str:
    """Resolve an optional provider name to a supported provider."""
    resolved = (provider or get_settings().default_provider).strip().lower()
    if resolved not in SUPPORTED_PROVIDERS:
        raise ModelConfigurationError(f"unknown model provider: {resolved}")
    return resolved


def create_model(provider: str | None = None, model_name: str | None = None) -> ChatModel:
    """Create a chat model for the requested provider."""
    resolved_provider = normalize_provider(provider)
    if resolved_provider == "deepseek":
        return DeepSeekModel(model_name=model_name)
    raise ModelConfigurationError(f"unknown model provider: {resolved_provider}")


def list_model_providers() -> list[ModelProviderDescriptor]:
    """List model providers known to this runtime."""
    settings = get_settings()
    return [
        ModelProviderDescriptor(
            name="deepseek",
            default_model=settings.default_model,
            configured=bool(settings.deepseek_api_key),
            base_url=settings.deepseek_base_url,
            models=[
                "deepseek-chat",
                "deepseek-reasoner",
                "deepseek-v4-pro",
                "deepseek-v4-flash",
            ],
        ),
    ]
