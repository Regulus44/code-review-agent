"""Application settings loaded from environment variables and `.env`."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import os
from pathlib import Path


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
        os.environ[key] = value.strip()


@dataclass(frozen=True)
class Settings:
    """Runtime settings for local development and service startup."""

    deepseek_api_key: str | None = None
    deepseek_base_url: str = "https://api.deepseek.com"
    default_model: str = "deepseek-chat"
    runtime_workspace_root: str = "D:\\Develop"
    database_url: str = "sqlite:///./runtime.db"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return cached application settings."""
    _load_dotenv()
    return Settings(
        deepseek_api_key=os.getenv("DEEPSEEK_API_KEY") or None,
        deepseek_base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
        default_model=os.getenv("DEFAULT_MODEL", "deepseek-chat"),
        runtime_workspace_root=os.getenv("RUNTIME_WORKSPACE_ROOT", "D:\\Develop"),
        database_url=os.getenv("DATABASE_URL", "sqlite:///./runtime.db"),
    )
