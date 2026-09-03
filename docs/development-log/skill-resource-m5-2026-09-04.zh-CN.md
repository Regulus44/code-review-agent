# Skill 资源渐进式加载 M5 开发日志

日期：2026-09-04  
范围：Filesystem watcher、catalog 外部变更失效与资源变化边界

## 目标

让外部编辑器、Git 或 shell 写入 `SKILL.md` 后，provider 在后续模型 step 重新发现最新 Skill；同时把 Skill catalog 变化和 `references/`、`scripts/`、`assets/` 深层资源变化分开处理，避免普通资源更新导致全量 catalog 重建。

## 实现切片

1. `@coding-agent/skills-filesystem` 增加 opt-in 的原生 `fs.watch` 管理：root 和受限深度的非 Skill 目录用于发现新目录，发现 Skill 目录后只监听其直属 `SKILL.md`。监听范围受 `maxWatchDirectories`、`maxDepth` 限制，避免递归 watcher 无界增长。
2. watcher 对 `SKILL.md` 及 Skill 目录新增/删除做 250ms debounce，并通过现有 `SkillProviderControl.invalidate()` 推动 registry revision；资源目录深层变化不触发 catalog invalidation。监听异常保留 last-good candidate、标记 observation `complete=false` 并按 1 秒节流重试；Abort/dispose 关闭所有句柄。
3. `AgentHost.notifySkillWorkspaceMutation()` 仅把 `.claude/skills` 根、Skill 目录和 `SKILL.md` 写入映射为 `skills/change`；普通 workspace 文件和 Skill 包内资源文件不再误触发 catalog 失效。

## 契约与安全边界

- `skills/change` 继续使用 bounded `revision/provider/scope/pathCount/paths`，不包含正文、绝对路径或 watcher 错误详情。
- watcher 是 best-effort，默认 `watch=false` 保持兼容；关闭 watcher 时每个 step/显式 refresh 仍按当前磁盘读取 Skill。
- Skill 资源读取仍沿用 M4 的 registry winner、provider root containment、UTF-8/size/offset 上限和 artifact replay 语义；M5 不自动枚举或执行 `scripts/`。
- watcher 错误不会把旧 catalog 静默替换为不完整结果；不完整观察由 provider bounded metadata 表达，下一次成功同步后恢复 complete。

## 提交与验证

- `99be81b feat(skills): add bounded filesystem skill watcher`
- `f158d45 fix(runtime): invalidate skills only for catalog mutations`

定向验证：`pnpm --filter @coding-agent/skills-filesystem test`（15 tests）和 `pnpm --filter @coding-agent/runtime test`（94 tests）通过；`pnpm typecheck` 通过。新增 watcher 测试覆盖 `SKILL.md` debounce、深层资源忽略、新 Skill 目录 watcher 覆盖、dispose 和 watcher 数量上限 incomplete。

## 剩余风险

- 当前实现使用 Node `fs.watch`，不同平台的 rename 事件粒度存在差异；错误时通过 retry 和显式 refresh 保证最终可见，不承诺实时强一致。
- 外部编辑器变更没有 session 上下文，watcher 只推进 registry revision；需要在具体 AgentHost session 边界消费 `skills/change` 时，才能追加可回放的 session 事件。
- watcher 只覆盖已配置的 filesystem roots；MCP/remote provider、生产级 tenant ACL 和资源版本事件仍属于后续阶段。
