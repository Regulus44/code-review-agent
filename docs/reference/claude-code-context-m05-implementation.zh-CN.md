# M05 实施说明：Tool Result Budget 与 MicroCompact

状态：`implemented`（阶段 4聚合预算与时间型 microcompact 已补齐）
日期：2026-08-26
所属阶段：Phase 8，高级上下文能力
参考快照：`D:/Develop/claude-code`

## 当前基线修订（2026-08-28，阶段 6）

阶段 3–5 已在 M05 基础上继续完成三项集成：单工具结果超过 `50000` 字符或 `100000` token 时写入 workspace artifact 并向模型提供最多 `2000` UTF-8 bytes 预览；单个 API user message 的工具结果聚合预算为 `200000` 字符，replacement receipt 可在重启后重建稳定 model view；并行工具调用由 DSH 风格 scheduler 限制为默认最多 `10` 个 in-flight，结果与 `tool/result` 事件按 assistant 声明顺序提交。时间型 microcompact 默认关闭，显式启用时使用 `60` 分钟 gap、保留最近 `5` 个结果。

当前 M05 及阶段 3–5 的入口、参数和测试证据以 [Token/Context/Tool 实施基线](token-context-tool-limits-dsh-claude-code-implementation-plan.zh-CN.md)、[阶段 4 实施日志](../archive/development-log/phase-4-tool-result-aggregate-microcompact-2026-08-28.zh-CN.md)和 [阶段 5 实施日志](../archive/development-log/phase-5-parallel-tool-scheduler-2026-08-28.zh-CN.md) 为准；本文件后续章节保留 M05 的原始设计和边界说明。

## 1. Claude Code 入口与本项目映射

| Claude Code 入口 | 关注点 | 本项目实现 |
|---|---|---|
| `src/query.ts:526-624` | 请求前释放工具结果、按 model view 计算预算 | `packages/runtime/src/index.ts:runSteps()`、`prepareModelContext()` |
| `src/services/compact/microCompact.ts:137-205` | 文本、结构化 block、image/document 的工具结果估算 | `packages/context/src/tool-result-budget.ts:estimateToolResultTokens()` |
| `src/services/compact/microCompact.ts:257-365` | 旧结果选择、最近结果保留、cleared marker | `packages/context/src/tool-result-budget.ts:microcompactTrigger()`、`applyToolResultBudgetAsync()` |
| `src/utils/toolResultStorage.ts:367-910` | 单条 API user message 聚合预算、fresh replacement 和稳定替换状态 | `packages/context/src/tool-result-budget.ts:enforceAggregateBudget()`、`ToolResultBudgetState` |
| `src/services/compact/timeBasedMCConfig.ts` | 时间型 microcompact 开关、60 分钟 gap、保留最近 5 个 | `ToolResultBudgetPolicy.timeBasedMicrocompactEnabled`、`timeBasedGapMs` |
| `src/services/compact/microCompact.ts:426-520` | 时间衰减和重复清理状态 | `toolResultTimestamps`、`alreadyClearedToolCallIds` |
| `src/services/compact/cachedMicrocompact.ts` | provider prompt-cache edit | 本阶段明确暂缓，不实现 provider-specific cache mutation |

Claude Code 仅作为行为参考。本项目没有复制其代码，使用本项目的 `ChatMessage`、EventStore、ToolRuntime、Permission projection 和 model adapter。

## 2. 模块分层

M05 的请求前路径固定为：

```text
EventStore transcript
  → ContextAssembly
  → M04 normalize
  → M04 tool pairing
  → per-result artifact view
  → single API user message aggregate budget
  → count/token/optional-time trigger
  → old compactable results → cleared marker
  → API round grouping
  → M02 token estimate/exact
  → step/started + model request
```

| 子模块 | 职责 | 输入 | 输出 |
|---|---|---|---|
| Tool name resolver | 从 assistant tool call 找到 tool result 的工具名 | `ChatMessage[]` | `toolCallId → toolName` |
| Result estimator | 估算文本、JSON、image/document block | tool result content | 近似 token 数 |
| Per-result bound | 对可压缩工具的过长结果生成 bounded model view | policy、tool result | bounded content |
| Trigger evaluator | 判断 count、tokens、time 是否触发 microcompact | eligible results、时间戳、policy | trigger |
| Microcompact selector | 保留最近 N 个，清理旧结果 | eligible results、protected IDs | cleared IDs |
| View replacement | 生成新的 model-visible `ChatMessage[]` | original messages、bounded/cleared IDs | model view |
| Durable receipt | 记录清理统计而不写入输出正文 | report | `context/*` events、step metadata |

## 3. Tool Result Budget API

入口是 `packages/context/src/tool-result-budget.ts:applyToolResultBudget()`：

```ts
interface ToolResultBudgetPolicy {
  enabled?: boolean;
  maxResultChars?: number;
  perToolResultChars?: Readonly<Record<string, number>>;
  microcompactTriggerToolCount?: number;
  microcompactTriggerTokens?: number;
  keepRecentResults?: number;
  timeBasedMicrocompactEnabled?: boolean;
  timeBasedGapMs?: number;
  maxToolResultsPerMessageChars?: number;
  compactableTools?: readonly string[];
}
```

默认值：`maxResultChars` 不自动启用（阶段 3单结果 artifact 阈值负责大结果），`maxToolResultsPerMessageChars=200000`、`microcompactTriggerToolCount=10`、`microcompactTriggerTokens=20000`、`keepRecentResults=5`、`timeBasedMicrocompactEnabled=false`、`timeBasedGapMs=60min`。默认白名单覆盖 `read_file`、`bash`、`pwsh`、`grep`、`glob`、`web_search`、`web_fetch`、`edit_file`、`write_file`。

旧 `contextBudget.maxToolResultChars` 由 `AgentHost.toolResultBudgetWithLegacyFallback()` 映射到 `maxResultChars`，保证旧配置继续可用。

## 4. 结果估算与 bounded view

`estimateToolResultTokens()` 使用 provider-neutral 估算：普通文本和 JSON 使用 `(content.length + 16) / 4` 的保守估算；顶层 JSON array 中的 `image` / `document` block 使用额外媒体成本，再叠加文本成本；解析失败时回退到纯文本估算。该估算只用于触发和诊断，不宣称 provider exact count。

当前 `ToolResultContextView.originalMessageIndex` 是 canonical model view 中的消息索引；EventStore sequence 仍由 durable `tool/result` 事件保存，后续 boundary 模块再建立 message-to-event 映射。

bounded view 只改变请求消息：

```text
原始结果：完整输出（EventStore 保留）
model view：前缀 + "[tool result bounded by context budget]"
```

当字符上限小于 marker 长度时，marker 自身被截到上限，保证 bounded 结果不会再次突破 per-result budget。protected tool result 不进行 bounded 或 cleared，避免待批准、待交互和不可安全重放的状态被隐藏。

## 5. MicroCompact 触发和选择

`microcompactTrigger()` 的判断顺序是：

1. eligible 结果数量不超过 `keepRecentResults`：不触发；
2. 数量达到 `microcompactTriggerToolCount`：`count`；
3. bounded model view 的 eligible token 总量超过 `microcompactTriggerTokens`：`tokens`；
4. 最老且有有效 `createdAt` 的 eligible 结果超过 `timeBasedGapMs`：`time`；
5. 否则返回 `none`。

触发后按 transcript 顺序从旧到新选择，保留最后 `keepRecentResults` 个 eligible 结果。不可压缩工具、protected tool call、已经是 cleared marker 的结果都不会进入清理候选。cleared marker 为 `[Old tool result content cleared]`。

再次运行时 marker 继续出现在 model view 中；`alreadyClearedToolCallIds` 只用于抑制重复 receipt，不会把结果重新展开，也不会删除 transcript 原文。

## 6. Runtime 接入与保护规则

`packages/runtime/src/index.ts:runSteps()` 为每个 turn 维护 `alreadyClearedToolCallIds`、`reportedBudgetToolCallIds` 和 `reportedMicrocompactToolCallIds`。每个 step：

1. 从 projection 收集 pending permission/interactions 对应的 tool call IDs；
2. 从 EventStore 收集 `tool/result.createdAt`；
3. 组装 M03 context；
4. 执行 M04 normalize + pairing；
5. 执行单结果 artifact、单消息 aggregate budget 和 M05 count/token/optional-time microcompact；
6. 使用同一份 `prepared.view` 做 token count 和 provider request；
7. tool loop 产生新结果后，下一 step 重新执行上述路径；
8. summary compact 后重新组装并重新执行 M04/M05。

Runtime 不会把“用于计数的工具结果”与“用于发送的工具结果”分成两套，也不会把清理后的 marker 写回 `tool/result` 事件。

## 7. Durable 事件与 step 诊断

新增事件类型：

- `context/tool_results_budgeted`：记录首次 bounded/cleared 的 IDs、触发器、节省 token 和 protected IDs；
- `context/microcompacted`：记录 `trigger`、`clearedToolCallIds`、`newlyClearedToolCallIds`、`keptRecent`、`tokensSaved` 和 `protectedToolCallIds`。

事件不保存完整工具输出、prompt、provider body 或 secret。同一 tool call 的 microcompact receipt 由 turn 内集合去重；Runtime 重启后从原始 transcript 重新计算。

`step/started.payload.toolResultBudget` 包含 enabled/changed/trigger、bounded/cleared/newly-cleared 数量和 IDs、tokensSaved、protected IDs 以及生效 policy 摘要。

阶段 4增加 `messageBudgetChars`、`messageBudgetMessagesOverBudget`、`messageBudgetReplacedToolCallIds`、`microcompactTrigger`、`timeBasedMicrocompactEnabled` 和 `timeBasedGapMs`，供 Storage projection 和 Web replay 使用。

## 8. 测试覆盖

`packages/context/src/tool-result-budget.test.ts` 覆盖 full result、per-result bound、count/time/token trigger、最近 N 个保留、protected/non-compactable 排除、重复 apply、tokensSaved、image/document 估算和输入不修改。

`packages/runtime/src/index.test.ts` 覆盖 model request 的 cleared view、两个 M05 receipt、step 诊断和 EventStore 原始 `tool/result` 完整性。

## 9. 边界与回滚

M05 不包含 provider-specific cached prompt edit、Session Memory compact、LLM summary compact、compact boundary、prompt-too-long recovery、UI projection 或跨会话 memory。回滚 M05 时删除预算 gate、两个事件类型和对应诊断字段即可；M04 normalize/pairing 与 M02 estimator 仍可独立运行。
