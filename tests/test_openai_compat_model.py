"""Tests for the OpenAI-compatible model adapter."""

import json

import httpx
import pytest

from code_review_agent.messages import user_message
from code_review_agent.models import (
    ChatRequest,
    ModelAPIError,
    ModelConfigurationError,
    OpenAICompatibleModel,
)


@pytest.fixture
def anyio_backend() -> str:
    """Run AnyIO tests on asyncio only."""
    return "asyncio"


@pytest.mark.anyio
async def test_openai_compatible_model_builds_request_and_parses_response() -> None:
    observed_payload = {}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal observed_payload
        observed_payload = json.loads(request.content.decode("utf-8"))
        assert request.headers["authorization"] == "Bearer test-key"
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-test",
                "model": "deepseek-chat",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "No issues found.",
                        },
                        "finish_reason": "stop",
                    },
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = OpenAICompatibleModel(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model_name="deepseek-chat",
        provider="deepseek",
        client=client,
    )

    response = await model.complete(
        ChatRequest(
            messages=[user_message("Review this repository.")],
            tools=[
                {
                    "name": "read_file",
                    "description": "Read a file.",
                    "parameters": {"type": "object", "properties": {}},
                },
            ],
            temperature=0.2,
            max_tokens=256,
        ),
    )

    await client.aclose()

    assert observed_payload["model"] == "deepseek-chat"
    assert observed_payload["messages"][0]["content"] == "Review this repository."
    assert observed_payload["tools"][0]["function"]["name"] == "read_file"
    assert observed_payload["tool_choice"] == "auto"
    assert observed_payload["temperature"] == 0.2
    assert observed_payload["max_tokens"] == 256
    assert response.message.content == "No issues found."
    assert response.usage is not None
    assert response.usage.total_tokens == 15
    assert response.finish_reason == "stop"


@pytest.mark.anyio
async def test_openai_compatible_model_maps_http_errors() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "bad key"}})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = OpenAICompatibleModel(
        api_key="bad-key",
        base_url="https://api.deepseek.com",
        model_name="deepseek-chat",
        client=client,
    )

    with pytest.raises(ModelAPIError):
        await model.complete(ChatRequest(messages=[user_message("hello")]))

    await client.aclose()


def test_openai_compatible_model_rejects_missing_config() -> None:
    with pytest.raises(ModelConfigurationError):
        OpenAICompatibleModel(
            api_key="",
            base_url="https://api.deepseek.com",
            model_name="deepseek-chat",
        )


@pytest.mark.anyio
async def test_streaming_is_reserved_but_not_implemented() -> None:
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: None))
    model = OpenAICompatibleModel(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model_name="deepseek-chat",
        client=client,
    )

    with pytest.raises(ModelConfigurationError):
        await model.complete(
            ChatRequest(messages=[user_message("hello")], stream=True),
        )

    await client.aclose()
