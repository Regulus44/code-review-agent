# M3 Skill canonical 内容与资源提示开发日志（2026-09-03）

## 目标与边界

本切片执行 [Skill 资源包与渐进式加载调研与实施方案](../reference/skill-resource-progressive-loading-research-and-implementation.zh-CN.md) 的 M3：模型调用 Skill 后能识别 `SKILL.md` 与同目录资源属于同一 Skill 包，并通过 `read_skill_resource` 按需读取 `references/`、`scripts/` 等 Skill-relative 路径。

本切片只调整 model-visible renderer、SkillTool 复用和 Host 选择开关，不新增 M4 的资源事件、artifact、compact/replay 或 watcher 语义。实现参考 DSH `packages/skill/skill/src/index.ts` 的 canonical 标签结构与转义行为，以及 Claude Code SkillTool 的 remote/untrusted 内容边界；未复制上游源码。

## 实现内容

- `packages/context/src/skill-catalog.ts` 新增 v2 canonical renderer：
  - 输出 `<skill_content name="...">`、`<skill_resources>`、`<skill_instructions>`；
  - 资源提示明确 `read_skill_resource`、Skill-relative path、按需读取和不预加载目录；
  - Skill 名称属性与资源提示中的引用经过属性转义；不输出 provider 的绝对目录或 URL；
  - remote Skill 或 `metadata.disableShellExpansion` 为 true 时保留 `$ARGUMENTS`，本地可调用 Skill 继续做有界参数替换。
- 保留 `renderSkillContentV1()` 与 `renderSkillContent(..., { version: "v1" })`，用于旧 `<skill>` 形状兼容和回滚；默认 renderer version 为 v2。
- `packages/tools/src/skill.ts` 移除重复本地 renderer，改为复用 context canonical renderer；`createSkillTool` 增加 `rendererVersion` 选择。
- `packages/runtime/src/index.ts` 增加 `AgentHostOptions.skillRendererVersion`，Host 注册 SkillTool 时默认选择 v2，也可显式选择 v1。
- `packages/runtime/src/index.test.ts` 验证 catalog、`read_skill_resource` 工具提示和 SkillTool canonical 内容会进入下一模型步骤。
- `docs/tool-contract.md` 更新 M3 的 model-visible 形状、remote 参数边界和 v1 回滚契约。

## 提交记录

由于共享工作树中的并行 context Slice D 正在同时提交，M3 代码实际被吸收到以下已存在提交中；这些提交的文件清单可追溯 M3 变更，但提交标题保留并行任务语义：

- `afba6c1 fix(test): make checkpoint request capture mutable`：包含 context canonical renderer、v1/v2 导出、SkillTool 复用、tools 依赖/测试及 `pnpm-lock.yaml`；同时包含并行 summary test 类型修复。
- `e055608 docs(context): record slice d development log`：包含 AgentHost renderer version 选项、SkillTool 注册传参及 Runtime 下一模型步骤合同测试；同时包含并行 Slice D 日志。

本开发日志与工具契约作为独立文档提交，避免把 M3 文档再次混入代码提交。

## 验证

- `pnpm --filter @coding-agent/context test`：100 tests passed；
- `pnpm --filter @coding-agent/tools test`：108 tests passed；
- `pnpm --filter @coding-agent/runtime test`：92 tests passed；
- `pnpm typecheck`：通过（并行 Slice D 的 summary 类型修复已在 `85b6e1e` 落盘）；
- `git diff --check`：通过。

## 回滚与后续

将 `skillRendererVersion` 或 `createSkillTool` 的 `rendererVersion` 设为 `v1` 可恢复旧 `<skill>` 结果形状；关闭 `skillToolEnabled` 仍会同时关闭模型 Skill catalog/SkillTool。v1 回滚不会放宽 Skill resource provider 的路径、workspace 或权限检查。

M4 继续负责资源正文的 replay/artifact、compact/recovery 一致性；本切片不改变现有 `skill/invocation`、`skill/result` 和 `tool/result` 事件契约。
