# M10 开发日志：Transcript、Boundary Replay 与 Session Restore

状态：`implemented`
日期：2026-08-26
阶段：Phase 8 / M10
checkpoint：独立提交 `feat(phase8): implement durable transcript session restore M10`
参考：`D:/Develop/claude-code/src/services/sessionTranscript/`、`src/utils/sessionRestore.ts`、`src/utils/messages.ts:5043-5090`

## 任务七问

1. Phase：Phase 8 高级上下文能力，M10；依赖 M01–M09。
2. 问题类型：恢复 Runtime 重启、SQLite reopen 和跨进程打开后的 durable transcript/model view 一致性。
3. 契约影响：新增 `context/transcript_segment`、`context/session_restored`、`ContextTranscriptSegment`、`ContextSessionRestoreProjection`，`ContextBoundaryMetadata` 增加 `algorithmVersion`。
4. Claude Code 参考：session transcript segment、`restoreSessionStateFromLog()`、`processResumedConversation()`、compact boundary lookup/replay。
5. 上游来源：`behavior-reference`；本地 Claude Code 的 sessionTranscript 实现是 stub，没有复制代码。
6. 验收场景：compact 后保留完整原始事件；restart 后 boundary/head/summary/附件顺序一致；stale head 或不匹配 metadata 安全回退完整 transcript；恢复事实可投影并可重放。
7. 回滚方式：移除 M10 事件、projection 和 replay builder，回退 M08 boundary slice；保留原始 transcript 和旧 compact 事件。

## 变更记录

1. 在 `packages/contracts/src/index.ts` 增加 transcript segment、restore projection 和两类事件契约；boundary 增加算法版本字段。
2. 新增 `packages/context/src/transcript-replay.ts`，实现纯函数 replay：boundary marker → summary → durable head 后缀；无法证明 head 时返回完整 transcript。
3. 在 `packages/runtime/src/index.ts` 将 `conversationMessages()` 从内存边界切片改为 EventStore transcript replay，并在 boundary replay 后追加 `context/session_restored`。
4. 修复 message identity：`sendMessageInternal()` 使用 append 返回的 user eventId；assistant/message 与 tool/result model view 使用持久化 eventId，避免用 Runtime-only turnId/responseId 作为跨重启 anchor。
5. 在 `packages/storage/src/index.ts` 增加两个事件的 bounded parser 和 InMemory/SQLite projection replay。
6. 新增 Context、Runtime、Storage 测试，覆盖 stale/mismatch fallback、SQLite reopen、Host restart、附件重建和 restore projection。
7. 同步 M10 实施说明、ADR-022、上游来源登记和研究文档状态。

## 根因记录

M10 初始测试失败的原因是 compact boundary 的 `preservedSegment.headMessageId` 使用了当前 turn 的 `turnId`。Runtime 当时可以在进程内继续工作，但 EventStore transcript 中 user message 的 identity 是 append 生成的 `eventId`；Host restart 后 replay 无法找到 head，只能安全回退完整历史，因此没有追加 boundary restore receipt。修复后新 turn 将 append 返回的 `eventId` 传入 model view，assistant/tool 同样优先使用 durable eventId。

## 关键行为

- EventStore 原始 user/assistant/tool 事件永久保留；M10 事件只保存边界链接和恢复诊断，不保存消息正文。
- `context/transcript_segment` 与 `context/compact_boundary` 必须指向同一个 boundary；segment 孤立或 boundary ID 不一致时完整回退。
- head 不存在、head 缺失或 projection 不完整时不猜测 sequence，不静默丢历史。
- replay builder 不修改输入 transcript；附件仍由 M08 host-owned provider 在 assembler 阶段按预算恢复。
- `context/session_restored` 在恢复事实进入 EventStore 后才继续模型请求，Storage 只投影最近一次恢复决定。

## 验证结果

```text
pnpm typecheck                                           ✓
pnpm --filter @code-review-agent/context test -- --run   ✓
pnpm --filter @code-review-agent/storage test -- --run   ✓
pnpm --filter @code-review-agent/runtime test -- --run   ✓
pnpm test                                                 ✓
git diff --check                                         ✓
```

## 后续边界

M10 不实现 Claude Code 的 JSONL transcript 文件轮转、Session Memory extraction、Project Memory、context-collapse、hooks、provider cache edit 或 Web context inspector。M11 继续负责 Session Memory extraction；M12 负责 Project Memory；M13 负责 Context diagnostics presenter。
