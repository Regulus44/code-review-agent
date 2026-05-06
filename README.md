# Code Review Agent

[中文文档](README.zh-CN.md)

Code Review Agent is a small but deployable agent runtime for repository
analysis and code review. It combines model providers, tool calling, workspace
guardrails, persistent sessions, runtime events, diagnostics, and a built-in web
UI into one local-first service.

The project is intended to demonstrate more than "calling an LLM with tools":
it exposes an Agent-as-a-Service API, persists run/session history in SQLite,
records observable model/tool events, and provides a repo-focused agent
application on top of the shared runtime.

## Current Capabilities

- Provider-neutral chat model interface.
- OpenAI-compatible adapters for DeepSeek, SiliconFlow, and MiMo.
- ReAct-style agent loop with tool calling.
- Tool registry with schema export and per-run tool filtering.
- Built-in repository tools:
  - `list_files`
  - `read_file`
  - `search_text`
  - `run_command`
- Minimal command sandbox:
  - workspace-bound working directory
  - allowlisted commands
  - timeout control
  - output truncation
  - no shell string execution
- Context manager for large tool histories and prompt-size control.
- Consecutive tool-error circuit breaker in the agent loop.
- Runtime lifecycle:
  - queued
  - running
  - completed
  - failed
  - cancelled
  - max_iterations
  - model_output_truncated
- SQLite-backed runtime and session storage.
- Runtime events, turn events, and diagnostics for observability.
- Persistent multi-turn sessions.
- Structured Repo Analyst app for repository overview and review reports.
- FastAPI service.
- Built-in single-page web UI.

## Architecture

```text
FastAPI / Web UI
        |
        v
Runtime services
  - AgentRuntime
  - SessionService
  - RepoAnalystService
        |
        v
Agent harness
  - Agent loop
  - Context manager
  - Session history
        |
        +------------------+
        |                  |
        v                  v
Model providers        Tool registry
  - DeepSeek             - list_files
  - SiliconFlow          - read_file
  - MiMo                 - search_text
                         - run_command
```

The runtime does not depend on a specific application. Repo Analyst is built as
one app facade on top of the generic runtime. Session APIs use the same agent
loop for continuous, chat-driven repository work.

## Installation

Requirements:

- Python 3.10+
- A model API key for at least one configured provider
- Optional: `ripgrep` for faster `search_text`; Python fallback is available

Create an environment and install the project:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

On Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
```

Create a local `.env` file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Do not commit `.env`. It should contain local API keys and deployment-specific
paths.

## Configuration

Common `.env` values:

```env
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com

SILICONFLOW_API_KEY=
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_MODEL=Qwen/Qwen2.5-Coder-32B-Instruct

MIMO_API_KEY=
MIMO_BASE_URL=https://api.xiaomi.com
MIMO_MODEL=mimo-v2.5-pro

DEFAULT_PROVIDER=deepseek
DEFAULT_MODEL=deepseek-chat

API_KEY=
RUNTIME_WORKSPACE_ROOT=/path/to/allowed/workspaces
DATABASE_URL=sqlite:///./runtime.db

RUN_TIMEOUT_SECONDS=300
MODEL_REQUEST_TIMEOUT_SECONDS=180
MAX_CONCURRENT_RUNS=4

ENABLED_TOOLS=list_files,read_file,search_text,run_command
```

Important settings:

- `RUNTIME_WORKSPACE_ROOT` is the root allowlist for repository access. Runs and
  sessions must use a `workspace_root` under this directory.
- `DATABASE_URL` defaults to local SQLite.
- `API_KEY` is required for non-local requests when configured. Local loopback
  requests are allowed without the header for local development.
- `ENABLED_TOOLS` controls globally enabled built-in tools. Leave it unset to
  enable all built-in tools, set a comma-separated list to expose only selected
  tools, or set it empty to disable all tools.
- `MODEL_REQUEST_TIMEOUT_SECONDS` controls one provider HTTP request timeout.
  Large review turns may need a larger value.

## Start the Service

```bash
uvicorn code_review_agent.api.app:create_app --factory --reload
```

Then open:

```text
http://127.0.0.1:8000/
```

Health check:

```bash
curl http://127.0.0.1:8000/health
```

## Web UI

The built-in UI is a local, single-page workspace for persistent sessions.

It supports:

- session list and chat workspace
- provider and model selection
- repository workspace binding
- tool permission selection
- optimistic user messages
- markdown rendering for assistant replies
- turn status summaries
- collapsible tool timelines
- turn cancellation and session deletion

The UI is intentionally lightweight and does not require a frontend build step.

## API Overview

Public endpoints:

- `GET /`
- `GET /health`

Discovery:

- `GET /tools`
- `GET /models/providers`

Generic runtime runs:

- `GET /runs`
- `POST /runs`
- `GET /runs/{run_id}`
- `GET /runs/{run_id}/events`
- `POST /runs/{run_id}/cancel`

Repo Analyst app:

- `POST /repo-analyst/runs`
- `GET /repo-analyst/runs`
- `GET /repo-analyst/runs/{run_id}`
- `GET /repo-analyst/runs/{run_id}/raw`
- `GET /repo-analyst/runs/{run_id}/events`
- `POST /repo-analyst/runs/{run_id}/cancel`

Persistent sessions:

- `POST /sessions`
- `GET /sessions`
- `GET /sessions/{session_id}`
- `DELETE /sessions/{session_id}`
- `POST /sessions/{session_id}/turns`
- `GET /sessions/{session_id}/turns`
- `POST /sessions/{session_id}/turns/{turn_id}/cancel`
- `GET /sessions/{session_id}/turns/{turn_id}/events`
- `GET /sessions/{session_id}/turns/{turn_id}/diagnostics`
- `GET /sessions/{session_id}/messages`

If `API_KEY` is configured and the request is not from loopback, send:

```text
X-API-Key: your_api_key
```

## Repo Analyst Example

Create an overview run:

```bash
curl -X POST http://127.0.0.1:8000/repo-analyst/runs \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_root": "/path/to/repository",
    "mode": "overview",
    "question": "Analyze the main purpose, modules, architecture, risks, and next steps.",
    "provider": "deepseek",
    "model": "deepseek-chat",
    "max_iterations": 100
  }'
```

Create a review run:

```bash
curl -X POST http://127.0.0.1:8000/repo-analyst/runs \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_root": "/path/to/repository",
    "mode": "review",
    "question": "Review recent code changes and check whether tests pass.",
    "enabled_tools": ["list_files", "read_file", "search_text", "run_command"],
    "provider": "deepseek",
    "model": "deepseek-chat",
    "max_iterations": 100
  }'
```

Check the result and event stream:

```bash
curl http://127.0.0.1:8000/repo-analyst/runs/<run_id>
curl http://127.0.0.1:8000/repo-analyst/runs/<run_id>/events
```

## Session Example

Create a session:

```bash
curl -X POST http://127.0.0.1:8000/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_root": "/path/to/repository",
    "provider": "deepseek",
    "model": "deepseek-chat",
    "max_iterations": 100
  }'
```

Start a turn:

```bash
curl -X POST http://127.0.0.1:8000/sessions/<session_id>/turns \
  -H "Content-Type: application/json" \
  -d '{
    "user_input": "Review the recent changes and identify concrete issues."
  }'
```

Inspect messages and diagnostics:

```bash
curl http://127.0.0.1:8000/sessions/<session_id>/messages
curl http://127.0.0.1:8000/sessions/<session_id>/turns/<turn_id>/diagnostics
curl http://127.0.0.1:8000/sessions/<session_id>/turns/<turn_id>/events
```

## Tools and Safety Model

The runtime exposes tools through explicit schemas. Tools are registered in a
registry and can be filtered by global environment configuration, application
mode, and per-run request payload.

File tools are workspace-bound:

- absolute paths are rejected
- `..` traversal is rejected
- paths are resolved under the configured workspace root

`run_command` is intentionally limited:

- uses `asyncio.create_subprocess_exec(..., shell=False)`
- accepts structured `program + args`, not shell strings
- enforces an allowlist
- rejects shell control operators
- enforces timeout and output truncation
- treats non-zero exit code as a successful observation, not a tool transport
  failure

This is not a Docker sandbox. It is a local command sandbox suitable for a
controlled development environment.

## Observability and Diagnostics

Runs and session turns record events such as:

- lifecycle changes
- model request and response
- tool started and finished
- cancellation
- failure details

Diagnostics summarize:

- total latency
- model call count
- tool call count
- event count
- token usage when provider data is available
- slowest model/tool steps
- failure reason

These events are available through API endpoints and are used by the web UI to
render turn timelines.

## Development

Run tests:

```bash
python -m pytest
```

Run focused tests:

```bash
python -m pytest tests/test_agent_loop.py
python -m pytest tests/test_context_manager.py
python -m pytest tests/test_session_api.py
```

Check the inline web script syntax:

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('src/code_review_agent/web/index.html','utf8');for(const m of h.matchAll(/<script[^>]*>([\\s\\S]*?)<\\/script>/gi)) new Function(m[1]);console.log('ok')"
```

## Current Limitations

- Streaming model output is not implemented.
- Command sandboxing is allowlist-based and local-process-based, not container
  isolation.
- Context management uses conservative character budgets rather than provider
  tokenizers.
- Repo Analyst structured output still depends on model compliance plus parser
  validation.
- The web UI is a single HTML file and intentionally avoids a frontend build
  system.
- SQLite is intended for single-instance local deployment.

## Repository Layout

```text
src/code_review_agent/
  api/              FastAPI app and routes
  apps/repo_analyst Structured repository analysis app
  context/          Prompt/context compaction
  formatters/       Provider payload formatting
  harness/          Agent loop and run result types
  messages/         Internal message and tool-call types
  models/           Model interfaces and provider adapters
  observability/    Event and diagnostics helpers
  runtime/          Run/session runtime services
  sandbox/          Workspace path and command policy checks
  session/          Session types and interfaces
  storage/          SQLite runtime/session stores
  tools/            Tool abstractions and built-in tools
  web/              Built-in single-page UI
```
