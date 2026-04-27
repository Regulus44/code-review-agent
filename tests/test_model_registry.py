"""Tests for model provider registry."""

from __future__ import annotations

import pytest

from code_review_agent.models import (
    DeepSeekModel,
    ModelConfigurationError,
    SiliconFlowModel,
    create_model,
    list_model_providers,
    normalize_provider,
)
from code_review_agent.settings import get_settings


def test_normalize_provider_uses_default_provider(monkeypatch) -> None:
    monkeypatch.setenv("DEFAULT_PROVIDER", "siliconflow")
    get_settings.cache_clear()

    assert normalize_provider(None) == "siliconflow"
    assert normalize_provider("DEEPSEEK") == "deepseek"
    assert normalize_provider("SiliconFlow") == "siliconflow"

    get_settings.cache_clear()


def test_normalize_provider_rejects_unknown_provider() -> None:
    with pytest.raises(ModelConfigurationError, match="unknown model provider"):
        normalize_provider("unknown")


def test_create_model_supports_deepseek(monkeypatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setenv("DEFAULT_PROVIDER", "deepseek")
    get_settings.cache_clear()

    model = create_model(None, "deepseek-chat")

    assert isinstance(model, DeepSeekModel)
    assert model.provider == "deepseek"
    assert model.model_name == "deepseek-chat"

    get_settings.cache_clear()


def test_create_model_supports_siliconflow(monkeypatch) -> None:
    monkeypatch.setenv("SILICONFLOW_API_KEY", "test-key")
    monkeypatch.setenv("DEFAULT_PROVIDER", "siliconflow")
    monkeypatch.setenv("SILICONFLOW_MODEL", "Qwen/Qwen2.5-Coder-32B-Instruct")
    get_settings.cache_clear()

    model = create_model(None, None)

    assert isinstance(model, SiliconFlowModel)
    assert model.provider == "siliconflow"
    assert model.model_name == "Qwen/Qwen2.5-Coder-32B-Instruct"

    get_settings.cache_clear()


def test_create_model_requires_siliconflow_api_key(monkeypatch) -> None:
    monkeypatch.setenv("SILICONFLOW_API_KEY", "")
    monkeypatch.setenv("DEFAULT_PROVIDER", "siliconflow")
    get_settings.cache_clear()

    with pytest.raises(ModelConfigurationError, match="SiliconFlow API key"):
        create_model(None, None)

    get_settings.cache_clear()


def test_list_model_providers_does_not_expose_api_key(monkeypatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "secret-key")
    monkeypatch.setenv("SILICONFLOW_API_KEY", "siliconflow-secret")
    get_settings.cache_clear()

    providers = list_model_providers()
    by_name = {provider.name: provider for provider in providers}

    assert by_name["deepseek"].configured is True
    assert by_name["siliconflow"].configured is True
    assert "deepseek-ai/DeepSeek-V4-Flash" in by_name["siliconflow"].models
    assert "deepseek-ai/DeepSeek-V3.2" in by_name["siliconflow"].models
    assert "Pro/deepseek-ai/DeepSeek-V3.2" in by_name["siliconflow"].models
    assert "Pro/moonshotai/Kimi-K2.6" in by_name["siliconflow"].models
    assert "Pro/zai-org/GLM-5.1" in by_name["siliconflow"].models
    assert "MiniMaxAI/MiniMax-M2.5" in by_name["siliconflow"].models
    serialized = [provider.model_dump_json() for provider in providers]
    assert all("secret-key" not in item for item in serialized)
    assert all("siliconflow-secret" not in item for item in serialized)

    get_settings.cache_clear()
