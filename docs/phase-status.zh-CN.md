# 阶段状态

本文记录当前开发阶段的实际状态。它不是长期架构决策；阶段完成以对应 Git checkpoint、测试命令和验收证据为准。

## 当前状态

| 阶段 | 状态 | Checkpoint/证据 |
|---|---|---|
| Phase 0：TypeScript 基线与契约 | completed | `codex/phase-0-typescript-foundation`；workspace、strict TS、contracts、依赖图检查通过 |
| Phase 1：Agentic Coding Core | in_progress（重新打开） | Web Shell checkpoint 已通过；tool-calling loop、permission resume 和真实 `read → edit → approve → test` 尚未通过 |
| Phase 2：事件、持久化与恢复 | completed | `a7f636f` + `5d5a198`；SQLite reopen/recovery、projection replay、SSE replay、queue、幂等 command 和 model failure 通过 |
| Phase 3：工具运行时与权限 | completed | `e1d3172`（替代 `5003dbd`）；工具禁用、显式覆盖、进程树终止、audit/modelView、权限过期/取消/重启恢复和 Web smoke 通过 |
| Phase 4：MCP Client | completed | `5477f16`；官方 SDK stdio/SSE/Streamable HTTP、discovery、ToolRegistry bridge、权限/取消/重连、API/Web MCP 状态和 fixture 验证通过 |
| Phase 5：内部 Subagent / 多 Agent | pending | 等 Phase 4 MCP 和 Task contract 稳定 |
| Phase 6：A2A | pending | 等 Phase 5 parent/child lifecycle 稳定 |
| Phase 7：DSH Web 前端收敛 | in_progress | DSH 三栏 Web 垂直切片 + Workspace Picker；类型检查、API 测试和浏览器 smoke 通过 |
| Phase 8：高级能力与产品化 | pending | 等前置阶段完成 |

## Phase 1 真实模型增强（2026-08-22）

Phase 1 的 provider-neutral adapter 现在已接入 API CLI 启动路径：通过根目录本地 `.env` 配置 `DEEPSEEK_API_KEY`，`MODEL_PROVIDER=auto` 会选择 DeepSeek；没有 Key 时保留 Echo fallback。默认模型为 `deepseek-v4-flash`，并可在 API/Web 中切换到 `deepseek-v4-pro` 或 `deepseek-v4-flash-vision-exp`。`.env`、`.env.*`（`.env.example` 除外）均被 Git 忽略，API health、事件和 Web 响应只展示不含凭据的 provider/model/configured 信息。fake-fetch API/LLM 测试已证明真实流式路径和 Authorization header 行为；Phase 1A.1–1A.3 已完成第一批 tool-calling loop，但真实 DeepSeek Coding smoke 尚未完成。

## Phase 1 状态校正（2026-08-22）

本次校正不是否定已完成的基础设施 checkpoint，而是把“产品可用”与“基础设施已存在”分开：

- `packages/tools` 已有 9 个内置工具，`ToolRuntime` 已有 schema、workspace、权限、取消、超时、输出预算和审计能力；
- `packages/mcp-client` 已能发现并桥接外部工具；
- 第一批 `packages/contracts`、`packages/llm` 和 `packages/runtime` 已携带工具 schema、解析 `delta.tool_calls` 并执行 model → tool → model 循环；进程重启后的 pending turn continuation 仍未完成；
- 当前 `packages/tools/src/builtin.ts` 的 9 个工具已经是 TypeScript 初版；旧 `src/code_review_agent/tools/` 仍是 Python legacy/reference，不进入新 Runtime 依赖图；
- 因此当前阶段目标改为 `Phase 1A：Agentic Core + TypeScript Tool Pool`，先完成工具调用层，再补齐 Terminal、Plan/Todo、AskUser 等核心 Coding Agent 工具和真实垂直场景；
- Phase 5 Subagent、Phase 6 A2A 和 Phase 8 高级能力的核心实现必须等待本门禁通过。

执行计划：[phase-1-agentic-coding-core.zh-CN.md](phase-plans/phase-1-agentic-coding-core.zh-CN.md)。

## Phase 1A 实现进展（2026-08-22）

本次 checkpoint 已完成 Phase 1A.1–1A.3 的第一批实现：

- `packages/contracts` 增加 provider-neutral tool call、tool result、tool schema、step event 和 content message 类型；
- `packages/llm` 请求会发送工具 schema，并解析 OpenAI/DeepSeek-compatible `delta.tool_calls`、参数增量和结束事件；
- `packages/runtime` 已能执行多 step model → tool → model 循环，工具结果会作为下一次模型上下文；
- permission ask 会暂停当前 turn，批准/拒绝后继续同一个 turn；
- 多工具上下文、tool-call replay 基础和 API/Web SSE step 事件订阅已补齐；
- 新增 LLM、Runtime、多 step、权限恢复和历史 tool context 测试。

尚未完成：真实 DeepSeek `read → edit → approve → test` smoke、进程重启后的 pending turn continuation，以及 Phase 1A.4 的 Terminal、AskUser、Plan/Todo、delete/git read 工具扩展。

## Phase 4 验收证据

### 自动化检查

```text
pnpm typecheck   ✓
pnpm test        ✓
git diff --check ✓
```

Phase 4 新增证据：

- `packages/mcp-client`：5 项测试，覆盖真实 stdio 子进程、Streamable HTTP、配置 secret 脱敏、tools/resources/prompts discovery、namespace/schema bridge、MCP error、ToolRuntime approval/cancel、统一事件和断线重连；
- `apps/api`：9 项测试，覆盖 MCP server 配置、列表、disable/delete、`/v1/tools` 来源字段、真实模型适配注入、模型切换和既有 Session/工具回归；
- `apps/web`：MCP server 状态侧栏、Reconnect/Enable/Disable 操作、MCP tool 来源卡片和 `mcp/*` 事件回放；
- 连接失败只影响对应 server，MCP provider 可以全部关闭，内置工具和既有 Session 保持可用。

### Phase 4 退出条件对照

- 至少一个 MCP server 可配置、发现、调用、取消和重连：真实 stdio/HTTP fixture 与 ToolRuntime 测试通过；
- MCP 工具与内置工具共享统一审计和事件：`tool/*`、`permission/*`、`mcp/*` 事件及 API/Web 回放通过；
- 外部工具不能绕过权限、超时、取消和输出预算：MCP approval/error/cancel 测试通过，默认未知 MCP 风险为 `network` 并由本地 policy 拒绝；
- 关闭所有 MCP provider 不影响现有功能：无 MCP 配置的 API/runtime 全量回归通过。

## Phase 2 验收证据

### 自动化检查

```text
pnpm typecheck   ✓
pnpm test        ✓
```

Phase 2 新增证据：

- `packages/storage`：SQLite schema migration、事务追加、projection 重建、跨 reopen 持久化、进程重启 interrupted 标记、命令幂等、并发 sequence 和 fixture replay；
- `packages/runtime`：单 Session queue、重复 send/cancel/resume/fork command、queued turn 恢复和取消；
- `apps/api`：SQLite 默认持久化、`after_sequence`/`Last-Event-ID` SSE、resume/fork、Idempotency-Key、API 进程重启历史恢复；
- 进程级 smoke：关闭并重启 API 后保留 Session、两条消息和完整 event sequence。

### Phase 2 退出条件对照

- 进程重启后 Session 历史完整：通过 SQLite API restart smoke；
- 任意 sequence 断线后可以补发且不重复渲染：SSE historical replay、buffered live events 和 sequence 去重测试/实现；
- 重复 command 不产生重复副作用：storage/runtime/API idempotency tests；
- 中途取消、模型错误和客户端断开都有可解释事件：cancel/turn-ended、agent/error 事件和 SSE close handling；
- SQLite schema migration 和并发追加：SQLite migration 初始化及 concurrent append test；
- 从事件 fixture 重建的 projection 与 API 返回一致：`replayProjection` test 及启动 projection rebuild。

## Phase 1 验收证据

### 自动化检查

```text
pnpm typecheck   ✓
pnpm test        ✓
```

当前 workspace 测试覆盖：

- `packages/contracts`：branded ID；
- `packages/llm`：Echo stream、OpenAI-compatible SSE parser；
- `packages/storage`：monotonic sequence、projection、session isolation；
- `packages/workspace`：workspace path traversal；
- `packages/runtime`：streaming turn、event persistence、cancel；
- `apps/api`：health、Session、message、web shell、SSE replay。

### 人工/运行时 smoke

- Node API：`GET /health` 返回 TypeScript runtime；
- HTTP：创建 Session → 发送消息 → projection 出现 `Echo: ...`；
- SSE：历史事件按 sequence 回放，并在空闲连接发送 `: connected` heartbeat；
- Browser：页面显示 Session sidebar、composer 和 Connected 状态；发送消息后显示 user message、turn event 和 assistant response。

## Phase 1 的明确边界（历史记录）

已完成：

- TypeScript/Node.js monorepo；
- provider-neutral model interface 和 OpenAI-compatible streaming adapter；
- in-memory EventStore；
- AgentHost、Session、Turn、cancel；
- Node HTTP API、SSE 和最小 DSH 风格 Web Shell。

尚未实现且属于后续阶段：

- SQLite durable EventStore 和进程重启恢复（已在 Phase 2 完成）；
- 文件/终端工具、permission approval 和 diff；
- MCP、Subagent、A2A；
- 完整 DSH UI 组件闭包。
