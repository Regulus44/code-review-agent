# Phase 5 开发日志：内部 Task/Subagent 多 Agent

## 状态

`completed`

## 2026-08-23：Phase 5.0–5.4 完成

本轮按 DSH R0/R1 行为逐层实现，主参考为 `D:/Develop/deepseek-harness-fork`，`D:/Develop/claude-code` 只用于 prompt/UX 语义参考。

### 交付切片

- 5.0：`packages/contracts` 增加 `SubagentDescriptor`、`TaskReport`、`ArtifactRef`、authority、budget、child metadata 和 lifecycle events；`packages/storage` schema v3 保存 parent/child metadata，Task projection 支持 report/artifact/input-required、重建和幂等 terminal folding；新增 descriptor、sequence-gap、SQLite reopen fixtures。
- 5.1：`packages/subagent` provider registry 与 `SubagentRuntime`；one-shot foreground 使用 `start → result → dispose`，background 立即返回 durable Task，child Session 独立保存 transcript；`packages/runtime/src/subagent-provider.ts` 用新 AgentHost 作为 in-process driver。
- 5.2：continuable child 使用 FIFO inbox、单 child turn lock、`send_message`/`interrupt_agent`/`list_agents`，interrupt 不删除 queued inbox；authority 允许 direct parent/ancestor，cold resume 从 descriptor 读取，不从 live Map 虚构 agent。
- 5.3：child-scoped `report` 由 descriptor 推导 direct parent，支持 `wakeup/quiet` 和独立 settlement notice；in-process child 的 tool registry 同时执行 tool allowlist 和 MCP server/tool allowlist，未显式 allow 的 MCP 不继承。
- 5.4：API 提供 subagent catalog/history/prompt/interrupt、task query/output/cancel；SSE 提供 parent/child scoped replay；Web 隐藏 child session 的顶层重复项，使用 Child agents 树展示状态、artifact/report 和取消入口。

### DSH 文件到本项目的行为对照

| DSH R0 文件 | 本项目对应实现 | 差异/边界 | Fixture |
|---|---|---|---|
| `subagent/src/descriptor.ts` | `packages/subagent/src/descriptor.ts` | 使用本项目 EventStore event payload 和 SessionId；版本 1、未知字段拒绝 | corrupt/unknown descriptor |
| `subagent/src/continuation.ts` + `core/agent/src/inbox.ts` | `packages/subagent/src/runtime.ts` | provider handle 由 AgentHost adapter 注入；FIFO/interrupt/authority 保持同语义 | FIFO、child lock、queued-after-interrupt |
| `subagent/src/run-settlement.ts` | `SubagentRuntime.settle*` | report/artifact 使用本项目 bounded contract | partial、双失败 dispose |
| `tool-subagent-control` / `tool-subagent-report` | `packages/tools/src/subagent.ts` + runtime methods | 工具只调用 SubagentRuntime，不直接调用 ToolRegistry | authority/direct-parent report |
| `host/apiproxy/src/api/subagents*.ts` | `apps/api/src/server.ts` | 使用本项目 `/v1/*`、DTO 和 SSE replay | API catalog/output/scoped replay |

### 约束确认

- child tool execution 继续走 `ToolRuntime`；`packages/tools` 不直接创建 Agent；
- EventStore 先追加、projection 后更新、SSE 最后消费；Web 不成为事实来源；
- workspaceRoot、permission preset、tool/MCP allowlist 显式传递并冻结；
- 不实现 A2A HTTP endpoint、Agent Card、外部 Task mapper 或 unrestricted swarm；
- 不重复普通基线测试，验证集中在 phase-specific fixtures 和 API/Web smoke。

## 2026-08-23：建立 DSH 对照执行计划

本节记录 5.0 实现前的调研基线；随后已按该计划完成 Phase 5.0–5.4。详细计划见 [Phase 5：内部 Task/Subagent 多 Agent（DSH 对照执行计划）](../phases/phase-plans/phase-5-subagents.zh-CN.md)。

### 已核对的 DSH 结构

- `packages/subagent/subagent`：provider registry、descriptor、child policy、lifecycle、continuation、projection、settlement；
- `packages/subagent/tool-subagent`：foreground/background/continuable delegation tool；
- `packages/subagent/tool-subagent-control`：`send_message`、`interrupt_agent`、`list_agents`；
- `packages/subagent/tool-subagent-report`：child-scoped direct-parent report channel；
- `packages/subagent/subagent-spawn-in-process` 与 `subagent-fork-in-process`：fresh child 和 seeded child provider；
- `packages/core/agent` 与 `packages/core/agent-loop`：inbox、dispatch、turn driver、idle convergence；
- `packages/core/session`、`packages/session/session-persistence*`、`packages/session/session-projection`：durable event、recovery、projection；
- `packages/host/apiproxy/src/api/subagents*.ts`：browser-safe catalog/history/prompt/interrupt API；
- `packages/acp/acp`：自动化 provider 边界，暂不作为 Phase 5 核心实现。

### 本项目与 DSH 的差距

- 当前 `packages/contracts` 已有 `TaskId`、`TaskStatus` 和基础 Task projection，缺少 parent/child identity、descriptor、run/activation、report、artifact 和 stop-reason contract；
- 当前 `packages/runtime` 的 `AgentHost` 只有 session 级 turn queue，尚未有独立 child Agent、provider registry、continuation inbox 和 child-first disposal；
- 当前 `packages/storage` 没有 child session metadata、descriptor event 和 parent/child projection；
- 当前 `packages/tools` 没有 `spawn_subagent`、`send_message`、`interrupt_agent`、`list_agents`、`report` 工具及对应的独立 prompt sections；
- 当前 API/Web 没有 parent/child tree、child history、Task report 和 control surface；
- MCP 已有 durable scope/generation，但还没有 child 显式 MCP allowlist 和权限继承边界。

### 计划裁决

Phase 5 依照以下顺序推进：

```text
5.0 Task contract + durable projection
  → 5.1 one-shot Subagent
  → 5.2 continuable child + control tools
  → 5.3 report + MCP-aware child
  → 5.4 API/Web + integrated gate
```

DSH R0 工作项必须逐文件对照并补行为 fixture；R1 工作项对照公共行为和 API；R2 内容只记录后续方向。A2A HTTP endpoint 继续等 Phase 5 parent/child lifecycle 稳定后再进入 Phase 6。

### 验证与提交

- 调研依据：本地 `D:/Develop/deepseek-harness-fork` 当前源码和 MIT LICENSE；
- 本节对应的计划建立阶段只写计划和日志；后续实现已在上方 Phase 5.0–5.4 条目记录；
- 计划文档、开发日志、阶段状态、ADR 和来源登记均已同步，提交门禁见最终 checkpoint；
- A2A HTTP endpoint 和远程 provider 保持 Phase 6 边界。
