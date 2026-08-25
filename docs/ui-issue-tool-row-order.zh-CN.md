# ToolRow 对话顺序问题记录

## 状态

- 状态：已修复
- Phase：Phase 8.0 Web 对齐
- 修复提交：`1935dc5 fix(phase8): preserve conversation tool order`
- 影响范围：Web Conversation projection、ToolRow 行顺序和 turn 尾状态
- 公共 Event、Tool、Task、Permission、Workspace contract：不变

## 用户可见症状

一轮对话完成后，assistant 的长篇总结先完整显示，所有工具调用集中追加在消息尾部。工具调用没有出现在实际执行位置，多个工具行看起来像连续的尾部通知。

截图中还可以看到 `Turn completed` / `Turn failed` 出现在对话开头或不对应的消息附近，进一步破坏了时间线。

## 根因

旧的 `ConversationProjection` 使用 `assistant:${turnId}` 作为整轮 assistant 消息的 key。一个 turn 内的所有 `assistant/chunk` 和 `assistant/message` 被合并到同一个节点：

```text
assistant preamble (step 1)
tool calls (step 1)
assistant explanation (step 2)
tool calls (step 2)
assistant final summary (step 8)
```

事件虽然按 sequence 追加，但投影后的 assistant 节点仍保留首个 chunk 的 sequence。渲染器消费的是合并后的节点，所以工具行只能排在完整 assistant 节点之后。

`turn:*` 节点同样保留首次创建时的 sequence。终态更新不会移动该节点，导致 `Turn completed` 或 `Turn failed` 被渲染在 turn 开头。

## DSH 对照结论

DSH 的 Conversation 使用稳定的消息/工具 node key。流式更新只更新对应 node；新的 assistant segment 或新的 tool call 才创建新 node。ToolRow 的位置由 Conversation timeline 决定，progress/result 只更新同一个 keyed row。

本项目对应采用：

1. `step/started` 为当前 turn 记录稳定 step key；
2. assistant chunk/message 使用 `assistant:${turnId}:step:${stepKey}` 分段；没有 step 事件的兼容流继续使用原 turn key；
3. tool call 继续使用 `tool:${toolCallId}`，其首个 call sequence 作为行 anchor；
4. turn 节点保留 `turn:${turnId}`，但 sequence 跟随最新状态事件，使终态成为 turn tail；
5. tool-only assistant message 不创建空 assistant 行；
6. renderer 继续只消费 projection，不在浏览器内重新按 tool/result 配对或拼接时间线。

## 验收证据

### 单元/投影

新增回归覆盖：

- assistant chunks 在同一步内合并为一个稳定节点；
- 跨 step 的 assistant segments 与 tool node 按原始顺序排列；
- tool-only assistant message 不产生空头像行；
- turn 终态位于投影尾部。

验证结果：

```text
pnpm typecheck                         ✓
pnpm --filter @code-review-agent/web test  ✓ 115 tests
pnpm build:web                         ✓
git diff --check                       ✓
```

### 真实页面

在 `http://127.0.0.1:3210/` 重启服务后，使用历史工具会话检查 DOM 顺序：

```text
message user
message assistant：我先来了解...
tool-row：git_status
tool-row：Search *
tool-row：Search **/*.md
message assistant：我来读取 README...
tool-row：Read README.zh-CN.md
tool-row：Read README.md
message assistant：我再看一下...
tool-row：Read package.json
tool-row：Search packages/*/src/*.ts
tool-row：Tool call git_log
event-row：Turn failed
```

浏览器 console warning/error：`0`；`GET /health`：`200`。

## 回滚

回退 `1935dc5` 可恢复旧的 turn 级 assistant 合并行为。回滚不会改变已持久化事件或公共 contract。

