# 阶段状态

本文记录当前开发阶段的实际状态。它不是长期架构决策；阶段完成以对应 Git checkpoint、测试命令和验收证据为准。

## 当前状态

| 阶段 | 状态 | Checkpoint/证据 |
|---|---|---|
| Phase 0：TypeScript 基线与契约 | completed | `codex/phase-0-typescript-foundation`；workspace、strict TS、contracts、依赖图检查通过 |
| Phase 1：最小 AgentHost 与 Web Shell | completed | 当前 checkpoint；`pnpm typecheck`、`pnpm test`、HTTP/SSE smoke、浏览器 Read-only smoke 通过 |
| Phase 2：事件、持久化与恢复 | next | 尚未开始；下一步是 SQLite EventStore、projection、重启恢复和幂等 command |
| Phase 3：工具运行时与权限 | pending | 等 Phase 2 退出条件满足 |
| Phase 4：MCP Client | pending | 等 Phase 3 ToolRegistry/Permission 稳定 |
| Phase 5：内部 Subagent / 多 Agent | pending | 等 Phase 4 MCP 和 Task contract 稳定 |
| Phase 6：A2A | pending | 等 Phase 5 parent/child lifecycle 稳定 |
| Phase 7：DSH Web 前端收敛 | pending | 先保持 Phase 1 最小 Shell，后续逐项移植 |
| Phase 8：高级能力与产品化 | pending | 等前置阶段完成 |

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

## Phase 1 的明确边界

已完成：

- TypeScript/Node.js monorepo；
- provider-neutral model interface 和 OpenAI-compatible streaming adapter；
- in-memory EventStore；
- AgentHost、Session、Turn、cancel；
- Node HTTP API、SSE 和最小 DSH 风格 Web Shell。

尚未实现且属于后续阶段：

- SQLite durable EventStore 和进程重启恢复；
- 文件/终端工具、permission approval 和 diff；
- MCP、Subagent、A2A；
- 完整 DSH UI 组件闭包。
