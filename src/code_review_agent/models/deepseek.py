"""DeepSeek model provider."""

from .base import ModelConfigurationError
from .openai_compat import OpenAICompatibleModel
from ..settings import get_settings


class DeepSeekModel(OpenAICompatibleModel):
    """DeepSeek chat model using its OpenAI-compatible API."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model_name: str | None = None,
        timeout: float = 60.0,
        default_temperature: float | None = None,
    ) -> None:
        settings = get_settings()
        resolved_api_key = api_key or settings.deepseek_api_key
        if not resolved_api_key:
            raise ModelConfigurationError(
                "DeepSeek API key is required. Set DEEPSEEK_API_KEY in the environment or .env.",
            )

        super().__init__(
            api_key=resolved_api_key,
            base_url=base_url or settings.deepseek_base_url,
            model_name=model_name or settings.default_model,
            provider="deepseek",
            timeout=timeout,
            default_temperature=default_temperature,
        )
