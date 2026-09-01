# M12 开发日志：Project Memory / memdir

状态：`implemented`

日期：2026-08-26

阶段：Phase 8 / M12

## 任务七问

1. Phase：Phase 8 高级上下文能力，M12；依赖 M03、M10、M11。
2. 问题类型：将 Claude Code `memdir` 的项目记忆索引、按需召回和 stale 验证接入本项目 canonical model view。
3. 契约影响：新增四类 Project Memory 事件、`ContextProjectMemoryProjection`、`ProjectMemoryScope` 和 host-owned `ProjectMemoryStore` adapter。
4. Claude Code 参考：`D:/Develop/claude-code/src/memdir/memdir.ts`、`findRelevantMemories.ts`、`memoryTypes.ts`、`memoryScan.ts`。
5. 上游来源：`behavior-reference`；未复制 Claude Code 源码，因本项目使用 EventStore、workspace 和 tenant contract。
6. 验收场景：bounded MEMORY.md、UTF-8 安全截断、topic relevance、stale 排除、显式忽略、workspace/tenant scope、事件不含正文、SQLite replay。
7. 回滚方式：不配置 `AgentHostOptions.projectMemory` 即停用 M12；既有 compact、Session Memory 和 transcript 不受影响。

## 变更记录

1. `packages/context/src/project-memory.ts` 新增 200 行/25,000 bytes bounded index、safe link parser、四类 memory taxonomy、topic relevance、already-surfaced 去重和 path/symbol/flag stale validator。
2. `packages/runtime/src/index.ts` 新增 `ProjectMemoryStore`、scope key、validation adapter 和 canonical `assembleTurnContext()` 接入；topic 以 `kind: "memory"` attachment 进入 model view。
3. Runtime 对每个 turn 去重 loaded/recalled/stale/disabled 事件；adapter 失败 fail closed，不影响主 turn；用户明确忽略 memory 时不调用 adapter。
4. `packages/contracts/src/index.ts` 新增四类 M12 事件与 `ContextProjectMemoryProjection`。
5. `packages/storage/src/index.ts` 在 InMemory/SQLite 共用 reducer 中投影 M12 metadata，正文不进入事件和 projection。
6. 新增 Context、Runtime、Storage 测试，覆盖边界、召回、stale、忽略、scope 和 SQLite reopen。
7. 新增 M12 实施说明、ADR-024、CC-013，并同步事件契约、Phase 8 计划、状态看板和研究文档。

## 关键决策

- `MEMORY.md` 是受限索引，不是完整记忆正文容器；topic 正文按 query 召回，最多 5 个。
- memory 被视为历史、不可信上下文，永远低于系统、权限、workspace 和当前代码事实；引用当前文件、symbol 或 flag 前必须由 host validator 重新检查。
- scope key 由 host/Runtime 派生，不允许由 memory 内容提供；默认使用 workspace/tenant 的 SHA-256 截断值。
- EventStore 只保存 bounded metadata、topic id、状态和时间；正文仍由 host-owned adapter 提供，不写入 durable event、SSE 或 Web projection。
- Project Memory 读取失败和 stale topic 采用 fail-closed：不把不确定内容送入模型，但不把可选 memory 故障升级为主 turn 失败。

## 验证结果

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/context test -- --run ✓
pnpm --filter @code-review-agent/storage test -- --run ✓
pnpm --filter @code-review-agent/runtime test -- --run ✓
```

完整 `pnpm test`、`git diff --check` 和 checkpoint 在本次 M12 收尾执行。

## 后续边界

M12 不实现 Claude Code 的账户、遥测、JSONL 文件布局、自动 memory 写入 agent、hooks、context diagnostics 或 Web inspector；M13 负责 Context diagnostics 与 Web projection。
