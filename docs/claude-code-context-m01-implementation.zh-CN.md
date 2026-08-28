# M01：Context Window 与 Auto-Compact Budget 实施记录

日期：2026-08-26

本文件记录 M01 的实际实现，作为 `docs/claude-code-context-management-research.zh-CN.md` 中 M01 规划的代码级落地补充。实现只参考 Claude Code 的结构和行为，没有复制 Claude Code 源码。

## 1. Claude Code 对照入口

| Claude Code 入口 | 关键职责 | 本项目对应实现 |
|---|---|---|
| `D:/Develop/claude-code/src/utils/context.ts:60-120` | 解析 model context window，处理默认值和窗口上限 | `packages/context/src/index.ts:1-31` 的 capability/fallback 入口 |
| `D:/Develop/claude-code/src/services/compact/autoCompact.ts:33-55` | 从 context window 扣除摘要输出预留 | `resolveContextBudget()` 的 `reservedOutputTokens/effectiveWindowTokens` |
| `D:/Develop/claude-code/src/services/compact/autoCompact.ts:60-94` | 13K/30K/50K buffer 和单轮增长估计 | `defaultAutoCompactBuffer()`、`DEFAULT_PREDICTIVE_GROWTH_TOKENS` |
| `D:/Develop/claude-code/src/services/compact/autoCompact.ts:100-165` | auto threshold、warning/error/blocking 状态 | `resolveContextBudget()`、`calculateContextWarningState()` |
| `D:/Develop/claude-code/src/services/compact/autoCompact.ts:270-380` | auto compact 前置门和失败后继续策略 | `AgentHost.runSteps()` 的 preflight 与现有 `compactTurnContext()` 兼容 facade |
| `D:/Develop/claude-code/src/query.ts:790-888` | 每次 API 请求前进行预测式检查 | `runSteps()` 在 `collectModelResponse()` 前计算 warning/predictive state |

## 2. 分层与职责

### 2.1 `packages/contracts`

新增公共契约：

- `ModelContextCapability`：provider、model、最大输入窗口、最大输出、exact count/prompt cache 能力和 provenance `source`；
- `ContextBudgetConfig`：窗口 fallback、输出预留、auto compact buffer、warning/error/blocking buffer、预测增长和开关；
- `ContextBudgetSnapshot`：一次请求实际使用的 reserved/effective/threshold 数值；
- `ContextWarningState`：当前 token usage 的 warning、error、auto、blocking、predictive 状态。

`ChatModel.contextCapability` 是可选字段，因此旧 adapter 和测试模型不需要立刻实现 provider metadata。`ModelRouteRecord.contextCapability` 允许 tenant route 携带同一份非敏感能力描述。

### 2.2 `packages/context`

`packages/context/src/index.ts` 是 M01 的唯一预算公式入口：

```text
ModelContextCapability + ContextBudgetConfig
    → resolveContextBudget()
    → ContextBudgetSnapshot
    → calculateContextWarningState(tokenUsage, snapshot)
    → shouldCompactBeforeRequest()
```

具体规则：

1. `reservedOutputTokens = min(maxOutputTokens, 20_000)`；
2. `effectiveWindowTokens = max(1, maxInputTokens - reservedOutputTokens)`；
3. effective window `< 400K` 使用 13K buffer，`400K–799,999` 使用 30K，`≥ 800K` 使用 50K；小于 13K 的兼容窗口将 buffer 限制为窗口的 20%，避免阈值变成负数；
4. warning/error threshold 分别从 effective window 扣除 20K，blocking threshold 扣除 3K；所有阈值至少为 1 且不超过 effective window；
5. auto compact 默认启用，`autoCompactEnabled: false` 时只保留 warning/error/blocking 诊断，不触发自动压缩；
6. predictive 状态使用保守的单轮增长估计（默认 15K），精确消息计数和工具结果增长留给 M02/M05。

`fallbackModelContextCapability()` 在 adapter 没有 capability 时使用 16K 输入窗口、0 输出预留、`source: "estimate"`。如果 host policy 显式覆盖窗口或输出，则 snapshot source 为 `hybrid`。

### 2.3 `packages/llm`

`OpenAICompatibleOptions.contextCapability` 和 `OpenAICompatibleChatModel.contextCapability` 为 provider adapter 提供注入点。内置 DeepSeek 配置登记为 1M input、8K output；Yayi 自定义模型由 Host 按模型名推导为 DeepSeek 系列 1M、其他模型 200K，来源标记为 `estimate`。

能力元数据挂在 host-owned model adapter 上；model catalog/config view 仍只返回 provider/model/base URL 等安全字段，避免把 capability registry 与既有 catalog contract 强绑定。

### 2.4 `packages/runtime`

`AgentHost` 新增 `contextPolicy` 选项和 `contextBudgetSnapshot(tenantId?)`：

- tenant model 的 adapter capability 优先；
- tenant route capability 次之；
- 当前 host model capability 再次之；
- 最后使用保守 fallback；
- 旧 `contextBudget.maxTokens` 只作为 capability 缺失时的输入窗口 fallback，其他旧字段继续交给 compaction。

`runSteps()` 的调用顺序现在是：

```text
append steers
→ resolve capability/snapshot
→ estimate current messages with existing compatibility estimator
→ calculate warning + predictive state
→ auto/predictive preflight
→ compact facade (if recommended)
→ append step/started with budget snapshot + warning state
→ collectModelResponse
```

每个 `step/started` 事件的 `payload.contextBudget` 只写 provider/model、数值阈值和能力布尔值；`payload.contextWarning` 写当前 usage 和状态。没有把 API key、credentialRef material 或原始 prompt 写入事件。

M01 仍通过现有 `compactMessages()` 执行压缩，动态使用 `autoCompactThreshold` 作为当前压缩 gate。旧 compaction failure 会继续写 `context/compaction_failed`，不会因为预算 preflight 失败而静默终止 turn。

## 3. 兼容边界

| 现有能力 | M01 处理方式 |
|---|---|
| `ContextBudget.maxTokens` | 保留；仅在没有 model capability 时作为 context window fallback |
| `recentMessageTokens`、`maxToolResultChars`、`maxSummaryChars` | 继续由 `@code-review-agent/compaction` 使用，M01 不重写其算法 |
| 现有 `estimateMessagesTokens()` | 仅作为 preflight 的临时 usage 来源；精确/估算双路径属于 M02 |
| `compactionEnabled: false` | 不执行 compact；仍可记录预算和 warning 状态 |
| 自定义 `ChatModel` | `contextCapability` 可省略，自动走 estimate fallback |
| tenant route | 可携带 capability；持久化 route 未提供 capability 时由 selector/adapter 在 restore 时重新提供 |

## 4. 验收与验证

新增测试：

- `packages/context/src/index.test.ts`：输出预留、13K/30K/50K buffer、warning/error/auto/blocking/predictive、fallback 和禁用 auto compact；
- `packages/runtime/src/index.test.ts`：`step/started` 中记录 provider capability、effective window、threshold 和 warning state。

已执行：

```text
pnpm typecheck                                  ✓
pnpm test                                       ✓ all workspace tests
pnpm --filter @code-review-agent/context test    ✓ 4 tests
pnpm --filter @code-review-agent/compaction test ✓ 3 tests
pnpm --filter @code-review-agent/runtime test    ✓ 35 tests
git diff --check                                ✓
```

## 5. 明确未包含的后续模块

M01 不实现以下能力：

- M02 exact token API、provider tokenizer 和 fallback estimator；
- M04 API round、tool pairing、message normalize；
- M05 工具结果独立预算与 microcompact；
- M06/M07 Session Memory、summary agent 和 PTL retry；
- M08 boundary/preserved segment/post-compact attachment；
- M09 400/413 reactive recovery 与 circuit breaker；
- M10 replay/restart 后的完整 model-view rebuild；
- M14 context collapse。

这些模块必须沿研究文档的 M01–M14 顺序继续开发，不能把未实现能力伪装成 M01 已完成。
