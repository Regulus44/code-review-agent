# 开发日志

这里记录每个阶段的实际开发过程、关键决策、验证证据和未完成事项。阶段状态看板位于 [../phase-status.zh-CN.md](../phase-status.zh-CN.md)，本目录记录比状态表更细的过程信息。

## 规则

- 每个 Phase 开始时建立或更新对应日志；
- 每个重要架构裁决、可运行里程碑、失败修复和验收门禁都追加一条记录；
- 记录必须包含日期、提交或工作树证据、验证命令和下一步；
- 阶段完成时追加最终验收、checkpoint 和遗留风险；
- 日志是过程记录，不替代 ADR、阶段计划或公共契约。

## 阶段日志

- [Phase 1：AgentHost 与 Web Shell](phase-1-agenthost-web.zh-CN.md)
- [Phase 1：Agentic Coding Core 校正记录](phase-1-agenthost-web.zh-CN.md#2026-08-22重新打开-phase-1-的-coding-agent-门禁)
- [Phase 2：事件、持久化与恢复](phase-2-events-persistence-recovery.zh-CN.md)
- [Phase 3：工具运行时与权限](phase-3-tools-permissions.zh-CN.md)
- [Phase 4：MCP Client](phase-4-mcp-client.zh-CN.md)
- [Phase 5：内部 Task/Subagent 多 Agent](phase-5-subagents.zh-CN.md)
- [Phase 7：DSH Web 前端收敛](phase-7-web-convergence.zh-CN.md)
- [Phase 8：高级能力与产品化](phase-8-productization.zh-CN.md)
- [M01：Claude Code 式 Context Window 与 Auto-Compact Budget](m01-context-budget.zh-CN.md)
- [M02：Claude Code 式 Token Estimation 与 Provider Exact Count](m02-token-estimation.zh-CN.md)
- [M03：Claude Code 式 Context Assembly 与 System Prompt Sections](m03-context-assembly.zh-CN.md)
- [M04：Claude Code 式 API Round、Message Normalize 与 Tool Pairing](m04-api-round-pairing.zh-CN.md)
