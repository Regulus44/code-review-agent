"""Xiaomi MiMo model provider."""

from .base import ModelConfigurationError
from .openai_compat import OpenAICompatibleModel
from ..settings import get_settings


class MiMoModel(OpenAICompatibleModel):
    """Xiaomi MiMo chat model using its OpenAI-compatible API."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model_name: str | None = None,
        timeout: float | None = None,
        default_temperature: float | None = None,
    ) -> None:
        settings = get_settings()
        resolved_api_key = api_key or settings.mimo_api_key
        if not resolved_api_key:
            raise ModelConfigurationError(
                "MiMo API key is required. Set MIMO_API_KEY in the environment or .env.",
            )

        super().__init__(
            api_key=resolved_api_key,
            base_url=base_url or settings.mimo_base_url,
            model_name=model_name or settings.mimo_model,
            provider="mimo",
            timeout=timeout or settings.model_request_timeout_seconds,
            default_temperature=default_temperature,
        )
