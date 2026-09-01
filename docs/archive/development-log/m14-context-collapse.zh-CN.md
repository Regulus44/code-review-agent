# M14 开发日志：Context Collapse Capability Boundary

状态：`implemented`（能力边界已实现，算法 `deferred`）

日期：2026-08-26

阶段：Phase 8 / M14

## 任务七问

1. Phase：Phase 8 高级能力与产品化，M14；依赖 M01–M13。
2. 问题类型：为 Claude Code Context Collapse 的最后评估建立可回放、可展示的 host capability boundary。
3. 契约影响：新增 `ContextCollapseCapability`，扩展 Runtime `ContextSettings` 和 Web `ContextCapability`；不改变 Event、Tool、Task、Permission 或 Workspace contract。
4. Claude Code 参考：`src/services/contextCollapse/index.ts`、`operations.ts`、`persist.ts`、`docs/features/context-collapse.md` 以及 `src/query.ts` 的集成顺序。
5. 上游来源：`behavior-reference`；本地快照核心为 stub，未复制源码或算法。
6. 验收场景：Runtime 返回 deferred metadata；Web 在 metadata 缺失时安全显示 unavailable；M01–M13 的事件和 model request 路径不变。
7. 回滚方式：移除 capability 输出和 Settings 行即可；保留可选客户端字段和既有 context 事件。

## 变更记录

- `packages/contracts/src/index.ts` 新增 `ContextCollapseCapability`，逐项声明 read-time projection、background collapse、overflow drain 和 snip。
- `packages/runtime/src/index.ts` 将 M14 capability 挂载到 `ContextSettings`，默认以 deferred/fail-closed 语义返回。
- `apps/web/src/client/api.ts` 增加可选 collapse metadata；`settings-presenter.ts` 增加 `context-collapse` 行。
- Runtime 与 Web presenter 测试覆盖 deferred metadata、feature 全 false 和旧 API 缺失字段 fallback。
- 同步 M14 实施说明、ADR-026、事件契约、来源登记、Phase 8 计划、阶段状态和日志索引。

## 关键决策

- Claude Code 的 contextCollapse 本地快照仍为 stub，不能把目录、接口或 query 集成点当成可用算法。
- M14 采用 `deferred`，不新增虚假的 collapse 事件，不改变现有 compaction、boundary、recovery、transcript 和 diagnostics。
- `unavailable` 只用于 host 未暴露 metadata 的旧 API/客户端兼容路径；已知但暂缓的 host 明确返回 `deferred`。

## 验证结果

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test -- --run src/presentation/settings-presenter.test.ts ✓
pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts ✓
```

## 遗留边界

完整 collapse 算法、collapse commit log、overflow drain、snip 和后台折叠均未实现。只有真实 provider 验收证明 M01–M13 不足时，才启动下一份独立 ADR 和实现切片。
