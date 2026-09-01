# M01 开发日志：Context Window 与 Auto-Compact Budget

## 2026-08-26：按 Claude Code 分层实现模型感知预算

### 任务七问

1. **Phase**：Phase 8 高级能力；上下文管理按研究文档的 M01 模块推进。
2. **问题类型**：Runtime 上下文预算、model/provider capability、auto-compact preflight 和可回放诊断。
3. **契约影响**：新增 `ModelContextCapability`、`ContextBudgetConfig`、`ContextBudgetSnapshot`、`ContextWarningState`；扩展 `ChatModel`、`ModelRouteRecord`；`step/started` payload 增加非敏感预算快照和 warning state。
4. **Claude Code 参考**：`D:/Develop/claude-code/src/utils/context.ts`、`src/services/compact/autoCompact.ts`、`src/query.ts`。
5. **上游来源**：只参考职责分层、阈值公式和调用顺序，没有复制 Claude Code 代码；对应架构裁决见 `docs/architecture-decisions.md` 的 ADR-013。
6. **验收场景**：不同 model capability 产生正确 effective window、输出预留和 13K/30K/50K buffer；warning/error/auto/blocking/predictive 状态可计算；每个 model step 记录可解释快照；无 capability 的旧 adapter 安全 fallback；compaction 失败仍写 durable failure event 并继续 turn。
7. **回滚方式**：回退 M01 代码与契约 checkpoint；旧 `ContextBudget` 参数和 `compactMessages()` facade 保持兼容，故可先回退 runtime 接入再回退 `packages/context`。

### 实现内容

- 新增 `packages/context` workspace package，集中实现 `resolveContextBudget()`、`calculateContextWarningState()`、`shouldCompactBeforeRequest()` 和 fallback capability；不把预算公式复制到 runtime。
- `packages/contracts` 增加 capability/config/snapshot/warning 公共类型；`ChatModel.contextCapability` 和 `ModelRouteRecord.contextCapability` 都是可选字段，兼容旧模型和旧 route。
- `packages/llm` 为模型 adapter 增加 capability 注入点；内置 DeepSeek 登记 1M input / 8K output，Yayi 自定义模型按 DeepSeek 系列 1M、其他模型 200K 推导 capability。
- `AgentHost` 增加 `contextPolicy`、`contextBudgetSnapshot()` 和每步 preflight；根据 snapshot 的 auto threshold 驱动现有 compaction facade；预测式增长只使用 M01 的保守 15K 估计。
- 每个 `step/started` 事件增加 `contextBudget` 和 `contextWarning`，只写 provider/model、数字阈值、能力布尔值和 usage，不写 secrets 或原始 prompt。
- API `createApiServer()` 支持 `contextPolicy`，`/v1/capabilities` 继续作为 host capability projection 入口。
- 新增 M01 实施文档 [`../../claude-code-context-m01-implementation.zh-CN.md`](../../reference/claude-code-context-m01-implementation.zh-CN.md)，并在研究文档 12.4 标记实际落点。

### 关键决策与失败修复

- 不把 `maxInputTokens` 直接等同于历史消息预算；先扣除输出/摘要 reservation，再生成 effective window 和各 threshold。
- 旧自定义 `ChatModel` 没有 capability 时使用 16K estimate fallback；旧 `contextBudget.maxTokens` 仅作为 fallback window，避免破坏已有 compaction 配置。
- 首版 preflight 在读取一个故意抛错的旧 budget fixture 时提前中断，导致没有 `context/compaction_failed` 事件；随后把 fallback policy 读取改为安全降级，并保留真实 getter 错误在 `compactTurnContext()` 内记录，恢复了既有失败契约。
- `exactOptionalPropertyTypes` 要求 adapter 只有在 capability 存在时才设置可选字段，不能显式赋 `undefined`；已按此约束修复 `OpenAICompatibleChatModel`。

### 验证证据

```text
pnpm typecheck                                  ✓
pnpm test                                       ✓ all workspace tests
pnpm --filter @code-review-agent/context test    ✓ 4 tests
pnpm --filter @code-review-agent/compaction test ✓ 3 tests
pnpm --filter @code-review-agent/runtime test    ✓ 35 tests
git diff --check                                ✓
```

工作树证据：本记录与 M01 代码、契约、研究补充文档在同一工作树中；`git diff --check` 和完整 `pnpm test` 已通过。独立 checkpoint 仍需在用户确认后提交。

### 下一步

进入 M02 前，先接受并保留 ADR-013；M02 只实现 Claude Code `tokenEstimation.ts` 对应的 exact/estimate 双路径，并让 M01 snapshot 的 `tokenUsage/source` 使用可解释的计数结果。不要在 M02 中提前加入 tool pairing、microcompact 或 summary agent。
