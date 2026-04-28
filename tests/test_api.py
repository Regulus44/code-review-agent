"""Tests for the FastAPI runtime API."""

from __future__ import annotations

from pathlib import Path

import anyio
import pytest
from pydantic import BaseModel, ConfigDict, Field

TestClient = pytest.importorskip("fastapi.testclient").TestClient

from code_review_agent.api import create_app
from code_review_agent.apps.repo_analyst import RepoAnalystRequest, RepoAnalystService
from code_review_agent.messages import ToolCall, assistant_message
from code_review_agent.models import ChatResponse, ChatModel
from code_review_agent.runtime import (
    AgentRuntime,
    CreateRunRequest,
    RunEvent,
    build_default_tool_descriptors,
    build_default_tool_registry,
)
from code_review_agent.settings import get_settings
from code_review_agent.tools import Tool, ToolExecutionResult, ToolRegistry


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
    """Model with scripted responses for API tests."""

    provider = "fake"
    model_name = "fake-model"

    def __init__(self, scripted: list[ChatResponse]) -> None:
        self._scripted = scripted

    async def complete(self, request):
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
    """Create a registry for API tests."""
    registry = ToolRegistry()
    registry.register(EchoTool())
    return registry


def build_runtime() -> AgentRuntime:
    """Create a runtime with a deterministic fake model."""
    return AgentRuntime(
        model_factory=lambda: FakeModel(
            [
                make_response(
                    tool_calls=[
                        ToolCall(id="call_1", name="echo", arguments={"value": "hello"}),
                    ],
                    finish_reason="tool_calls",
                ),
                make_response(content="Done"),
            ],
        ),
        tool_registry_factory=build_registry,
    )


def build_client(*, runtime: AgentRuntime | None = None, api_key: str | None = None) -> TestClient:
    app = create_app(runtime=runtime or build_runtime())
    app.state.api_key = api_key
    return TestClient(app)


def test_health_endpoint() -> None:
    client = build_client()

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_debug_runtime_config_endpoint() -> None:
    client = build_client()

    response = client.get("/debug/runtime-config")

    assert response.status_code == 200
    payload = response.json()
    assert "default_provider" in payload
    assert "default_model" in payload
    assert "deepseek_base_url" in payload
    assert "runtime_workspace_root" in payload
    assert "pid" in payload
    assert "cwd" in payload


def test_index_page_serves_frontend_html() -> None:
    client = build_client()

    response = client.get("/")

    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "Repo Analyst" in response.text
    assert "/repo-analyst/runs" in response.text
    assert "siliconflow" in response.text


def test_tools_endpoint_lists_default_runtime_tools() -> None:
    enabled_tools = ("list_files", "read_file", "search_text", "run_command")
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="Done")]),
        tool_registry_factory=lambda: build_default_tool_registry(enabled_tools),
        tool_discovery_factory=lambda: build_default_tool_descriptors(enabled_tools),
    )
    client = build_client(runtime=runtime)

    response = client.get("/tools")

    assert response.status_code == 200
    payload = response.json()
    by_name = {tool["name"]: tool for tool in payload}
    assert set(by_name) == {"list_files", "read_file", "search_text", "run_command"}
    assert by_name["list_files"]["enabled"] is True
    assert by_name["list_files"]["category"] == "filesystem"
    assert by_name["list_files"]["risk_level"] == "low"
    assert by_name["read_file"]["risk_level"] == "medium"
    assert by_name["search_text"]["category"] == "search"
    assert by_name["run_command"]["category"] == "command"
    assert by_name["run_command"]["risk_level"] == "high"
    assert by_name["run_command"]["source"] == "builtin"
    assert by_name["run_command"]["parameters"]["type"] == "object"


def test_tools_endpoint_schema_matches_registry_export() -> None:
    enabled_tools = ("list_files", "read_file", "search_text", "run_command")
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="Done")]),
        tool_registry_factory=lambda: build_default_tool_registry(enabled_tools),
        tool_discovery_factory=lambda: build_default_tool_descriptors(enabled_tools),
    )
    client = build_client(runtime=runtime)

    response = client.get("/tools")

    assert response.status_code == 200
    api_schemas = {
        item["name"]: {
            "name": item["name"],
            "description": item["description"],
            "parameters": item["parameters"],
        }
        for item in response.json()
    }
    registry_schemas = {
        item["name"]: item
        for item in build_default_tool_registry(enabled_tools).get_model_schemas()
    }
    assert api_schemas == registry_schemas


def test_tools_endpoint_requires_api_key_for_remote_request() -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="Done")]),
        tool_registry_factory=build_default_tool_registry,
    )
    client = build_client(runtime=runtime, api_key="secret-key")

    response = client.get("/tools", headers={"x-forwarded-for": "8.8.8.8"})

    assert response.status_code == 401


def test_tools_endpoint_accepts_valid_api_key_for_remote_request() -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="Done")]),
        tool_registry_factory=build_default_tool_registry,
    )
    client = build_client(runtime=runtime, api_key="secret-key")

    response = client.get(
        "/tools",
        headers={"x-forwarded-for": "8.8.8.8", "x-api-key": "secret-key"},
    )

    assert response.status_code == 200


def test_model_providers_endpoint_lists_supported_providers(monkeypatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-secret")
    monkeypatch.setenv("SILICONFLOW_API_KEY", "siliconflow-secret")
    monkeypatch.setenv("SILICONFLOW_MODEL", "deepseek-ai/DeepSeek-V4-Flash")
    get_settings.cache_clear()
    client = build_client()

    response = client.get("/models/providers")

    assert response.status_code == 200
    payload = response.json()
    by_name = {provider["name"]: provider for provider in payload}
    assert set(by_name) == {"deepseek", "siliconflow"}
    assert by_name["deepseek"]["configured"] is True
    assert by_name["siliconflow"]["configured"] is True
    assert "deepseek-v4-pro" in by_name["deepseek"]["models"]
    assert "deepseek-ai/DeepSeek-V4-Flash" in by_name["siliconflow"]["models"]
    assert "Pro/moonshotai/Kimi-K2.6" in by_name["siliconflow"]["models"]
    serialized = response.text
    assert "deepseek-secret" not in serialized
    assert "siliconflow-secret" not in serialized

    get_settings.cache_clear()


def test_model_providers_endpoint_requires_api_key_for_remote_request() -> None:
    client = build_client(api_key="secret-key")

    response = client.get("/models/providers", headers={"x-forwarded-for": "8.8.8.8"})

    assert response.status_code == 401


def test_tools_endpoint_marks_disabled_tools_from_runtime_policy() -> None:
    enabled_tools = ("list_files", "read_file")
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="Done")]),
        tool_registry_factory=lambda: build_default_tool_registry(enabled_tools),
        tool_discovery_factory=lambda: build_default_tool_descriptors(enabled_tools),
    )
    client = build_client(runtime=runtime)

    response = client.get("/tools")

    assert response.status_code == 200
    by_name = {tool["name"]: tool for tool in response.json()}
    assert by_name["list_files"]["enabled"] is True
    assert by_name["read_file"]["enabled"] is True
    assert by_name["search_text"]["enabled"] is False
    assert by_name["search_text"]["disabled_reason"] == "not_in_enabled_tools"
    assert by_name["run_command"]["enabled"] is False
    assert by_name["run_command"]["disabled_reason"] == "not_in_enabled_tools"


def test_run_endpoints_execute_and_return_events(tmp_path: Path) -> None:
    client = build_client()

    create_response = client.post(
        "/runs",
        json={
            "user_input": "Inspect this repo.",
            "workspace_root": str(tmp_path),
        },
    )
    run_id = create_response.json()["id"]

    get_response = client.get(f"/runs/{run_id}")
    events_response = client.get(f"/runs/{run_id}/events")
    list_response = client.get("/runs")

    assert create_response.status_code == 202
    assert get_response.status_code == 200
    assert events_response.status_code == 200
    assert list_response.status_code == 200
    assert get_response.json()["status"] == "completed"
    assert get_response.json()["result"]["final_message"]["content"] == "Done"
    event_types = [event["event_type"] for event in events_response.json()]
    assert event_types[0] == "run.queued"
    assert "model.response" in event_types
    assert "tool.finished" in event_types
    assert event_types[-1] == "run.completed"
    assert get_response.json()["diagnostics"]["model_call_count"] == 2
    assert list_response.json()[0]["id"] == run_id


def test_run_endpoint_persists_provider_and_model(tmp_path: Path) -> None:
    client = build_client()

    create_response = client.post(
        "/runs",
        json={
            "user_input": "Inspect this repo.",
            "workspace_root": str(tmp_path),
            "provider": "siliconflow",
            "model": "deepseek-ai/DeepSeek-V4-Flash",
        },
    )
    run_id = create_response.json()["id"]
    get_response = client.get(f"/runs/{run_id}")

    assert create_response.status_code == 202
    assert create_response.json()["provider"] == "siliconflow"
    assert create_response.json()["model"] == "deepseek-ai/DeepSeek-V4-Flash"
    assert get_response.status_code == 200
    assert get_response.json()["provider"] == "siliconflow"
    assert get_response.json()["model"] == "deepseek-ai/DeepSeek-V4-Flash"


def test_run_endpoints_return_404_for_missing_run() -> None:
    client = build_client()

    get_response = client.get("/runs/missing")
    events_response = client.get("/runs/missing/events")

    assert get_response.status_code == 404
    assert events_response.status_code == 404


def test_run_cancel_endpoint_cancels_queued_run_and_returns_events(tmp_path: Path) -> None:
    runtime = build_runtime()
    run = anyio.run(
        runtime.create_run,
        CreateRunRequest(user_input="cancel me", workspace_root=str(tmp_path)),
    )
    client = build_client(runtime=runtime)

    cancel_response = client.post(f"/runs/{run.id}/cancel")
    get_response = client.get(f"/runs/{run.id}")
    events_response = client.get(f"/runs/{run.id}/events")

    assert cancel_response.status_code == 200
    assert cancel_response.json()["status"] == "cancelled"
    assert cancel_response.json()["failure_reason"] == "cancelled_by_user"
    assert get_response.json()["status"] == "cancelled"
    event_types = [event["event_type"] for event in events_response.json()]
    assert "run.cancel_requested" in event_types
    assert event_types[-1] == "run.cancelled"


def test_run_cancel_endpoint_returns_404_for_missing_run() -> None:
    client = build_client()

    response = client.post("/runs/missing/cancel")

    assert response.status_code == 404


def test_run_cancel_endpoint_returns_409_for_terminal_run(tmp_path: Path) -> None:
    client = build_client()
    create_response = client.post(
        "/runs",
        json={
            "user_input": "Inspect this repo.",
            "workspace_root": str(tmp_path),
        },
    )
    run_id = create_response.json()["id"]

    response = client.post(f"/runs/{run_id}/cancel")

    assert create_response.status_code == 202
    assert response.status_code == 409


def test_run_cancel_endpoint_requires_api_key_for_remote_request(tmp_path: Path) -> None:
    runtime = build_runtime()
    run = anyio.run(
        runtime.create_run,
        CreateRunRequest(user_input="cancel me", workspace_root=str(tmp_path)),
    )
    client = build_client(runtime=runtime, api_key="secret-key")

    response = client.post(
        f"/runs/{run.id}/cancel",
        headers={"x-forwarded-for": "8.8.8.8"},
    )

    assert response.status_code == 401


def test_repo_analyst_run_endpoints(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel(
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
        ),
        tool_registry_factory=build_registry,
    )
    client = build_client(runtime=runtime)

    create_response = client.post(
        "/repo-analyst/runs",
        json={
            "workspace_root": str(tmp_path),
            "question": "Analyze this repository",
        },
    )
    run_id = create_response.json()["id"]

    get_response = client.get(f"/repo-analyst/runs/{run_id}")
    events_response = client.get(f"/repo-analyst/runs/{run_id}/events")
    list_response = client.get("/repo-analyst/runs")
    raw_response = client.get(f"/repo-analyst/runs/{run_id}/raw")

    assert create_response.status_code == 202
    assert get_response.status_code == 200
    assert events_response.status_code == 200
    assert list_response.status_code == 200
    assert raw_response.status_code == 200
    assert get_response.json()["status"] == "completed"
    assert get_response.json()["report"]["summary"] == "A repository analysis tool"
    assert get_response.json()["report"]["modules"][0]["name"] == "runtime"
    assert get_response.json()["result"] is None
    assert "result" not in list_response.json()[0]
    assert raw_response.json()["result"]["final_message"]["content"].startswith(
        '{"summary"',
    )
    event_types = [event["event_type"] for event in events_response.json()]
    assert event_types[0] == "run.queued"
    assert "model.response" in event_types
    assert "tool.finished" in event_types
    assert event_types[-1] == "run.completed"
    assert all(event["payload"] == {} for event in events_response.json())


def test_repo_analyst_events_limit_and_payload_opt_in(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content='{"summary":"x"}')]),
        tool_registry_factory=build_registry,
    )
    client = build_client(runtime=runtime)
    run = anyio.run(
        runtime.create_run,
        CreateRunRequest(
            user_input="Analyze",
            workspace_root=str(tmp_path),
            app_name="repo_analyst",
        ),
    )
    for index in range(2, 7):
        anyio.run(
            runtime.store.append_event,
            run.id,
            RunEvent(
                index=index,
                type="custom",
                event_type="custom.event",
                payload={"large": "x" * 1000},
            ),
        )

    response = client.get(f"/repo-analyst/runs/{run.id}/events?limit=2")
    payload_response = client.get(
        f"/repo-analyst/runs/{run.id}/events?limit=1&include_payload=true&max_payload_chars=1000",
    )

    assert response.status_code == 200
    assert len(response.json()) == 2
    assert all(event["payload"] == {} for event in response.json())
    assert payload_response.status_code == 200
    assert payload_response.json()[0]["payload"]


def test_repo_analyst_review_run_endpoint(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel(
            [
                make_response(
                    content=(
                        '{"summary":"Review complete",'
                        '"changed_files":["src/example.py"],'
                        '"test_result":{"status":"passed","command":"python -m pytest",'
                        '"exit_code":0,"summary":"All tests passed"},'
                        '"findings":[],'
                        '"risks":["No major risk"],'
                        '"next_steps":["Proceed"]}'
                    ),
                ),
            ],
        ),
        tool_registry_factory=build_registry,
    )
    client = build_client(runtime=runtime)

    create_response = client.post(
        "/repo-analyst/runs",
        json={
            "workspace_root": str(tmp_path),
            "question": "Review recent changes",
            "mode": "review",
        },
    )
    run_id = create_response.json()["id"]

    get_response = client.get(f"/repo-analyst/runs/{run_id}")

    assert create_response.status_code == 202
    assert get_response.status_code == 200
    payload = get_response.json()
    assert payload["mode"] == "review"
    assert payload["report_type"] == "review"
    assert payload["report"] is None
    assert payload["review_report"]["summary"] == "Review complete"
    assert payload["review_report"]["test_result"]["status"] == "passed"


def test_repo_analyst_run_endpoint_returns_mode_tool_names(tmp_path: Path) -> None:
    enabled_tools = ("list_files", "read_file", "search_text", "run_command")
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel(
            [
                make_response(
                    content=(
                        '{"summary":"A repository analysis tool",'
                        '"modules":[{"name":"runtime","description":"Runs agents"}],'
                        '"architecture":["API -> runtime -> agent -> tools"],'
                        '"risks":["No major risk"],'
                        '"next_steps":["Proceed"]}'
                    ),
                ),
            ],
        ),
        tool_registry_factory=lambda: build_default_tool_registry(enabled_tools),
        tool_discovery_factory=lambda: build_default_tool_descriptors(enabled_tools),
    )
    client = build_client(runtime=runtime)

    create_response = client.post(
        "/repo-analyst/runs",
        json={
            "workspace_root": str(tmp_path),
            "mode": "overview",
        },
    )
    run_id = create_response.json()["id"]

    get_response = client.get(f"/repo-analyst/runs/{run_id}")

    assert create_response.status_code == 202
    assert get_response.status_code == 200
    assert get_response.json()["provider"] == "deepseek"
    assert get_response.json()["tool_names"] == [
        "list_files",
        "read_file",
        "search_text",
    ]


def test_repo_analyst_run_accepts_enabled_tools_override(tmp_path: Path) -> None:
    enabled_tools = ("list_files", "read_file", "search_text", "run_command")
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel(
            [
                make_response(
                    content=(
                        '{"summary":"A repository analysis tool",'
                        '"modules":[{"name":"runtime","description":"Runs agents"}],'
                        '"architecture":["API -> runtime -> agent -> tools"],'
                        '"risks":["No major risk"],'
                        '"next_steps":["Proceed"]}'
                    ),
                ),
            ],
        ),
        tool_registry_factory=lambda: build_default_tool_registry(enabled_tools),
        tool_discovery_factory=lambda: build_default_tool_descriptors(enabled_tools),
    )
    client = build_client(runtime=runtime)

    create_response = client.post(
        "/repo-analyst/runs",
        json={
            "workspace_root": str(tmp_path),
            "mode": "overview",
            "provider": "siliconflow",
            "model": "Qwen/Qwen2.5-Coder-32B-Instruct",
            "enabled_tools": ["list_files"],
        },
    )
    run_id = create_response.json()["id"]

    get_response = client.get(f"/repo-analyst/runs/{run_id}")

    assert create_response.status_code == 202
    assert get_response.status_code == 200
    assert get_response.json()["provider"] == "siliconflow"
    assert get_response.json()["model"] == "Qwen/Qwen2.5-Coder-32B-Instruct"
    assert get_response.json()["tool_names"] == ["list_files"]


def test_repo_analyst_run_rejects_unknown_provider(tmp_path: Path) -> None:
    client = build_client()

    response = client.post(
        "/repo-analyst/runs",
        json={
            "workspace_root": str(tmp_path),
            "provider": "unknown",
        },
    )

    assert response.status_code == 400
    assert "unknown model provider" in response.json()["detail"]


def test_repo_analyst_run_rejects_unknown_enabled_tools(tmp_path: Path) -> None:
    enabled_tools = ("list_files", "read_file", "search_text", "run_command")
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="unused")]),
        tool_registry_factory=lambda: build_default_tool_registry(enabled_tools),
        tool_discovery_factory=lambda: build_default_tool_descriptors(enabled_tools),
    )
    client = build_client(runtime=runtime)

    response = client.post(
        "/repo-analyst/runs",
        json={
            "workspace_root": str(tmp_path),
            "enabled_tools": ["missing_tool"],
        },
    )

    assert response.status_code == 400
    assert "unknown tools" in response.json()["detail"]


def test_repo_analyst_run_rejects_disabled_enabled_tools(tmp_path: Path) -> None:
    enabled_tools = ("list_files", "read_file", "search_text")
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="unused")]),
        tool_registry_factory=lambda: build_default_tool_registry(enabled_tools),
        tool_discovery_factory=lambda: build_default_tool_descriptors(enabled_tools),
    )
    client = build_client(runtime=runtime)

    response = client.post(
        "/repo-analyst/runs",
        json={
            "workspace_root": str(tmp_path),
            "mode": "review",
            "enabled_tools": ["run_command"],
        },
    )

    assert response.status_code == 400
    assert "disabled tools" in response.json()["detail"]


def test_repo_analyst_endpoints_return_404_for_missing_run() -> None:
    client = build_client()

    get_response = client.get("/repo-analyst/runs/missing")
    events_response = client.get("/repo-analyst/runs/missing/events")

    assert get_response.status_code == 404
    assert events_response.status_code == 404


def test_repo_analyst_cancel_endpoint_cancels_queued_run_and_returns_events(
    tmp_path: Path,
) -> None:
    runtime = build_runtime()
    service = RepoAnalystService(runtime)
    run = anyio.run(
        service.create_run,
        RepoAnalystRequest(workspace_root=str(tmp_path), question="Cancel this analysis"),
    )
    client = build_client(runtime=runtime)

    cancel_response = client.post(f"/repo-analyst/runs/{run.id}/cancel")
    get_response = client.get(f"/repo-analyst/runs/{run.id}")
    events_response = client.get(f"/repo-analyst/runs/{run.id}/events")

    assert cancel_response.status_code == 200
    assert cancel_response.json()["status"] == "cancelled"
    assert cancel_response.json()["failure_reason"] == "cancelled_by_user"
    assert get_response.json()["status"] == "cancelled"
    event_types = [event["event_type"] for event in events_response.json()]
    assert "run.cancel_requested" in event_types
    assert event_types[-1] == "run.cancelled"


def test_repo_analyst_cancel_endpoint_returns_404_for_missing_run() -> None:
    client = build_client()

    response = client.post("/repo-analyst/runs/missing/cancel")

    assert response.status_code == 404


def test_repo_analyst_cancel_endpoint_returns_409_for_terminal_run(
    tmp_path: Path,
) -> None:
    client = build_client()
    create_response = client.post(
        "/repo-analyst/runs",
        json={
            "workspace_root": str(tmp_path),
            "question": "Analyze this repository",
        },
    )
    run_id = create_response.json()["id"]

    response = client.post(f"/repo-analyst/runs/{run_id}/cancel")

    assert create_response.status_code == 202
    assert response.status_code == 409


def test_repo_analyst_invalid_report_returns_parse_diagnostics(tmp_path: Path) -> None:
    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="not-json")]),
        tool_registry_factory=build_registry,
    )
    client = build_client(runtime=runtime)

    create_response = client.post(
        "/repo-analyst/runs",
        json={
            "workspace_root": str(tmp_path),
            "question": "Analyze this repository",
        },
    )
    run_id = create_response.json()["id"]

    get_response = client.get(f"/repo-analyst/runs/{run_id}")

    assert create_response.status_code == 202
    assert get_response.status_code == 200
    assert get_response.json()["failure_reason"] == "invalid_repo_analyst_report_json"
    assert get_response.json()["parse_diagnostics"]["code"] == "invalid_json"


def test_repo_analyst_list_filters_out_generic_runs(tmp_path: Path) -> None:
    client = build_client()
    create_generic = client.post(
        "/runs",
        json={
            "user_input": "generic run",
            "workspace_root": str(tmp_path),
        },
    )

    response = client.get("/repo-analyst/runs")

    assert create_generic.status_code == 202
    assert response.status_code == 200
    assert response.json() == []


def test_api_key_allows_local_requests_without_header(tmp_path: Path) -> None:
    client = build_client(api_key="secret-key")

    response = client.post(
        "/runs",
        json={
            "user_input": "Inspect this repo.",
            "workspace_root": str(tmp_path),
        },
    )

    assert response.status_code == 202


def test_api_key_blocks_remote_request_without_key(tmp_path: Path) -> None:
    client = build_client(api_key="secret-key")

    response = client.post(
        "/runs",
        headers={"x-forwarded-for": "8.8.8.8"},
        json={
            "user_input": "Inspect this repo.",
            "workspace_root": str(tmp_path),
        },
    )

    assert response.status_code == 401


def test_api_key_blocks_remote_request_with_wrong_key(tmp_path: Path) -> None:
    client = build_client(api_key="secret-key")

    response = client.post(
        "/runs",
        headers={"x-forwarded-for": "8.8.8.8", "x-api-key": "wrong-key"},
        json={
            "user_input": "Inspect this repo.",
            "workspace_root": str(tmp_path),
        },
    )

    assert response.status_code == 401


def test_api_key_accepts_remote_request_with_valid_key(tmp_path: Path) -> None:
    client = build_client(api_key="secret-key")

    response = client.post(
        "/runs",
        headers={"x-forwarded-for": "8.8.8.8", "x-api-key": "secret-key"},
        json={
            "user_input": "Inspect this repo.",
            "workspace_root": str(tmp_path),
        },
    )

    assert response.status_code == 202


def test_workspace_root_outside_allowlist_returns_400(tmp_path: Path) -> None:
    allowed_root = tmp_path / "allowed"
    outside_root = tmp_path / "outside"
    allowed_root.mkdir()
    outside_root.mkdir()

    runtime = AgentRuntime(
        model_factory=lambda: FakeModel([make_response(content="Done")]),
        tool_registry_factory=build_registry,
        allowed_workspace_root=allowed_root,
    )
    client = build_client(runtime=runtime)

    response = client.post(
        "/runs",
        json={
            "user_input": "Inspect this repo.",
            "workspace_root": str(outside_root),
        },
    )

    assert response.status_code == 400
