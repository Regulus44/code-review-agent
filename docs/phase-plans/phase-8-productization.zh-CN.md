# Phase 8：高级能力与产品化

## 目标

在前七个阶段稳定后补齐生产级 Coding Agent 能力。此阶段不再改变 Agent/Event/Tool/Task 的核心契约，只在既有扩展点上增加能力。

## 参考入口

DSH：

- `D:/Develop/deepseek-harness-fork/packages/compaction`
- `D:/Develop/deepseek-harness-fork/packages/lsp`
- `D:/Develop/deepseek-harness-fork/packages/workspace`
- `D:/Develop/deepseek-harness-fork/packages/terminal`
- `D:/Develop/deepseek-harness-fork/packages/workflow`
- `D:/Develop/deepseek-harness-fork/packages/guard`

Claude Code：

- `D:/Develop/claude-code/src/services/contextCollapse`
- `D:/Develop/claude-code/src/utils/context*`
- `D:/Develop/claude-code/packages/builtin-tools/src/tools/EnterWorktree*`
- `D:/Develop/claude-code/packages/builtin-tools/src/tools/LSP*`
- `D:/Develop/claude-code/packages/builtin-tools/src/tools/REPL*`
- `D:/Develop/claude-code/src/services`

## 能力顺序

### 8.1 Context Compaction

- token budget、tool result budget、microcompact、collapse、autocompact；
- 保证 tool_use/tool_result、thinking 和任务状态不会被错误截断；
- 压缩前后可从事件和摘要恢复。

### 8.2 Workspace / Worktree

- branch/worktree 生命周期；
- workspace 与 Session/Task 绑定；
- 并发修改冲突、清理和回收；
- 继续沿用 permission 和审计策略。

### 8.3 LSP / Code Mode

- LSP 诊断、符号和跳转以受控工具提供；
- Code Mode 只能在明确 sandbox、预算和权限下执行；
- 不因为增加代码执行能力而绕过 `run_command` policy。

### 8.4 后台任务和可靠性

- background jobs、retry、model fallback、deadline；
- session fork/replay/export；
- metrics、tracing、structured diagnostics；
- graceful shutdown 和进程恢复。

### 8.5 产品化

- remote auth、multi-user、tenant、quota；
- provider/model routing；
- secrets/credentials 管理；
- deployment、backup、migration 和 upgrade policy；
- 必要时再做 desktop wrapper。

## 不包含

- 改写已稳定的 Event/Tool/Task 契约；
- 为单一 provider 定制整个 Runtime；
- 没有安全评估的任意代码执行；
- 在没有用户场景的情况下引入完整 workflow/plugin 平台。

## 测试与验收

- 长上下文、工具结果超预算和 compaction 恢复；
- worktree 并发、冲突、清理和崩溃恢复；
- LSP 服务故障和超时；
- Code Mode sandbox、权限、资源和网络隔离；
- 后台任务重试、取消、幂等和进程重启；
- 多用户认证、租户隔离、quota 和敏感数据审计。

退出条件：核心四个验收场景在长会话、并发、断线和多用户部署下仍满足事件、工具、任务和安全不变量。

## 回滚点

高级能力逐项 feature flag 化；每项能力有独立 migration、配置开关和禁用后的 fallback 行为。
