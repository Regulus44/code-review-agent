# ADR：Phase 5 Child Session 与 Parent Task 的事实来源

## 状态

Accepted — 2026-08-23

## 背景

多 Agent 委派同时包含两个不能合并的身份：父侧可见的 `TaskId`，以及保存 child transcript 和 turn event 的独立 `SessionId`。如果只保留内存 Agent registry，API 重启后会出现“历史任务被误报为 running”、父子关系丢失或 sibling 越权。

## 决策

1. EventStore 是 parent/child/task 的唯一事实来源，内存 provider registry 只作为 live cache。
2. 每个 child Session 在 `session/created` 中冻结 `parentSessionId`、`parentTaskId`、`childMode`、`childProvider`、`delegationDepth` 和 workspace/permission 边界。
3. child 的首个 `subagent/descriptor` 事件是版本化 durable identity；当前版本为 `1`，未知字段和当前版本的损坏字段拒绝恢复，未知版本只能作为不可分类 child 返回，不能猜测为 live。
4. parent Session 保存 `task/created`、`task/report`、`task/artifact`、`task/input-required`、`task/ended` projection；完整 child transcript 只保留在 child Session。
5. 一个 Task 的 terminal 状态不可被重复 create/update 回退；重复 cancel/report 通过已有 command claim 或 terminal folding 保持幂等。
6. continuable child 的 follow-up 进入 child FIFO inbox；interrupt 只停止当前 turn，不删除 queued inbox。冷恢复必须重新读取 descriptor，并由 parent/ancestor authority 检查后调用 provider resume。
7. child report 不接受任意 recipient，direct parent 从 durable descriptor 推导；MCP/permission/workspace scope 不因 report 或 child creation 自动扩大。

## 取舍与后果

- parent projection 能快速渲染 catalog 和 bounded report，但不会直接提供完整 child history；需要显式 task output/history API。
- SQLite schema 通过 v3 migration 增加 child metadata，旧 Session 保持普通 Session 语义。
- 子 Agent 的工具池需要显式 allowlist；未显式允许的内置工具和 MCP server/tool 不进入 child registry，MCP generation 仍由 MCP client 的本地事件和 registry 管线负责。
- provider 的 live handle 丢失后，one-shot 进入 failed/diagnostic，continuable 只有 descriptor 和 provider 都支持时才进入 ready/resumable。

## 参考

- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent/src/descriptor.ts`
- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent/src/continuation.ts`
- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent/src/projection.ts`
- `D:/Develop/deepseek-harness-fork/packages/subagent/tool-subagent-report/src/index.ts`

本项目实现位于 `packages/contracts`、`packages/storage`、`packages/subagent`、`packages/runtime`、`packages/tools`、`apps/api` 和 `apps/web`，没有复制 DSH 内部类型或 Cordis runtime。
