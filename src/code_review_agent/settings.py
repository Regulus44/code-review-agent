"""Application settings loaded from environment variables and `.env`."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import os
from pathlib import Path


def _normalize_env_value(raw_value: str) -> str:
    """Normalize one `.env` value string.

    - Trim surrounding whitespace
    - Remove matching wrapper quotes (single or double)
    """
    value = raw_value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _load_dotenv() -> None:
    """Load a root-level .env file into os.environ without overriding existing vars."""
    env_path = Path(".env")
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = _normalize_env_value(value)


def _parse_csv_env(raw_value: str | None) -> tuple[str, ...] | None:
    """Parse a comma-separated env value.

    `None` means the setting was not configured. An empty configured value means
    the user intentionally selected an empty list.
    """
    if raw_value is None:
        return None
    return tuple(item.strip() for item in raw_value.split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    """Runtime settings for local development and service startup."""

    deepseek_api_key: str | None = None
    deepseek_base_url: str = "https://api.deepseek.com"
    siliconflow_api_key: str | None = None
    siliconflow_base_url: str = "https://api.siliconflow.cn/v1"
    siliconflow_model: str = "Qwen/Qwen2.5-Coder-32B-Instruct"
    default_provider: str = "deepseek"
    default_model: str = "deepseek-chat"
    runtime_workspace_root: str = "D:\\Develop"
    database_url: str = "sqlite:///./runtime.db"
    api_key: str | None = None
    run_timeout_seconds: int = 300
    model_request_timeout_seconds: float = 180.0
    max_concurrent_runs: int = 4
    enabled_tools: tuple[str, ...] | None = None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return cached application settings."""
    _load_dotenv()
    return Settings(
        deepseek_api_key=os.getenv("DEEPSEEK_API_KEY") or None,
        deepseek_base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        siliconflow_api_key=os.getenv("SILICONFLOW_API_KEY") or None,
        siliconflow_base_url=os.getenv(
            "SILICONFLOW_BASE_URL",
            "https://api.siliconflow.cn/v1",
        ),
        siliconflow_model=os.getenv(
            "SILICONFLOW_MODEL",
            "Qwen/Qwen2.5-Coder-32B-Instruct",
        ),
        default_provider=os.getenv("DEFAULT_PROVIDER", "deepseek"),
        default_model=os.getenv("DEFAULT_MODEL", "deepseek-chat"),
        runtime_workspace_root=os.getenv("RUNTIME_WORKSPACE_ROOT", "D:\\Develop"),
        database_url=os.getenv("DATABASE_URL", "sqlite:///./runtime.db"),
        api_key=os.getenv("API_KEY") or None,
        run_timeout_seconds=int(os.getenv("RUN_TIMEOUT_SECONDS", "300")),
        model_request_timeout_seconds=float(
            os.getenv("MODEL_REQUEST_TIMEOUT_SECONDS", "180"),
        ),
        max_concurrent_runs=int(os.getenv("MAX_CONCURRENT_RUNS", "4")),
        enabled_tools=_parse_csv_env(os.getenv("ENABLED_TOOLS")),
    )
