"""Tests for settings and dotenv parsing."""

from __future__ import annotations

from pathlib import Path

from code_review_agent.settings import get_settings


def test_dotenv_strips_wrapping_quotes(tmp_path: Path, monkeypatch) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        (
            'DEEPSEEK_API_KEY="quoted-key"\n'
            "DEFAULT_PROVIDER='deepseek'\n"
            "DEFAULT_MODEL='deepseek-v4-pro'\n"
            "ENABLED_TOOLS=list_files, read_file,run_command\n"
        ),
        encoding="utf-8",
    )

    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("DEFAULT_PROVIDER", raising=False)
    monkeypatch.delenv("DEFAULT_MODEL", raising=False)
    monkeypatch.delenv("ENABLED_TOOLS", raising=False)
    get_settings.cache_clear()

    settings = get_settings()

    assert settings.deepseek_api_key == "quoted-key"
    assert settings.default_provider == "deepseek"
    assert settings.default_model == "deepseek-v4-pro"
    assert settings.enabled_tools == ("list_files", "read_file", "run_command")

    get_settings.cache_clear()


def test_enabled_tools_empty_env_value_means_no_tools(monkeypatch) -> None:
    monkeypatch.setenv("ENABLED_TOOLS", "")
    get_settings.cache_clear()

    settings = get_settings()

    assert settings.enabled_tools == ()

    get_settings.cache_clear()
