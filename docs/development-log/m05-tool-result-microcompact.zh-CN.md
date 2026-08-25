# M05 开发日志：Tool Result Budget 与 MicroCompact

状态：`implemented`
日期：2026-08-26
checkpoint：本次独立提交 `feat(phase8): implement tool result microcompact M05`

## 任务七问

1. **Phase**：Phase 8 高级上下文能力，M05；依赖 M02 token view、M03 canonical assembly 和 M04 request gate。
2. **问题类型**：工具结果的 model-view 预算、旧结果局部释放、清理事件和重放诊断。
3. **契约影响**：新增 `ToolResultBudgetPolicy`、`ToolResultBudgetReport`；新增 `context/tool_results_budgeted` 与 `context/microcompacted`；`step/started` 增加 `toolResultBudget`。
4. **Claude Code 参考**：`src/query.ts`、`src/services/compact/microCompact.ts`、`src/services/compact/cachedMicrocompact.ts`。
5. **上游来源**：登记为 `behavior-reference`；没有复制 Claude Code 代码；cached provider edit 暂缓。
6. **验收场景**：长工具结果在 provider request 中变为 bounded/cleared；最近结果和 pending permission/interaction 受到保护；EventStore 原文不变；重复 step 不重复产生 microcompact receipt。
7. **回滚方式**：回退 M05 checkpoint，保留 M04 normalize/pairing 和 M02 estimator；新增事件均为追加类型，不需要迁移旧事件。

## 实现内容

- 新增 `packages/context/src/tool-result-budget.ts` 与单元测试。
- 导出 `applyToolResultBudget()`、默认 compactable 工具白名单和 cleared marker。
- `AgentHost.runSteps()` 在每个 step 传入 pending protected IDs、tool result timestamps 和 turn-local cleared IDs。
- model request 与 token estimator 共用 budgeted `prepared.view`。
- 新增 budget/microcompact durable receipts 和 step 诊断。
- 新增 M05 实施说明、ADR-017 和 CC-006 来源登记。

## 关键决策

- transcript 与 model view 严格分离；marker 不会写回 `tool/result`。
- 只清理白名单工具，默认覆盖 Read/Bash/Grep/Glob/WebSearch/WebFetch/Edit/Write 语义。
- pending permission/interaction 对应 tool call 同时禁止 bounded 和 cleared。
- count、tokens、time trigger 使用同一套 eligible 列表；tokens trigger 使用 bounded model view 的估算。
- receipt 只对首次 bounded/cleared 的 tool call 追加，避免 tool loop 每一步重复写入相同 microcompact 事件。
- provider cache edit 暂缓到后续 provider adapter 具备明确能力契约后再评估。

## 验证证据

```text
pnpm typecheck
pnpm --filter @code-review-agent/context test
pnpm --filter @code-review-agent/runtime test
pnpm test
git diff --check
```

验证结果：

- `pnpm typecheck`：通过；
- `pnpm --filter @code-review-agent/context test`：通过，25 tests；
- `pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts`：通过，41 tests；
- `pnpm test`：通过，workspace 全量测试通过；
- `git diff --check`：通过（仅有 Git 的 LF/CRLF 提示）。

## 未完成与后续边界

M06 继续实现 Session Memory compact；M07 继续实现 LLM Summary compact。M05 不提前引入 provider cache mutation、compact boundary 或 overflow recovery。
