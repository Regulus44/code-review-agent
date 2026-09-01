# Web Session Turn/Trajectory 消失问题调研记录

日期：2026-08-26  
范围：Web Session、Turn、Conversation、Trajectory、SSE 实时事件、事件回放和发送 Composer  
任务类型：Web 状态同步、事件回放、Session/Turn/Trajectory contract 诊断  
阶段映射：Phase 7 Web 收敛，涉及 Phase 8 Reliability 的恢复与可观测性入口

本文记录“一个 turn 执行完成后无法直接输入下一个 prompt，需要刷新；刷新后上一条 prompt 和 trajectory 消失；再次刷新后第二条 prompt 和对应 trajectory 也消失”的调研结果。用户所说的“第二条 prompt 和对应的 prompt”已按澄清更正为“第二条 prompt 和对应的 trajectory”。本文只记录问题、证据和修复方向，未修改 AGENTS.md，也未修改运行时代码。

## 1. 结论摘要

问题主要位于 Web 的状态同步和历史事件回放边界，当前没有证据表明 SQLite 中的 prompt 或 trajectory 真正丢失。

根因按确定性和影响分级如下：

| 优先级 | 问题 | 结论 | 影响 |
| --- | --- | --- | --- |
| P0/P1 | 首次加载固定只取最新 200 条事件 | 已确认 | Session 历史超过 200 条后，旧 prompt、assistant 记录和 trajectory 不会进入首屏 projection；刷新会表现为“消失” |
| P1 | Conversation 和 Trajectory 共用同一个 bounded event window | 已确认 | 两个视图同时缺少旧事件；Trajectory 的 loadOlder() 只在详情面板手动触发，Conversation 不会自动补齐 |
| P1 | SSE 事件类型列表与公共 contract 漂移 | 已确认存在契约缺口；stale composer 为高风险表现 | workspace/updated、queue/changed 没有进入 typed connection 的监听列表，可能导致前端 projection 或 active turn 状态滞后 |
| P2 | 发送失败前先清空输入框 | 已确认 | API 失败或网络异常时 prompt 文本被清除，用户会误以为发送内容丢失 |
| P2 | boot 状态与 active turn 状态混合呈现 | 需结合现场复现确认 | textarea 只由 boot 状态控制；若是“完全无法输入”，需要检查 booting/failed，若能输入但无法提交，更符合 stale active turn 或 pending takeover |

## 2. 调研链路

调研覆盖以下数据链路：

~~~text
Browser composer / Conversation / Trajectory
        ↓
Web SessionConnection + SessionStore + SSE listeners
        ↓
Web API /v1/sessions/:id/events
        ↓
AgentHost eventsPage / runtime projection
        ↓
SQLite Event Store
~~~

项目的事件原则要求事件是唯一事实来源。此次证据显示事实事件仍在 SQLite 中，问题发生在“初始取数窗口”和“实时事件到前端 projection 的闭环”之间。

## 3. 已确认问题：刷新只加载最新 200 条事件

### 3.1 Web 初始加载策略

SessionConnection 使用固定历史页大小：

- [apps/web/src/client/connection.ts](D:/Develop/code-review-agent/apps/web/src/client/connection.ts) 中 DEFAULT_HISTORY_PAGE_SIZE = 200；
- 打开 Session 时调用 listEventsPage(sessionId, { limit: 200 })；
- loadOlder() 虽然存在，但属于显式的向前翻页操作，不是刷新时的自动恢复流程。

### 3.2 Storage 的分页语义

在 [packages/storage/src/index.ts](D:/Develop/code-review-agent/packages/storage/src/index.ts) 的 pageEvents() 中，当没有 beforeSequence 且指定 limit 时，候选事件使用 candidates.slice(-limit)，也就是返回最新的一页。响应同时返回 hasMoreBefore，这说明服务端知道前面还有历史，但客户端首屏没有继续读取。

API 路由位于 [apps/api/src/server.ts](D:/Develop/code-review-agent/apps/api/src/server.ts) 的 /v1/sessions/:id/events。因此刷新不是读取了“空 Session”，而是读取了一个有明确边界的最新事件页。

### 3.3 真实 SQLite/API 证据

调研期间检查到一条真实 Session：

~~~text
Session: ses_d2141700-e054-48cb-8f2b-6ecf9f2c91a7
Session status: idle
总事件数: 1314
completed turn 数量: 2
~~~

两个 prompt 的事件序号为：

~~~text
第一条 prompt: sequence = 2
第二条 prompt: sequence = 1054
~~~

刷新时的首屏事件接口返回：

~~~text
events count = 200
oldestSequence = 1115
newestSequence = 1314
hasMoreBefore = true
~~~

所以第一条 prompt（sequence 2）和第二条 prompt（sequence 1054）都位于刷新后的首屏窗口 [1115, 1314] 之外。后端 SQLite 和 Session projection 中的数据仍然完整，当前证据不支持“事件被删除”或“prompt 被覆盖”的判断。

## 4. 为什么 prompt 和 trajectory 会一起消失

Conversation 和 Trajectory 都从同一个 bounded event window 重建：

1. 刷新时 Web Store 只收到最新 200 条事件；
2. Store 根据这一页事件生成 Session、Turn、Conversation 和 Trajectory projection；
3. 旧的 user/message、turn/*、assistant 输出和 tool records 没有进入本次 replay；
4. 两个视图都以当前 projection 渲染，于是旧 prompt 与其 trajectory 同时不可见。

Trajectory 面板存在 loadOlder() 入口，可以按 before_sequence 向前分页；但该操作只在 Trajectory 详情面板中可见，且不会自动补齐 Conversation。因此用户刷新后看到的是“两个视图都变短”，而不是数据库中的历史被删除。

这也解释了“再次刷新后第二条 prompt 和对应 trajectory 也消失”的现象：随着新事件继续增加，第二条 prompt 也会被推到最新 200 条窗口之前；每次刷新都从新的窗口重建，旧内容持续不可见。

## 5. 高风险问题：实时 SSE 与 Composer 状态可能不同步

### 5.1 后端能够连续执行多个 turn

真实 Session 已经存在两个 completed turn，且临时 live fixture 验证表明，在正常收到 terminal event 后 Composer 可以恢复。因此 AgentHost 的 turn queue/runtime 没有表现出“完成一个 turn 后永久拒绝第二个 turn”的问题。

### 5.2 active turn 的前端判定

在 [apps/web/index.html](D:/Develop/code-review-agent/apps/web/index.html) 的 activeTurn() 中，前端从 typed projection 查找状态为 running 或 queued 的 turn。renderComposerState() 再根据 active turn 决定发送按钮是 Send、Stop 还是 disabled。

如果 terminal event 已由后端追加，但前端 projection 没有正确应用，旧 turn 可能继续被认为是 running。这会造成：

- 发送按钮仍显示 Stop 或保持 disabled；
- 用户感觉“turn 执行完了却不能输入/提交下一条命令”；
- 刷新后重新从后端 projection 初始化，状态暂时恢复正常。

### 5.3 事件类型契约漂移

公共类型在 [packages/contracts/src/index.ts](D:/Develop/code-review-agent/packages/contracts/src/index.ts) 声明了 91 个 AgentEventType，其中包括：

- workspace/updated
- queue/changed

typed connection 在 [apps/web/src/client/connection.ts](D:/Develop/code-review-agent/apps/web/src/client/connection.ts) 的 AGENT_EVENT_TYPES 只列出 89 项，缺少上述两个事件。与此同时，旧的 inline fallback 监听列表在 [apps/web/index.html](D:/Develop/code-review-agent/apps/web/index.html) 又包含这两个事件。

这形成了三套事件认知：公共 contract、typed connection、inline fallback。turn/ended 本身已经在 typed connection 中监听，因此当前证据不能把问题简化为“完全没有监听 turn/ended”。更准确的判断是：实时 projection 管线存在契约漂移，队列或 workspace 相关状态可能滞后，进而放大 stale active turn 的表现。

需要通过事件级集成测试进一步确认以下链路是否闭合：

~~~text
turn/ended / queue/changed
    → SSE listener
    → SessionStore.reduce
    → projection.session.turns
    → activeTurn()
    → renderComposerState()
~~~

## 6. 次级问题：发送失败会清空 prompt

在 [apps/web/index.html](D:/Develop/code-review-agent/apps/web/index.html) 的发送逻辑中，代码先执行：

~~~ts
send.disabled = true;
input.value = '';

try {
  await sendMessage(...);
} catch (error) {
  // 显示错误
}
~~~

如果 API 请求失败、网络断开、session 发生切换或服务端拒绝请求，输入内容在失败处理前已经被清空。这个问题不会解释“刷新后历史窗口缺失”，但会解释某些单次 prompt 看起来突然消失，尤其是用户在网络异常时重复刷新页面的场景。

建议保留 pending draft，只有在服务端确认接受并产生 user/message 或 turn/queued 后再清空；失败时恢复原文本。

## 7. “无法输入”和“无法提交”的区分

textarea 的直接禁用位置是 [apps/web/index.html](D:/Develop/code-review-agent/apps/web/index.html) 中的 input.disabled = intent.status !== 'ready'。它受 boot intent 控制，正常 completed turn 不会直接使 textarea disabled。

因此现场诊断应区分：

| 用户看到的现象 | 更匹配的代码路径 |
| --- | --- |
| 光标无法进入输入框、文本框灰掉 | boot 状态为 booting 或 failed，或 pending permission/interaction takeover 占用了 composer |
| 可以输入文字，但发送按钮不能提交 | stale active turn、queued turn、stopping 状态或 presentComposerSubmit() 判定 disabled |
| 点击发送后文字消失且没有新 turn | API 失败清空输入，或发送请求未成功落事件 |
| 刷新后旧历史消失 | 首屏只 replay 最新 200 条事件 |

## 8. 后端排除项

当前证据可以排除以下方向作为首要根因：

- AgentHost 无法连续创建第二个 turn：真实 Session 已有两个 completed turn；
- SQLite 事件被物理删除：sequence 2 和 1054 的 prompt 事件仍存在；
- Session 被刷新重置为空：刷新接口返回 200 条最新事件并标记 hasMoreBefore = true；
- 服务端不支持历史分页：API 和 storage 都支持 before_sequence，并已有分页测试。

后端仍需要补充完整的 replay/e2e 验证，但优先修复面应放在 Web 的历史加载、事件监听和 Composer 状态呈现。

## 9. 现有测试与覆盖缺口

本次调研运行结果：

~~~text
pnpm typecheck                         通过
pnpm --filter @code-review-agent/web test
  33 test files / 126 tests passed
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts
  31 tests passed
git diff --check                        通过
~~~

已有测试覆盖了事件分页 API、hasMoreBefore 和部分 SessionStore replay。当前缺口包括：

1. 一个超过 200 条事件、包含多个 prompt/trajectory 的真实浏览器刷新回放测试；
2. 刷新后 Conversation 与 Trajectory 的自动补历史验收；
3. turn/ended、queue/changed 到 Composer 可发送状态的 SSE 集成测试；
4. 发送 API 失败时 draft 保留与恢复测试；
5. boot failure、pending permission、pending interaction 与普通 active turn 的 UI 状态区分测试；
6. 从完整事件日志重建 projection，并与实时 projection 做一致性比对的回放测试。

## 10. 根因分级

~~~text
事实层：SQLite Event Store 保留全部事件
  ↓
恢复层：Web 首次加载只请求最新 200 条
  ↓
投影层：Conversation/Trajectory 从 bounded window 重建
  ↓
表现层：旧 prompt/trajectory 在刷新后不可见

并行风险：SSE event type drift
  ↓
实时 projection 可能缺少 queue/workspace 更新
  ↓
activeTurn() 可能滞后
  ↓
Composer 仍显示 Stop/disabled，无法直接提交第二个 turn

附加风险：发送失败先清空 input
  ↓
单次失败 prompt 没有 draft 可恢复
~~~

## 11. 修复建议与优先级

### P0/P1：修复历史回放语义

- 明确定义 Session 首屏的历史策略：完整 replay、按需分页，或“最近事件 + 永久保留的用户/assistant transcript projection”；
- 刷新后自动恢复 Conversation 所需的历史，不要求用户先打开 Trajectory 详情；
- 保留 hasMoreBefore、oldestSequence，并在 Conversation/Trajectory 中提供一致的“加载更早内容”行为；
- 对超过 200 条事件的 Session 增加浏览器 e2e，验证刷新前后 prompt、turn 和 trajectory 的可见性一致。

### P1：统一 AgentEventType 来源

- 让 typed connection 从 packages/contracts 生成或导入事件列表，避免手工维护 89/91 项列表；
- 为每个公共事件增加“声明、SSE 监听、Store reducer、projection 影响”的合同检查；
- 重点覆盖 turn/ended、turn/queued、queue/changed、workspace/updated 的实时状态转换；
- 当事件类型未被监听或未被 reducer 处理时，在开发模式输出诊断而不是静默丢弃。

### P1/P2：修复 Composer 可靠性

- 提交前保存 draft；服务端确认接受后再清空；失败时恢复并保留错误提示；
- 将 activeTurn、pending request takeover、boot status 和 stopping status 分开展示；
- 在 terminal event 到达后显式断言 activeTurn() === undefined（除非确有 queued turn），并记录恢复延迟。

### P2：增加可观测性

- 在 Web diagnostics 中显示当前 oldestSequence/newestSequence/hasMoreBefore；
- 显示最后收到的 SSE event type、sequence 和 projection sequence；
- 为“发送按钮 disabled”提供原因标签，区分 boot、active turn、pending request、stopping 和 API error。

## 12. 验收场景

修复完成后至少应满足：

1. 连续发送两条 prompt，第一条 turn 完成后无需刷新即可输入并提交第二条；
2. 在事件数超过 200 的 Session 中刷新，第一、第二条 prompt 及对应 trajectory 仍可通过默认视图查看或自动加载；
3. 断开 SSE 后重连，按 sequence replay 不重复、不遗漏，Composer 状态与后端 Session projection 一致；
4. 在 turn/ended 与 queue/changed 到达后，发送按钮从 Stop/disabled 恢复为 Send；
5. 模拟发送 API 失败，输入文本仍保留，可重试；
6. 打开 pending permission/interaction 时，界面明确显示 takeover 原因，完成或取消后恢复普通 Composer；
7. 从 SQLite 完整事件日志冷启动重建，与实时运行期间的 Conversation/Trajectory 结果一致。

## 13. 回滚与禁用方式

本文档为诊断记录，删除或回滚该文档不会影响运行时。后续代码修复应按独立 checkpoint 提交，并保留以下可回滚开关：

- 历史加载策略应可回退到固定页模式；
- 新的统一事件监听器应可通过 feature flag 切回当前监听器；
- Composer draft 保留逻辑应可独立禁用；
- 新增的自动 replay/e2e 只读验证不应改变生产事件。

## 14. 参考文件

- [apps/web/src/client/connection.ts](D:/Develop/code-review-agent/apps/web/src/client/connection.ts)：Session 初始历史加载、loadOlder()、typed SSE event listeners；
- [apps/web/src/client/store.ts](D:/Develop/code-review-agent/apps/web/src/client/store.ts)：事件 replay、history window 和 projection；
- [apps/web/index.html](D:/Develop/code-review-agent/apps/web/index.html)：Composer、active turn、inline SSE fallback、Conversation/Trajectory 渲染；
- [apps/web/src/client/api.ts](D:/Develop/code-review-agent/apps/web/src/client/api.ts)：事件分页 API client；
- [apps/api/src/server.ts](D:/Develop/code-review-agent/apps/api/src/server.ts)：/v1/sessions/:id/events API；
- [packages/storage/src/index.ts](D:/Develop/code-review-agent/packages/storage/src/index.ts)：内存/SQLite 事件分页实现；
- [packages/contracts/src/index.ts](D:/Develop/code-review-agent/packages/contracts/src/index.ts)：AgentEventType 公共事件 contract；
- [apps/web/src/client/connection.test.ts](D:/Develop/code-review-agent/apps/web/src/client/connection.test.ts)、[apps/web/src/client/store.test.ts](D:/Develop/code-review-agent/apps/web/src/client/store.test.ts)、[apps/api/src/server.test.ts](D:/Develop/code-review-agent/apps/api/src/server.test.ts)：现有分页、replay 和 API 测试。

