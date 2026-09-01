# M13 开发日志：Context Diagnostics 与 Web Projection

状态：`implemented`

日期：2026-08-26

阶段：Phase 8 / M13

## 任务七问

1. Phase：Phase 8 高级上下文能力，M13；依赖 M01、M02、M05、M08、M09、M10、M11、M12。
2. 问题类型：把 Claude Code TokenWarning、context analysis 和 compact progress 变成可回放的 durable diagnostics，并接入 Web projection。
3. 契约影响：新增 `ContextDiagnosticsProjection`、compact 前后 token 字段和 Web presenter/store projection；不改变 Tool、Permission、Task 或 Workspace contract。
4. Claude Code 参考：`D:/Develop/claude-code/src/components/TokenWarning.tsx`、`src/utils/analyzeContext.ts`、`src/query.ts` compact events。
5. 上游来源：`behavior-reference`；未复制 Claude Code 源码，因本项目使用 EventStore、SQLite replay 和现有 ContextBudget/TokenCounter contract。
6. 验收场景：estimate/provider exact/stale usage、warning/error/auto/blocking、compact 前后节省量、recovery chain、SSE 增量更新、SQLite close/reopen 和旧 projection fallback。
7. 回滚方式：停止 `contextDiagnostics` 投影和 presenter 增量 fold，保留已有 M01–M12 事件和旧 ContextMeter fallback。

## 变更记录

1. `packages/contracts/src/index.ts` 新增 M13 diagnostics 枚举、recovery item、`ContextDiagnosticsProjection`，并扩展 `ContextCompactionProjection` 的前后 token 和 tokensSaved。
2. `packages/runtime/src/index.ts` 在 legacy/session-memory/summary/boundary compact receipt 中记录 compact 前后 token 与节省量；每个 `step/started` 已包含可脱敏 token/预算诊断。
3. `packages/storage/src/index.ts` 在 InMemory/SQLite 共用 reducer 中投影 step diagnostics、compact receipt 和最多 16 条 recovery chain；compact/recovery 先到时建立 unknown baseline。
4. `apps/web/src/presentation/context-presenter.ts` 优先消费 durable diagnostics，新增 inspector intent，并保留旧 session 的估算 fallback。
5. `apps/web/src/client/store.ts`、`connection.ts` 和 `browser.ts` 接入 context SSE event types、实时增量 projection 和 presenter bridge。
6. 新增 Web、Storage、Runtime 测试，覆盖 provenance、阈值状态、compact 节省量、recovery cap、SQLite reopen 和兼容行为。
7. 同步 M13 实施说明、ADR-025、CC-014、事件契约、Phase 8 计划、状态看板和研究文档。

## 关键决策

- `step/started` 是当前模型请求的诊断事实来源，Web 不自行重新估算已存在 durable diagnostics。
- compact/recovery 事件早于首个 step 时使用 unknown baseline，后续 step 只补齐事实，不丢失历史 receipt。
- breakdown、recovery chain、request/error/reason 全部 bounded；diagnostics 不包含 prompt、工具原文、provider body 或 credential。
- durable projection 是附加字段，旧事件和旧 Web session 继续使用兼容 fallback。

## 验证结果

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test -- --run  ✓
pnpm --filter @code-review-agent/storage test -- --run ✓
pnpm --filter @code-review-agent/runtime test -- --run ✓
pnpm test                                            ✓
git diff --check                                     ✓
```

## 后续边界

M13 不实现 Claude Code 账户、遥测、完整 context inspector UI、context collapse、provider cache edit 或 Web 端恢复控制；后续只在 M14 评估 context collapse 是否有必要。
