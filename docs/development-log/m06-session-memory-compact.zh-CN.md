# M06 开发日志：Session Memory Compact

状态：`implemented`
日期：2026-08-26
checkpoint：本次独立提交 `feat(phase8): implement session memory compact M06`

## 任务七问

1. **Phase**：Phase 8 高级上下文能力，M06；依赖 M02 token view、M03 canonical assembly、M04 pairing gate 和 M05 tool-result budget。
2. **问题类型**：利用已有 session memory 摘要替换旧会话历史，计算保留窗口并保护 API 消息边界。
3. **契约影响**：新增 `SessionMemoryStore`、`SessionMemorySnapshot`、M06 compact 结果类型；`ChatMessage` 增加内部 `messageId`；新增 `context/session_memory_compacted` 与 `context/session_memory_compaction_failed`；projection 增加 `kind=session_memory`。
4. **Claude Code 参考**：`src/services/compact/sessionMemoryCompact.ts`、`src/services/SessionMemory/sessionMemoryUtils.ts`。
5. **上游来源**：登记为 `behavior-reference`；没有复制 Claude Code 代码；memory extraction/update 暂留 M11。
6. **验收场景**：已有 memory 时无需摘要模型即可压缩；边界缺失不猜测并回退 legacy compact；tool pair/streaming response 不被切开；memory 内容有界且不覆盖 system 安全规则。
7. **回滚方式**：移除 M06 adapter、Runtime 注入和两个事件类型，恢复 M05 之后的 legacy compact；新增 `messageId` 为可选字段，旧事件无需迁移。

## 实现内容

- 新增 `packages/context/src/session-memory-compact.ts` 和单元测试。
- 新增 `SessionMemoryStore` 只读 adapter，明确不承担 M11 extraction。
- 实现 `calculateMessagesToKeepIndex()` 的 minimum/maximum 保留窗口。
- 实现 `adjustIndexToPreserveAPIInvariants()` 的 tool pair、protected tool 和 response stream 回溯。
- `AgentHost.compactTurnContext()` 在 legacy compact 前优先尝试 M06。
- Runtime replay 为历史消息附加 EventStore `eventId`，provider 请求前由 M04 normalize 剥离内部 `messageId`。
- 新增 session-memory compact 成功/失败事件和 storage projection 标识。
- 更新研究文档、M06 实施说明、ADR-018、来源登记和开发日志索引。

## 关键决策

- M06 只读取已有 memory，不启动摘要模型、不执行工具、不写 workspace。
- 已知 `lastSummarizedMessageId` 不存在时不猜边界，记录失败并回退 legacy compact。
- 没有 boundary ID 但 memory 有内容时从尾部向前扩展，采用 resumed-session 保守策略。
- system 消息永远保留；protected tool call/result 通过起点回溯保留。
- memory 作为 `<session-memory>` 不可信历史上下文注入，限制 `maxMemoryChars`。
- transcript、memory store 和 compact receipt 分离；事件只记录计数、原因、边界 ID 和 fallback，不记录 memory 原文。

## 验证证据

```text
pnpm typecheck
pnpm --filter @code-review-agent/context test
pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts
pnpm test
git diff --check
```

最终验证结果：

```text
pnpm typecheck                         # passed
pnpm --filter @code-review-agent/context test  # 8 files / 32 tests passed
pnpm --filter @code-review-agent/runtime test  # 1 file / 42 tests passed
pnpm test                              # all workspace packages passed
git diff --check                       # passed
```

验证过程中修正了 Runtime fixture 的 boundary：`lastSummarizedMessageId` 必须指向最后一条已摘要消息，避免把仍属于未摘要区的 assistant 回复错误地当作可丢弃历史。

## 未完成与后续边界

M07 继续实现 LLM Summary Compact；M08 负责 durable compact boundary 和 post-compact rebuild；M11 负责 Session Memory extraction/update。M06 不提前引入 Project Memory、provider cache edit 或 reactive overflow recovery。
