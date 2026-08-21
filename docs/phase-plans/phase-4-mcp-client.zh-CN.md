# Phase 4：MCP Client

## 目标

让外部工具、资源和 Prompt 通过 MCP 接入，而不是继续把每个业务集成写成本地工具。MCP 工具必须和内置工具共享 ToolRegistry、权限、取消、事件和审计。

## 参考入口

DSH：

- `D:/Develop/deepseek-harness-fork/packages/mcp/mcp-client`
- `D:/Develop/deepseek-harness-fork/packages/core/tools`
- `D:/Develop/deepseek-harness-fork/packages/interaction`

Claude Code：

- `D:/Develop/claude-code/packages/mcp-client`
- `D:/Develop/claude-code/packages/builtin-tools/src/tools/MCP*`
- `D:/Develop/claude-code/src/tools.ts`

## 交付物

- `McpConfigStore`：server 配置、scope、enabled/disabled；
- `McpConnectionManager`：stdio、SSE 兼容 transport、Streamable HTTP、连接状态、重连和超时；
- `McpDiscovery`：tools/list、resources/list、prompts/list；
- `McpToolAdapter` 和 resource/prompt adapter；
- 工具名称隔离、来源标识、schema 转换和错误分类；
- Web 中的 MCP server 状态和工具来源；
- MCP contract、mock server 和故障 fixture。

## 工作流任务

### 连接与配置

1. 明确 user/project/session 三种配置 scope；
2. 配置中禁止携带明文 secrets 到事件或 Web；
3. server 状态至少包含 pending、connected、failed、needs_auth、disabled；
4. 每个连接有启动、停止、重连和 shutdown 生命周期。

### 工具适配

1. 将 MCP schema 转成内部 ToolDefinition；
2. 为工具名加 server namespace，避免冲突；
3. MCP 调用经过本地 policy 和 approval；
4. 记录 server、tool、latency、error code 和截断信息。

### Web/运维

1. 设置页展示 server 配置和当前状态；
2. 工具卡片显示来源是 built-in 还是 MCP；
3. 连接失败提供可行动 remedy；
4. 支持单个 server 的 disable/reconnect，不影响其他 Session。

## 不包含

- 本项目 MCP Server；
- A2A；
- MCP 工具绕过 workspace 或 permission；
- 将所有本地安全基元迁移到 MCP。

## 测试与验收

- stdio/HTTP 连接、启动失败、断线重连和超时；
- discovery schema、命名冲突和 server 隔离；
- MCP tool 的权限、取消、进度、错误和事件回放；
- server 输出过大、恶意路径和敏感字段脱敏；
- 一个真实或 fixture MCP 工具完成查询并在 Web 中显示来源。

退出条件：至少一个 MCP Server 可配置、发现、调用、取消、重连，且其行为与内置工具共享统一审计和事件模型。

## 回滚点

MCP 作为可选 provider；关闭所有 MCP server 时，内置工具和既有 Session 必须完全可用。
