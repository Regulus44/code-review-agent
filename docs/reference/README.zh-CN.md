# 设计与调研参考

这里保存 DSH、Claude Code、MCP、Provider、Context、Web 和 Windows 执行环境的设计参考与实现说明。

这些文档用于解释背景、行为对照和历史实现，不定义当前产品状态。当前能力、限制和优先级以 [docs/status.zh-CN.md](../status.zh-CN.md) 为准；架构约束以 ADR 和公共契约为准。

常用入口：

- `dsh-frontend-reference.zh-CN.md`：Web 信息架构与组件行为参考；
- `dsh-session-replay-and-composer-reference.zh-CN.md`：Session、回放和 Composer 参考；
- `claude-code-context-management-research.zh-CN.md`：Context、Compact、Memory 和 Recovery 研究；
- `memory-skill-cc-dsh-research-and-implementation.zh-CN.md`：Claude Code / DSH / 本仓库 Memory 与 Skill 对照、模块改造点和分阶段实施方案；
- `provider-model-routing-research.zh-CN.md`：Provider / model routing 研究；
- `dsh-windows-tool-execution-environment-research.zh-CN.md`：Windows 工具执行环境研究。
- `skill-resource-progressive-loading-research-and-implementation.zh-CN.md`：Skill 目录资源包、`scripts/` / `references/` 按需读取、Claude Code / DSH 对照与分模块实施方案。
