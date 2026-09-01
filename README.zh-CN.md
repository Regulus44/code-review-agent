# Coding Agent

[English README](README.md)

Coding Agent 是一个基于 TypeScript/Node.js 的 Coding Agent。它通过 Web
工作台驱动流式 Agent Loop，在受权限控制的 workspace 中读取、修改、验证代码，
并使用 append-only EventStore 持久化 Session、工具、权限和任务状态。

当前文档入口：

- [文档导航](docs/README.zh-CN.md)
- [当前状态、限制与优先级](docs/status.zh-CN.md)
- [长期开发规则](AGENTS.md)

## 当前能力

### Agent Runtime

- turn → step → model → tool 的流式循环；支持并行工具、取消、错误处理和恢复。
- DeepSeek OpenAI-compatible 流式 adapter；未配置 API key 时使用本地 Echo fallback。
- 模型目录、运行时模型切换、provider/model routing 和 bounded context budget。
- 分层 system prompt，向模型注入当前 workspace、工具策略、风险和审批信息。

### Session 与恢复

- SQLite append-only event store，事件具有单调 sequence、幂等和可回放语义。
- Session、message、turn、permission、interaction、plan、todo、terminal、job、task
  projection 从事件重建。
- SSE 断线重连和 `after_sequence` / `Last-Event-ID` replay。
- 进程重启后恢复可继续的 turn、pending permission、任务元数据和会话选择。

### 工具与权限

- 文件与搜索：`read_file`、`glob`、`grep`、`edit_file`、`write_file`、`delete_file`。
- Git 只读：`git_status`、`git_diff`、`git_log`、`git_show`；另有 worktree 生命周期管理。
- 命令与终端：`run_command`、`run_tests`、`bash`、`pwsh`、持久 Terminal 和后台 Job。
- 交互与计划：`ask_user`、`plan`、`todo_write`、Goal 和 Session query。
- 统一执行管线：schema 校验、workspace 检查、风险分类、审批、超时、取消、输出预算、
  structured result、diff preview 和审计。
- 权限 preset：`read-only`、`workspace-write`、`ask-on-write`、`ask-on-execute`、
  `workspace-full-access`、`danger-full-access`。

### MCP 与 Multi-Agent

- MCP stdio、SSE/HTTP、Streamable HTTP transport。
- tools/resources/prompts discovery、list-changed resync、enable/disable/reconnect。
- MCP 工具与内置工具共享权限、取消、超时、审计和 bounded model view。
- 内部 Subagent：parent/child Task 与 Session、one-shot/continuable child、background
  execution、report、artifact、取消、恢复、scoped replay 和显式工具/MCP scope。

### 上下文、Web 与产品化

- tool-result artifact、microcompact、summary compact、session/project memory、context
  recovery 和 token diagnostics。
- 基础 LSP（diagnostics、definition、references）以及图片读取能力。
- DSH 风格三栏 Web 工作台：Conversation、Trajectory、Tool、Diff、Permission、Interaction、
  Task/Subagent、MCP、Settings 和 Produced Files。
- 已有 JWT/principal、tenant session、credential metadata、provider/model routing、SQLite
  backup/restore 和诊断指标等产品化基础。

## 当前限制

当前状态和风险详见 [docs/status.zh-CN.md](docs/status.zh-CN.md)。主要限制包括：

- Web 端认证尚未完全贯通，Bearer/JWT、登录、refresh、logout 和认证 SSE 仍需收敛；
- 远程 workspace root allowlist 和统一 OS/container 执行隔离仍需加强；
- 公共 projection/SSE 与内部审计结果需要更严格的脱敏和 artifact ACL；
- Code Review findings、baseline、inline comment、SARIF 导出尚未形成独立领域能力；
- Git branch/commit/PR 结构化交付闭环尚未完成；
- RBAC、细粒度 quota、跨进程 Subagent、A2A 和完整插件运行时暂未落地。

## 架构

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

事件先写入 EventStore，再广播到 SSE；Web UI 从事件和 API projection 推导状态。

## 快速开始

环境要求：Node.js >= 22.19，pnpm 11。

```bash
pnpm install
cp .env.example .env
pnpm dev:api
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
pnpm dev:api
```

然后打开 `http://127.0.0.1:3210/`。不配置 `DEEPSEEK_API_KEY` 时使用 Echo
模型；配置 key 后可使用 DeepSeek。源码 checkout 默认持久化到
`apps/api/.data/coding-agent.sqlite`，容器镜像默认使用
`/app/.data/coding-agent.sqlite`。同一数据目录中只有旧
`code-review-agent.sqlite` 时，运行时会直接复用它，不复制也不改写数据。

容器运行：将 `CODING_AGENT_WORKSPACE_HOST_ROOT` 设置为要暴露给 Agent 的宿主目录，
然后执行：

```bash
docker compose up --build
```

容器内 workspace 路径为 `/workspaces/project`。

## 配置

| 变量 | 说明 |
|---|---|
| `MODEL_PROVIDER` | `auto`、`deepseek` 或 `echo`；默认 `auto` |
| `DEEPSEEK_API_KEY` | DeepSeek API key，仅保存在本机 `.env` |
| `DEEPSEEK_BASE_URL` | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 默认 `deepseek-v4-flash` |
| `PORT` | API 端口，默认 `3210` |
| `CODING_AGENT_DB_PATH` | SQLite 数据库路径 |
| `CODING_AGENT_PWSH` | `pwsh` 工具可选的 Windows PowerShell 可执行路径 |
| `CODING_AGENT_PORT` | Docker 宿主机端口，默认 `3210` |
| `CODING_AGENT_WORKSPACE_HOST_ROOT` | Docker workspace 挂载源，默认 `.` |

## 命名迁移

产品名称、私有 workspace scope、MCP client 标识、Docker service/image 和 health
response 已统一为 `Coding Agent` / `coding-agent`。迁移期间仍兼容读取
`CODE_REVIEW_AGENT_DB_PATH`、`CODE_REVIEW_AGENT_PWSH`、
`CODE_REVIEW_AGENT_PORT` 与 `CODE_REVIEW_WORKSPACE_HOST_ROOT`；同时设置新旧变量时，
`CODING_AGENT_*` 优先。Docker 在本次发布继续挂载原有命名 volume，因此本地已有的
SQLite 数据库会保持连接。

原有 `@code-review-agent/*` 是私有 workspace scope，现已改为
`@coding-agent/*`。使用源码 checkout 的下游项目需要在同一变更中更新 import。
若部署端显式配置 JWT audience，也应同步将 `code-review-agent` 改为
`coding-agent`，并更新 identity provider。

运行时 capability、context、tool execution 和 provider 信息可通过
`GET /v1/capabilities`、`GET /health` 和 `GET /v1/models` 查看。

## API 入口

- `GET /health`
- `GET /v1/capabilities`
- `GET /v1/models`、`POST /v1/models`
- `GET /v1/tools`
- `POST /v1/sessions`、`GET /v1/sessions`
- `GET /v1/sessions/{id}`、`POST /v1/sessions/{id}`
- `GET /v1/sessions/{id}/events`（SSE replay）
- `POST /v1/sessions/{id}/resume`、`cancel`、`fork`
- `POST /v1/sessions/{id}/permissions/{permissionId}`
- `POST /v1/sessions/{id}/interactions/{interactionId}`
- `POST /v1/sessions/{id}/tools`
- `GET/POST /v1/sessions/{id}/subagents`
- `GET /v1/sessions/{id}/tasks/{taskId}`、`output`、`cancel`
- `POST /v1/workspaces/validate`
- `/v1/mcp/servers` 及其 enable/disable/reconnect/resources/prompts 入口

## 开发与验证

```bash
pnpm typecheck
pnpm test
```

文档分类、契约和历史资料见 [docs/README.zh-CN.md](docs/README.zh-CN.md)。
历史 Phase 计划和阶段日志保存在 `docs/archive/`，不再定义当前开发顺序。
