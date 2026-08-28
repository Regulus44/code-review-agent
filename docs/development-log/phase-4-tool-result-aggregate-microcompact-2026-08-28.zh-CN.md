# 阶段 4：单消息工具结果聚合与时间型 MicroCompact 实施日志（2026-08-28）

## 目标与边界

本阶段在阶段 3 单工具结果落盘基础上，按最终 API user message 对工具结果做聚合预算。默认每条最终 user message 的工具结果合计不超过 `200000` 字符；超预算时按最大 fresh 结果优先落盘并替换为阶段 3的 bounded artifact view。

时间型 microcompact 已独立为显式开关，默认关闭；开启后默认 gap 为 `60` 分钟，保留最近 `5` 个可清理结果。count/token trigger 继续独立生效。

本阶段没有实现阶段 5 的并行 scheduler，也没有实现 provider-specific cached microcompact、Session Memory 或 summary compact。

## 直接修改的代码入口

- `packages/context/src/tool-result-budget.ts`
  - 增加 `maxToolResultsPerMessageChars`，默认 `200000`；
  - 按 assistant 边界收集最终 API user message 中的 tool result，跨连续 user/tool fragment 聚合；
  - 按最大 fresh 结果优先选择，调用阶段 3 storage 强制落盘，直到剩余工具结果字符数回到预算内；
  - 增加 `ToolResultBudgetState.seenIds/replacements`，冻结已见未替换结果，并复用已替换结果的完整 model view；
  - 时间型 microcompact 增加 `timeBasedMicrocompactEnabled`，默认 `false`，默认 gap `60min`，保留 `5` 个结果；
  - 保留 count/token trigger、protected tool call、非文本结果和 cleared marker 语义。
- `packages/context/src/tool-result-storage.ts`
  - 增加 `forcePersist`，允许聚合预算对低于 `50000` 字符但属于超预算 message 的结果落盘；
  - 原有单结果阈值、artifact 路径、preview 脱敏和 fail-closed 行为不变。
- `packages/runtime/src/index.ts`
  - `prepareModelContext()` 固定执行单结果落盘 → 单消息聚合 → count/token/time microcompact；
  - 每个 turn 创建并维护 replacement state；
  - 聚合产生的新 replacement receipt 追加 `context/tool_result_persisted`；
  - `step/started.payload.toolResultBudget`、`context/tool_results_budgeted` 和 `context/microcompacted` 增加 aggregate/time 诊断字段；
  - 重启时由完整 transcript、replacement receipt 和 bounded model view 恢复同一替换决定。
- `packages/contracts/src/index.ts`
  - 增加工具结果预算诊断类型和 `ContextDiagnosticsProjection.lastToolResultBudget`。
- `packages/storage/src/index.ts`
  - 从 `step/started.toolResultBudget` 回放并保存 bounded aggregate/time 诊断。
- `apps/web/src/client/store.ts`
  - Web replay 同步投影 `lastToolResultBudget`，不直接读取宿主路径或原始工具结果。

## 上游行为对照

- Claude Code `D:/Develop/claude-code/src/utils/toolResultStorage.ts`
  - `collectCandidatesByMessage()`：按最终 API user message 聚合；
  - `selectFreshToReplace()` / `enforceToolResultBudget()`：最大 fresh 结果优先、已见结果冻结、已替换结果复用固定 preview；
  - `ContentReplacementState`：跨 turn 保持 prompt cache 前缀和 replacement view 稳定。
- Claude Code `D:/Develop/claude-code/src/services/compact/timeBasedMCConfig.ts`
  - 时间型 microcompact 默认关闭；开启后 `60` 分钟和 `keepRecent=5`。
- DSH `D:/Develop/deepseek-harness-fork/packages/core/agent-loop`
  - 继续作为 Agent loop、Session/EventStore 和 workspace boundary 的分层参考；本阶段未复制 DSH 调度实现。

## 验收证据

- Context：聚合 `10 × 40K` 结果、跨 user fragment 分组、最大 fresh 选择、seen/replacement 冻结、默认关闭时间触发、显式 `60min` 触发；
- Runtime：并行工具结果实际请求不超过 `200000` 字符，replacement receipt 持久化，重启请求复用相同 tool view；
- Storage/Web：`lastToolResultBudget` 诊断可 replay，字段有界且不含完整工具输出；
- `pnpm --filter @code-review-agent/context test`：通过；
- `pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts`：通过；
- `pnpm --filter @code-review-agent/storage test -- --run src/index.test.ts`：通过；
- `pnpm --filter @code-review-agent/web test -- --run src/client/store.test.ts`：通过；
- `pnpm typecheck`：通过；
- `pnpm test`：全 workspace 通过；
- `git diff --check`：通过。

## 回滚与下一步

回滚时关闭或移除 aggregate/time budget gate，保留阶段 3 artifact、replacement receipt 和完整 `tool/result` 可读；EventStore、permission、workspace 和取消 contract 不回滚。

阶段 5入口是最多 `10` 个并行工具调用的统一 scheduler，必须继续消费本阶段稳定的单消息聚合预算和 replacement state。
