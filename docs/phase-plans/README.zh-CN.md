# 分阶段开发计划

这些文档是 [总改造计划](../coding-agent-migration-plan.zh-CN.md) 的执行层。总计划负责方向、架构取舍和长期边界；本目录负责每个阶段具体做什么、参考哪些源码、如何验收以及何时允许进入下一阶段。

## 阶段顺序

```text
Phase 0  TypeScript 基线与契约
   ↓
Phase 1  最小 AgentHost + DSH 风格 Web Shell
   ↓
Phase 2  事件日志、持久化与恢复
   ↓
Phase 3  内置工具运行时与权限
   ↓
Phase 4  MCP Client
   ↓
Phase 5  内部 Subagent / 多 Agent
   ↓
Phase 6  A2A 互操作层
   ↓
Phase 7  DSH Web 前端收敛
   ↓
Phase 8  高级能力与产品化
```

## 文档入口

- [Phase 0：TypeScript 基线和防漂移机制](../phase-0-checklist.zh-CN.md)
- [Phase 1：最小 AgentHost 与 Web Shell](phase-1-agenthost-web.zh-CN.md)
- [Phase 2：事件、持久化与恢复](phase-2-events-recovery.zh-CN.md)
- [Phase 3：工具运行时与权限](phase-3-tools-permissions.zh-CN.md)
- [Phase 4：MCP Client](phase-4-mcp-client.zh-CN.md)
- [Phase 5：内部 Subagent / 多 Agent](phase-5-subagents.zh-CN.md)
- [Phase 6：A2A 互操作层](phase-6-a2a.zh-CN.md)
- [Phase 7：DSH Web 前端收敛](phase-7-web-convergence.zh-CN.md)
- [Phase 8：高级能力与产品化](phase-8-productization.zh-CN.md)

## 每个阶段的固定结构

每份阶段文档都必须包含：

1. 目标和明确不包含的内容；
2. 参考仓库和源码入口；
3. 交付物及其依赖；
4. 分工作流任务；
5. 测试和安全检查；
6. 进入条件、退出条件和回滚点；
7. 完成后对下一阶段开放的能力。

## 状态规则

- 阶段状态以 Git checkpoint 为准，不以“代码已经写了一部分”为准。
- 前一阶段退出条件未满足，不进入后一阶段的核心实现。
- 允许并行做文档、设计和 fixture，但不能绕过依赖提前合并协议或运行时能力。
- 新需求必须先归属到一个阶段；无法归属时先更新 ADR，不直接扩张当前阶段。
