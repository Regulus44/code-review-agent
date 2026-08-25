# M04 开发日志：API Round、Message Normalize 与 Tool Pairing

## 2026-08-26：完成模型请求消息合法性 gate

### 任务七问

1. **Phase**：Phase 8 高级能力；上下文管理 M04，依赖 M02 token view 和 M03 canonical assembly。
2. **问题类型**：API round 分组、streaming assistant 合并、tool call/result 配对、请求前 repair/strict gate。
3. **契约影响**：`ChatMessage.assistant` 增加可选 `responseId`；新增 `context/messages_normalized`、`context/tool_pairing_repaired` 事件；`AgentHostOptions` 增加 `messageValidationMode`；step/assistant 事件增加 request/response 与 validation metadata。
4. **Claude Code 参考**：`D:/Develop/claude-code/src/services/compact/grouping.ts`、`src/utils/messages.ts`、`src/query.ts`。
5. **上游来源**：仅登记为 `behavior-reference`，未复制 Claude Code 代码；本项目使用自己的 EventStore、ChatMessage、ToolRuntime 和安全策略。
6. **验收场景**：同一 response 的 streaming/tool loop 保持一个 API round；duplicate/orphan/missing pair 可 repair；strict 模式 fail-closed；模型调用与 token count 使用同一合法 view；重启后可从事件恢复 responseId。
7. **回滚方式**：回退 M04 checkpoint 可恢复 M03 的 assembly；新增 responseId 和诊断事件均为兼容字段，旧事件仍可读。

### 实现内容

- 新增 `packages/context/src/api-round.ts`：`groupMessagesByApiRound()`。
- 新增 `packages/context/src/api-normalize.ts`：assistant streaming 合并、字段规范化、repair/strict 报告。
- 新增 `packages/context/src/tool-pairing.ts`：duplicate/orphan/missing 检测与 repair/strict 结果。
- 修改 `packages/contracts/src/index.ts`：assistant `responseId` 和两个上下文 repair 事件类型。
- 修改 `packages/runtime/src/index.ts`：每个 step 通过 `prepareModelContext()`；生成 `modelRequestId`、`responseId`；repair 追加诊断事件；strict 模式拒绝非法请求。
- 新增 context 与 runtime 测试，覆盖正常、repair、strict、restart metadata 和 tool loop。
- 明确不实现 M05 工具结果 microcompact。

### 关键决策

- 默认 repair，确保历史中的孤儿/缺失结果不会直接把正常 turn 变成 provider 请求失败；严格模式供安全敏感场景 fail-closed。
- synthetic result 只存在于 model-visible view，EventStore 原文和工具审计事实不变。
- 以 response ID 而不是 user turn 作为 round 边界；无 response ID 的旧历史保持兼容。
- 事件只记录 issue codes 与计数，不记录完整工具输出或 provider 原始 body。

### 验证证据

```text
pnpm typecheck                                  ✓
pnpm test                                       ✓ all workspace tests
pnpm --filter @code-review-agent/context test   ✓ 17 tests
pnpm --filter @code-review-agent/runtime test   ✓ 40 tests
git diff --check                                ✓
```

### 下一步

进入 M05：依据 Claude Code `microCompact.ts` 实现工具结果预算和 model-view 局部释放，保持 transcript 原文不变，并复用本 M04 pairing gate。

