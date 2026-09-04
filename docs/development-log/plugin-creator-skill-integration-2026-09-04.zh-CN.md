# plugin-creator Skill 集成与真实 Agent 验证日志

日期：2026-09-04

## 变更

- filesystem provider 默认扫描存在的 `~/.codex/skills/.system`，作为 bundled root；显式 `bundledPath` 会与该系统 root 并列扫描。
- 默认 project/user/system roots 标记为 optional，缺失时不会遮蔽其它可用 Skill；显式 custom root 仍保留 fail-closed 观察语义。
- 将主机上的 `plugin-creator` Skill 原样复制到 `.claude/skills/plugin-creator/`，保留 `SKILL.md`、`references/`、`scripts/`、`assets/` 和 `agents/`。
- 新增真实 `AgentHost → skill → read_skill_resource → read_skill_resource` 测试，验证项目级 winner、按需读取 reference/script 和下一模型步骤上下文。

## 验证场景

模型 fixture 按四步运行：

1. 发现 `/plugin-creator` 并调用 `skill`；
2. 读取 `references/plugin-json-spec.md`；
3. 读取 `scripts/validate_plugin.py` 的 bounded window；
4. 在下一模型步骤确认脚本内容可见并结束。

`assets/plugin-creator-small.svg` 可作为 UTF-8 资源读取；PNG 等二进制 asset 按当前资源工具契约拒绝，且不会触发脚本执行。

## 相关提交

- `6d13be0 feat(skills): scan host Codex system root by default`
- `6c835e4 feat(skills): add project plugin creator skill`
- `0f20fe7 fix(skills): tolerate missing default skill roots`
- `1fb6ba6 test(api): exercise project plugin creator skill`
- `9a334c3 test(api): stabilize plugin creator agent chain`

## 风险

- `~/.codex/skills/.system` 是主机路径，其他机器若不存在则不会加入默认 roots。
- 当前真实 Agent 验证使用 deterministic model fixture；真实第三方模型/浏览器 e2e 仍需单独环境验证。
