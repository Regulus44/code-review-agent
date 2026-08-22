# Code Review Agent

[中文文档](README.zh-CN.md)

Code Review Agent is a TypeScript coding-agent runtime. It drives a streaming
agent loop over a local workspace, persists every session as an append-only
event log in SQLite, and serves a DSH-style web workspace for interactive
coding sessions.

The project is evolving from an earlier Python repo-analysis prototype into a
web-based coding agent runtime. Active development follows the phased plan in
`docs/coding-agent-migration-plan.zh-CN.md`; phase status and acceptance
evidence live in `docs/phase-status.zh-CN.md`.

## Current Capabilities

### Streaming agent loop

- Turn → step → model → tool execution; tool results return to the model as
  context for subsequent steps.
- DeepSeek via an OpenAI-compatible streaming adapter, with a local Echo model
  fallback when no API key is configured.
- Runtime model switching between `deepseek-v4-flash`, `deepseek-v4-pro`, and
  `deepseek-v4-flash-vision-exp`.
- Parallel tool calls, max-step limits, cancellation, and malformed tool-call
  handling.
- Layered system prompt built from sections (identity, task execution, tool
  use, workspace, permission, safety, verification, communication, recovery).
  Every turn injects the actual workspace root and the policy-filtered tool
  list with risk/approval/execution metadata.

### Event-sourced sessions

- Every state change appends an event to a SQLite event store with a monotonic
  sequence number.
- Projections for sessions, messages, tasks, permissions, plans, todos, and
  terminals rebuild from events at startup.
- SSE replay via `after_sequence` / `Last-Event-ID`, with buffered live events
  during replay and sequence deduplication.
- Recovery across process restarts: interrupted turns, pending permission
  approvals that resume the original turn after resolution, and interrupted
  terminals restored as metadata only.
- Idempotent commands (send/cancel/resume/fork) and a per-session turn queue.

### Tools and permissions

Built-in tools registered in a shared `ToolRegistry` and executed through one
`ToolRuntime`:

- Files: `read_file`, `glob`, `grep`, `edit_file`, `write_file` (overwrite
  requires explicit opt-in), `delete_file` (moves to `.agent-trash` by
  default)
- Git read tools: `git_status`, `git_diff`, `git_log`, `git_show`
- Processes: `run_command`, `run_tests` (argv plus executable allowlist;
  shell strings are rejected), and the persistent terminal set
  `terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` /
  `terminal_close` / `terminal_list`
- Interaction and planning: `ask_user`, `plan`, `todo_write`

The `ToolRuntime` enforces JSON-schema validation, workspace path resolution,
risk levels (`read` / `write` / `execute` / `network`), approval modes,
permission presets (`read-only`, `workspace-write`, `ask-on-write`,
`ask-on-execute`, `danger-full-access`), timeouts, output budgets,
cancellation, and cross-platform process-tree termination. Each result keeps a
full audit record alongside a budget-limited model view. File edits produce
diff previews.

### MCP client

- stdio, SSE-compatible, and Streamable HTTP transports built on the official
  MCP TypeScript SDK.
- Discovery for tools, resources, and prompts, with list-changed resync.
- MCP tools register under `mcp__<server>__<tool>` and share the same
  permission, approval, cancellation, timeout, and audit pipeline as built-in
  tools.
- Server enable / disable / reconnect; connection failures stay scoped to the
  affected server.
- Server secrets stay out of events, projections, and API responses.

### Web workspace

- Three-panel DSH-style layout: session sidebar, conversation column, session
  details panel.
- Workspace picker that validates a local directory before creating a session.
- Streaming transcript, tool call/progress/result rows, diff cards, permission
  approval cards (Approve / Deny / Cancel), `ask_user` interaction cards, and
  MCP server status with reconnect controls.
- SSE reconnect and event replay; the UI rebuilds its state from events.

## Architecture

```text
Browser (apps/web)
    |  REST commands + SSE events
    v
Node HTTP API (apps/api)
    |
    v
AgentHost / SessionService (packages/runtime)
    |  turn -> step -> model -> tool
    +------------------+-------------------+
    |                                      |
    v                                      v
ChatModel adapters (packages/llm)   ToolRuntime (packages/tools)
  - DeepSeek streaming                - built-in tools
  - Echo fallback                     - MCP bridge (packages/mcp-client)
    |                                      |
    +------------------+-------------------+
                       v
      EventStore + projections (packages/storage, SQLite)
```

Events are written to the store first and then broadcast over SSE. The web UI
derives all state from events.

## Repository Layout

```text
packages/
  contracts/    shared event, tool, task, and model types
  llm/          provider-neutral chat model and OpenAI-compatible adapters
  runtime/      AgentHost, turn/step execution, system prompt
  storage/      SQLite event store and projections
  tools/        ToolRegistry, ToolRuntime, permission policy, built-in tools
  workspace/    workspace path resolution and fs/process boundaries
  mcp-client/   MCP config store, transports, discovery, tool bridge
apps/
  api/          Node HTTP/SSE host; also serves the web UI
  web/          static DSH-style web workspace
src/code_review_agent/   legacy Python prototype (reference only)
docs/                    plans, contracts, development logs
```

The TypeScript runtime has no dependency on `src/code_review_agent`. The
Python package remains in the repository as a behavior and test reference
during the migration.

## Requirements

- Node.js >= 22.19
- pnpm (the `packageManager` field pins pnpm 11)
- Optional: a DeepSeek API key for real model calls; the Echo model runs
  without any key

## Getting Started

```bash
pnpm install
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Set `DEEPSEEK_API_KEY` in `.env` to use DeepSeek. Keep the key local; `.env`
is ignored by Git.

Start the API:

```bash
pnpm dev:api
```

Then open `http://127.0.0.1:3210/`. The server binds to `127.0.0.1`; set
`PORT` to change the port.

Sessions persist to `.data/code-review-agent.sqlite` relative to the working
directory.

## Configuration

`.env` values read by the TypeScript API:

| Key | Meaning |
|---|---|
| `MODEL_PROVIDER` | `auto` (default), `deepseek`, or `echo`. `auto` selects DeepSeek when `DEEPSEEK_API_KEY` is set and falls back to Echo otherwise. |
| `DEEPSEEK_API_KEY` | DeepSeek API key. |
| `DEEPSEEK_BASE_URL` | Defaults to `https://api.deepseek.com`. |
| `DEEPSEEK_MODEL` | Default model; defaults to `deepseek-v4-flash`. |
| `PORT` | API port; defaults to `3210`. |

The remaining entries in `.env.example` belong to the legacy Python prototype
and are ignored by the TypeScript API.

## API Overview

Health and discovery:

- `GET /health`
- `GET /v1/models`, `POST /v1/models`
- `GET /v1/tools`

Sessions:

- `POST /v1/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/{session_id}`
- `POST /v1/sessions/{session_id}` — send a message and start a turn
- `GET /v1/sessions/{session_id}/events` — SSE stream; supports
  `after_sequence` and `Last-Event-ID`
- `POST /v1/sessions/{session_id}/resume`
- `POST /v1/sessions/{session_id}/cancel`
- `POST /v1/sessions/{session_id}/fork`
- `POST /v1/sessions/{session_id}/permissions/{permission_id}` — resolve a
  pending approval
- `POST /v1/sessions/{session_id}/interactions/{interaction_id}` — answer an
  `ask_user` request
- `POST /v1/sessions/{session_id}/tools` — execute a tool directly
- `POST /v1/sessions/{session_id}/tools/{tool_call_id}/cancel`

Workspaces:

- `POST /v1/workspaces/validate`

MCP servers:

- `GET /v1/mcp/servers`, `POST /v1/mcp/servers`
- `GET /v1/mcp/servers/{server_id}`, `DELETE /v1/mcp/servers/{server_id}`
- `POST /v1/mcp/servers/{server_id}/enable`
- `POST /v1/mcp/servers/{server_id}/disable`
- `POST /v1/mcp/servers/{server_id}/reconnect`
- `GET /v1/mcp/servers/{server_id}/resources`
- `POST /v1/mcp/servers/{server_id}/prompts`

## Development

```bash
pnpm typecheck   # tsc build across the workspace
pnpm test        # vitest suites across all packages
```

Reference documents:

- `docs/coding-agent-migration-plan.zh-CN.md` — overall migration plan
- `docs/phase-status.zh-CN.md` — current phase status and acceptance evidence
- `docs/event-contract.md`, `docs/tool-contract.md` — event and tool
  contracts
- `docs/protocol-boundaries.md` — MCP / ACP / A2A boundary definitions
- `docs/development-log/` — per-phase development logs

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | TypeScript baseline, contracts, governance docs | completed |
| 1 | AgentHost and agentic coding core: tool-calling loop, P0/P1 tools, permission presets, restart recovery, real DeepSeek read → edit → approve → test smoke | completed |
| 2 | Event persistence and recovery: SQLite event store, projections, SSE replay, idempotent commands | completed |
| 3 | Tool runtime and permissions: registry, policy, hardening | completed |
| 4 | MCP client: stdio/SSE/Streamable HTTP, discovery, registry bridge | completed |
| 5 | Internal subagents / multi-agent delegation | pending |
| 6 | A2A interoperability adapter | pending |
| 7 | DSH-style web frontend convergence | in progress |
| 8 | Productization: worktree, LSP, code mode, background jobs, scheduled tasks, model fallback, session fork/replay/export, multi-user auth, desktop wrapper | pending |

Near-term work in Phase 7: extract Diff, Terminal, Permission, Subagent, and
MCP detail views into reusable components, add narrow-screen and SSE
reconnect browser regressions, and evaluate moving the static shell into a
TypeScript UI package while keeping the API contract stable.

Phase 5 will add a `SubagentRegistry` with parent/child lifecycle, task and
report contracts, and concurrency/depth/budget limits, built on the existing
event, tool, and task contracts. Phase 6 will then add A2A as an adapter
layer (agent card discovery, task create/get/cancel, streaming updates)
mapped onto internal sessions.

## Legacy Python Prototype

`src/code_review_agent` contains the original Python implementation: a
FastAPI service, a structured repo-analysis app, SQLite-backed runs and
sessions, and a single-page web UI. It remains runnable via `pyproject.toml`
and `docker-compose.yml` and serves as a behavior and test reference. New
features are developed in the TypeScript packages.
