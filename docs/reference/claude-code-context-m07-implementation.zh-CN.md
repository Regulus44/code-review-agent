# M07 实施说明：LLM Summary Compact

状态：`implemented`
日期：2026-08-26
所属阶段：Phase 8，高级上下文能力
参考快照：`D:/Develop/claude-code`

## 1. Claude Code 入口与本项目映射

| Claude Code 入口 | 关注点 | 本项目实现 |
|---|---|---|
| `src/services/compact/compact.ts:149-227` | 摘要输入媒体和可重注入附件清理 | `packages/context/src/summary-input.ts` |
| `src/services/compact/compact.ts:247-297` | prompt-too-long 时按 API round 截断 | `packages/context/src/summary-compact.ts:truncateHeadForPtlRetry()` |
| `src/services/compact/compact.ts:411-530` | compact 主控制流、summary agent、有限重试 | `compactWithSummaryModel()`、Runtime `compactWithSummaryModel()` |
| `src/services/compact/compact.ts:1159-1180` | 摘要 agent 禁止工具 | `SummaryRequest.tools=[]`、`toolChoice=none`、`runSummaryModel()` |
| `src/services/compact/compact.ts:540-690` | summary usage、compact result | `context/summary_compacted` receipt；`summaryUsage` 与主请求分离 |

Claude Code 仅作为行为参考。本项目没有复制其代码；摘要请求使用本项目 `ChatModel`、`ModelRequest`、EventStore 和 Runtime tenant model 路由。

## 2. 摘要输入清理

`buildSummaryInput()` 永远返回新数组和新消息对象：

1. 移除内部 `messageId`，避免事件 ID进入 provider；
2. 以 `[image]`、`[document]` 替换字符串化的媒体 marker；
3. 默认移除 `kind=skill` 的 context attachment，避免摘要重复包含会在后续重建阶段再次注入的内容；
4. 复制 assistant tool call，保证摘要输入不会与主 model view 共享可变引用。

主 system prompt 不作为摘要会话正文发送。Runtime 仍在摘要成功后通过 M03 assembler 重建完整 system prompt、工具 schema 和动态 section。

## 3. SummaryRunner 契约

```ts
interface SummaryRequest {
  purpose: "context_summary";
  messages: readonly ChatMessage[];
  tools: readonly [];
  toolChoice: "none";
  attempt: number;
  signal?: AbortSignal;
}

type SummaryRunner = (request: SummaryRequest) => Promise<SummaryResponse>;
```

Runtime 使用当前 tenant 的 `ChatModel`，但通过独立 `runSummaryModel()` 发送：

- `purpose=context_summary`；
- `tools=[]`；
- `toolChoice=none`；
- 不追加 `assistant/chunk`、`assistant/message`，避免把中间摘要泄露为主会话回复；
- provider 返回任何 tool call 都转为 `SUMMARY_TOOL_USE_DENIED`，不会进入 ToolRuntime。

`ModelRequest.purpose` 同时让 adapter、审计和测试区分主 agent 请求与摘要请求。摘要 usage 只写入 summary receipt，不并入主请求 usage。

## 4. 保留窗口与摘要结果

`findRecentStartIndex()` 从会话尾部向前累计 `recentMessageTokens`，得到近期 preserved suffix；随后复用 M06 的 `adjustIndexToPreserveAPIInvariants()`，避免切断 tool call/result 或同一 response 的 streaming 片段。

如果没有可丢弃的旧消息，返回 `nothing-to-compact`，Runtime 继续 legacy 路径。成功摘要的 model view 顺序为：

```text
system messages
→ <conversation-summary> 历史摘要
→ preserved recent messages
```

摘要文本受 `maxSummaryChars` 限制，并使用不可信历史上下文 wrapper。原始 transcript 不会被改写。

## 5. Prompt-too-long（PTL）重试

`compactWithSummaryModel()` 捕获 runner 的 prompt-too-long、context length、413 和 too-many-tokens 错误：

1. 通过 `groupMessagesByApiRound()` 识别完整 API round；
2. 每次从头部删除至少一个最老 group，但始终保留至少一个 group；
3. 如果截断后首条为 assistant，插入 `[earlier conversation truncated for compaction retry]` user marker；
4. 下一次 retry 会先移除上一次 marker，保证每次都有真实进展；
5. `maxPtlRetries` 默认 3，耗尽后返回 `prompt-too-long` 结构化失败。

非 PTL 错误不会重试，返回 `summary-failed` 和错误信息。摘要为空返回 `summary-empty`。Runtime 收到失败结果后追加失败 receipt，并回退 deterministic legacy compact。

## 6. Runtime 调用顺序

`AgentHost.compactTurnContext()` 的顺序为：

```text
M06 Session Memory Compact
  → M07 LLM Summary Compact
  → legacy deterministic compact
```

M07 仅在 M06 没有成功替换消息时执行。成功后 Runtime 重新调用 M03 assembler、M04 normalize/pairing 和 M05 tool-result budget，再进行 token count 和下一次主模型请求。

## 7. Durable 事件和 projection

新增事件：

- `context/summary_started`：记录 purpose、输入消息数和 protected tool 数；
- `context/summary_retried`：记录 PTL retry 次数和保留消息数；
- `context/summary_compacted`：记录 summary usage、重试数、保留/丢弃统计和 `kind=summary`；
- `context/summary_compaction_failed`：记录结构化 reason、error、重试数和 `fallback=legacy-summary-compact`。

事件不包含完整摘要请求、provider body、工具输出或 memory 原文。Storage projector 将成功/失败状态投影到 `SessionProjection.contextCompaction`，并标记 `kind=summary`。

## 8. 测试覆盖

`packages/context/src/summary-compact.test.ts` 覆盖：

- 媒体 marker、skill attachment 和内部 ID 清理；
- 无工具 summary request 和 bounded recent suffix；
- PTL oldest-round retry、synthetic user marker 和 retry 上限；
- 摘要失败的结构化 reason。

`packages/runtime/src/index.test.ts` 覆盖：

- Runtime 使用 tool-less summary request；
- summary usage 与主请求分离；
- `context/summary_*` receipt 和 `contextCompaction.kind=summary`；
- legacy compact 不重复执行。

## 9. 边界与回滚

M07 不包含 provider prompt-cache sharing、PreCompact/SessionStart 外部 hook、compact boundary、post-compact file/plan/skill/MCP attachments、reactive overflow recovery 或 Session Memory extraction。上述能力分别留给 provider adapter、M08、M09 和 M11。

回滚 M07 时移除 summary context 模块、Runtime summary gate、四类 summary 事件及 `ModelRequest.purpose` 字段即可；M06 和现有 legacy compact 保持可用。
