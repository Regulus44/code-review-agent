# M02：Token Estimation 与 Provider Exact Count 实施记录

日期：2026-08-26

本文件记录 M02 的实际实现，依据研究文档第 13 节和 Claude Code `tokenEstimation.ts` 的职责分层完成。实现只复刻行为边界和接口思想，没有复制 Claude Code 源码。

## 1. Claude Code 对照入口

| Claude Code 入口 | 关键职责 | 本项目对应实现 |
|---|---|---|
| `D:/Develop/claude-code/src/services/tokenEstimation.ts:131-212` | provider exact count、provider 不支持时的降级 | `packages/context/src/estimator.ts` 的 `countContextTokens()` |
| `D:/Develop/claude-code/src/services/tokenEstimation.ts:229-250` | `/4` rough token estimate | `estimateText()` |
| `D:/Develop/claude-code/src/services/tokenEstimation.ts:252-285` | JSON/文件类型更保守的 bytes-per-token | `estimateStructured()`，tool schema/arguments/results 使用 `/2` |
| `D:/Develop/claude-code/src/services/tokenEstimation.ts:287-360` | message/tool 内容抽取和 fallback 计数 | `estimateContextTokens()` 的 `ModelContextView` breakdown |
| `D:/Develop/claude-code/src/query.ts:790-888` | API 请求前的预算决策 | `packages/runtime/src/index.ts:runSteps()` 的 estimate → boundary exact → compact gate |

## 2. M02 契约与数据结构

### 2.1 `ModelContextView`

```ts
interface ModelContextView {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ModelToolDefinition[];
}
```

M02 只对即将发送给模型的可见消息和工具 schema 计数。它不读取 EventStore 原始 payload，也不改变消息顺序；M04 才负责 API round、normalize 和 tool pairing。

### 2.2 `TokenCount`

```ts
interface TokenCount {
  readonly value: number;
  readonly source: "provider" | "estimate" | "stale_usage";
  readonly confidence: "exact" | "high" | "medium" | "low";
  readonly stale?: boolean;
  readonly exactAttempted?: boolean;
  readonly exactError?: string;
  readonly breakdown?: TokenCountBreakdown;
}
```

约束：

- exact count 返回有效非负数时才使用 `source: "provider"`；
- provider 不支持 exact 时直接保留 `source: "estimate"`；
- exact 请求失败不能返回 0；没有 stale usage 时保留估算值并记录 `exactError`；
- 调用方明确传入上一份可信 usage 时，失败结果才可标记为 `source: "stale_usage"` 和 `stale: true`；
- Web/diagnostic 只能把 estimate 显示为 estimate，不能把它改写成 provider 实际 usage。

### 2.3 Breakdown

`TokenCountBreakdown` 单独记录：

- `systemTokens`：system prompt；
- `messageTokens`：user/assistant 普通文本；
- `toolSchemaTokens`：工具名称、描述和 JSON schema；
- `toolArgumentTokens`：assistant tool call JSON arguments；
- `toolResultTokens`：tool result model view；
- `totalTokens`：五项之和。

普通文本使用 `(length + 16) / 4` 的向上取整；结构化 JSON 使用 `(length + 16) / 2` 的向上取整。当前 `ChatMessage` 没有图像/document block，因此 M02 不伪造媒体精确计数；媒体能力进入后续 Context Assembly/attachment 模块。

## 3. Estimator 实现入口

### 3.1 `packages/context/src/estimator.ts`

公共入口：

```text
estimateContextTokens(view)
createTokenCounter(model)
countContextTokens(counter, view, options)
shouldUseExactTokenCount(estimate, snapshot, policy)
```

`createTokenCounter()` 将 `ChatModel.countTokens(request)` 适配为统一 `TokenCounter.countExact()`。它只传递当前 messages/tools 和 AbortSignal，不复制 provider SDK 或 provider-specific wire schema。

### 3.2 Exact 调用门

Runtime 每个 step 先执行快速 estimate。只有同时满足以下条件才调用 exact：

1. `ModelContextCapability.supportsExactCount === true`；
2. adapter 实际实现了 `ChatModel.countTokens()`；
3. estimate 已达到 warning threshold，或 `estimate + predictiveGrowthTokens` 已接近 effective window。

这对应 Claude Code 的“热路径保持 estimate，关键边界再做 exact”原则，避免每个普通 step 都增加 provider countTokens 往返。

### 3.3 Runtime 接入

`AgentHost.runSteps()` 的 M02 顺序：

```text
resolve M01 budget snapshot
→ build ModelContextView(messages + visible tools)
→ fast estimate
→ boundary exact count（条件满足时）
→ calculate warning/predictive state
→ M01 compact gate
→ compact 后重新 estimate（不重复 exact）
→ append step/started.tokenCount
→ collectModelResponse
```

`step/started.payload.tokenCount` 只包含计数值、source、confidence、breakdown 和 exact failure diagnosis，不包含 secret、原始凭据或未裁剪的 provider response body。

## 4. Provider 能力边界

- `ChatModel.countTokens()` 是可选 seam，旧模型无需修改；
- `ModelContextCapability.supportsExactCount` 是 host/adapter 对能力的声明，声明为 true 但没有实现 `countTokens()` 时仍安全回退 estimate；
- 当前 Echo/DeepSeek adapter 没有真实 countTokens endpoint，因此正常使用 estimate；DeepSeek 的 context capability 仍只描述窗口能力，不代表 exact token API 已接通；
- provider exact 实现后只需在 adapter 实现 `countTokens()` 并将 capability 的 `supportsExactCount` 设为 true，Runtime/预算层无需改公式。

## 5. 测试与验证

新增测试：

- `packages/context/src/estimator.test.ts`：分项 breakdown、exact 成功、exact 失败保留 estimate、显式 stale usage、exact boundary gate；
- `packages/runtime/src/index.test.ts`：接近预算边界时 provider exact count 的 source/confidence 被写入 `step/started`。

已执行：

```text
pnpm typecheck                                  ✓
pnpm test                                       ✓ all workspace tests
pnpm --filter @coding-agent/context test    ✓ 8 tests
pnpm --filter @coding-agent/runtime test    ✓ 36 tests
git diff --check                                ✓
```

## 6. M02 不包含的能力

- M03 完整 Context Assembly、附件和可复现 fingerprint；
- M04 API round、message normalize、tool pairing；
- M05 工具结果独立预算、microcompact 和原文/model-view 双存储；
- provider-specific tokenizer SDK、媒体 block 精确计数和跨 provider wire normalization；
- M09 400/413 reactive recovery。

这些能力继续按研究文档的 M03–M14 模块推进，不能把 M02 的 estimate breakdown 当作完整 context assembly。
