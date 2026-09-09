# Coding Agent

[中文文档](README.zh-CN.md)

Coding Agent is a TypeScript/Node.js coding agent. It drives a streaming
agent loop over a permission-scoped workspace, persists sessions and tool
activity as an append-only event log, and exposes a web workspace for interactive
coding tasks. The repository was originally named `code-review-agent`; the
current product focuses on general coding workflows.

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
- The default SQLite API host wires bounded file-backed Session/Project Memory;
  Session Memory uses a restricted fallback extractor and Project Memory performs
  workspace/tenant-scoped `MEMORY.md` manifest and lexical recall with stale checks.
  The Skill registry, `SKILL.md` loader, catalog, SkillTool, local plugin bundle,
  and gated MCP Skill provider are implemented; model-facing SkillTool remains opt-in.
- Partial productization: JWT/principals, tenant sessions, credentials metadata,
  provider/model routing, SQLite backup/restore, and diagnostics.

## Current limitations

See [docs/status.zh-CN.md](docs/status.zh-CN.md) for the maintained status. The
most important gaps are end-to-end browser authentication, remote workspace
root allowlisting, uniform OS/container execution isolation, public projection
redaction and artifact ACLs, and a structured Git branch/commit/PR delivery loop.
RBAC, fine-grained quotas,
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
model is used. Sessions default to `apps/api/.data/coding-agent.sqlite` in a
source checkout, or `/app/.data/coding-agent.sqlite` in the container image.
If only an existing `code-review-agent.sqlite` is present in that data
directory, it is reused without copying or modifying it.

For Docker, set `CODING_AGENT_WORKSPACE_HOST_ROOT` and run:

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
| `CODING_AGENT_DB_PATH` | SQLite database path |
| `CODING_AGENT_PWSH` | Optional Windows PowerShell executable for the `pwsh` tool |
| `CODING_AGENT_PORT` | Docker host port; default `3210` |
| `CODING_AGENT_WORKSPACE_HOST_ROOT` | Docker workspace bind source; default `.` |

## Naming migration

The active product, private workspace scope, MCP client identity, Docker
service/image, and health response are now `coding-agent` / `Coding Agent`.
The legacy `CODE_REVIEW_AGENT_DB_PATH`, `CODE_REVIEW_AGENT_PWSH`,
`CODE_REVIEW_AGENT_PORT`, and `CODE_REVIEW_WORKSPACE_HOST_ROOT` variables are
accepted as fallbacks during migration; the `CODING_AGENT_*` variables win when
both are set. Docker retains the old named data volume for this release so an
existing local SQLite database remains attached.

The `@code-review-agent/*` workspace scope was private and has changed to
`@coding-agent/*`. Downstream users of a source checkout should update imports
in the same change. Deployments that configure a JWT audience explicitly should
move its value from `code-review-agent` to `coding-agent` together with their
identity-provider configuration.

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
