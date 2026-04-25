"""OpenAI-compatible chat completion model adapter."""

from typing import Any

import httpx

from code_review_agent.formatters import MessageFormatter, OpenAIChatFormatter

from .base import (
    ChatModel,
    ChatRequest,
    ChatResponse,
    ModelAPIError,
    ModelConfigurationError,
    ModelResponseParseError,
    ModelUsage,
)


class OpenAICompatibleModel(ChatModel):
    """Adapter for providers that implement OpenAI-style chat completions."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model_name: str,
        provider: str = "openai-compatible",
        timeout: float = 60.0,
        default_temperature: float | None = None,
        formatter: MessageFormatter | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not api_key:
            raise ModelConfigurationError("api_key is required")
        if not base_url:
            raise ModelConfigurationError("base_url is required")
        if not model_name:
            raise ModelConfigurationError("model_name is required")

        self.provider = provider
        self.model_name = model_name
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.default_temperature = default_temperature
        self.formatter = formatter or OpenAIChatFormatter()
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._owns_client = client is None
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    async def complete(self, request: ChatRequest) -> ChatResponse:
        """Execute an OpenAI-compatible non-streaming chat completion."""
        if request.stream:
            raise ModelConfigurationError("streaming is not implemented in v1")

        payload = self._build_payload(request)
        try:
            response = await self._client.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers,
                json=payload,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            body = exc.response.text
            raise ModelAPIError(
                f"{self.provider} API returned HTTP "
                f"{exc.response.status_code}: {body}",
            ) from exc
        except httpx.HTTPError as exc:
            raise ModelAPIError(f"{self.provider} API request failed: {exc}") from exc

        raw = response.json()
        return self._parse_response(raw)

    async def aclose(self) -> None:
        """Close the owned HTTP client."""
        if self._owns_client:
            await self._client.aclose()

    def _build_payload(self, request: ChatRequest) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model_name,
            "messages": self.formatter.format_messages(request.messages),
            "stream": False,
        }

        tools = self.formatter.format_tools(request.tools)
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        temperature = (
            request.temperature
            if request.temperature is not None
            else self.default_temperature
        )
        if temperature is not None:
            payload["temperature"] = temperature

        if request.max_tokens is not None:
            payload["max_tokens"] = request.max_tokens

        return payload

    def _parse_response(self, raw: dict[str, Any]) -> ChatResponse:
        choices = raw.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ModelResponseParseError("model response did not include choices")

        first_choice = choices[0]
        provider_message = first_choice.get("message")
        if not isinstance(provider_message, dict):
            raise ModelResponseParseError("model response choice missing message")

        message = self.formatter.parse_assistant_message(provider_message)
        usage = self._parse_usage(raw.get("usage"))
        return ChatResponse(
            message=message,
            provider=self.provider,
            model=raw.get("model") or self.model_name,
            usage=usage,
            finish_reason=first_choice.get("finish_reason"),
            raw=raw,
        )

    def _parse_usage(self, usage: Any) -> ModelUsage | None:
        if usage is None:
            return None
        if not isinstance(usage, dict):
            raise ModelResponseParseError("model usage must be an object")

        return ModelUsage(
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            total_tokens=usage.get("total_tokens"),
        )

