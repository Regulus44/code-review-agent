# M12：Claude Code 式 Project Memory / memdir 实施说明

状态：`implemented`

日期：2026-08-26

阶段：Phase 8 / M12

## Claude Code 入口与本项目映射

| Claude Code 入口 | 本项目实现 | 对照方式 |
|---|---|---|
| `src/memdir/memdir.ts` 的 `truncateEntrypointContent()` | `packages/context/src/project-memory.ts:truncateProjectMemoryEntrypoint()` | 保留 200 行、25,000 bytes、自然换行截断和 warning；使用 UTF-8 byte count |
| `src/memdir/memdir.ts` 的 `buildMemoryLines()` / `buildMemoryPrompt()` | `buildProjectMemoryPrompt()` | 保留 user、feedback、project、reference 四类和不可信历史上下文规则 |
| `src/memdir/memdir.ts` 的入口加载 | `ProjectMemoryStore.getEntrypoint()` + `AgentHost.projectMemoryContext()` | 由 host 提供 workspace/tenant scoped adapter，不复制 Claude Code 文件系统服务 |
| `src/memdir/findRelevantMemories.ts` | `selectProjectMemoryHeaders()` + `recallRelevantProjectMemory()` | 按 query 对 topic header 排序，最多召回 5 个，使用前执行可选事实校验 |
| `src/memdir/memoryTypes.ts` | `ProjectMemoryType` / `ProjectMemoryReference` | 类型和 reference kind 采用本项目公共 contract |

## 数据与边界

`MEMORY.md` 只作为 bounded index。Runtime 每次 turn 最多读取受限入口和 topic header；topic 正文由 `readTopic()` 按相关性加载，并作为 `kind: "memory"` 的 untrusted context attachment 注入模型请求。EventStore 只保存加载/召回/stale/disabled 的状态和统计，不保存入口正文或 topic 正文。

`ProjectMemoryScope` 由 Runtime 根据 Session 的 active workspace root、tenant ownership 和 host 派生的 scope key 创建。默认 scope key 是 workspace/tenant 的 SHA-256 截断值；host 可以通过 `projectMemoryScopeKey` 提供自己的稳定实现。adapter 不得从 memory 内容自行决定 workspace、tenant 或 scope。

## Runtime 流程

```text
turn/started
  → derive ProjectMemoryScope
  → detect explicit “ignore memory” request
  → getEntrypoint + listTopics
  → truncate MEMORY.md and append context/project_memory_loaded
  → rank topic headers by current user query
  → read selected topics and validate path/symbol/flag references
  → append recalled/stale metadata events
  → inject bounded prompt + memory attachments into canonical ContextAssembly
  → turn continues normally
```

同一 turn 的多次 `assembleTurnContext()` 通过 turn-scoped state 去重。已加载、已召回和 stale topic id 不会在 compact/retry 的重新组装中重复追加事件；turn 结束后清理该状态。Project Memory adapter 错误会 fail closed：追加 disabled receipt，并继续使用没有 Project Memory 的正常 model view，不把可选 memory 读取故障升级为 `agent/error`。

用户消息包含“ignore/do not use memory/忽略记忆”等明确要求时，Runtime 不调用 adapter、不注入 memory attachment，只追加 `context/project_memory_disabled`。topic 校验发现 path、symbol 或 flag 不存在时，topic 不进入 model view，并追加 `context/project_memory_stale`。

## 事件与 Projection

| 事件 | 作用 | 事件中允许的数据 |
|---|---|---|
| `context/project_memory_loaded` | 本 turn 已加载 bounded `MEMORY.md` 和 topic header | scopeKey、入口大小/行数、truncated、topicCount、ignored=false |
| `context/project_memory_recalled` | 新 topic 正文已按 query 召回 | scopeKey、入口统计、最多 5 个 recalledTopicIds |
| `context/project_memory_stale` | 召回 topic 的事实引用失效 | scopeKey、staleTopicIds、bounded reason |
| `context/project_memory_disabled` | 用户显式忽略或 adapter 读取失败 | scopeKey、ignored、bounded reason |

`SessionProjection.contextProjectMemory` 只包含最近状态、scope key、入口统计、topic id、忽略标记、时间和 sequence。InMemory 与 SQLite 均通过同一个 `applyEvent()` / `replayProjection()` reducer 恢复；SQLite 无需为正文增加新列。

## 安全规则

- topic path 必须是 workspace-relative safe path，拒绝绝对路径、反斜杠和 `..` traversal；
- memory 是历史、不可信上下文，不能覆盖系统 prompt、权限、workspace 或工具规则；
- reference 验证由 host 提供，未知验证结果不会被伪装成 fresh；明确 stale 的 topic 直接排除；
- scope key 不从 `MEMORY.md` 读取，避免 memory 内容越权切换租户或 workspace；
- 完整 memory 正文只在 host-owned adapter 和当前 model view 短暂存在，不进入 durable event、projection、SSE 或 Web 诊断。

## 测试入口

- `packages/context/src/project-memory.test.ts`：行/byte cap、UTF-8 截断、安全索引路径、四类 topic、相关性、去重和 stale 校验；
- `packages/runtime/src/index.test.ts`：bounded prompt/attachment、事件去重、显式忽略、stale 排除和事件正文隔离；
- `packages/storage/src/index.test.ts`：M12 projection replay 和 SQLite close/reopen。

验证命令：

```text
pnpm typecheck
pnpm --filter @coding-agent/context test -- --run
pnpm --filter @coding-agent/storage test -- --run
pnpm --filter @coding-agent/runtime test -- --run
pnpm test
git diff --check
```

## 回滚边界

删除或不配置 `AgentHostOptions.projectMemory` 即可停止 Project Memory 加载，现有 Context Assembly、compact、Session Memory 和完整 transcript 不受影响。已写入的 M12 metadata event 可作为未知扩展保留；memory 正文不由本项目回滚或删除。
