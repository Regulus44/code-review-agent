# Phase 5 开发日志：内部 Task/Subagent 多 Agent

## 状态

`planned`

## 2026-08-23：建立 DSH 对照执行计划

本轮完成本地 DeepSeek Harness multi-agent 结构调研，尚未合并 Phase 5 运行时代码。详细计划见 [Phase 5：内部 Task/Subagent 多 Agent（DSH 对照执行计划）](../phase-plans/phase-5-subagents.zh-CN.md)。

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
- 本轮只写计划和日志，没有修改运行时代码；
- 计划文档、开发日志、阶段状态和来源登记完成后必须创建独立 `docs(phase-5): ...` checkpoint；
- 下一次开发从 `5.0.0` contract/projection fixture 开始，完成后立即独立 commit。
