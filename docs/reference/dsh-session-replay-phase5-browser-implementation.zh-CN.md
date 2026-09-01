# DSH Session/Turn/Trajectory 与 Composer：第五阶段浏览器验收实现记录

日期：2026-08-26
范围：依据 `docs/reference/dsh-session-replay-and-composer-reference.zh-CN.md` 完成浏览器验收与回归覆盖。
阶段性质：本记录中的“第五阶段”指 Session replay/composer 参考文档的第五阶段，不改变项目迁移计划中既有的 Phase 5 Subagent 历史记录。

## 1. 结论

第五阶段已新增一个可重复执行的浏览器边界 gate。它启动真实 SQLite EventStore、AgentHost、HTTP API 和静态 Web shell，通过 HTTP、SSE 和冷启动重建验证浏览器消费的事实来源。

本阶段没有引入 Playwright 生产依赖，也没有复制 DSH 的 WebSocket 或内部类型。每个场景都保留在 `apps/web/tests` 中，后续可以直接接入图形浏览器执行；统一 gate 使用相同的 API/SSE/SQLite 边界，避免只检查静态 HTML marker。

## 2. 实现入口

| 责任 | 本仓库入口 | DSH 行为参考 |
| --- | --- | --- |
| 连续多 turn | `apps/web/tests/chat-continuous-conversation.e2e.mjs`、`packages/runtime/src/index.test.ts` | `D:/Develop/deepseek-harness-fork/apps/web/tests/chat-continuous-conversation.e2e.ts` |
| 冷启动回放与 200 条窗口 | `apps/web/tests/replay-round-trip.e2e.mjs`、`apps/api/src/server.test.ts` | `D:/Develop/deepseek-harness-fork/apps/web/tests/replay-round-trip.e2e.ts`、`lifecycle-chrome.e2e.ts` |
| SSE 丢帧/重连 | `apps/web/tests/lifecycle-chrome.e2e.mjs`、`apps/web/src/client/connection.test.ts` | `D:/Develop/deepseek-harness-fork/packages/client/connection/src/client/connection.ts` |
| queue snapshot 清理 | `apps/web/tests/queue-reconnect.e2e.mjs`、`apps/web/src/presentation/queue-presenter.test.ts` | `D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/sessions/queue-mirror.ts` |
| Composer 失败 draft | `apps/web/tests/composer-failure.e2e.mjs`、`apps/web/src/presentation/composer-state.test.ts` | `D:/Develop/deepseek-harness-fork/packages/client/ui-conversation/src/client/input/machine.ts`、`submission-policy.ts` |
| Conversation prepend 锚点 | `apps/web/tests/chat-scroll-contract.e2e.mjs`、`apps/web/src/client/store.test.ts` | `D:/Develop/deepseek-harness-fork/apps/web/tests/chat-scroll-contract.e2e.ts` |
| Trajectory 长日志窗口 | `apps/web/tests/trajectory-virtualization.e2e.mjs`、`apps/web/src/projection/trajectory.test.ts` | `D:/Develop/deepseek-harness-fork/apps/web/tests/trajectory-virtualization.e2e.ts` |
| 全日志 stats | `apps/web/tests/stats-paged-history.e2e.mjs`、`apps/web/src/presentation/usage-presenter.test.ts` | `D:/Develop/deepseek-harness-fork/apps/web/tests/stats-paged-history.e2e.ts` |

共享 fixture 位于 `apps/web/tests/fixture.mjs`。它只在构造可控事件和验证重启时直接访问 Store；页面侧事实仍通过 API/SSE 获取。

统一入口：

```text
pnpm test:phase5:browser
  → pnpm typecheck
  → pnpm build:web
  → node scripts/phase5-browser-gate.mjs
```

## 3. 场景与验收断言

### 3.1 连续多 turn

`chat-continuous-conversation.e2e.mjs` 通过真实 `/v1/sessions/:id` 提交 12 个 prompt，每轮轮询 API projection 直到 `status=idle`，然后断言 12 条 user message、12 条 assistant message 全部保留，所有 turn 已离开 `running/queued`。

该场景对应 DSH 连续 12 turn 测试，重点验证 terminal event 后 Composer 重新派生 Send 状态。

### 3.2 超过 200 条事件的冷启动回放

`replay-round-trip.e2e.mjs` 先产生两条需要长期保留的 prompt，再追加 240 条 durable filler，使日志达到 287 条。首屏请求严格限制为 200 条并检查 `hasMoreBefore=true`；随后关闭并重新打开 SQLite/API，逐页从尾部向前读取并验证：

- raw sequence 连续且无重复；
- 第一条和第二条 prompt 仍存在于 Session projection；
- 两条 prompt 也存在于 Trajectory 的事件源；
- cold-start 最新窗口、`lastSequence` 和 stats source sequence 与重启前一致；
- 冷启动后追加的 live event 能立即进入 projection，并在下一次重启后再次出现。

### 3.3 SSE 丢帧与重连

`lifecycle-chrome.e2e.mjs` 使用真实 SSE endpoint：第一条连接只消费一个 live frame，随后模拟客户端丢帧并关闭连接；第二条连接从同一 cursor 请求历史 replay，断言得到完整 `[n+1,n+2]`、顺序连续且没有重复。

`apps/web/src/client/connection.test.ts` 继续覆盖客户端 generation、gap repair、live buffer 和旧 generation 失效；浏览器 gate 覆盖传输边界，两者共同形成恢复证据。

### 3.4 queue 与 Composer

`queue-reconnect.e2e.mjs` 先写入两个 queued turn 和明确的 `queue/changed` 顺序，再追加空 queue snapshot，重启后断言旧 queue position 不会复活。

`composer-failure.e2e.mjs` 通过缺失 Session 的真实 HTTP admission failure 验证 host 不会产生副作用，并检查 Web shell 仍使用 `settleComposerSubmit` 事务入口。精确的“成功才清空、失败保留 draft、旧 settlement 不覆盖新输入”由 `composer-state.test.ts` 作为 reducer 合同测试；这避免在无图形 DOM 环境中伪造输入框状态。

### 3.5 Conversation/Trajectory prepend 与 stats

`chat-scroll-contract.e2e.mjs` 以事件 id 作为稳定 row key，在旧页 prepend 后断言选中行索引只增加旧页长度且没有重复。

`trajectory-virtualization.e2e.mjs` 产生 130 个 tool turn（651 条事件），验证窗口 bounded 到 200 条、旧页可完整回放、最早和最新 prompt 都能搜索到、语义 row key 唯一。

`stats-paged-history.e2e.mjs` 在 8 个真实 turn 和长 filler 日志上读取尾页及旧页，断言加载旧页前后 whole-log stats 完全相同，且 projection 标记为 `complete`。

## 4. 与现有实现的关系

本阶段没有新增 Event、Tool、Task、Permission 或 Workspace 字段，也没有改变 API schema。验收直接使用前四阶段已经冻结的：

- `EventPage` 的 `limit/before_sequence/hasMoreBefore`；
- `SessionStore` 的 `baseSequence/tailSequence/loadingOlder/connectionGeneration`；
- `SessionConnectionController` 的 SSE cursor、generation、gap repair；
- Composer transactional state；
- whole-log `session.stats` projection。

因此第五阶段的交付物是测试和门禁，不会引入第二个事实来源。

## 5. 运行结果

2026-08-26 本地结果：

```text
pnpm typecheck                         ✓
pnpm build:web                         ✓
pnpm test:phase5:browser               ✓
git diff --check                       ✓
```

统一 gate 的场景摘要：

```text
continuous conversation       12 turns, 24 messages
replay round-trip              287 events, 200-event bounded page, SQLite reopen
SSE lifecycle                  terminal idle, replay [5, 6], no duplicate
queue reconnect                stale queue removed after restart
composer failure               draft retained, transactional bridge present
scroll contract                selected row anchor delta equals prepended rows
trajectory window              651 events, bounded 200, 130 searchable prompts
stats paged history            14 pages, 8 turns, stats unchanged
```

## 6. 已知边界与后续接入

当前仓库未将 Playwright 固定为依赖，因此 gate 是“真实浏览器边界”而非图形浏览器截图测试。它已经验证浏览器实际依赖的 HTTP/SSE/SQLite 行为；后续若接入图形浏览器，只需让 DSH 对照的 e2e 文件调用相同 fixture 和断言，不应改变 EventStore 或 Web projection。

回滚方式：删除 `scripts/phase5-browser-gate.mjs`、`apps/web/tests` 新增场景、对应 package script 与本记录即可；生产运行时代码和前四阶段契约不受影响。
