# M07 开发日志：LLM Summary Compact

状态：`implemented`
日期：2026-08-26
checkpoint：本次独立提交 `feat(phase8): implement llm summary compact M07`

## 任务七问

1. **Phase**：Phase 8 高级上下文能力，M07；依赖 M02 token view、M03 canonical assembly、M04 pairing gate、M05 tool-result budget 和 M06 Session Memory Compact。
2. **问题类型**：在已有 Session Memory 不可用或不足时，调用无工具摘要模型压缩旧会话历史，并对摘要请求自身的 prompt-too-long 做有限恢复。
3. **契约影响**：新增 `ModelRequest.purpose`；新增 `SummaryRequest`、`SummaryRunner` 和 Summary Compact 结果类型；新增四类 `context/summary_*` 事件；`ContextCompactionProjection.kind` 增加 `summary`。
4. **Claude Code 参考**：`src/services/compact/compact.ts:149-227,247-297,336-389,411-690,1159-1450`。
5. **上游来源**：登记为 `behavior-reference`；没有复制 Claude Code 代码；prompt cache sharing 和 hooks 暂留后续模块。
6. **验收场景**：摘要请求无工具权限；媒体/skill 输入被清理；PTL 按 API round 删除老消息并最多重试三次；摘要 usage 单独记录；失败安全回退 legacy compact。
7. **回滚方式**：移除 Summary Input、Summary Compact、Runtime summary gate、summary 事件和 `ModelRequest.purpose`，恢复 M06 后的 legacy compact。

## 实现内容

- 新增 `packages/context/src/summary-input.ts`，实现媒体 marker、skill attachment 和内部 message ID 清理。
- 新增 `packages/context/src/summary-compact.ts`，实现 recent suffix、summary wrapper、tool pair 保持和 PTL oldest-round retry。
- Runtime 新增 `runSummaryModel()`，固定 `purpose=context_summary`、`tools=[]`、`toolChoice=none`，拒绝摘要流中的 tool call。
- `compactTurnContext()` 顺序调整为 M06 → M07 → legacy compact；成功后继续重新组装 M03/M04/M05 model view。
- 新增 summary started/retried/success/failure durable receipts，并在 storage projection 中标记 `kind=summary`。
- 更新研究文档、M07 实施说明、ADR-019、来源登记、Phase 8.1 状态和开发日志索引。

## 关键决策

- Summary agent 复用当前 tenant model，但拥有独立 request purpose 和空工具集，任何 tool call 都 fail closed。
- 摘要输入与主 model view、EventStore transcript 使用不同对象，清理不会修改原始消息。
- PTL 只删除完整 API round；首条变成 assistant 时插入 bounded user marker；retry marker 不会累积。
- 摘要失败不会阻塞主 turn，Runtime 记录结构化失败后回退 deterministic legacy compact。
- prompt cache sharing、PreCompact/SessionStart hooks、post-compact attachments 和 boundary 留待 M08/provider adapter。

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
pnpm --filter @code-review-agent/context test  # 9 files / 37 tests passed
pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts  # 43 tests passed
pnpm test                              # full workspace suite passed
git diff --check                       # passed
```

## 未完成与后续边界

M08 继续实现 durable compact boundary、preserved segment 和 post-compact attachments；M09 负责 reactive overflow recovery；M11 负责 Session Memory extraction/update。M07 不实现 provider cache edit 或外部 hooks。
