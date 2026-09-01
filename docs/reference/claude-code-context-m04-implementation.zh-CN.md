# M04 实施说明：API Round、Message Normalize 与 Tool Pairing

状态：`implemented`  
日期：2026-08-26  
所属阶段：Phase 8，高级上下文能力  
参考快照：`D:/Develop/claude-code`

## 1. Claude Code 入口与本项目映射

| Claude Code 参考 | 关注点 | 本项目实现 |
|---|---|---|
| `src/services/compact/grouping.ts:22-63` | 按 assistant response ID 分 API round，不按 user turn 切分 | `packages/context/src/api-round.ts:groupMessagesByApiRound()` |
| `src/utils/messages.ts:2292-2670` | provider request 前的消息规范化、字段清理和 streaming 合并 | `packages/context/src/api-normalize.ts:normalizeMessagesForAPI()` |
| `src/utils/messages.ts:5591-5947` | tool_use/tool_result 配对、duplicate/orphan/missing repair | `packages/context/src/tool-pairing.ts:ensureToolResultPairing()` |
| `src/query.ts` | 每次模型请求前执行 validator，并在恢复/压缩后重新构造请求 | `packages/runtime/src/index.ts:prepareModelContext()`、`runSteps()` |

Claude Code 只作为行为和职责参考。本项目没有复制其实现代码，所有消息、事件、工具和权限边界使用本项目自己的 contracts。

## 2. API Round 分组

`groupMessagesByApiRound()` 接收带可选 `responseId` 的 `ChatMessage[]`，输出：

```ts
interface ApiRound {
  readonly index: number;
  readonly responseId?: string;
  readonly messages: readonly ChatMessage[];
}
```

算法规则：

1. 从第一条消息开始建立当前 round；
2. assistant 消息带有新的 `responseId` 且当前 round 已经存在不同 response ID 时，关闭旧 round；
3. 同一 response ID 的 streaming assistant chunks、tool calls 和 tool results 保持在同一 round；
4. 没有 response ID 的历史保持在当前 round，不凭 user message 人为切段；
5. round index 按最终输出顺序从 0 开始。

这保证一次用户请求触发多个 assistant/tool loop 时，压缩或 pairing 可以在 API round 边界上工作。

## 3. Message Normalize

`normalizeMessagesForAPI()` 支持两种模式：

| 模式 | 行为 |
|---|---|
| `repair` | 返回规范化消息，并记录修复问题 |
| `strict` | 发现问题时保留原输入，报告 `valid: false`，由 Runtime fail-closed |

当前规范化规则：

- system message 统一移动到请求前缀；
- 同一 `responseId` 的相邻 assistant chunks 合并 content 和 toolCalls；
- tool name 去除首尾空白，空 name 的 tool call 丢弃；
- 空 tool call ID 生成确定性的 `normalized_call_<message>_<call>`；
- 空 arguments 归一化为 `{}`；
- 空 tool result ID 的消息在 repair 模式移除；
- 所有修改只产生新的消息数组，不修改 EventStore 原始 transcript。

`MessageNormalizationReport` 记录 `issueCodes`、合并数量、丢弃数量、mode 和 changed 状态。报告不包含工具输出原文或敏感内容。

## 4. Tool Pairing

`ensureToolResultPairing()` 对 assistant tool calls 和后续连续 tool result 做双向校验：

| 问题 | repair 模式 | strict 模式 |
|---|---|---|
| duplicate tool call ID | 保留第一次，移除后续重复 call | 报告失败并保留输入 |
| duplicate tool result | 保留第一次，移除后续结果 | 报告失败并保留输入 |
| missing tool result | 插入 deterministic synthetic error result | 报告失败并保留输入 |
| orphan tool result | 移除孤儿结果 | 报告失败并保留输入 |
| tool result 不在 assistant round 后 | 移除并报告 | 报告失败并保留输入 |

synthetic result 只进入 model-visible view，内容为有界的结构化错误：

```json
{"ok":false,"error":{"code":"MISSING_TOOL_RESULT","message":"The tool result was missing from the model-visible history."}}
```

原始事件和工具审计结果不被删除。`ToolPairingReport` 记录 issue、synthetic 数量、移除孤儿数量和移除重复 call 数量。

## 5. Runtime 共同 request gate

M03 assembly 完成后，Runtime 的每个 step 执行：

```text
ContextAssembly
  → normalizeMessagesForAPI
  → ensureToolResultPairing
  → groupMessagesByApiRound
  → M02 token estimate/exact
  → step/started
  → model.stream(normalized + paired view)
```

compact 后会重新走完整 gate，确保 token 计数和 provider request 使用同一份合法消息。tool loop 产生的新 assistant/tool history 也会在下一 step 重新走 gate。

Runtime 新增 `AgentHostOptions.messageValidationMode`，默认是 `repair`；设置为 `strict` 后，任何 normalize/pairing issue 都以 `MODEL_MESSAGE_VALIDATION_FAILED` 结束本次 turn，不调用模型。

## 6. Durable request/response identity

每个 model step 生成 `modelRequestId`，写入 `step/started.payload`。成功的 assistant response 写入：

```text
assistant/message.payload.requestId
assistant/message.payload.responseId
```

`conversationMessages()` 从 EventStore 恢复 `responseId`，因此 restart/replay 后 API round grouping 不依赖进程内状态。旧事件没有 ID 时仍可兼容，消息会落入无 ID round。

## 7. Repair/strict 事件

repair 实际发生时追加：

- `context/messages_normalized`：记录 normalize mode、issue codes、合并/丢弃数量；
- `context/tool_pairing_repaired`：记录 pairing issue codes、synthetic result、孤儿移除和重复 call 移除数量。

`step/started.payload.messageValidation` 同时记录：

- `apiRoundCount`、`apiRoundResponseIds`；
- normalize/pairing 是否改变消息；
- issue code 列表和计数；
- synthetic/removed 统计。

事件只保存诊断元数据，不保存完整 prompt、工具结果、provider body 或 credential。

## 8. 测试覆盖

- `packages/context/src/api-round.test.ts`
  - response ID 分组；
  - 同一 response 的 streaming/tool loop 保持同 round。
- `packages/context/src/api-normalize.test.ts`
  - assistant chunk 合并；
  - ID/arguments repair；
  - strict 保留原输入。
- `packages/context/src/tool-pairing.test.ts`
  - missing/orphan repair；
  - duplicate strict failure。
- `packages/runtime/src/index.test.ts`
  - request/response identity；
  - validation metadata；
  - strict gate 不调用模型；
  - tool loop 后 assembly 和 round metadata 可继续工作。

验证命令：

```text
pnpm typecheck
pnpm test
pnpm --filter @code-review-agent/context test
pnpm --filter @code-review-agent/runtime test
git diff --check
```

## 9. 后续边界

M04 不实现工具结果预算、microcompact、缓存 edit、summary agent、compact boundary 或 overflow recovery。M05 只在本 M04 gate 之上增加 transcript/model-view 分离和工具结果局部释放。

