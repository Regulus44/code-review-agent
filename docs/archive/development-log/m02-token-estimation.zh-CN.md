# M02 开发日志：Token Estimation 与 Provider Exact Count

## 2026-08-26：实现 Claude Code 式两级 token 计数

### 任务七问

1. **Phase**：Phase 8 高级能力；上下文管理 M02，依赖已完成的 M01。
2. **问题类型**：上下文 token 估算、provider exact count seam、预算边界决策和可解释诊断。
3. **契约影响**：`ChatModel` 增加可选 `countTokens()`；新增 `ModelContextView`、`TokenCount`、`TokenCountBreakdown`、`TokenCounter` 等 context package 类型；`step/started` 增加 `tokenCount` payload。
4. **Claude Code 参考**：`D:/Develop/claude-code/src/services/tokenEstimation.ts`、`src/query.ts:790-888`。
5. **上游来源**：只复刻 rough/exact/fallback 的行为边界和职责分层，没有复制 Claude Code 或 provider SDK 代码；M02 继续受 ADR-013 的上下文预算边界约束。
6. **验收场景**：普通 step 快速 estimate；接近 warning/predictive 边界时调用 exact；exact 成功标记 provider/exact；exact 失败不返回 0，保留 estimate 或显式 stale usage；system、普通文本、tool schema、arguments、results 分项可解释。
7. **回滚方式**：回退 M02 checkpoint 即可恢复 M01 的兼容 estimator；`ChatModel.countTokens` 为可选字段，旧 adapter 和旧事件仍可继续运行。

### 实现内容

- 新增 `packages/context/src/estimator.ts`：`estimateContextTokens()`、`createTokenCounter()`、`countContextTokens()`、`shouldUseExactTokenCount()`。
- 估算 breakdown 拆分 system/message/tool schema/tool arguments/tool result；普通文本使用 `/4`，结构化 JSON 使用更保守的 `/2`。
- `ChatModel` 增加可选 `countTokens(request)`，不把 provider-specific count API 写入 Runtime。
- Runtime 每个 step 先 estimate；只有 capability 支持且接近 warning/predictive 边界时才 exact；compact 后只重新 estimate，避免同一步重复 provider count 请求。
- `step/started.payload.tokenCount` 记录 value、source、confidence、breakdown、exactAttempted 和脱敏 error。
- exact 失败保留 estimate；调用方显式提供 stale usage 时才使用 `source: "stale_usage"`，不把失败伪装成 0。
- 新增 [`../../claude-code-context-m02-implementation.zh-CN.md`](../../reference/claude-code-context-m02-implementation.zh-CN.md)，研究文档第 13 节同步更新实现状态。

### 关键决策与边界

- 不在 M02 引入 M04 的 API round、normalize、tool pairing；estimator 只接收当前 model-visible `ModelContextView`。
- 不在 M02 引入 M05 的工具结果裁剪；tool result 只被计数，不改变原文或 model view。
- `supportsExactCount` 只是能力声明；若 adapter 没有 `countTokens()`，即使声明为 true 也安全回退 estimate。
- provider exact 返回值只接受有限、非负数字；其他结果都按失败处理并保留 estimate。

### 验证证据

```text
pnpm typecheck                                  ✓
pnpm test                                       ✓ all workspace tests
pnpm --filter @code-review-agent/context test    ✓ 8 tests
pnpm --filter @code-review-agent/runtime test    ✓ 36 tests
git diff --check                                ✓
```

工作树证据：M02 代码、测试、实施文档和本日志在同一工作树中；完整 `pnpm test`、`git diff --check` 已通过，接下来创建独立 checkpoint。

### 下一步

进入 M03 时，使用 M02 的 `ModelContextView` 和 breakdown 作为 Context Assembly 的计数输入，补齐 system/tools/history/attachments 的稳定组装与 fingerprint；不要在 M03 中重新发明另一套 token estimator。
