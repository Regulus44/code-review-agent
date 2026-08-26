# DSH Session Stats Projection：第四阶段实施记录

日期：2026-08-26
范围：把全日志统计从 Web bounded history window 中分离出来，并让 Storage、Runtime、Web 使用同一套 Projection 语义。

## 交付结果

- `SessionProjection.stats` 新增 `SessionStatsProjection`，覆盖 `version`、`sourceSequence`、`complete`、`latestPrompt`、turn/step/tool 数量、duration、TTFT、token usage、total tokens、generation speed、cache hit 和 Session status。
- `packages/contracts` 提供 `createSessionStatsProjection` 与 `reduceSessionStats`，Storage 与 Web live-tail reducer 共用这套折叠逻辑。
- `packages/storage` 在 `baseProjection` 初始化 stats，在 `applyEvent`/`replayProjection` 中按完整事件日志更新 stats；SQLite reopen 会通过现有 `rebuildProjections()` 重建 stats。
- `packages/runtime` 保持 `getSession()` 返回完整 SessionProjection，并新增 `getSessionStats()` 作为不依赖 history page 的显式查询入口。
- `apps/web/src/client/store.ts` 将服务端 stats 作为 whole-log baseline；实时无 gap 的高 sequence 事件继续增量折叠，`prependHistory` 只重建 Conversation/Trajectory，不重新累计 stats。
- `apps/web` usage meter 优先读取 `snapshot.session.stats`；legacy projection 没有 stats 时才退回当前事件窗口，并在标题中标明覆盖范围。

## 本仓库入口

| 位置 | 作用 |
| --- | --- |
| `packages/contracts/src/index.ts` | `SessionStatsProjection`、内部 fold cursor、`createSessionStatsProjection`、`reduceSessionStats` |
| `packages/storage/src/index.ts` | `baseProjection` 初始化、`applyEvent` 折叠、`replayProjection` 和 SQLite rebuild |
| `packages/runtime/src/index.ts` | `AgentHost.getSession()` whole projection 返回，以及 `getSessionStats()` 显式读取入口 |
| `apps/web/src/client/store.ts` | 服务端 baseline、实时高 sequence stats 增量、旧页 prepend 与 stats 解耦 |
| `apps/web/src/presentation/usage-presenter.ts` | Projection/event 双输入 presenter、完整日志/窗口覆盖标记 |
| `apps/web/index.html` | usage meter 从 `snapshot.session.stats` 渲染，不从 bounded `state.events` 计算全局值 |
| `docs/event-contract.md` | stats projection 的事件事实来源、sequence、兼容和安全边界 |

## DSH 对照入口

- `D:/Develop/deepseek-harness-fork/packages/session/session-projection/src/index.ts`：ProjectionRegistry、snapshot/restore、stateVersion。
- `D:/Develop/deepseek-harness-fork/packages/session/session-projection-cache/src/index.ts`：checkpoint、revision 校验和 tail replay。
- `D:/Develop/deepseek-harness-fork/packages/session/session-stats/src/index.ts`：全日志 turns、steps、timing、tokens 统计。
- `D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api-proxy.ts`：history 尾页与 projection baseline/推送。
- `D:/Develop/deepseek-harness-fork/apps/web/tests/stats-paged-history.e2e.ts`：分页前后 stats 不变的浏览器验收。

本仓库没有复制 DSH 内部类型或实现；只复用“Projection 是完整日志状态，history page 是窗口载体”的行为边界。

## 关键实现语义

1. Event Store 仍是唯一事实来源。`sourceSequence` 是 stats 覆盖到的事件 sequence，不能用 bounded history 的 tail 代替。
2. `complete=true` 表示来自完整 Session projection；没有服务端 stats 的旧 projection 使用 `complete=false` 的兼容 fallback。
3. Storage 的 SQLite projection JSON 继续沿用现有表，不新增旁路统计表；旧数据库打开时由完整 events rebuild，因此不会把旧的 bounded page 当作全局状态。
4. `folding` 只保存继续处理高 sequence tail 所需的 turn/step/tool 起始时间与已见 turn id，不保存 transcript、provider response、credential 或 secret。
5. Web 旧页加载只影响当前可见 Conversation/Trajectory 节点；stats 的 turns/steps/tokens/duration/latest prompt 不因分页发生重复累计或倒退。
6. Projection version 不匹配时 presenter 不把未知结构冒充完整 stats；应通过服务端 rebuild 后重新下发 version `1` projection。

## 验收与回滚

已验证：

```text
pnpm typecheck
pnpm --filter @code-review-agent/contracts test
pnpm --filter @code-review-agent/storage test
pnpm --filter @code-review-agent/web test
```

覆盖场景：

- 200 条以上事件/多 turn 日志，history page 变化前后 whole-log stats 一致；
- InMemory 与 SQLite projection 都能重建 turns、steps、tokens、duration、latest prompt；
- SQLite close/reopen 后 stats 不丢；
- Web server baseline 加载后，实时高 sequence 事件更新 stats；旧页 prepend 不重复统计；
- legacy projection 缺少 stats 时明确降级为 bounded-window usage。

回滚边界：回滚本阶段提交会移除 `SessionProjection.stats` 与 Web whole-log usage 入口，但不会删除 EventStore 事件、改变 sequence、影响 Conversation/Trajectory 分页、Composer 或权限 contract。SQLite 现有事件和 projection 表保持可读，后续重新部署时可再次由完整日志 rebuild。
