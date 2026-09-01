# ADR：Phase 7 Web 收敛不等待 A2A

## 状态

Accepted — 2026-08-23

## 背景

本项目长期目标包含 A2A 外部 Agent 互操作，但 Coding Agent 的核心产品场景是由本项目管理的 Web AgentHost、Session、工具和内部 Subagent。Phase 5 已完成 parent/child Task、Session、权限、workspace、MCP scope、report、cancel 和恢复语义。当前没有明确的跨产品、跨组织或远程 Agent 接入场景。

Phase 7 Web 前端已经开始建设。如果把 A2A HTTP endpoint、Agent Card 和外部 task mapper 作为 Web 收敛的硬前置，会延迟对内部 Agent 运行轨迹、工具展示、权限交互和恢复体验的改进，并把外部协议字段带入 UI contract。

## 决策

1. 暂缓 Phase 6 A2A 的核心实现，状态标记为 `deferred`，不把它作为 Phase 7 Web 收敛的前置门禁。
2. Phase 7 以 Phase 5 的内部 Task/Subagent、Session EventStore、PermissionPolicy、WorkspaceResolver 和 MCP scope 作为唯一数据与安全边界。
3. Web 不把 A2A 当作内部 Subagent transport，也不为 A2A 预留未经验证的 UI 状态；未来 A2A 仍必须作为 inbound adapter 映射到已有 Task/Session/Workspace/Permission。
4. A2A 恢复条件至少包括以下一项明确需求：外部 Agent 需要发现并调用本项目、跨进程/主机 Agent 协作、跨组织标准化 task/artifact/streaming，或现有 ACP/私有 API 已产生可量化维护成本。
5. 恢复 A2A 时必须重新提交 Phase 6 计划、Agent Card/Task/Artifact contract、认证/租户/限流/审计方案和独立 checkpoint；关闭 A2A 不得影响 Web、MCP 或内部 Subagent。

## 取舍与后果

- Phase 7 可以直接完善内部 Multi-Agent 的可见体验和 Trajectory，而无需等待外部协议。
- 长期路线仍保留 A2A 适配层，不把“当前没有必要”解释为“永久删除”。
- 阶段顺序文档需要明确“Phase 6 deferred，不阻塞 Phase 7”；真正实现 A2A 时再恢复 Phase 6 门禁。
- 由于 Web 只消费内部 projection，未来 A2A 的外部 envelope 变化不会直接破坏 Conversation、Tool 或 Trajectory UI。

## 参考

- [Phase 5：内部 Task/Subagent 多 Agent](../archive/phases/phase-plans/phase-5-subagents.zh-CN.md)
- [Phase 6：A2A 互操作层](../archive/phases/phase-plans/phase-6-a2a.zh-CN.md)
- [协议边界](../protocol-boundaries.md)
- [Phase 7 DSH Web 调研](../archive/references/phase-7-dsh-web-research.zh-CN.md)
