# Code Review Agent

[English README](README.md)

Code Review Agent 是一个 TypeScript 实现的 Coding Agent Runtime。它在本地
workspace 上运行流式 Agent Loop，把每个 Session 以 append-only 事件日志的
形式持久化到 SQLite，并提供 DSH 风格的 Web 工作台用于交互式编码会话。
仓库只保留当前 TypeScript Runtime、Web host、公共契约、工具、测试和产品
文档。

开发按 `docs/coding-agent-migration-plan.zh-CN.md` 中的阶段计划推进，阶段
状态和验收证据记录在 `docs/phase-status.zh-CN.md`。

## 当前能力

### 流式 Agent Loop

- turn → step → model → tool 执行；工具结果作为上下文返回给模型的后续
  step。
- DeepSeek 通过 OpenAI-compatible 流式 adapter 接入；未配置 API key 时回退
  到本地 Echo 模型。
- 运行时模型切换，可选 `deepseek-v4-flash`、`deepseek-v4-pro`、
  `deepseek-v4-flash-vision-exp`。
- 并行工具调用、max step 限制、取消、malformed tool call 处理。
- 分层 system prompt，按 identity、task execution、tool use、workspace、
  permission、safety、verification、communication、recovery 分 section
  组装。每个 turn 注入真实 workspace 根路径和经过 policy 过滤的工具列表及
  风险/审批/调度元数据。

### 事件驱动的 Session

- 所有状态变更以单调递增 sequence 追加到 SQLite event store。
- Session、message、task、goal、permission、plan、todo、terminal、job 的 projection
  在启动时从事件重建。
- SSE 通过 `after_sequence` / `Last-Event-ID` 补发，replay 期间缓冲实时
  事件并按 sequence 去重。
- 进程重启恢复：interrupted turn、pending permission 审批全部解决后继续原
  turn、interrupted terminal 只恢复元数据。
- send / cancel / resume / fork 命令幂等，每个 Session 有独立 turn 队列。

### 工具与权限

内置工具统一注册在 `ToolRegistry`，并通过同一个 `ToolRuntime` 执行：

- 文件：`read_file`、`glob`、`grep`、`edit_file`、`write_file`（覆盖已有
  文件需要显式开启）、`delete_file`（默认移入 `.agent-trash`）
- Git 只读：`git_status`、`git_diff`、`git_log`、`git_show`
- 进程：`run_command`、`run_tests`（argv + 可执行文件白名单，拒绝 shell
  字符串），显式 `bash` / `pwsh` fresh-shell 工具，以及持久终端 `terminal_open` / `terminal_send` /
  `terminal_read` / `terminal_signal` / `terminal_close` / `terminal_list`
- 后台任务：`job_output`、`job_kill`、`job_list`；job 受 session/workspace
  隔离、权限、取消和 `job/*` 事件审计约束。
- 交互与计划：`ask_user`、`plan`、`todo_write`
- 长任务与恢复：`create_goal`、`update_goal`、`get_goal`、`session_query`；job 元数据从事件恢复，重启后不会伪造仍存活的进程
- 可选只读能力：能力开关打开时提供 `read_image` 和配置的 `lsp_diagnostics` / `lsp_definition` / `lsp_references`
- 扩展能力边界：`capability_status` 展示 Web/Skill/Subagent/Workflow 的 host policy；这些扩展默认关闭，不能通过 prompt 自行启用

`ToolRuntime` 负责 JSON schema 校验、workspace 路径解析、风险级别
（`read` / `write` / `execute` / `network`）、审批模式、permission preset
（`read-only`、`workspace-write`、`ask-on-write`、`ask-on-execute`、
`danger-full-access`）、超时、输出预算、取消和跨平台进程树终止。每个结果
保留完整审计记录，同时生成受预算限制的 model view。文件编辑生成 diff
preview。

### MCP Client

- 基于官方 MCP TypeScript SDK 支持 stdio、SSE 兼容和 Streamable HTTP
  transport。
- 发现 tools、resources、prompts，并响应 list-changed 重新同步。
- MCP 工具以 `mcp__<server>__<tool>` 注册，和内置工具共享同一套权限、审批、
  取消、超时和审计管线。
- 支持 server enable / disable / reconnect；连接失败只影响对应 server。
- server secret 不进入事件、projection 和 API 响应。

### Web 工作台

- DSH 风格三栏布局：session 侧栏、会话列、session 详情面板。
- Workspace picker，在创建 Session 前验证本地目录。
- 流式 transcript、工具调用/进度/结果行、diff 卡片、权限审批卡片
  （Approve / Deny / Cancel）、`ask_user` 交互卡片、MCP server 状态和重连
  操作。
- SSE 断线重连和事件回放；UI 状态完全从事件重建。

## 架构

```text
浏览器 (apps/web)
    |  REST 命令 + SSE 事件
    v
Node HTTP API (apps/api)
    |
    v
AgentHost / SessionService (packages/runtime)
    |  turn -> step -> model -> tool
    +------------------+-------------------+
    |                                      |
    v                                      v
ChatModel adapter (packages/llm)   ToolRuntime (packages/tools)
  - DeepSeek 流式                    - 内置工具
  - Echo fallback                    - MCP 桥接 (packages/mcp-client)
    |                                      |
    +------------------+-------------------+
                       v
      EventStore + projection (packages/storage, SQLite)
```

事件先写入 store，再广播到 SSE。Web UI 的全部状态由事件推导。

## 目录结构

```text
packages/
  contracts/    事件、工具、任务和模型的公共类型
  llm/          provider-neutral chat model 和 OpenAI-compatible adapter
  runtime/      AgentHost、turn/step 执行、system prompt
  storage/      SQLite event store 和 projection
  tools/        ToolRegistry、ToolRuntime、permission policy、内置工具
  workspace/    workspace 路径解析和 fs/进程边界
  mcp-client/   MCP 配置、transport、discovery、工具桥接
apps/
  api/          Node HTTP/SSE host；同时托管 Web UI
  web/          静态 DSH 风格 Web 工作台
docs/                    计划、契约、开发日志
```

## 环境要求

- Node.js >= 22.19
- pnpm（`packageManager` 字段固定 pnpm 11）
- 可选：DeepSeek API key，用于真实模型调用；Echo 模型无需任何 key

## 快速开始

```bash
pnpm install
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

使用 DeepSeek 时在，在 `.env` 中填写 `DEEPSEEK_API_KEY`。key 只保存在
本机，`.env` 已被 Git 忽略。

启动 API：

```bash
pnpm dev:api
```

然后打开 `http://127.0.0.1:3210/`。服务绑定 `127.0.0.1`，`PORT` 可修改
端口。

Session 持久化到工作目录下的 `.data/code-review-agent.sqlite`。

如需使用容器运行，先将 `.env.example` 复制为 `.env`，把
`CODE_REVIEW_WORKSPACE_HOST_ROOT` 设置为需要暴露给 Agent 的本机目录，然后执行：

```bash
docker compose up --build
```

挂载后的 workspace 在容器内使用 `/workspaces/project`。

## 配置

TypeScript API 读取的 `.env` 配置：

| 键 | 说明 |
|---|---|
| `MODEL_PROVIDER` | `auto`（默认）、`deepseek` 或 `echo`。`auto` 在设置了 `DEEPSEEK_API_KEY` 时选择 DeepSeek，否则回退 Echo。 |
| `DEEPSEEK_API_KEY` | DeepSeek API key。 |
| `DEEPSEEK_BASE_URL` | 默认 `https://api.deepseek.com`。 |
| `DEEPSEEK_MODEL` | 默认模型，默认 `deepseek-v4-flash`。 |
| `PORT` | API 端口，默认 `3210`。 |
| `CODE_REVIEW_AGENT_DB_PATH` | SQLite 数据库路径，默认使用 API 包的 `.data` 目录。 |

当前运行时限制（阶段 1–5 基线）：

| 项目 | 默认值 | 允许范围/硬上限 |
|---|---:|---:|
| Anthropic-compatible 单次输出 | `32000` tokens | 请求最多 `64000`，同时受模型自身上限校验 |
| 未声明模型 context fallback | `200000` input / `64000` output / `32000` default | 默认 effective window `180000` |
| Agent step | `32` | `1–512` |
| Summary 正文 | `8192` 字符 | 由 summary compact 配置控制 |
| 单工具结果 artifact | `50000` 字符或 `100000` tokens 触发 | model view 预览最多 `2000` UTF-8 bytes |
| 单消息工具结果聚合 | `200000` 字符 | 超出部分使用稳定 artifact replacement |
| 时间型 microcompact | 默认关闭 | 启用时 gap `60` 分钟、保留最近 `5` 个结果 |
| 并行工具调用 | `10` 个 in-flight | Host 配置 `1–512`，`1` 可退化为串行 |

运行时诊断通过 `GET /v1/capabilities` 查看 context、tool execution 和其他能力投影；每个
`step/started` 事件包含实际 context budget、warning 和工具结果预算诊断。完整工具原文
保存在 Session workspace 的 `.agent-artifacts/tool-results/<session>/<toolCallId>.(txt|json)`，
模型只接收受限预览或 replacement reference。

## API 概览

健康检查和发现：

- `GET /health`
- `GET /v1/models`、`POST /v1/models`
- `GET /v1/tools`

Session：

- `POST /v1/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/{session_id}`
- `POST /v1/sessions/{session_id}` — 发送消息并启动 turn
- `GET /v1/sessions/{session_id}/events` — SSE 流，支持 `after_sequence` 和
  `Last-Event-ID`
- `POST /v1/sessions/{session_id}/resume`
- `POST /v1/sessions/{session_id}/cancel`
- `POST /v1/sessions/{session_id}/fork`
- `POST /v1/sessions/{session_id}/permissions/{permission_id}` — 解决
  pending 审批
- `POST /v1/sessions/{session_id}/interactions/{interaction_id}` — 回答
  `ask_user` 请求
- `POST /v1/sessions/{session_id}/tools` — 直接执行工具
- `POST /v1/sessions/{session_id}/tools/{tool_call_id}/cancel`

Workspace：

- `POST /v1/workspaces/validate`

MCP server：

- `GET /v1/mcp/servers`、`POST /v1/mcp/servers`
- `GET /v1/mcp/servers/{server_id}`、`DELETE /v1/mcp/servers/{server_id}`
- `POST /v1/mcp/servers/{server_id}/enable`
- `POST /v1/mcp/servers/{server_id}/disable`
- `POST /v1/mcp/servers/{server_id}/reconnect`
- `GET /v1/mcp/servers/{server_id}/resources`
- `POST /v1/mcp/servers/{server_id}/prompts`

## 开发

```bash
pnpm typecheck   # 全 workspace tsc 构建
pnpm test        # 全 package vitest 测试
```

参考文档：

- `docs/coding-agent-migration-plan.zh-CN.md` — 改造总计划
- `docs/phase-status.zh-CN.md` — 当前阶段状态和验收证据
- `docs/event-contract.md`、`docs/tool-contract.md` — 事件和工具契约
- `docs/protocol-boundaries.md` — MCP / ACP / A2A 边界定义
- `docs/development-log/` — 各阶段开发日志

## 路线图

| 阶段 | 范围 | 状态 |
|---|---|---|
| 0 | TypeScript 基线、契约、治理文档 | 已完成 |
| 1 | AgentHost 与 Agentic Coding Core：tool-calling loop、P0/P1 工具、permission preset、重启恢复、真实 DeepSeek read → edit → approve → test smoke | 已完成 |
| 2 | 事件持久化与恢复：SQLite event store、projection、SSE replay、幂等命令 | 已完成 |
| 3 | 工具运行时与权限：registry、policy、安全硬化 | 已完成 |
| 4 | MCP Client：stdio/SSE/Streamable HTTP、discovery、registry 桥接 | 已完成 |
| 5 | 内部 Subagent / 多 Agent 任务委派 | 已完成 |
| 6 | A2A 互操作适配层 | 暂缓，不阻塞 Phase 7 |
| 7 | DSH 风格 Web 前端收敛 | 进行中 |
| 8 | 产品化：worktree、LSP、code mode、后台任务、定时任务、模型回退、session fork/replay/export、多用户认证、桌面端 | 待开始 |

Phase 7 近期工作：把 Diff、Terminal、Permission、Subagent 和 MCP 详情视图
抽成可复用组件，补充窄屏和 SSE 断线重连的浏览器回归，并评估把静态 shell
迁移到 TypeScript UI package，同时保持 API contract 稳定。

Phase 5 已在现有事件、工具和任务契约之上完成 `SubagentRuntime`、
parent/child 生命周期、task/report contract、并发/深度/预算限制和
API/Web catalog。Phase 6 A2A 暂缓，只有出现明确的外部 Agent
互操作需求后才重新开启；当前 Phase 7 直接完善内部 Agent 的 Web
工作台、工具展示和可见运行轨迹。
