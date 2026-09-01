# 阶段 2：Context fallback、Step 上限与 Summary 预算实施日志（2026-08-28）

## 目标

按 [Token/Context/Tool 实施基线](../../reference/token-context-tool-limits-dsh-claude-code-implementation-plan.zh-CN.md) 将无 capability 的 context fallback 提升到 200K，并统一 Runtime、子 Agent、API 和评测 Runner 的 step 范围；同时把 summary 最终正文上限统一为 8192 字符。

## 实施入口

- `packages/context/src/index.ts`：fallback `200000/64000/32000` 和 `180000` effective window；
- `packages/compaction/src/index.ts`：legacy context `200000`、summary `8192`；
- `packages/context/src/summary-compact.ts`：summary 默认 `8192` 字符；
- `packages/runtime/src/index.ts`：默认 32 steps、硬上限 512；
- `packages/runtime/src/subagent-provider.ts`：子 Agent 继续通过 AgentHost 使用相同边界；
- `apps/api/src/server.ts`：API 继续透传 Host step 配置；
- `scripts/eval-mvp/run-pilot.ps1`、`run-agent-task.ts`：评测边界统一到 `1–512`；
- `docs/coding-agent-bench-mvp.zh-CN.md`：标记旧 12-step 结果为历史，记录当前 `32/512`。

## 验收证据

- `fallbackModelContextCapability()` 默认返回 `maxInputTokens=200000`、`maxOutputTokens=64000`、`defaultMaxOutputTokens=32000`；
- `resolveContextBudget()` 默认 reserved output 为 `20000`，effective window 为 `180000`；
- summary runner 默认结果最多保留 `8192` 字符；legacy compaction 默认 context 为 `200000`；
- `AgentHost` 默认可运行 32 steps，显式 512 可构造，513 立即拒绝；API 同步拒绝 513；
- `pnpm test`：全 workspace 通过；
- `pnpm typecheck`、`git diff --check`：通过。

## 边界与下一步

阶段 2没有修改单工具结果落盘、单消息聚合、时间型 microcompact 或并行 scheduler。阶段 3从 Claude Code 风格单工具结果 artifact/preview 入口开始实施。
