# Phase 3：工具运行时与权限开发日志

状态：`in_progress`

阶段计划：[phase-3-tools-permissions.zh-CN.md](../phase-plans/phase-3-tools-permissions.zh-CN.md)

## 2026-08-21：阶段启动

### 基线

- Phase 2 已完成，当前基线为 `9e716eb`；
- `pnpm typecheck`、`pnpm test` 已通过；
- 新后端继续使用 TypeScript/Node.js，旧 Python Runtime 不进入依赖图；
- 事件日志、SQLite projection、SSE replay 和 command 幂等契约已稳定，可作为工具运行时的事实来源。

### 本阶段目标

- 建立统一 `ToolRegistry`、schema validation、风险级别和 execution mode；
- 建立 `PermissionPolicy`、approval request/resolved、取消和审计事件；
- 先实现本地安全基元：workspace 文件读取/搜索/编辑、受控进程和 Git 只读信息；
- 让工具调用、进度、结果、diff 和权限状态都能从事件恢复；
- 保持 MCP、Subagent、A2A 和 Code Mode 在本阶段之外。

### 当前决策

- 工具不直接写 Session projection，统一通过 AgentHost/EventStore 追加事件；
- `read` 默认自动批准，`write`/`execute` 默认需要审批，`network` 默认拒绝；
- 所有路径经过 WorkspaceResolver；命令使用 argv，不接受任意 shell 字符串；
- 结果分为完整审计结果和受预算限制的 presentation/model view；
- 工具按能力逐个注册，可从 Registry 禁用而不影响既有 Session 和事件回放。

### 下一步

1. 冻结 Tool/Permission contract 和事件类型；
2. 实现 ToolRegistry、schema validator、PermissionPolicy 和统一执行器；
3. 实现首批 read-only 工具，再接 write/execute 工具；
4. 接入 Runtime/API/Web 并完成安全与恢复验收。

## 后续记录

后续每个里程碑追加：变更范围、相关提交、失败/修复、验证命令、风险和下一步。阶段完成时在此记录最终 checkpoint 和退出条件逐项证据。
