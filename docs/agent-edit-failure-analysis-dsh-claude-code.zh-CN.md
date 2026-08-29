# Agent 编辑失败分析（历史记录）

本文记录早期 DSH/Claude Code 对照和 Grader 方案的历史结论，不再是当前评测执行规范。旧方案中的独立 Grader、hidden patch、scope audit、step/超时注入和命令白名单已经移除。

当前实施请阅读 [`coding-agent-simple-evaluation-plan.zh-CN.md`](coding-agent-simple-evaluation-plan.zh-CN.md)：使用真实 provider/model、隔离 workspace、Full Access 和仓库原生验证。历史结果仍可用于解释过去的失败，但不得据此恢复旧入口或把“等待 Grader 确认”作为 resolved 条件。
