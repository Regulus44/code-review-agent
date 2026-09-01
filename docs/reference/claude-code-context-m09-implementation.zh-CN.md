# M09 实施说明：Query Proactive 与 Reactive Recovery

状态：`implemented`
日期：2026-08-26
所属阶段：Phase 8，高级上下文能力
参考快照：`D:/Develop/claude-code`

## 1. Claude Code 入口与本项目映射

| Claude Code 入口 | 关注点 | 本项目实现 |
|---|---|---|
| `src/query.ts:584-888` | 请求前 snip/microcompact/autocompact、blocking gate、predictive compact | `packages/runtime/src/index.ts:runSteps()`，复用 M01–M08 的 canonical model view |
| `src/query.ts:1041-1124` | 流式错误 withholding、recoverable error 不立即暴露 | `collectModelResponse()` 保留 provider error，Runtime 在请求边界执行分类与 recovery |
| `src/query.ts:1349-1470` | prompt-too-long/media recovery、collapse drain、reactive compact、retry transition | `runSteps()` 的 `collectModelResponse()` catch 分支；成功后 `continue` 回到 query loop |
| `src/query.ts:1582-1587` | reactive guard 保留，避免 stop hook → compact → 413 死循环 | `ContextRecoveryGuard` 的 per-turn attempt/circuit 状态 |
| `src/services/compact/autoCompact.ts:52-60,270-380` | consecutive failure circuit breaker、成功清零 | `packages/context/src/recovery.ts:ContextRecoveryGuard` |
| `src/services/compact/reactiveCompact.ts` | PTL/media 分类、单次 emergency compact、失败后直接暴露 | `classifyProviderContextError()`、`isReactiveContextError()`、Runtime recovery events |

Claude Code 仅作为行为参考。本项目没有复制其代码；压缩仍由 M06/M07/legacy compact 实现，M09 只增加请求失败后的恢复状态机、错误分类、重试边界和诊断事件。

## 2. Recovery 错误分类

`classifyProviderContextError()` 从错误对象的 `status/statusCode/httpStatus/response.status`、`code/providerCode` 和 bounded message 中提取最小诊断字段：

| 分类 | 识别条件 | M09 行为 |
|---|---|---|
| `prompt_too_long` | HTTP 413，或 `context_length_exceeded`、prompt/context too long、too many tokens 等关键词 | 允许一次 reactive compact 后重试原请求 |
| `media_too_large` | prompt-too-long 同时包含 image/media/document/pdf/attachment/payload-too-large | 允许一次 reactive compact；若保留区仍包含过大媒体，第二次错误直接暴露 |
| `tool_pairing` | tool call/result pairing、orphan、missing、invalid 等错误 | 不进入 M09 compact；交给 M04 pairing gate 或 provider 错误处理 |
| `schema` | schema、validation、malformed、invalid request/message 等错误 | 不进入 M09 compact，避免把协议错误误判为容量问题 |
| `other` | 其余错误 | 保持原有 fallback/agent error 行为 |

分类器只保存 status、code、providerCode 和最多 500 字符 message。Provider body、认证信息和完整请求不会进入事件。

## 3. Request fingerprint 与 per-turn guard

`fingerprintModelRequest()` 对 model-visible messages、tool schema、tool choice、reasoning effort 和 purpose 做稳定序列化，再生成 `ctxreq_<16 hex>` SHA-256 前缀。字段排序稳定、数组顺序保留；`messageId` 等内部事件标识不参与 hash。该 hash 用于关联原始失败请求和恢复后的 retry，不替代 EventStore sequence。

`ContextRecoveryGuard` 每个 `runSteps()` 实例创建一次，因此天然按 turn/session 隔离：

- `maxReactiveAttempts` 默认 1，同一个 turn 不会重复 reactive compact；
- `consecutiveCompactionFailures` 默认阈值 3，连续主动/反应式 compact 失败后打开 circuit；
- compact 成功清零连续失败计数；
- `attemptedModules` 记录 `proactive_compact`、`reactive_compact` 等已尝试模块；
- circuit 打开后不会继续调用 compact，也不会因 provider 413 进入递归重试。

## 4. Proactive 路径

`runSteps()` 继续在 provider 请求前执行 M01/M02 gate：

```text
assemble → normalize/pair → tool-result budget → token estimate/exact
→ warning state → proactive compact → rebuild M08 view → provider request
```

当 `shouldCompactBeforeRequest()` 为真且 circuit 未打开时：

1. 计算本次 model-visible request hash；
2. 追加 `context/recovery_started`，transition reason 为 `proactive_compact`；
3. 调用现有 `compactTurnContext()`；
4. compact 成功追加 `context/recovery_succeeded`，并重新 assemble/count；
5. compact 无变化或失败追加 `context/recovery_failed`；达到阈值时追加 `context/recovery_circuit_open`。

`compactTurnContext()` 现在返回 boolean：session memory、summary 或 legacy compact 成功并重建 boundary 时返回 true；没有可压缩内容或发生异常时返回 false。已有 `context/*compaction_failed` receipt 继续保留，M09 recovery event 只记录状态和诊断，不重复保存摘要正文。

## 5. Reactive 路径

Provider 已返回错误后，`collectModelResponse()` 将可识别的容量错误直接交给 `runSteps()`，不再把 prompt-too-long 当作普通 fallback。Runtime 执行以下状态机：

```text
provider error
  ├─ 非 PTL/media → 原有错误路径
  └─ PTL/media + guard 可用
       → recovery_started
       → compactTurnContext（不重新进入 runSteps）
       ├─ 成功 → recovery_transition → recovery_succeeded → continue query loop
       └─ 失败 → recovery_failed → [达到阈值时 circuit_open] → 暴露原错误
```

恢复成功后继续使用同一个 `turnId` 和原始任务，不创建新的 user message 或 assistant message。下一步重新执行 M03 assembler、M04 pairing、M05 tool-result budget 和 M02 token count。provider 错误发生在已有 text delta 之后时，Runtime 标记 `partialOutput` 并跳过 reactive compact，避免把不完整 assistant 输出误当成可恢复响应。

Reactive compact 不调用 stop hook；当前 Runtime 没有 stop-hook 注入路径，未来接入时必须保持该边界。恢复失败不会再次注入 recovery attachment，也不会递归调用主动 gate。

## 6. Provider adapter 状态传递

`packages/llm/src/index.ts` 新增 `ModelProviderError`：

- 保留 HTTP status；
- 从非 2xx JSON body 中只提取 bounded `message/code`；
- 错误消息仍以 `LLM request failed with HTTP <status>` 开头，兼容旧调用方；
- `ModelStreamPart.error` 增加可选 `status`、`providerCode` 字段，供自定义 adapter 直接传递 provider 诊断。

网络错误仍不伪造 HTTP status；只有明确的 provider status/code 才会参与容量分类。

## 7. Durable Event 与 Projection

新增事件：

- `context/recovery_started`
- `context/recovery_transition`
- `context/recovery_succeeded`
- `context/recovery_failed`
- `context/recovery_circuit_open`

事件 payload 统一包含或按场景提供：

```text
requestHash
errorClass
providerStatus?
providerCode?
attempt
attemptedModules
transitionReason
error?
```

`SessionProjection.contextRecovery` 只保存最近一次 recovery 状态，包含 version=1、status、hash、分类、provider status/code、attempt、模块列表、transition reason、时间和 bounded error。Storage 的 InMemory/SQLite replay 走同一 `applyEvent()` reducer，不依赖进程内 guard 状态。事件和 projection 均不保存 provider body、完整 prompt、工具输出、凭据或 secret。

## 8. 测试覆盖

- `packages/context/src/recovery.test.ts`：PTL/media/tool pairing/schema 分类、稳定 request hash、reactive attempt 上限和三次失败 circuit breaker。
- `packages/runtime/src/index.test.ts`：provider 413 → summary compact → 同 turn retry 成功；恢复事件、attempt、provider status 和 request hash；不同 guard 状态隔离。
- `packages/storage/src/index.test.ts`：recovery started/succeeded replay 到 `contextRecovery`，字段受 bounded projection 约束。
- `packages/llm/src/index.test.ts`：既有 SSE/错误适配回归。

验证命令：

```text
pnpm --filter @coding-agent/context test -- --run   ✓
pnpm --filter @coding-agent/storage test -- --run   ✓
pnpm --filter @coding-agent/runtime test -- --run    ✓
pnpm --filter @coding-agent/llm test -- --run        ✓
pnpm typecheck                                           ✓
```

## 9. 边界与回滚

M09 不实现 Claude Code 的 context collapse、provider prompt-cache edit、SessionStart/PreCompact hooks、Session Memory extraction、完整 transcript restore 或 Web context inspector。M09 复用 M06/M07/M08 的 compact、summary、boundary 和 attachment rebuild，不改变 transcript/model-view 分离。

回滚 M09 时移除 `packages/context/src/recovery.ts`、Runtime recovery catch/guard、`ModelProviderError` 状态传递、五类 recovery 事件及 `contextRecovery` projection；已有 M01–M08 compact 事件和 model view 不需要迁移。
