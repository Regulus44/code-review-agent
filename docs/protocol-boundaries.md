# 协议边界

MCP、ACP 和 A2A 解决的是不同问题。本项目不把它们合并成一个“通用 Agent API”，也不允许外部协议跳过内部 Session、Task、Permission 和 Workspace 层。

## MCP：外部工具与资源

```text
MCP server
   ↓ tools/list, resources/list, prompts/list
McpConnectionManager
   ↓
McpToolAdapter / McpResourceAdapter
   ↓
ToolRegistry → PermissionPolicy → EventStore → AgentLoop
```

MCP Client 负责：

- stdio、SSE/HTTP 连接和重连；
- server scope、连接状态和错误分类；
- tools/resources/prompts discovery；
- 工具名称隔离、schema 转换和超时。

MCP Client 不负责：

- 决定本项目的 workspace 根目录；
- 绕过权限审批；
- 直接写入 Session 状态；
- 直接驱动 A2A 或 Subagent 生命周期。

## ACP：程序化 Client 驱动 Agent

ACP 作为可选的自动化接入层，适合 IDE、脚本或测试 harness 驱动一个 Agent。ACP 请求映射到 `AgentHost` 的 Session/Turn API，并复用同一套事件、权限和取消语义。

ACP 不等于 Subagent，也不等于 A2A。它描述的是“Client 如何驱动一个 Agent”，不是“Agent 如何委派另一个 Agent”。

## A2A：外部 Agent 互操作

```text
A2A HTTP/JSON/SSE
        ↓
AgentTaskService
        ↓
Internal Task / Subagent
        ↓
AgentHost + Session EventStore
```

A2A 适配层负责 Agent Card、task create/get/cancel、message、artifact、streaming updates、认证和 correlation id。外部 task 必须映射到内部 `TaskId`、`SessionId`、`WorkspaceId` 和权限上下文。

A2A 禁止：

- 直接调用 ToolRegistry 的 `execute`；
- 直接访问本地文件或 shell；
- 创建没有 parent/session 的隐式 Agent；
- 绕过 permission request/resolved 事件；
- 把外部 task 状态直接当作内部 turn 状态。

## 引入顺序和门禁

| 阶段 | 能力 | 进入条件 | 退出条件 |
|---|---|---|---|
| 1 | TypeScript AgentHost + SSE | 事件 envelope 已固定 | Read-only/Edit/Test 可重放 |
| 2 | MCP Client | ToolRegistry、权限、取消已稳定 | MCP 工具与内置工具有相同事件和审计 |
| 3 | 内部 Subagent | Task contract、parent/child lifecycle 已稳定 | 并发、深度、预算、工具白名单测试通过 |
| 4 | A2A adapter | Subagent 和 Artifact contract 已稳定 | 外部 task 可创建、流式、取消、恢复 |
