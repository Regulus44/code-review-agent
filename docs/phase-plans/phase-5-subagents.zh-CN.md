# Phase 5：内部 Subagent / 多 Agent

## 目标

让主 Agent 可以把独立任务委派给受约束的子 Agent，并在 Web 中看到子任务状态和结构化报告。先建立内部任务模型，不急于实现 A2A。

## 参考入口

DSH：

- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent`
- `D:/Develop/deepseek-harness-fork/packages/subagent/tool-subagent`
- `D:/Develop/deepseek-harness-fork/packages/subagent/tool-subagent-control`
- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent-acp`

Claude Code：

- `D:/Develop/claude-code/src/coordinator`
- `D:/Develop/claude-code/src/utils/swarm`
- `D:/Develop/claude-code/packages/builtin-tools/src/tools/Task*`
- `D:/Develop/claude-code/packages/builtin-tools/src/tools/Team*`

## 交付物

- `SubagentDescriptor` 和 `SubagentRegistry`；
- parent/child Task、Session、Workspace 和权限关联；
- scheduler、并发/深度/预算限制；
- `spawn_subagent`、`list_subagents`、`send_subagent_message`、`wait_subagent`、`cancel_subagent`；
- 结构化 `TaskReport` 和 artifact 引用；
- Web 的子任务树、状态、进度和报告面板。

## 工作流任务

### Task contract

1. 定义 task input、output、artifact、budget 和 retry semantics；
2. 生命周期为 created → queued → running → waiting → completed/failed/cancelled/blocked；
3. 每个 child 必须有 parentTaskId、sessionId 和 workspace scope；
4. 主 Agent 只接收明确的 report，不共享子 Agent 的全部上下文。

### Scheduler/权限

1. 限制最大并发数、递归深度、token/时间预算；
2. 子 Agent 的工具集合使用显式白名单；
3. parent 取消时按策略传播到 child；
4. 子 Agent 的 MCP、写入和执行权限不能自动提升。

### Web/事件

1. 追加 task/created、task/updated、task/report 事件；
2. 展示 queued/running/waiting 状态和失败原因；
3. 支持等待、取消和报告折叠；
4. 从事件重建完整 parent/child 树。

## 不包含

- 外部 A2A endpoint；
- 无限制的自主 swarm；
- 共享父 Agent 全部上下文；
- 子 Agent 绕过统一 ToolRegistry。

## 测试与验收

- 一个主 Agent 创建两个并行、互不冲突的只读子任务；
- 并发上限、深度上限和预算上限生效；
- child 失败不破坏 parent，parent 可决定重试或继续；
- 取消能传播且不会遗留 running task；
- child 报告和 artifact 可持久化、回放并显示在 Web；
- 权限白名单和 workspace scope 不能越界。

退出条件：主 Agent 能安全委派、等待、取消并消费结构化子任务报告，所有任务状态都可从事件恢复。

## 回滚点

Subagent 功能由 feature flag 或 preset 启用；关闭后主 Agent、内置工具和 MCP 不受影响。
