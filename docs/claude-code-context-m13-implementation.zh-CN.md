# M13：Claude Code 式 Context Diagnostics 与 Web Projection 实施说明

状态：`implemented`

日期：2026-08-26

阶段：Phase 8 / M13

## Claude Code 入口与本项目映射

| Claude Code 入口 | 本项目实现 | 对照方式 |
|---|---|---|
| `src/components/TokenWarning.tsx` | `apps/web/src/presentation/context-presenter.ts` | 保留 warning/error/auto-compact/blocking 状态和剩余百分比；展示层消费 durable projection |
| `src/utils/analyzeContext.ts` | `packages/runtime/src/index.ts` 的 `step/started` 诊断 payload、`packages/storage/src/index.ts` reducer | 每个模型 step 记录 token、预算阈值、来源、confidence、breakdown 和 request cursor |
| `src/query.ts` 的 compact progress/log events | `context/*` 事件与 `ContextDiagnosticsProjection.lastCompaction` | compact、失败、recovery 和 boundary 事件按 sequence 归并为最近状态与 bounded chain |
| Claude Code context inspector 的状态展示 | `presentContextMeter()`、`presentContextDiagnostics()`、`SessionStore` 增量投影 | Web 不重新估算 token，不把 UI 状态当作事实来源 |

## 数据流与事实来源

```text
Runtime canonical model view
  → countContextTokens()
  → calculateContextWarningState()
  → step/started { contextBudget, contextWarning, tokenCount, modelRequestId }
  → EventStore append
  → InMemory/SQLite applyEvent()
  → SessionProjection.contextDiagnostics
  → SSE replay / SessionStore incremental fold
  → ContextMeter / diagnostics inspector
```

`step/started` 是每次模型请求的主要诊断事实来源。compact、boundary 和 recovery 事件提供跨 step 的节省量、失败原因和恢复链。EventStore 与 Web projection 只保存 bounded metadata：token 数、阈值、来源、confidence、最多 16 条 recovery metadata、最近一次 compact receipt 和 request cursor；不保存完整 transcript、工具原文、provider body、凭据或 secret。

当 compact/recovery 事件先于第一个 `step/started` 到达时，reducer 创建 `unknown` diagnostics baseline，后续 step 会补齐真实窗口和 token 事实，避免丢失 turn 开始阶段的 compact/recovery 记录。旧事件没有 diagnostics 时，Web presenter 继续使用原有 message estimate fallback。

## 公共契约

`packages/contracts/src/index.ts` 新增：

- `ContextDiagnosticLevel`：`unknown`、`healthy`、`warning`、`error`、`auto_compact`、`blocking`；
- `ContextDiagnosticTokenSource`：`provider`、`estimate`、`stale_usage`；
- `ContextDiagnosticTokenConfidence`：`exact`、`high`、`medium`、`low`；
- `ContextDiagnosticRecovery`：恢复状态、attempt、bounded error class/reason/provider status 和 sequence；
- `ContextDiagnosticsProjection`：token usage、effective window、四类 threshold、percent left、最近 step/request、breakdown、最近 compact 和 recovery chain；
- `ContextCompactionProjection.preCompactTokens/postCompactTokens/tokensSaved`。

`ContextDiagnosticsProjection` 为附加字段，旧 SessionProjection、旧 compact 事件和旧 Web fallback 不需要迁移。`recoveryChain` 固定最多 16 项，breakdown 最多 16 个数值字段，request/error 字符串均执行长度限制。

## Runtime 实现

`packages/runtime/src/index.ts` 的 `runSteps()` 在每次发送模型请求前：

1. 由同一份 `prepared.view` 计算 estimate/exact token count；
2. 由 `ContextBudgetSnapshot` 和 `ContextWarningState` 得到阈值状态；
3. 生成 bounded `modelRequestId`；
4. 追加 `step/started`，再调用 provider；
5. compact 成功、失败和 boundary rebuild 事件携带 `preCompactTokens`、`postCompactTokens`、`tokensSaved`。

Legacy、Session Memory 和 Summary compact 均使用 compact 前的 token 值计算节省量；post-compact 值使用实际 compacted model view 估算值。失败事件保留错误摘要并继续原有 fail-soft/recovery 流程。

## Storage 与 replay

`packages/storage/src/index.ts` 的 InMemory/SQLite 共用 reducer：

- `step/started` 更新当前 token usage、source/confidence、window、阈值、percent、level、breakdown、step 和 request；
- `context/compacted`、`context/microcompacted`、`context/session_memory_compacted`、`context/summary_compacted`、`context/compact_boundary` 更新最近 compact receipt；microcompact 直接保留 `tokensSaved`，boundary event 的 kind 从 payload 或 boundary metadata 读取；
- `context/*recovery*` 追加 bounded recovery chain，并保留最近 16 项；
- SQLite 只持久化事件和 projection JSON，close/reopen 后通过同一 replay reducer 得到相同 diagnostics。

compact projection 同步保留前后 token 和节省量，避免 boundary event 覆盖旧字段。compact/recovery 先到时使用 unknown baseline，确保 diagnostics 不依赖事件到达顺序。

## Web Projection

`apps/web/src/presentation/context-presenter.ts`：

- `presentContextMeter()` 优先消费 `session.contextDiagnostics`；
- label 包含当前 token/有效窗口，detail 展示 source/confidence、剩余百分比、warning/error/auto/blocking thresholds、最近 compact 和 recovery 数量；
- `presentContextDiagnostics()` 返回 inspector intent，缺少 durable diagnostics 时明确 `unknown`；
- 无 diagnostics 的旧 session 保留基于 replay messages 的兼容估算。

`apps/web/src/client/store.ts` 对实时 SSE 的 `step/started`、compact 和 recovery 事件执行增量 projection；`apps/web/src/client/connection.ts` 注册 M05–M13 context event type；`apps/web/src/browser.ts` 暴露两个 presenter。客户端按 sequence 去重，刷新时由 API snapshot 覆盖临时状态。

## 安全与边界

- diagnostics 只保存 bounded 数值和枚举，不写入完整 prompt、工具结果、provider 原始 response、token credential 或 headers；
- `modelRequestId`、request/error/reason 字符串限制长度；breakdown 只接受有限数量的 number；
- UI 不根据 messages 自行猜测已发生 compact；只有没有 durable diagnostics 的旧数据才启用兼容估算；
- diagnostics 不改变 permission、workspace、tool、Task 或 EventStore transcript 事实；
- recovery chain 只用于可观察性，不允许 Web 直接驱动恢复副作用。

## 测试入口

- `apps/web/src/presentation/context-presenter.test.ts`：durable diagnostics 优先、provider exact/stale usage、状态、compact 节省量、recovery 和旧 fallback；
- `apps/web/src/client/store.test.ts`：实时 step/compact/recovery 增量投影和 bounded chain；
- `packages/storage/src/index.test.ts`：step replay、compact boundary 前后 token、16 项 recovery cap、SQLite close/reopen；
- `packages/runtime/src/index.test.ts`：每 step diagnostics、provider/exact provenance 和各类 compact receipt。

验证命令：

```text
pnpm typecheck
pnpm --filter @code-review-agent/web test -- --run
pnpm --filter @code-review-agent/storage test -- --run
pnpm --filter @code-review-agent/runtime test -- --run
pnpm test
git diff --check
```

## 回滚边界

停止生成 M13 projection 字段和 Web presenter 增量 fold，即可回退到 M12 的 context compaction/session/project memory projection；旧 compact、recovery、transcript 和 memory 事件保持可回放。删除 `contextDiagnostics` 不影响模型请求、权限和 transcript。
