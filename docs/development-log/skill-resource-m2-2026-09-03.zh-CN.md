# M2 Skill 资源工具开发日志（2026-09-03）

## 目标

让模型在读取 `SKILL.md` 后，能够通过受控的 `read_skill_resource` 按需读取同一 Skill 目录包中的 `references/`、`scripts/` 等相对资源，同时继续复用 ToolRuntime 的 schema、权限、取消、事件和下一步模型上下文管线。

## 本次实现

- 新增 `packages/tools/src/skill-resource.ts`：
  - 输入 schema 为 `{ skill, path, offset?, limit? }`；
  - 规范化 Skill 名称，拒绝绝对路径、空段、NUL 和非法窗口；
  - 通过 `SkillRegistry.get()` 解析当前 cwd 下的 winning candidate；
  - 检查模型可调用策略和 Skill source trust；不可信来源进入交互审批；
  - 通过 `SkillRegistry.readResource()` 委派 provider，禁止任意 workspace 绝对路径回退；
  - 输出 bounded metadata、`modelView` 与 `<skill_resource>` presentation，不暴露 provider 的绝对路径。
- `packages/tools/src/index.ts` 导出工具工厂。
- `packages/runtime/src/index.ts` 增加 `skillResourceToolEnabled` 开关。开关默认关闭；启用时才向 ToolRegistry 注册工具，并继续受 `skill` capability gate 约束。
- 新增工具和 Host 注册测试，覆盖 schema、成功读取、Skill 绑定、未知/不支持/危险路径、remote trust 审批、取消和默认关闭行为。
- 更新 `docs/tool-contract.md` 工具契约与工具表。

## 验证

- `pnpm --filter @coding-agent/tools test`：14 个测试文件、107 个测试通过。
- `pnpm --filter @coding-agent/runtime test -- --run src/index.test.ts`：75 个测试通过。
- 全量 `pnpm typecheck`、`pnpm test` 和 `git diff --check` 在父任务收尾阶段执行。

## 提交

- `1be4f7b feat(skills): add model skill resource tool`：工具实现、工具导出、定向工具测试和 Host 注册测试。
- `0289ef0 docs(skills): log M2 resource tool contract`：工具契约与本开发日志。
- AgentHost 的 `skillResourceToolEnabled` 选项和注册行实际随并行上下文提交 `f824e68 feat(runtime): persist microcompact checkpoints before clearing` 进入当前历史；本次未重写该提交。
- `ad33447 chore(skills): fix resource tool whitespace`：修复工具源码 EOF 空白。

## 已知边界

M2 不自动预加载 Skill 目录，不执行 `scripts/`，不新增资源专用事件类型，也不承诺资源正文的 compact/replay/artifact 持久化；这些能力属于后续阶段。provider 仍负责最终的 realpath、symlink、文件类型和资源大小安全检查。
