# P8.5-MR6 实施说明：Retry、Fallback 与模型发现收敛

状态：`implemented`

日期：2026-08-27

## 目标与参考映射

本切片统一 provider failure taxonomy、重试边界、retry-after、fallback 和诊断字段，
并复用 M09 的 Context recovery。结构参考 DSH：
`D:/Develop/deepseek-harness-fork/packages/llm/llm/src/index.ts` 的 `LlmError`、
`adapterFailureChunk()` 与 provider retry policy；行为参考 Claude Code：
`D:/Develop/claude-code/src/services/api/withRetry.ts` 的 `getRetryDelay()`、
`getRetryAfterMs()`、`shouldRetry()`，以及 `src/services/api/errors.ts` 的 401/403/413/429/529
分类。仅自行实现兼容行为，未复制 Claude Code 源码。

## 实施内容

### 1. 统一 failure taxonomy

`packages/llm/src/failures.ts` 新增 bounded `ModelFailureCode`、`ModelFailureError`、
`modelFailureMetadata()`、`parseRetryAfter()` 和脱敏函数。稳定码包括：
`ABORTED`、`TIMEOUT`、`AUTH`、`RATE_LIMIT`、`OVERLOADED`、`CONTEXT_WINDOW_EXCEEDED`、
`STREAM_CLOSED`、`NETWORK`、`PROTOCOL_ERROR`、`CONFIGURATION`、`PROVIDER_ERROR`。
`ModelProviderError` 与 `AnthropicMessagesError` 保留 provider code，同时暴露稳定
`failureCode`、`retryable`、`retryAfterMs`、`requestId` 和 `partialOutput`。

### 2. Retry ownership 与 retry-after

OpenAI-compatible 与 Anthropic adapter 只在收到响应前执行有限的 host-owned retry：主 Agent
请求最多两次，`context_summary` 辅助请求一次。429、529、5xx 和网络错误可重试；
`Retry-After` 支持秒数和 HTTP-date，并受 30 秒退避上限约束。abort 不再进入重试。
响应只读取 bounded message/code、request id 和 retry-after，不保存 provider response body。

### 3. Fallback 与 Context recovery

`packages/runtime/src/index.ts:collectModelResponse()` 继续拥有候选模型 fallback：
仅 pre-output failure 可切换；已有文本或工具调用增量（包括仅收到 tool-call start/delta）
后设置 `partialOutput=true` 并禁止 fallback。413/context-window failure 继续进入已有
`packages/context/src/recovery.ts` 与 M09 reactive compact，不被当作普通 fallback。

`agent/error` 事件增加稳定 failure code、retryable、retry-after、request id 和 partial
output 等 bounded 诊断字段；不写入 provider body、token、headers 或 credential material。

## 验收

- `pnpm typecheck`
- `pnpm --filter @code-review-agent/llm test -- --run`
- `pnpm --filter @code-review-agent/context test -- --run`
- `pnpm --filter @code-review-agent/runtime test -- --run`
- `git diff --check`

回滚时可移除 failure taxonomy 与 adapter retry 包装，恢复现有一次网络 retry 和
AgentHost fallback；M01–M09 Context/Event contract 保持兼容。
