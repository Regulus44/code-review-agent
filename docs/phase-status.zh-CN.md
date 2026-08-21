# 阶段状态

本文记录当前开发阶段的实际状态。它不是长期架构决策；阶段完成以对应 Git checkpoint、测试命令和验收证据为准。

## 当前状态

| 阶段 | 状态 | Checkpoint/证据 |
|---|---|---|
| Phase 0：TypeScript 基线与契约 | completed | `codex/phase-0-typescript-foundation`；workspace、strict TS、contracts、依赖图检查通过 |
| Phase 1：最小 AgentHost 与 Web Shell | completed | 当前 checkpoint；`pnpm typecheck`、`pnpm test`、HTTP/SSE smoke、浏览器 Read-only smoke 通过 |
| Phase 2：事件、持久化与恢复 | completed | `a7f636f` + `5d5a198`；SQLite reopen/recovery、projection replay、SSE replay、queue、幂等 command 和 model failure 通过 |
| Phase 3：工具运行时与权限 | next | 等 Phase 2 退出条件满足；下一步是 ToolRegistry、内置文件工具和 PermissionPolicy |
| Phase 4：MCP Client | pending | 等 Phase 3 ToolRegistry/Permission 稳定 |
| Phase 5：内部 Subagent / 多 Agent | pending | 等 Phase 4 MCP 和 Task contract 稳定 |
| Phase 6：A2A | pending | 等 Phase 5 parent/child lifecycle 稳定 |
| Phase 7：DSH Web 前端收敛 | pending | 先保持 Phase 1 最小 Shell，后续逐项移植 |
| Phase 8：高级能力与产品化 | pending | 等前置阶段完成 |

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
