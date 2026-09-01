# Phase 6：A2A 互操作层

## 目标

把已经稳定的内部 AgentHost、Task、Subagent、Session 和 Artifact 映射成外部 Agent 可以调用的 A2A 接口。A2A 是适配层，不反过来定义核心 Runtime。

## 参考入口

本地 DSH/Claude Code 快照没有完整的 A2A 实现，因此本阶段同时参考：

- DSH `D:/Develop/deepseek-harness-fork/packages/acp`：程序化 Agent 驱动和流式报告；
- DSH `D:/Develop/deepseek-harness-fork/packages/subagent`：内部 parent/child 生命周期；
- Claude Code `D:/Develop/claude-code/packages/acp-link`：ACP 链路和协议适配边界；
- Claude Code `D:/Develop/claude-code/packages/remote-control-server`：远程 Session、事件流和取消；
- A2A 官方协议定义：Agent Card、Task、Message、Artifact、JSON/HTTP/SSE。

## 交付物

- Agent Card / capability discovery；
- `task create/get/cancel`；
- message、artifact 和 streaming updates；
- 外部 task 与内部 TaskId/SessionId 的映射；
- auth、tenant、correlationId 和 rate limit；
- A2A contract test、兼容性 fixture 和审计记录。

## 工作流任务

### 映射层

1. 外部 task 创建内部 Task 和 Session；
2. 外部 message 映射为 user/message 或 task input；
3. 内部 assistant/tool/task 事件映射为 A2A updates；
4. artifact 只引用经过 workspace/permission 检查的产物。

### 生命周期

1. create、get、cancel、retry 都必须幂等；
2. 外部取消按内部 Task policy 传播；
3. A2A 连接断开后支持按 cursor 或 task state 恢复；
4. 内部失败、阻塞、等待批准要转换成可解释的外部状态。

### 安全

1. 外部身份映射到明确的 permission context；
2. A2A 不直接调用 ToolRegistry.execute；
3. A2A 不直接读取文件、运行 shell 或启动 MCP server；
4. tenant、workspace、quota 和 artifact 泄露测试必须通过。

## 不包含

- 用 A2A 替换内部 Subagent contract；
- 匿名执行本地命令；
- 跨租户 Session 共享；
- 没有认证和审计的公网部署。

## 测试与验收

- Agent Card 能准确声明能力和认证要求；
- 外部 task 可创建、流式更新、查询、取消和恢复；
- 内部 permission request 能映射成等待状态；
- tool/MCP/subagent 事件不会泄露越权数据；
- 重复请求、断线、超时和服务重启保持幂等；
- 至少有一个外部 A2A client contract fixture。

退出条件：外部 Agent 能通过 A2A 完成一个受权限控制的只读或编辑任务，并可在断线后恢复状态。

## 回滚点

A2A adapter 独立部署或 feature flag 开关；关闭 A2A 不影响本地 Web、ACP、MCP 和内部 Subagent。
