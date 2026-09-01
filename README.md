# Code Review Agent

[中文文档](README.zh-CN.md)

Code Review Agent is a TypeScript/Node.js coding agent. It drives a streaming
agent loop over a permission-scoped workspace, persists sessions and tool
activity as an append-only event log, and exposes a web workspace for interactive
coding and review tasks.

Start with:

- [Documentation map](docs/README.md)
- [Current status and limitations](docs/status.zh-CN.md)
- [Long-term development rules](AGENTS.md)

## Current capabilities

- Streaming `turn → step → model → tool` runtime with cancellation, recovery,
  parallel tool calls, model routing, and bounded context handling.
- SQLite event store with monotonic sequences, idempotent commands, projections,
  SSE replay, reconnect, and restart recovery.
- Permissioned file, search, patch, Git-read, command, terminal, background-job,
  planning, and user-interaction tools.
- MCP stdio, SSE/HTTP, and Streamable HTTP transports with discovery,
  reconnect, policy, approval, cancellation, and audit integration.
- Internal Multi-Agent/Subagent runtime with durable parent/child Tasks and
  Sessions, one-shot or continuable children, reports, artifacts, cancellation,
  scoped replay, and explicit tool/MCP/permission scopes.
- Context compaction, tool-result artifacts, session/project memory, recovery,
  worktrees, basic LSP, and a DSH-style three-panel web workspace.
- Partial productization: JWT/principals, tenant sessions, credentials metadata,
  provider/model routing, SQLite backup/restore, and diagnostics.

## Current limitations

See [docs/status.zh-CN.md](docs/status.zh-CN.md) for the maintained status. The
most important gaps are end-to-end browser authentication, remote workspace
root allowlisting, uniform OS/container execution isolation, public projection
redaction and artifact ACLs, a first-class Code Review findings model, and a
structured Git branch/commit/PR delivery loop. RBAC, fine-grained quotas,
cross-process Subagents, A2A, and a full plugin runtime are not yet complete.

## Architecture

```text
Browser (apps/web)
    | REST commands + SSE events
    v
Node HTTP API (apps/api)
    |
    v
AgentHost / Session runtime (packages/runtime)
    | turn -> step -> model -> tool
    +----------------------+-------------------+
    |                                          |
    v                                          v
ChatModel adapters (packages/llm)       ToolRuntime (packages/tools)
  - DeepSeek streaming                    - built-in tools
  - Echo fallback                         - MCP bridge
    |                                          |
    +----------------------+-------------------+
                           v
             EventStore + projections (packages/storage)
```

Events are written to the store before they are broadcast over SSE; the web UI
derives its state from events and API projections.

## Getting started

Requirements: Node.js >= 22.19 and pnpm 11.

```bash
pnpm install
cp .env.example .env
pnpm dev:api
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
pnpm dev:api
```

Open `http://127.0.0.1:3210/`. Without `DEEPSEEK_API_KEY`, the local Echo
model is used. Sessions default to `.data/code-review-agent.sqlite` relative to
the API working directory.

For Docker, set `CODE_REVIEW_WORKSPACE_HOST_ROOT` and run:

```bash
docker compose up --build
```

The mounted workspace is available inside the container at
`/workspaces/project`.

## Configuration

| Variable | Meaning |
|---|---|
| `MODEL_PROVIDER` | `auto`, `deepseek`, or `echo`; default `auto` |
| `DEEPSEEK_API_KEY` | Local DeepSeek API key |
| `DEEPSEEK_BASE_URL` | Defaults to `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | Defaults to `deepseek-v4-flash` |
| `PORT` | API port; default `3210` |
| `CODE_REVIEW_AGENT_DB_PATH` | SQLite database path |

Use `GET /health`, `GET /v1/capabilities`, and `GET /v1/models` for runtime
discovery.

## Development and verification

```bash
pnpm typecheck
pnpm test
```

See [docs/README.md](docs/README.md) for contracts, architecture, evaluation
guidance, and historical archives. Phase plans and development logs under
`docs/archive/` are historical records and do not define the current order of
work.
