# M10 实施说明：Transcript、Boundary Replay 与 Session Restore

状态：`implemented`
日期：2026-08-26
所属阶段：Phase 8，高级上下文能力（8.1 Context Compaction）
参考快照：`D:/Develop/claude-code`

## 1. 任务范围

1. Phase：Phase 8 / M10，依赖 M01–M09。
2. 问题类型：让 compact 后的 model view 可以从持久化 transcript 和 boundary 在重启、重连、跨进程打开后确定性重建。
3. 契约影响：新增 `ContextTranscriptSegment`、`ContextSessionRestoreProjection`、`context/transcript_segment`、`context/session_restored`，并为 boundary 增加 `algorithmVersion`。
4. Claude Code 参考：`src/services/sessionTranscript/`、`src/utils/sessionRestore.ts`、`src/utils/messages.ts:5043-5090`。
5. 上游来源：只登记为 `behavior-reference`，没有复制 Claude Code 代码。
6. 验收场景：完整原始消息继续保留；compact boundary 能指向 durable transcript 的 head；SQLite reopen 和 Host restart 后 model view 顺序、boundary、附件一致；锚点失效时完整 transcript 安全回退。
7. 回滚方式：移除 transcript segment/restore projection、replay builder 和 Runtime restore receipt，回到 M09 的 M08 boundary 读取路径；旧 `context/compacted`、`context/compact_boundary` 事件仍可读取。

## 2. Claude Code 入口对照

| Claude Code 入口 | 代码职责 | 本项目入口 |
|---|---|---|
| `src/services/sessionTranscript/sessionTranscript.ts` | transcript segment 写入、日期切换 flush；当前本地快照是 stub，不能直接复制 | `EventStore.append()`；所有原始 user/assistant/tool 事件已经按 sequence 落盘 |
| `src/utils/messages.ts:isCompactBoundaryMessage()` | 识别 compact system marker | `packages/context/src/boundary.ts:isCompactBoundaryMessage()` |
| `src/utils/messages.ts:findLastCompactBoundaryIndex()` | 从消息尾部查找最近 boundary | `packages/context/src/boundary.ts:findLastCompactBoundaryIndex()` |
| `src/utils/messages.ts:getMessagesAfterCompactBoundary()` | boundary 后切片，保留 model-visible suffix | `restoreModelViewFromTranscript()`，增加 durable head 校验和 fallback |
| `src/utils/messages.ts` 的 boundary annotation 逻辑 | 记录 head/anchor/tail，使压缩后的消息链可重连 | `packages/context/src/boundary.ts:annotateBoundaryWithPreservedSegment()` |
| `src/utils/sessionRestore.ts:restoreSessionStateFromLog()` | 从日志恢复 file history、context-collapse、Todo 等 session state | `packages/storage` 的 `applyEvent()` projection replay；Runtime 在每个 resumed turn 重新构建 context |
| `src/utils/sessionRestore.ts:processResumedConversation()` | resume/fork 时恢复 session metadata、worktree、agent 和 context state | `AgentHost` 构造时 `restoreQueuedTurns()`，发送 turn 时 `conversationMessages()` + `recordSessionRestore()` |

Claude Code 的 JSONL loader 在本地快照中不是可复用实现，因此本项目把“日志文件读取”改写成 EventStore replay：事件 envelope 的 `sequence/eventId/turnId` 作为 durable identity，projection 和 model view 使用两个不同 reducer。

## 3. 总体分层

| 层 | 持久化事实 | 投影/重建职责 | 本项目实现 |
|---|---|---|---|
| Transcript | user/message、assistant/message、tool/result 等原始事件永久保留 | 提供完整、按 sequence 排序的历史 | InMemory/SQLite `EventStore.list()` |
| Compact metadata | boundary、summary、preserved head/anchor/tail、algorithm version | 只描述 model view 应从哪里开始 | `context/compact_boundary` → `contextCompaction` |
| Transcript segment link | boundary 与原始 transcript head 的 durable link | 防止运行时 ID 与事件 ID 混用 | `context/transcript_segment` → `contextTranscript` |
| Replay builder | 完整 transcript + boundary/segment/summary | 生成 boundary → summary → preserved suffix | `restoreModelViewFromTranscript()` |
| Session restore receipt | 本次恢复采用 boundary replay 或 legacy fallback 的事实 | 供 API/Web/审计读取最近恢复决定 | `context/session_restored` → `contextRestore` |
| Runtime integration | turn start/restart/queue resume | 在发送模型前调用 replay；恢复成功追加 receipt | `conversationMessages()`、`runTurn()`、`runRecoveredTurn()` |

核心数据流：

```text
EventStore transcript (完整原文)
        + context/compact_boundary
        + context/transcript_segment
        + contextCompaction.summary
        ↓
restoreModelViewFromTranscript()
        ├─ boundary + durable head 可定位
        │    → boundary marker → summary → transcript suffix
        └─ boundary/head/segment 不可信
             → 完整 transcript fallback
        ↓
assembleTurnContext() → normalize/pair → token budget → provider
```

## 4. Durable 契约

### 4.1 `ContextBoundaryMetadata.algorithmVersion`

`packages/contracts/src/index.ts` 为 boundary 增加可选 `algorithmVersion`。M10 新生成的 boundary 使用 `m10.v1`；读取 M08 旧事件时没有该字段，Runtime 显示兼容值 `legacy-boundary-v1`，不会拒绝旧事件。

该版本只标识重建算法，不标识 provider、模型或 prompt 内容。完整摘要、附件原文和工具输出继续不进入 boundary payload。

### 4.2 `ContextTranscriptSegment`

```ts
interface ContextTranscriptSegment {
  version: 1
  boundaryId: string
  algorithmVersion: string
  sourceSequence: number
  headMessageId?: string
  anchorMessageId?: string
  tailMessageId?: string
  createdAt: string
}
```

`headMessageId` 必须对应 EventStore transcript 中的 message identity。M10 修复了一个关键身份边界：新 user/assistant message 使用 append 返回的 `eventId`，不再把只存在于 Runtime 内存的 `turnId` 或 `responseId` 写入 preserved head。重启后的 `conversationMessages()` 同样使用事件 `eventId`，因此 head 可以被稳定定位。

### 4.3 `context/session_restored`

事件 payload 保存：

```text
mode: boundary | legacy
boundaryId?
algorithmVersion?
sourceSequence?
reason
```

Storage 只投影最近一次恢复决定。该事件不复制消息，也不改变 transcript；它是可观察的恢复 receipt。

## 5. Replay builder 实现

文件：`packages/context/src/transcript-replay.ts`

`restoreModelViewFromTranscript()` 是纯函数，输入为完整 transcript、可选 boundary、可选 transcript segment 和 summary，返回新数组，不修改任何输入。

处理顺序：

1. boundary 和 segment 都不存在：返回完整 transcript，原因 `no_boundary`。
2. 只有 segment 没有 boundary：拒绝仅凭 segment 截断，返回完整 transcript，原因 `boundary_without_head`。
3. segment.boundaryId、sourceSequence、anchorMessageId 或 algorithmVersion 与 boundary 不一致：返回完整 transcript，原因 `boundary_mismatch`。
4. 没有 preserved head：返回完整 transcript，原因 `boundary_without_head`。
5. head 不在 transcript 中：返回完整 transcript，原因 `boundary_head_missing`。
6. head 可定位：生成新的 boundary system marker，插入 summary，再追加 `transcript.slice(preservedIndex)`。

实现中的安全边界是“无法证明截断点就不截断”。这对应 Claude Code 的 boundary 后切片行为，但增加了 EventStore 场景所需的 stale/mismatch 防护，避免 projection 损坏时静默丢历史。

输出顺序：

```text
Conversation compacted / Context microcompacted
→ <conversation-summary> 或已有 compact summary
→ durable head 开始的原始 transcript suffix
```

附件不写入 replay builder。`assembleTurnContext()` 在 replay 后继续调用 `postCompactAttachmentsForSession()`，按 M08 的 attachment ID 和 token budget 恢复 plan/file 等 bounded attachment。

## 6. Runtime 接入点

### 6.1 `conversationMessages()`

文件：`packages/runtime/src/index.ts`

该函数先按 EventStore sequence 将 user、assistant、tool/result 转成完整 `ChatMessage[]`：

- user/turn-steered：使用 `event.eventId` 作为 `messageId`；
- assistant：使用 `event.eventId`，同时恢复 `responseId` 和 tool calls；
- tool/result：使用 `event.eventId`，保留完整 `ToolResult` 供重放和审计。

随后读取 `SessionProjection.contextCompaction.boundary`、`contextTranscript` 和 summary，调用 replay builder。该函数不删除事件，不修改 projection，也不把 bounded model view 写回 transcript。

### 6.2 新 turn 的 durable user identity

`sendMessageInternal()` 先读取旧 model view，再 append `user/message`，从 append 返回值取得 `eventId`，将它放入 `PendingTurn.userMessageId`。`runTurn()` 把该 ID 用于当前 user message；Host restart 的 `restoreQueuedTurns()` 从历史 user/message 事件恢复相同 ID。

这样 boundary 在“当前 turn 的 user message 被保留”时也能跨重启定位。若只使用 `turnId`，内存中的 compact view 可以工作，但 SQLite reopen 后 transcript 只有 `eventId`，会错误触发完整历史 fallback。

### 6.3 assistant/tool identity

assistant/message append 的返回 `eventId` 被写入当前 model view。tool/result 在 ToolRuntime 完成后按 `turnId + toolCallId` 从 EventStore 找到对应 event，优先使用该 eventId，找不到时保留 tool call ID 作为兼容 fallback。该处理保证常见的 user、assistant、tool preserved segment 都使用 durable identity。

### 6.4 restore receipt

`runTurn()` 和 `runRecoveredTurn()` 在 assemble 前调用 `recordSessionRestore()`。当 previous model view 包含 boundary marker 时追加 `context/session_restored`，携带 boundary ID、算法版本、source sequence 和 `durable_boundary_replay` 原因。事件追加后才继续 provider request，保证恢复事实先进入 EventStore。

## 7. Storage projection 与跨进程恢复

文件：`packages/storage/src/index.ts`

- `contextTranscriptSegment()` 对 version、ID、algorithmVersion、sourceSequence、createdAt 和可选 head/anchor/tail 做 bounded 解析；
- `context/session_restored` 只接受 `boundary` 或 `legacy` 两种 mode，限制字符串长度和 source sequence；
- InMemory 与 SQLite 共用 `applyEvent()` 语义，SQLite reopen 读取 projection JSON；
- projection 损坏时 SQLite 仍可用事件表重建，M10 新事件会在重建过程中重新得到 `contextTranscript/contextRestore`。

EventStore 仍是唯一事实来源：`contextTranscript` 和 `contextRestore` 是查询加速与 Web 投影，不取代原始 transcript。

## 8. 测试覆盖

| 测试 | 场景 |
|---|---|
| `packages/context/src/transcript-replay.test.ts` | boundary + summary + suffix；stale head fallback；segment 缺 boundary；boundary ID mismatch；输入 transcript 不可变；无 boundary legacy |
| `packages/runtime/src/index.test.ts` | M08 boundary 增加 `m10.v1` 和 transcript segment；Host restart 后恢复 boundary、plan/file attachment 和 `context/session_restored`；model request 顺序保持一致 |
| `packages/storage/src/index.test.ts` | SQLite 写入 transcript segment/restore receipt，close/reopen 后 projection 保持 boundary ID、算法版本、restore mode 和 source sequence |

验证命令：

```text
pnpm typecheck
pnpm --filter @code-review-agent/context test -- --run
pnpm --filter @code-review-agent/storage test -- --run
pnpm --filter @code-review-agent/runtime test -- --run
pnpm test
git diff --check
```

## 9. 兼容与边界

- M08 boundary 没有 `algorithmVersion` 时仍可读取，按 `legacy-boundary-v1` 记录恢复版本。
- 旧 transcript 没有 M10 segment 时，已有 boundary 的 `preservedSegment.headMessageId` 仍可作为 fallback anchor；两者都缺失时使用完整 transcript。
- segment 只有 head 但 boundary 缺失时绝不截断，避免仅凭孤立指针丢历史。
- head stale、segment/boundary mismatch、projection 不完整时返回完整 transcript；当前实现不会猜测最近消息或按 sequence 强行截断。
- replay 不会重复追加 compact boundary、transcript segment 或修改 transcript；只有实际 resumed turn 才追加 restore receipt。
- M10 不实现 Claude Code 的 JSONL 文件轮转、context-collapse、Session Memory extraction、Project Memory、hooks、provider cache edit 或商业遥测。

## 10. 回滚

回滚 M10 时：

1. 移除 `restoreModelViewFromTranscript()` 及 `contextTranscript`/`contextRestore` projection 字段；
2. 停止追加 `context/transcript_segment` 和 `context/session_restored`；
3. Runtime 恢复到 M08 的 boundary + in-memory message slice；
4. 保留已经落盘的 M10 事件，旧 Runtime 忽略未知事件类型，或在迁移脚本中将其标记为历史扩展；
5. 不删除原始 user/assistant/tool transcript，也不回滚 M01–M09 的预算、compact 和 recovery 事件。
