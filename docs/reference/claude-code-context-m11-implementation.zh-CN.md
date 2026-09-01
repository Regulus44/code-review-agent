# M11：Claude Code 式 Session Memory Extraction 实施说明

状态：`implemented`

日期：2026-08-26

阶段：Phase 8 / M11

## 代码映射

| Claude Code 入口 | 本项目入口 | 对照方式 |
|---|---|---|
| `src/services/SessionMemory/sessionMemoryUtils.ts` 的配置和 threshold helpers | `packages/context/src/session-memory.ts` | 保留 10,000 初始 token、5,000 增长 token、3 次 tool call 默认门槛；改为 session-scoped pure state |
| `sessionMemory.ts:135-181` 的 `shouldExtractMemory()` | `sessionMemoryStats()` + `shouldExtractSessionMemory()` | token 门槛始终必需；tool threshold 与自然断点按 Claude Code 规则组合 |
| `markExtractionStarted()` / `markExtractionCompleted()` | 同名状态迁移函数及 failed/cancelled 变体 | 状态显式返回新对象，可由事件 replay 重建 |
| `waitForSessionMemoryExtraction()` | `SessionMemoryExtractionScheduler.wait()` | 每个 session 独立串行尾部和 timeout；主 turn 不等待 |
| `runForkedAgent()` + `createSubagentContext()` | `AgentHost` 的 `SessionMemoryExtractor` adapter | extractor 只收到 snapshot、消息和受限 capability |
| `createMemoryFileCanUseTool(memoryPath)` | `createSessionMemoryFileWriteGuard()` | 规范化后只允许 exact path 写入 |
| `setupSessionMemoryFile()` | `SessionMemoryStore.memoryPath()` + host-owned `save()` | 路径由 host 提供；memory 正文不进入 EventStore |

## 触发门控

`sessionMemoryStats()` 计算 model-visible transcript 的估算 token、最后一个 durable messageId、上次 extraction 后的 assistant tool call 数和最后一轮 assistant 的 tool call 数。

`shouldExtractSessionMemory()` 顺序固定为：

1. `queued`/`running` 返回 `in_flight`，同一 session 不重复调度；
2. 未初始化时，当前 token 达到 `minimumMessageTokensToInit`；
3. 已初始化后，当前 token 与 `lastExtractedTokens` 的增长达到 `minimumTokensBetweenUpdate`；
4. token 达标后，满足 tool call threshold，或最后一轮 assistant 没有 tool call 的自然断点；
5. 触发原因记录为 `initialization`、`threshold` 或 `natural_break`。

tool call threshold 不能单独触发 extraction；自然断点也不能绕过 token growth threshold。

## Runtime 调度

`AgentHost.runTurn()` 和 `runRecoveredTurn()` 只有在主 turn 成功追加 `turn/ended: completed` 后才调用 `scheduleSessionMemoryExtraction()`。该调用只创建后台任务，不延长主 turn 完成路径。

同一 session 使用 `SessionMemoryExtractionScheduler` 串行执行；不同 session 互不阻塞。`waitForSessionMemoryExtraction()` 只用于 host/测试等待，`cancelSessionMemoryExtraction()` 只取消 extraction 的 `AbortController`。

```text
turn completed
  → read transcript + current memory
  → shouldExtractSessionMemory
  → context/session_memory_extraction_started
  → isolated SessionMemoryExtractor.extract
  → host-owned SessionMemoryStore.save
  → context/session_memory_extraction_completed
```

失败和取消分别追加 `context/session_memory_extraction_failed` 或 `context/session_memory_extraction_cancelled`，不会追加 `agent/error`，也不会把失败文本写入 memory。

## 隔离与安全

`SessionMemoryExtractionRequest.capabilities` 固定为：`canReadSessionMemory: true`、`canWriteSessionMemory: true`、`canUseParentTools: false`、`canWriteWorkspace: false`、`canExecute: false`。

extractor 只能通过 host 传入的 `SessionMemoryStore.save()` 更新 memory。若 host 提供 `memoryPath()`，Runtime 同时传入 `SessionMemoryFileWriteGuard`；adapter 在执行文件工具时必须调用 `assertWritable()`，非 exact path 抛出 `SESSION_MEMORY_WRITE_PATH_DENIED`。

memory 内容只保留在 host-owned store。事件和 projection 仅记录 `memoryChars`、`memoryUpdatedAt`、source cursor、token/tool 统计、extractor session id 和有界错误。

## Durable 事件与 Projection

| 事件 | 作用 | 允许的数据 |
|---|---|---|
| `context/session_memory_extraction_started` | source cursor、触发原因、阈值统计、extractor session id | bounded metadata |
| `context/session_memory_extraction_completed` | host-owned save 成功和新的 message cursor | cursor、token/tool 统计、长度和时间 |
| `context/session_memory_extraction_failed` | 失败诊断 | bounded error 和 source metadata |
| `context/session_memory_extraction_cancelled` | 取消 | source metadata |

`SessionProjection.contextSessionMemory` 由事件 reducer 得到，包含状态、初始化标记、message cursor、token/tool 统计、extractor session id、时间戳和有界错误。InMemory 与 SQLite 使用同一个 `applyEvent()` / `replayProjection()` 逻辑。

## 重启恢复和幂等

`restoreQueuedTurns()` 检查 projection 中的 `running`/`queued` extraction。重启后按原 source cursor 重新排队；若 host-owned memory 已保存相同的 `sourceMessageId`，Runtime 追加 `idempotentRecovery: true` 的 completed receipt，不重复调用 extractor。

## 测试入口

- `packages/context/src/session-memory.test.ts`：初始化/增长/tool/natural-break 门控、串行 scheduler、exact path guard；
- `packages/runtime/src/index.test.ts`：后台 extraction、受限 capability、memory save、事件不包含正文；
- `packages/storage/src/index.test.ts`：M11 metadata replay 和正文不进入 projection。

验证命令：

```text
pnpm typecheck
pnpm --filter @coding-agent/context test -- --run
pnpm --filter @coding-agent/storage test -- --run
pnpm --filter @coding-agent/runtime test -- --run
pnpm test
git diff --check
```

## 不包含内容

M11 不复制 Claude Code 的账户、遥测、feature flag、JSONL transcript 文件布局、Project Memory/memdir、provider prompt cache edit 或主 Agent 的全部工具权限。M12 继续实现 Project Memory；M13 负责 Context diagnostics 与 Web projection。
