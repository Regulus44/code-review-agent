# DSH Session/Turn/Trajectory 与 Composer 实现调研

日期：2026-08-26  
调研对象：[D:\Develop\deepseek-harness-fork](D:/Develop/deepseek-harness-fork)  
用途：为本仓库后续 Web 状态同步、历史回放、Composer、Trajectory 和恢复功能改造提供源码入口与实施依据。

## 1. 总结

DSH 对本次问题采用分层解决方案：

1. Session 以 append-only 事件日志为事实来源，事件序号连续；
2. Persistence 保存完整日志并提供冷读取、恢复和按序号读取；
3. Host API 以消息边界分页，首屏取尾页并返回 hasMore；
4. Web Runtime 维护连续事件窗口，旧页按 beforeSeq 向前 prepend；
5. 实时流使用序号去重、断线重连、gap repair 和 generation 失效保护；
6. 全日志 projection 提供不受分页影响的统计和状态；
7. Conversation 与 Trajectory 都能加载更早页面，Trajectory 在滚动到顶部时自动加载；
8. Composer 通过独立输入状态机处理 Queue、Steer、提交成功和失败恢复；
9. 真实浏览器 e2e 覆盖连续多 turn、刷新回放、分页、重连和虚拟化。

最重要的迁移结论：不要把本仓库的 200 条事件简单改成另一个固定数字。DSH 解决的是 bounded window 的完整协议，包括窗口起点、连续性、hasMore、旧页加载、实时事件拼接和失败恢复。

DSH 也不是刷新时一次性加载完整历史。它采用尾页加旧页加载，因此本仓库必须把 Conversation 和 Trajectory 的历史补齐入口做成一致、可见或自动触发的行为。

## 2. 模块总览

| DSH 模块 | 主要职责 | 对本仓库问题的价值 |
| --- | --- | --- |
| dsh-session | Event log、连续 seq、surface 和派生消息 | 保证 prompt、assistant、tool、turn 有稳定事实来源 |
| dsh-session-persistence | 持久化协调、冷读取、恢复、写入串行化 | 刷新、重启和断线后可恢复完整 Session |
| dsh-session-persistence-jsonl / sqlite | JSONL、SQLite 存储 | 物理存储、suffix read、损坏尾部处理 |
| dsh-session-projection | 全日志 projection registry | 统计和状态不随页面窗口变化 |
| dsh-session-projection-cache | projection checkpoint 和 tail replay | 冷启动避免每次从零折叠 |
| dsh-host-apiproxy | session.history、session.prompt、projection frame | 统一历史分页、提交入口和实时状态 |
| dsh-client-connection | 双流握手、重连、generation | 防止旧连接结果覆盖新状态 |
| dsh-client-runtime/sessions | Session 窗口、旧页、重连修复、queue mirror | 直接对应刷新丢历史和 turn 状态不同步 |
| dsh-client-ui-conversation | Chat、Composer、Queue/Steer、draft 状态机 | 直接对应连续 turn 和发送失败 |
| dsh-client-ui-trajectory | Trajectory 定义、分页、自动加载、虚拟化 | 直接对应 trajectory 消失和长日志性能 |
| apps/web/tests | 浏览器级验收 | 提供本仓库应补充的测试模型 |

## 3. 事件事实来源：dsh-session

源码入口：

- [packages/core/session/src/index.ts](D:/Develop/deepseek-harness-fork/packages/core/session/src/index.ts)
- [packages/core/session/src/surface.ts](D:/Develop/deepseek-harness-fork/packages/core/session/src/surface.ts)

实现方式：

- Session.append 写入连续 seq 的 SessionEvent；
- Session.events 返回完整事件日志；
- message-producing 事件用 surfaceOp 表示 append 或 replace；
- turn/start、step/start、assistant/chunk 等控制或增量事件可记录但不直接变成独立 Chat 消息；
- Session.deriveMessages 从 surface 节点派生模型消息，并对未变化节点做缓存；
- Session.fromRestore 在恢复时重新验证 seq、事件 envelope 和 surface 转换。

迁移建议：把 Event Store、Session projection、Browser window 和 UI view 明确分层。当前问题本质上是 Browser window 被当成了完整 Session。

## 4. 持久化与恢复：dsh-session-persistence

源码入口：

- [packages/session/session-persistence/src/index.ts](D:/Develop/deepseek-harness-fork/packages/session/session-persistence/src/index.ts)
- [packages/session/session-persistence/src/coordinator.ts](D:/Develop/deepseek-harness-fork/packages/session/session-persistence/src/coordinator.ts)
- [packages/session/session-persistence-jsonl/src/index.ts](D:/Develop/deepseek-harness-fork/packages/session/session-persistence-jsonl/src/index.ts)
- [packages/session/session-persistence-sqlite/src/index.ts](D:/Develop/deepseek-harness-fork/packages/session/session-persistence-sqlite/src/index.ts)
- [packages/session/session-persistence-sqlite/src/schema.ts](D:/Develop/deepseek-harness-fork/packages/session/session-persistence-sqlite/src/schema.ts)

关键机制：

- persisted unit 就是 SessionEvent，不另建持久化消息类型；
- append 按 Session id 串行化，并在 durable 后才返回；
- load 返回完整、平衡的逻辑日志；
- inspect 提供不提交恢复的只读视图；
- readFrom 按 fromSeq 读取后缀，供 checkpoint 和 gap repair 使用；
- crashed turn 保留真实事件并补充 interrupted closers；
- 中段 seq gap 或已提交损坏会拒绝，只有未完整写入的 torn tail 可以丢弃；
- coordinator 以 revision 判断冷缓存是否仍对应当前日志。

对本仓库的价值：刷新和重连只能依赖完整日志或明确的 sequence cursor，不应依赖内存中上一页状态。

## 5. 历史分页：dsh-host-apiproxy

源码入口：

- [packages/host/apiproxy/src/api/sessions.schema.ts](D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/sessions.schema.ts)
- [packages/host/apiproxy/src/api-proxy.ts](D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api-proxy.ts)

协议：

~~~text
session.history({ sessionId, beforeSeq?, maxMessages? })
→ { events: [{ event, view? }], hasMore, projections? }

session.prompt({ sessionId, mode: queue | steer, content })
→ { accepted: true, command? }
~~~

paginate 实现位于 api-proxy.ts 的 paginate 函数：

1. 无 beforeSeq 时从日志尾部开始；
2. 有 beforeSeq 时只看 seq 更小的事件；
3. 从尾部向前统计 append-origin message events；
4. sourceEventSeqs 将相关 chunk 或 summary 绑定为同一消息组；
5. 达到 maxMessages 后，以最老消息组的起始 seq 为 cut；
6. 返回连续 raw event range 和 hasMore。

DSH 默认 maxMessages 是 50。该数值只代表当前窗口大小，不代表完整历史。它依靠 Session.loadOlder、UI 顶部入口和 Trajectory 自动加载来补齐旧数据。

对本仓库的直接建议：

- 将分页单位从任意 event 条数改为消息或 turn 边界；
- 返回 oldestSequence、newestSequence、hasMoreBefore；
- 旧页必须与当前窗口连续；
- Conversation 和 Trajectory 都使用同一分页状态；
- 首屏可以 bounded，但必须显示或自动处理更早历史。

## 6. 全日志 projection：统计和状态不随分页变化

源码入口：

- [packages/session/session-projection/src/index.ts](D:/Develop/deepseek-harness-fork/packages/session/session-projection/src/index.ts)
- [packages/session/session-projection-cache/src/index.ts](D:/Develop/deepseek-harness-fork/packages/session/session-projection-cache/src/index.ts)
- [packages/session/session-stats/src/index.ts](D:/Develop/deepseek-harness-fork/packages/session/session-stats/src/index.ts)
- [packages/host/apiproxy/src/api-proxy.ts](D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api-proxy.ts)

实现方式：

- ProjectionRegistry 为每个 key 注册 initial、reduce、toWire 和 stateVersion；
- history 尾页附带 projections baseline；
- projection 变化通过 session/projection frame 推送，携带 sessionId、key、value、seq；
- 客户端按更高 seq 覆盖旧值；
- loadOlder 不重复发送 baseline；
- projection cache 保存 sessionId、key、stateVersion、seq、value，并从 checkpoint 后继续折叠。

stats-paged-history.e2e.ts 验证了 28-turn 日志：首屏只显示尾页，stats strip 仍显示全日志 turn/step；加载旧页后统计完全不变。

迁移建议：turn 数、step 数、token、duration、最近用户 prompt 等全日志数据使用独立 projection，Conversation 和 Trajectory 只负责当前窗口的可见记录。

## 7. 实时连接与重连：dsh-client-connection

源码入口：

- [packages/client/connection/src/client/connection.ts](D:/Develop/deepseek-harness-fork/packages/client/connection/src/client/connection.ts)
- [packages/client/connection/src/websocket-downlink.ts](D:/Develop/deepseek-harness-fork/packages/client/connection/src/websocket-downlink.ts)
- [packages/client/connection/src/api-path.ts](D:/Develop/deepseek-harness-fork/packages/client/connection/src/api-path.ts)

DSH 使用 events.mux 和 events.host 两条只下行 WebSocket。ConnectionController：

- 先建立两条流并调用 host.describe；
- 两条流和 describe 都成功后才触发 onConnected；
- 任一流结束，整个 generation 进入失败并重连；
- 使用指数退避；
- onConnected 触发已打开 Session 的 resync；
- 旧 generation 的结果不会继续写入新状态。

本仓库使用 SSE 时可保留相同语义：

- 为每次连接分配 generation；
- 历史 baseline 成功后才接受增量；
- 重连时按 sequence/cursor replay；
- 旧请求返回时检查 generation；
- 发生 gap 时主动回拉 history。

## 8. Web Runtime Session：最直接的参考实现

源码入口：

- [packages/client/runtime/src/client/sessions/session.ts](D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/sessions/session.ts)
- [packages/client/runtime/src/client/sessions/manager.ts](D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/sessions/manager.ts)
- [packages/client/runtime/src/client/sessions/queue-mirror.ts](D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/sessions/queue-mirror.ts)
- [packages/client/runtime/src/client/sessions/projection-store.ts](D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/sessions/projection-store.ts)

Session 窗口状态：

~~~text
events[]              连续 raw event window
views[]               与 events 对齐的 host view
baseSeq               当前窗口最早 seq
hasMore               是否还有更早页
openState             cold / loading / open / error
openGeneration        当前 open/resync generation
loadingOlder          是否正在加载旧页
liveBuffer            历史加载期间暂存的实时事件
stitching             gap repair 状态
subscribedLastSeq     Host baseline 最后 seq
~~~

关键入口和行为：

- open() 取尾页，openPromise 合并并发打开；
- installWindow() 一次性安装事件、views、baseSeq、hasMore 和 projection baseline；
- loadOlder() 以 beforeSeq = baseSeq 请求旧页；
- 旧页最后 seq + 1 必须等于当前 baseSeq；
- 不连续时丢弃旧页，避免渲染有洞的窗口；
- acceptLiveEvent() 在 loading 时放入 liveBuffer；
- seq 小于等于当前尾部时去重；
- seq 大于当前尾部加一时触发 repairGap；
- repairGap() 重新拉尾页，并复用 installWindow()；
- resync() 递增 generation、清空窗口并重新 open，旧请求结果自动失效；
- queue mirror 与 running 状态分别由完整 frame 更新。

这套实现解决了本仓库最核心的两个问题：刷新后历史窗口不完整，以及实时 turn 状态落后导致 Composer 仍认为有 active turn。

## 9. Composer：连续 turn 和失败 draft

源码入口：

- [packages/client/ui-conversation/src/client/service.ts](D:/Develop/deepseek-harness-fork/packages/client/ui-conversation/src/client/service.ts)
- [packages/client/ui-conversation/src/client/input/machine.ts](D:/Develop/deepseek-harness-fork/packages/client/ui-conversation/src/client/input/machine.ts)
- [packages/client/ui-conversation/src/client/input/submission-policy.ts](D:/Develop/deepseek-harness-fork/packages/client/ui-conversation/src/client/input/submission-policy.ts)
- [packages/client/ui-conversation/src/client/queue/QueueDock.tsx](D:/Develop/deepseek-harness-fork/packages/client/ui-conversation/src/client/queue/QueueDock.tsx)

提交状态机：

1. onEnter() 创建 SubmitAttempt，保存 seq、mode 和 draftSnapshot；
2. ConversationController.sendSession() 调用 session.prompt(content, mode)；
3. Host 返回 accepted=true 后，输入机收到成功的 submit-settled 或 send-committed；
4. 成功时才清空 draft 和 undo log；
5. adjudication failure 或 submit failure 将 phase 恢复为 plain/claimed，但保留 draft；
6. 如果用户在请求期间编辑了文本，新 draft 优先，不被旧失败结果覆盖；
7. release() 取消 inflight attempt，但不删除 draft。

忙碌 turn 期间，Composer 仍可 Queue 下一条 prompt；支持 steering 时，Queue 和 Steer 根据设置选择。运行中的 turn 不等于 Composer 被锁死。

这正对应本仓库先执行 input.value = '' 再 await sendMessage 的问题。迁移时应实现成功 commit 清空，失败 retain，而不是仅在 catch 中重新填值。

## 10. Trajectory：旧页加载、锚点和虚拟化

源码入口：

- [packages/client/ui-trajectory/src/client/TrajectoryView.tsx](D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/TrajectoryView.tsx)
- [packages/client/ui-trajectory/src/client/TrajectoryTable.tsx](D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/TrajectoryTable.tsx)
- [packages/client/ui-trajectory/src/client/trajectory-virtual-rows.ts](D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/trajectory-virtual-rows.ts)

Trajectory 从 Session snapshot 读取：

- openState 控制首屏 loading；
- loadingOlder 控制旧页状态；
- hasMore 表示是否还有更早记录；
- nodes[0].seq 是窗口起点；
- Trajectory 自己定义 User、Assistant、Tool、Subtool、Compaction 记录；
- 它不另读一套日志，也不修改 Chat snapshot。

TrajectoryTable 的 requestOlder 和 onScroll：

1. 首屏滚到 tail；
2. scrollTop 小于 48px 时自动调用 requestOlder；
3. 请求前记录 historyStartSeq、scrollHeight、scrollTop；
4. 旧页 prepend 后，用新旧 scrollHeight 差值修正 scrollTop；
5. 顶部保留 Load earlier history 按钮；
6. 长日志使用 TanStack virtualizer 和 overscan；
7. 用户向上查看历史时暂停 tail follow，避免新事件把视图拉回底部；
8. 语义 row key 保持稳定，选中记录和几何位置不会因为 prepend 跳变。

迁移建议：Conversation 也应拥有同样的旧页入口，避免只有 Trajectory 能补齐历史。

## 11. DSH 测试对应关系

| 测试 | 覆盖行为 | 本仓库应补充 |
| --- | --- | --- |
| [chat-continuous-conversation.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/chat-continuous-conversation.e2e.ts) | 连续 12 turn、工具调用、每轮 Composer 恢复 | 连续 turn 后 textarea 和 Send 状态 |
| [replay-round-trip.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/replay-round-trip.e2e.ts) | 持久化 fixture 冷启动、回放、真实提交 | 刷新前后 Session projection 一致 |
| [chat-scroll-contract.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/chat-scroll-contract.e2e.ts) | Chat 顶部加载旧页、prepend 锚点、tail follow | Conversation 历史自动恢复 |
| [trajectory-virtualization.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/trajectory-virtualization.e2e.ts) | Trajectory Load earlier、加载状态、虚拟行和选中稳定 | Trajectory 与 Conversation 同源分页 |
| [stats-paged-history.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/stats-paged-history.e2e.ts) | 全日志统计不受分页影响 | turns/steps/token/duration projection |
| [lifecycle-chrome.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/lifecycle-chrome.e2e.ts) | 刷新后的 settled Conversation 回放 | SSE 重连、terminal event、Composer 恢复 |

## 12. 针对本仓库问题的映射

| 本仓库现象 | DSH 机制 | 本仓库改造方向 |
| --- | --- | --- |
| 刷新后第一条 prompt 不见 | tail page + hasMore + loadOlder + Chat 顶部触发 | Conversation 和 Trajectory 共用 history window，显示并自动加载旧页 |
| 第二条 prompt 和 trajectory 也不见 | 同一 Session window，Trajectory 自动向前分页 | 不让单个 bounded window 覆盖完整 Session 语义 |
| 任意 event 条数截断 | message-boundary paginate，保持 raw range 连续 | 以消息或 turn 边界分页，校验 olderTail.seq + 1 |
| turn 完成后无法发送下一条 | running frame、Session.handleRunning、resync、gap repair | terminal/running/queue 用明确投影驱动 Composer |
| SSE 事件列表漂移 | DSH 使用统一 frame union 和显式 frame router | 从公共 contracts 生成监听器并做 reducer 覆盖检查 |
| 实时事件重复或缺口 | liveBuffer、seq dedup、repairGap | 统一 initial replay、SSE append、reconnect replay 和 loadOlder |
| 发送失败后 prompt 丢失 | SubmitAttempt draftSnapshot，失败 retain | API 成功后清空，失败保留，用户新输入优先 |
| stats 随分页变化 | 全日志 sessionStats projection | 统计从 projection 读取，窗口只渲染记录 |
| 加载旧页滚动跳动 | olderLoadAnchor + scrollHeight delta | prepend 前后恢复 scrollTop 和 selected key |
| 长 trajectory 过慢 | virtual rows + overscan + stable key | 在分页正确后引入虚拟化 |

## 13. 建议实施顺序

### 第一阶段：Session replay contract

本仓库入口：

- [apps/web/src/client/connection.ts](D:/Develop/code-review-agent/apps/web/src/client/connection.ts)
- [apps/web/src/client/store.ts](D:/Develop/code-review-agent/apps/web/src/client/store.ts)
- [apps/web/src/client/api.ts](D:/Develop/code-review-agent/apps/web/src/client/api.ts)
- [packages/contracts/src/index.ts](D:/Develop/code-review-agent/packages/contracts/src/index.ts)

DSH 对照入口：

- [packages/client/runtime/src/client/sessions/session.ts](D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/sessions/session.ts)：open、loadOlder、resync、installWindow、acceptLiveEvent、repairGap；
- [packages/client/runtime/src/client/sessions/manager.ts](D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/sessions/manager.ts)：Mux/Host frame 分发、连接恢复后重建 Session；
- [packages/host/apiproxy/src/api-proxy.ts](D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api-proxy.ts)：paginate、historyPage 和尾页 projection baseline；
- [packages/host/apiproxy/src/api/sessions.schema.ts](D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/sessions.schema.ts)：beforeSeq、maxMessages、hasMore 和 history response schema；
- [packages/client/connection/src/client/connection.ts](D:/Develop/deepseek-harness-fork/packages/client/connection/src/client/connection.ts)：generation、readiness handshake、重连和旧 generation 失效。

对照关系：本阶段应先以 DSH Session 的窗口状态和 seq 拼接逻辑为行为参考，再把传输层映射到本仓库 SSE；不要只修改本仓库的 history limit。

先增加 baseSequence、tailSequence、hasMoreBefore、loadingOlder、connectionGeneration；让初始加载、SSE、重连、旧页都走同一个 seq-aware reducer；增加连续性校验和 gap repair；统一事件类型来源。

### 第二阶段：Composer 状态

本仓库入口：

- [apps/web/index.html](D:/Develop/code-review-agent/apps/web/index.html)
- [apps/web/src/client/connection.ts](D:/Develop/code-review-agent/apps/web/src/client/connection.ts)

DSH 对照入口：

- [packages/client/ui-conversation/src/client/input/machine.ts](D:/Develop/deepseek-harness-fork/packages/client/ui-conversation/src/client/input/machine.ts)：SubmitAttempt、draftSnapshot、onSubmitSettled、onSendCommitted、onRelease；
- [packages/client/ui-conversation/src/client/service.ts](D:/Develop/deepseek-harness-fork/packages/client/ui-conversation/src/client/service.ts)：send、sendSession、Queue/Steer 的 Host admission；
- [packages/client/runtime/src/client/sessions/session.ts](D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/sessions/session.ts)：handleRunning、handleMuxEnvelope、composerPhase 所需的 Session 状态；
- [packages/client/runtime/src/client/sessions/queue-mirror.ts](D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/sessions/queue-mirror.ts)：完整 queue snapshot 和 durable steering handoff；
- [apps/web/tests/chat-continuous-conversation.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/chat-continuous-conversation.e2e.ts)：连续 12 个 turn 的 Composer 恢复验收。

对照关系：本阶段以 DSH InputMachine 的提交事务为参考，成功才清空 draft，失败保留 draft；以 DSH running/queue 分离状态为参考，不把 Composer 是否可提交简化为单个 active turn 布尔值。

区分 active turn、running、queued、pending request、stopping、boot；terminal event 后重新派生 Send；保存 draft snapshot，服务端接受后清空，失败保留。

### 第三阶段：Conversation 与 Trajectory 同源分页

本仓库入口：

- [apps/web/index.html](D:/Develop/code-review-agent/apps/web/index.html)
- [apps/web/src/client/store.ts](D:/Develop/code-review-agent/apps/web/src/client/store.ts)
- [apps/web/src/client/connection.ts](D:/Develop/code-review-agent/apps/web/src/client/connection.ts)

DSH 对照入口：

- [packages/client/runtime/src/client/sessions/session.ts](D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/sessions/session.ts)：同一个 Session window 同时服务 Chat 和 Trajectory；
- [packages/client/ui-trajectory/src/client/TrajectoryView.tsx](D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/TrajectoryView.tsx)：读取 openState、loadingOlder、hasMore 和窗口起点；
- [packages/client/ui-trajectory/src/client/TrajectoryTable.tsx](D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/TrajectoryTable.tsx)：requestOlder、顶部自动加载、Load earlier history、olderLoadAnchor；
- [packages/client/ui-trajectory/src/client/trajectory-virtual-rows.ts](D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/trajectory-virtual-rows.ts)：稳定语义 row key 和虚拟行；
- [apps/web/tests/chat-scroll-contract.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/chat-scroll-contract.e2e.ts)：Conversation prepend 后滚动锚点验收；
- [apps/web/tests/trajectory-virtualization.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/trajectory-virtualization.e2e.ts)：Trajectory 旧页、虚拟化和选中稳定性验收。

对照关系：本阶段应复用本仓库同一个 SessionStore window；DSH 的 Trajectory 组件只负责消费窗口和触发 loadOlder，不另建日志读取路径。Conversation 也必须拥有同等的旧页入口，不能只修 Trajectory。

Conversation 顶部自动 loadOlder；Trajectory 保留显式按钮；两个视图共享 baseSequence 和 hasMoreBefore；prepend 时保留滚动锚点和选择。

### 第四阶段：Projection 与统计

本仓库入口：

- [packages/runtime/src/index.ts](D:/Develop/code-review-agent/packages/runtime/src/index.ts)
- [packages/storage/src/index.ts](D:/Develop/code-review-agent/packages/storage/src/index.ts)
- [packages/contracts/src/index.ts](D:/Develop/code-review-agent/packages/contracts/src/index.ts)

DSH 对照入口：

- [packages/session/session-projection/src/index.ts](D:/Develop/deepseek-harness-fork/packages/session/session-projection/src/index.ts)：ProjectionRegistry、snapshot、restore、stateVersion；
- [packages/session/session-projection-cache/src/index.ts](D:/Develop/deepseek-harness-fork/packages/session/session-projection-cache/src/index.ts)：checkpoint、revision 校验和 tail replay；
- [packages/session/session-stats/src/index.ts](D:/Develop/deepseek-harness-fork/packages/session/session-stats/src/index.ts)：全日志 turns、steps、timing 和 token 统计 projection；
- [packages/host/apiproxy/src/api-proxy.ts](D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api-proxy.ts)：history 尾页 baseline 和 session/projection 推送；
- [apps/web/tests/stats-paged-history.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/stats-paged-history.e2e.ts)：分页前后全日志统计不变的验收。

对照关系：本阶段借鉴 DSH 的“projection 是全日志状态，history page 只是载体”原则；不要在 Conversation/Trajectory reducer 中重复累计全局统计。

为 turns、steps、tokens、duration 和 latest prompt 建立全日志 projection；tail baseline 和实时高 seq 覆盖；projection version 变化时重新折叠。

### 第五阶段：浏览器验收

本仓库入口：

- [apps/web/tests](D:/Develop/code-review-agent/apps/web/tests)：补充连续 turn、刷新回放、SSE gap repair、Composer draft 和分页锚点测试；
- [apps/api/src/server.test.ts](D:/Develop/code-review-agent/apps/api/src/server.test.ts)：补充 history page、sequence continuity 和 replay contract 测试；
- [apps/web/src/client/connection.test.ts](D:/Develop/code-review-agent/apps/web/src/client/connection.test.ts)：补充 generation、重连和事件列表覆盖测试。

DSH 对照入口：

- [apps/web/tests/chat-continuous-conversation.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/chat-continuous-conversation.e2e.ts)：连续多 turn；
- [apps/web/tests/replay-round-trip.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/replay-round-trip.e2e.ts)：持久化 fixture 冷启动和真实 round trip；
- [apps/web/tests/lifecycle-chrome.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/lifecycle-chrome.e2e.ts)：刷新后的 settled Conversation 回放；
- [apps/web/tests/chat-scroll-contract.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/chat-scroll-contract.e2e.ts)：Chat 旧页加载和滚动 contract；
- [apps/web/tests/trajectory-virtualization.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/trajectory-virtualization.e2e.ts)：Trajectory 分页、虚拟行和 selection；
- [apps/web/tests/stats-paged-history.e2e.ts](D:/Develop/deepseek-harness-fork/apps/web/tests/stats-paged-history.e2e.ts)：全日志统计与分页一致性。

对照关系：每一个本仓库新增 e2e 场景都应先找到一个 DSH 行为对照测试，再确定本仓库的事件名称、API 和 UI 断言；如果没有对应 DSH 场景，应先补充设计记录再实现。

至少加入：

- 12 个连续 turn，第一轮完成后无需刷新即可发送第二轮；
- 超过 200 条事件，刷新后第一、第二条 prompt 可从 Conversation 和 Trajectory 恢复；
- SSE 丢一帧后重连无缺口、无重复；
- terminal event 后 active turn 清零；
- queue snapshot 在重连后不会保留旧值；
- 发送失败保留 draft；
- prepend 后滚动位置和选中行稳定；
- stats 在旧页加载前后不变；
- SQLite 完整日志冷启动与实时 projection 一致。

## 14. 不应直接照搬的细节

1. DSH 使用 WebSocket mux，本仓库可以继续使用 SSE，但必须补齐 generation、cursor、replay 和 gap repair；
2. DSH 的 50 是消息页大小，不是历史正确性的边界；
3. DSH 的 session/projection 是 Host 计算的 whole value，本仓库应明确 projection 的事实来源；
4. DSH 使用 scoped Context，本仓库应保持现有 AgentHost、SessionStore 和 contracts 分层；
5. DSH 把 queue、running、pending request 分开维护，本仓库不应把它们压成一个 activeTurn 布尔值；
6. DSH 的虚拟化建立在分页和连续性正确之后，不能用虚拟化掩盖回放缺陷。

## 15. 最终原则

~~~text
完整 Event Store / projection baseline
        ↓
带 sequence 的 Session history window
        ↓
SSE live append + dedup + gap repair
        ↓
Conversation / Trajectory 同源渲染
        ↓
Composer 从 authoritative running/queue/pending 状态派生
        ↓
成功 commit 清空 draft，失败保留 draft
~~~

最终验收关注的不是刷新接口是否返回 200 条，而是：

- 页面是否知道还有更早历史；
- Conversation 和 Trajectory 是否可以通过同一个 Session window 恢复；
- 实时事件、重连回放和旧页 prepend 是否序列连续；
- terminal event 后 Composer 是否恢复可提交；
- 发送失败是否保留用户输入；
- 全日志统计是否不受分页窗口影响。
