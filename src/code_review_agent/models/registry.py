"""Model provider registry."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from code_review_agent.settings import get_settings

from .base import ChatModel, ModelConfigurationError
from .deepseek import DeepSeekModel
from .siliconflow import SiliconFlowModel


class ModelProviderDescriptor(BaseModel):
    """Public metadata for one model provider."""

    model_config = ConfigDict(extra="forbid")

    name: str
    default_model: str
    configured: bool
    base_url: str
    models: list[str]


SUPPORTED_PROVIDERS = {"deepseek", "siliconflow"}

SILICONFLOW_MODELS = [
    "deepseek-ai/DeepSeek-V4-Flash",
    "deepseek-ai/DeepSeek-V3.2",
    "Pro/deepseek-ai/DeepSeek-V3.2",
    "deepseek-ai/DeepSeek-V3.1-Terminus",
    "Pro/deepseek-ai/DeepSeek-V3.1-Terminus",
    "Pro/moonshotai/Kimi-K2.6",
    "Pro/moonshotai/Kimi-K2.5",
    "Pro/zai-org/GLM-5.1",
    "Pro/zai-org/GLM-5",
    "Pro/zai-org/GLM-4.7",
    "MiniMaxAI/MiniMax-M2.5",
    "Pro/MiniMaxAI/MiniMax-M2.5",
]


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
    if resolved_provider == "siliconflow":
        return SiliconFlowModel(model_name=model_name)
    raise ModelConfigurationError(f"unknown model provider: {resolved_provider}")


def _dedupe_models(models: list[str]) -> list[str]:
    """Preserve model order while removing duplicates and empty values."""
    seen: set[str] = set()
    deduped: list[str] = []
    for model in models:
        if not model or model in seen:
            continue
        seen.add(model)
        deduped.append(model)
    return deduped


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
        ModelProviderDescriptor(
            name="siliconflow",
            default_model=settings.siliconflow_model,
            configured=bool(settings.siliconflow_api_key),
            base_url=settings.siliconflow_base_url,
            models=_dedupe_models([settings.siliconflow_model, *SILICONFLOW_MODELS]),
        ),
    ]
