"""Tests for model provider registry."""

from __future__ import annotations

import pytest

from code_review_agent.models import (
    DeepSeekModel,
    ModelConfigurationError,
    create_model,
    list_model_providers,
    normalize_provider,
)
from code_review_agent.settings import get_settings


def test_normalize_provider_uses_default_provider(monkeypatch) -> None:
    monkeypatch.setenv("DEFAULT_PROVIDER", "deepseek")
    get_settings.cache_clear()

    assert normalize_provider(None) == "deepseek"
    assert normalize_provider("DEEPSEEK") == "deepseek"

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


def test_list_model_providers_does_not_expose_api_key(monkeypatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "secret-key")
    get_settings.cache_clear()

    providers = list_model_providers()

    assert providers[0].name == "deepseek"
    assert providers[0].configured is True
    assert "secret-key" not in providers[0].model_dump_json()

    get_settings.cache_clear()
