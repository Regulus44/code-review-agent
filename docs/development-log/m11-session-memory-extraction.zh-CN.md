# M11 开发日志：Session Memory Extraction

状态：`implemented`

日期：2026-08-26

阶段：Phase 8 / M11

## 任务七问

1. Phase：Phase 8 高级上下文能力，M11；依赖 M02、M08、M10。
2. 问题类型：为已有 Session Memory Compact 增加 Claude Code 式后台提取、状态持久化和重启恢复。
3. 契约影响：新增 extraction started/completed/failed/cancelled 事件、`ContextSessionMemoryProjection`、`SessionMemoryExtractor` 和可选 `SessionMemoryStore.save()`。
4. Claude Code 参考：`sessionMemoryUtils.ts` 的阈值/等待状态，`sessionMemory.ts` 的 `shouldExtractMemory()`、`runForkedAgent()`、`createMemoryFileCanUseTool()`。
5. 上游来源：`behavior-reference`；未复制本地 Claude Code 源码，因其 SessionMemory transcript/host 依赖与本项目存储边界不同。
6. 验收场景：token/tool/natural-break 门控；同一 session 串行；隔离 capability；失败不影响主 turn；保存后重启恢复且不重复写入；事件不含 memory 正文。
7. 回滚方式：停止配置 `sessionMemoryExtractor`，保留 M06 只读 compact；删除 M11 事件消费不影响原始 transcript 和旧 projection。

## 变更记录

1. `packages/context/src/session-memory.ts` 新增 extraction config、stats、门控 decision、状态迁移、串行 scheduler 和 exact-path write guard。
2. `packages/context/src/session-memory-compact.ts` 将 `SessionMemoryStore` 扩展为可选 `save()`/`memoryPath()`，继续保持 host-owned memory 正文边界。
3. `packages/contracts/src/index.ts` 新增四类 M11 事件和 `ContextSessionMemoryProjection`。
4. `packages/storage/src/index.ts` 在 InMemory/SQLite 共用的 reducer 中投影 M11 状态；事件只保存 bounded metadata。
5. `packages/runtime/src/index.ts` 在成功 turn 后后台调度 extraction，主 turn 不等待；提供等待/取消接口；失败和取消不进入主 turn error path。
6. Runtime 为 extractor 提供固定 restricted capabilities，并在 host 提供 memory path 时传入 `SessionMemoryFileWriteGuard`。
7. Host restart 检查 running/queued projection；发现 memory 已保存相同 source cursor 时追加幂等 completed receipt，避免重复 extraction。
8. 新增 Context、Runtime、Storage 测试和 M11 实施说明。

## 关键决策

- 门控采用 Claude Code 的组合条件：初始化 token threshold；后续 token growth threshold；tool call threshold 与自然 assistant break 二选一；token threshold 永远必需。
- extraction state 按 session 存储在 EventStore projection 中，不使用 Claude Code 的进程级全局变量，避免并行 session/subagent 互相污染。
- memory 正文由 host-owned store 保存；EventStore、SSE、projection 和诊断不复制正文。
- extractor 没有父 Agent 的工具、workspace write 或 execute 能力；写入必须经 host `save()`，文件 adapter 还需通过 exact-path guard。
- extraction 失败不能让已完成的 assistant turn 变为失败；失败只生成 bounded diagnostic event。

## 验证结果

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/context test -- --run ✓
pnpm --filter @code-review-agent/storage test -- --run ✓
pnpm --filter @code-review-agent/runtime test -- --run ✓
```

完整 `pnpm test` 与最终 `git diff --check` 在 checkpoint 前执行。

## 后续边界

M11 不包含 Project Memory/memdir、JSONL transcript 文件轮转、provider prompt cache edit、hooks、账户/遥测和 Web Context inspector。M12 负责项目记忆，M13 负责 Context diagnostics 与 Web projection。
