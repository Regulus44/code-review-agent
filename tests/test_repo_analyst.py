"""Tests for the repository analyst app."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import BaseModel, ConfigDict, Field

from code_review_agent.apps.repo_analyst import (
    DEFAULT_REPO_ANALYST_QUESTION,
    RepoAnalystParseError,
    RepoAnalystRequest,
    RepoAnalystService,
    build_repo_analyst_prompt,
    parse_repo_analyst_report,
)
from code_review_agent.harness import AgentRunResult
from code_review_agent.messages import ToolCall, assistant_message
from code_review_agent.models import ChatResponse, ChatModel
from code_review_agent.runtime import AgentRuntime
from code_review_agent.tools import Tool, ToolExecutionResult, ToolRegistry


@pytest.fixture
def anyio_backend() -> str:
    """Run AnyIO tests on asyncio only."""
    return "asyncio"


class EchoArguments(BaseModel):
    """Arguments for a fake echo tool."""

    model_config = ConfigDict(extra="forbid")

    value: str = Field(min_length=1)


class EchoTool(Tool):
    """Tool that echoes a value."""

    name = "echo"
    description = "Echo a value."
    arguments_model = EchoArguments

    async def _execute(self, context, arguments: EchoArguments) -> ToolExecutionResult:
        return ToolExecutionResult.success(
            tool_name=self.name,
            content=f"echo: {arguments.value}",
        )


class FakeModel(ChatModel):
    """Model with scripted responses for repo analyst tests."""

    provider = "fake"
    model_name = "fake-model"

    def __init__(self, scripted: list[ChatResponse]) -> None:
        self._scripted = scripted
        self.requests = []

    async def complete(self, request):
        self.requests.append(request.model_copy(deep=True))
        return self._scripted.pop(0)


def make_response(
    *,
    content: str | None = None,
    tool_calls: list[ToolCall] | None = None,
    finish_reason: str | None = "stop",
) -> ChatResponse:
    """Create a fake chat response."""
    return ChatResponse(
        message=assistant_message(content=content, tool_calls=tool_calls or []),
        provider="fake",
        model="fake-model",
        finish_reason=finish_reason,
    )


def build_registry() -> ToolRegistry:
    """Create a registry for repo analyst tests."""
    registry = ToolRegistry()
    registry.register(EchoTool())
    return registry


def test_repo_analyst_prompt_contains_json_constraints() -> None:
    default_prompt = build_repo_analyst_prompt()
    custom_prompt = build_repo_analyst_prompt("Explain the architecture")

    assert DEFAULT_REPO_ANALYST_QUESTION in default_prompt
    assert "Explain the architecture" in custom_prompt
    assert "Return only valid JSON" in custom_prompt
    assert "summary" in custom_prompt
    assert "modules" in custom_prompt
    assert "next_steps" in custom_prompt


def test_repo_analyst_request_default_max_iterations() -> None:
    request = RepoAnalystRequest(workspace_root="D:/Develop/code-review-agent")
    assert request.max_iterations == 100


def test_repo_analyst_parser_accepts_valid_json() -> None:
    run_result = AgentRunResult(
        status="completed",
        final_message=assistant_message(
            content=(
                '{"summary":"Repo summary","modules":[{"name":"core","description":"Core logic"}],'
                '"architecture":["API -> runtime -> agent"],'
                '"risks":["Missing persistence"],'
                '"next_steps":["Add observability"]}'
            ),
        ),
    )
    result = parse_repo_analyst_report(run_result)

    assert result.summary == "Repo summary"
    assert result.modules[0].name == "core"


def test_repo_analyst_parser_accepts_json_markdown_fence() -> None:
    run_result = AgentRunResult(
        status="completed",
        final_message=assistant_message(
            content=(
                "Now I have all the evidence needed.\n\n"
                "```json\n"
                '{"summary":"Repo summary","modules":[{"name":"core","description":"Core logic"}],'
                '"architecture":["API -> runtime -> agent"],'
                '"risks":["Missing persistence"],'
                '"next_steps":["Add observability"]}'
                "\n```"
            ),
        ),
    )

    result = parse_repo_analyst_report(run_result)

    assert result.summary == "Repo summary"
    assert result.modules[0].name == "core"


def test_repo_analyst_parser_accepts_embedded_json_object() -> None:
    run_result = AgentRunResult(
        status="completed",
        final_message=assistant_message(
            content=(
                "analysis done. "
                '{"summary":"Repo summary","modules":[{"name":"core","description":"Core logic"}],'
                '"architecture":["API -> runtime -> agent"],'
                '"risks":["Missing persistence"],'
                '"next_steps":["Add observability"]}'
                " trailing text"
            ),
        ),
    )

    result = parse_repo_analyst_report(run_result)

    assert result.summary == "Repo summary"
    assert result.modules[0].description == "Core logic"


def test_repo_analyst_parser_rejects_invalid_json() -> None:
    invalid = AgentRunResult(
        status="completed",
        final_message=assistant_message(content="not-json"),
    )

    with pytest.raises(RepoAnalystParseError):
        parse_repo_analyst_report(invalid)


def test_repo_analyst_parser_rejects_schema_mismatch() -> None:
    invalid = AgentRunResult(
        status="completed",
        final_message=assistant_message(content='{"summary":"ok"}'),
    )

    with pytest.raises(RepoAnalystParseError):
        parse_repo_analyst_report(invalid)


@pytest.mark.anyio
async def test_repo_analyst_service_returns_structured_report(tmp_path: Path) -> None:
    model = FakeModel(
        [
            make_response(
                tool_calls=[
                    ToolCall(id="call_1", name="echo", arguments={"value": "hello"}),
                ],
                finish_reason="tool_calls",
            ),
            make_response(
                content=(
                    '{"summary":"A repository analysis tool",'
                    '"modules":[{"name":"runtime","description":"Runs agents"}],'
                    '"architecture":["API -> runtime -> agent -> tools"],'
                    '"risks":["No persistence yet"],'
                    '"next_steps":["Add report UI"]}'
                ),
            ),
        ],
    )
    runtime = AgentRuntime(
        model_factory=lambda: model,
        tool_registry_factory=build_registry,
    )
    service = RepoAnalystService(runtime)

    run = await service.create_run(
        RepoAnalystRequest(
            workspace_root=str(tmp_path),
            question="Explain this repository",
        ),
    )
    result = await service.execute_run(run.id)
    events = await service.get_events(run.id)

    assert result.status == "completed"
    assert result.report is not None
    assert result.report.summary == "A repository analysis tool"
    assert result.report.modules[0].name == "runtime"
    assert [event.type for event in events][-1] == "status_change"
    assert "Explain this repository" in model.requests[0].messages[0].content


@pytest.mark.anyio
async def test_repo_analyst_service_marks_invalid_report(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="not-json")]),
        tool_registry_factory=build_registry,
    )
    service = RepoAnalystService(runtime)

    run = await service.create_run(RepoAnalystRequest(workspace_root=str(tmp_path)))
    result = await service.execute_run(run.id)

    assert result.status == "completed"
    assert result.report is None
    assert result.failure_reason == "invalid_repo_analyst_report_json"
    assert result.parse_diagnostics is not None
    assert result.parse_diagnostics.code == "invalid_json"


@pytest.mark.anyio
async def test_repo_analyst_service_marks_schema_mismatch(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content='{"summary":"only summary"}')]),
        tool_registry_factory=build_registry,
    )
    service = RepoAnalystService(runtime)

    run = await service.create_run(RepoAnalystRequest(workspace_root=str(tmp_path)))
    result = await service.execute_run(run.id)

    assert result.status == "completed"
    assert result.report is None
    assert result.failure_reason == "invalid_repo_analyst_report_schema"
    assert result.parse_diagnostics is not None
    assert result.parse_diagnostics.code == "schema_validation_failed"
