# M03 开发日志：Context Assembly 与 System Prompt Sections

## 2026-08-26：完成 Claude Code 式 canonical context assembly

### 任务七问

1. **Phase**：Phase 8 高级能力；上下文管理 M03，依赖 M01 budget 和 M02 token estimation。
2. **问题类型**：system prompt section 分层、model-visible context 统一组装、稳定排序和回放诊断。
3. **契约影响**：新增 `ContextAssembly`、`ContextAssemblyInput`、`ContextAttachment`、`SystemPromptSection`；`step/started` 增加 `contextAssembly` 诊断 payload。未改变既有 `ChatMessage`、`ModelRequest` 和 EventStore 事件类型。
4. **Claude Code 参考**：`D:/Develop/claude-code/src/context.ts`、`src/constants/prompts.ts`、`src/utils/systemPrompt.ts`、`src/utils/messages.ts`。
5. **上游来源**：仅复刻静态/动态 section、canonical model view、稳定排序和不可信上下文边界的行为；未复制 Claude Code 代码。实现继续遵循 ADR-009、ADR-013、ADR-014。
6. **验收场景**：每次模型请求的 system/history/tools 来自同一个 assembly；静态 section 排在动态 section 前；tool/attachment 排序稳定；compact 后重新组装；事件能通过 fingerprint 关联到 model-visible view。
7. **回滚方式**：回退 M03 checkpoint 即可恢复 M02 的 runtime 手工 messages/tools 组装；`contextAssembly` 是附加诊断字段，不影响旧事件读取。

### 实现内容

- 新增 `packages/context/src/assembler.ts`：实现 `assembleContext()`、section/attachment 规范化、稳定排序、attachment wrapper 和 fingerprint。
- 修改 `packages/context/src/index.ts`：导出 assembler 与相关公共类型。
- 修改 `packages/runtime/src/system-prompt.ts`：新增 `buildAgentSystemPromptSections()`；静态 section 为 `identity/task_execution/safety/verification/communication`，动态 section 为 `tool_use/tool_guidance/workspace/permissions/recovery/custom_instructions`。
- 修改 `packages/runtime/src/index.ts`：新增 `assembleTurnContext()`；runTurn、恢复 turn 和每个 step 统一使用 assembly；compact 后重新组装；model adapter 使用同一份 `assembly.messages` 与 `assembly.visibleTools`。
- `step/started.payload.contextAssembly` 记录 fingerprint、section IDs、静态/动态分类和 attachment IDs。
- 未提前实现 M04 API round/tool pairing，也未提前实现 M05 tool-result microcompact。

### 关键决策

- static section 使用稳定 ID/order，并保持安全规则位于所有动态内容之前；
- history 不由 assembler 重排，保留 EventStore/replay 顺序；
- tools 按名称排序，避免 ToolRegistry 注册顺序影响 prompt/cache/fingerprint；
- attachment 只作为带 wrapper 的不可信 model-view 数据，不能成为新的 system instruction；
- fingerprint 只用于诊断和 replay correlation，不取代 durable event sequence；
- Runtime 不再分别构造“计数 view”和“发送 view”。

### 验证证据

```text
pnpm typecheck                                  ✓
pnpm test                                       ✓ all workspace tests
pnpm --filter @code-review-agent/runtime test   ✓ 38 tests
git diff --check                                ✓
```

### 下一步

进入 M04：依据 Claude Code `grouping.ts` 和 `messages.ts` 实现 API round、message normalize、tool pairing strict/repair，并把 validator 放入所有模型请求的共同入口。
