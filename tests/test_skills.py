"""Tests for skill catalog and routing."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from code_review_agent.messages import assistant_message
from code_review_agent.models import ChatModel, ChatRequest, ChatResponse
from code_review_agent.runtime.session_service import SessionService
from code_review_agent.session.store import InMemorySessionStore
from code_review_agent.session.types import SessionRecord
from code_review_agent.skills import LlmSkillRouter, load_builtin_skill_catalog
from code_review_agent.tools import ToolRegistry


class RecordingModel(ChatModel):
    provider = "fake"
    model_name = "fake-model"

    def __init__(self, router_content: str) -> None:
        self.router_content = router_content
        self.requests: list[ChatRequest] = []

    async def complete(self, request: ChatRequest) -> ChatResponse:
        self.requests.append(request)
        if request.metadata.get("purpose") == "skill_router":
            return ChatResponse(
                message=assistant_message(content=self.router_content),
                provider=self.provider,
                model=self.model_name,
                finish_reason="stop",
            )
        return ChatResponse(
            message=assistant_message(content="Done"),
            provider=self.provider,
            model=self.model_name,
            finish_reason="stop",
        )


def test_builtin_skill_catalog_loads_descriptors() -> None:
    catalog = load_builtin_skill_catalog()

    descriptors = catalog.descriptors()

    names = {descriptor.name for descriptor in descriptors}
    assert {"code-review", "bug-fix", "architecture-analysis"} <= names
    assert all("prompt" not in descriptor.model_dump() for descriptor in descriptors)


@pytest.mark.anyio
async def test_llm_skill_router_selects_known_skills() -> None:
    catalog = load_builtin_skill_catalog()
    model = RecordingModel(
        '{"skills":["code-review","unknown"],"confidence":0.9,"reason":"review"}',
    )
    router = LlmSkillRouter(catalog)

    result = await router.select(
        model=model,
        user_input="请审查最近的代码改动",
        history=[],
        workspace_root=str(Path.cwd()),
    )

    assert result.selected_skills == ["code-review"]
    assert result.confidence == 0.9
    assert result.reason == "review"
    assert model.requests[0].metadata["purpose"] == "skill_router"


@pytest.mark.anyio
async def test_session_service_applies_selected_skill_to_turn_prompt() -> None:
    catalog = load_builtin_skill_catalog()
    model = RecordingModel(
        '{"skills":["code-review"],"confidence":0.88,"reason":"review request"}',
    )
    store = InMemorySessionStore()
    service = SessionService(
        store=store,
        model_factory=lambda provider=None, model_name=None: model,
        tool_registry_factory=ToolRegistry,
        skill_catalog=catalog,
        skill_router=LlmSkillRouter(catalog),
    )
    await store.create_session(
        SessionRecord(id="sess-1", workspace_root=".", max_iterations=3),
    )

    turn = await service.start_turn("sess-1", "帮我做一次代码审查")
    await asyncio.sleep(0.2)

    events = await store.get_turn_events(turn.id)
    skill_events = [event for event in events if event.event_type == "skill.selected"]
    assert skill_events
    assert skill_events[0].payload["selected_skills"] == ["code-review"]
    assert len(model.requests) >= 2
    agent_request = model.requests[1]
    assert agent_request.messages[0].role.value == "system"
    assert "Code Review Skill" in (agent_request.messages[0].content or "")
