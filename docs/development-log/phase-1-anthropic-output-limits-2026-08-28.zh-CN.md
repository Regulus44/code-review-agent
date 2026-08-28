# 阶段 1：Anthropic-compatible 输出能力实施日志（2026-08-28）

## 目标

按 [Token/Context/Tool 实施基线](../token-context-tool-limits-dsh-claude-code-implementation-plan.zh-CN.md) 完成 Anthropic-compatible 的双值输出解析：默认请求 `32000` tokens，协议硬上限 `64000` tokens，并保留模型级 `maxOutputTokens` 校验。本次不采用 DSH DeepSeek 的 `256000`。

## 实施入口

- `packages/contracts/src/index.ts`：增加 `ModelContextCapability.defaultMaxOutputTokens` 和 context fallback 字段；
- `packages/llm/src/providers/anthropic-messages/types.ts`：集中定义 `32000/64000` 常量；
- `packages/llm/src/providers/anthropic-messages/adapter.ts`：构造阶段完成协议上限、模型上限和 default/upper 一致性校验；
- `packages/llm/src/index.ts`：内置 Anthropic capability 和 bootstrap 使用 `64000/32000`；DeepSeek 保持 `8000`；
- `packages/llm/src/catalog.ts`：Yayi profile 推断和 profile default 解析；
- `apps/api/src/server.ts`：bootstrap catalog 的 Anthropic capability 投影。

## 验收证据

- Anthropic adapter 默认请求体包含 `"max_tokens":32000`；
- 显式 `64000` 可发送，`64001` 在 fetch 前抛出配置错误；
- 模型 upper `8192` 且 default `8192` 可用，default `32000` 与 upper `8192` 的不一致配置 fail fast；
- Yayi v4pro 推断得到 `maxOutputTokens=64000`、`defaultMaxOutputTokens=32000`，并传入 Anthropic adapter；
- `pnpm --filter @code-review-agent/llm test`：33 项通过；
- `pnpm --filter @code-review-agent/api test`：51 项通过；
- `pnpm typecheck`、`git diff --check`：通过。

## 边界与下一步

阶段 1没有修改 context fallback、step 上限、summary、工具结果落盘/聚合、时间压缩或并行 scheduler。阶段 2从 `packages/context`、`packages/compaction`、`packages/runtime` 的既定入口继续实施。
