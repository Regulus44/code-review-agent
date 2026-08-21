# Phase 4 开发日志：MCP Client

## 状态

`in_progress`

本日志只记录 Phase 4 的实际实现与验证，不替代根目录 `AGENTS.md` 的长期治理规则。

## 阶段目标

- 用官方 MCP TypeScript SDK 接入 stdio、SSE 兼容 transport 和 Streamable HTTP；
- 管理 user/project/session scope 的 server 配置，并在展示和事件中脱敏；
- 发现 tools/resources/prompts，给 MCP tool 建立稳定的 server namespace；
- 将 MCP tool 注册到现有 `ToolRegistry`，调用继续经过 `ToolRuntime` 的 schema、权限、取消、超时、结果预算和事件审计；
- 支持连接失败分类、重连、disable/reconnect 和工具列表变更；
- 提供 fixture/contract 测试，证明 MCP 与内置工具共享统一管线。

## 设计取舍

- 采用 DSH 的 transport + connection supervisor + tool generation swap 思路，但不复制其 Cordis 运行时；
- 采用 Claude Code 的 config/discovery/error 分层思路，但 MCP 适配层不直接写 Session 状态；
- 第一批只桥接 MCP tools；resources/prompts 先完成 discovery API，消费侧留给后续明确场景；
- 默认将未知 MCP tool 视为 `network` 风险，只有显式配置为只读或由工具注解判定为只读时才允许自动策略；
- MCP server 的 secret 只保存在运行时配置，不进入 event payload、projection 或 Web 响应。

## 参考入口

- DSH：`D:/Develop/deepseek-harness-fork/packages/mcp/mcp-client/src/{transport,connection,tools}.ts`；
- Claude Code：`D:/Develop/claude-code/packages/mcp-client/src/{manager,connection,discovery,execution}.ts`；
- 本项目：`packages/tools/src/{registry,runtime}.ts`、`packages/contracts/src/index.ts`、`apps/api/src/server.ts`。

## 里程碑

### M1：契约与配置

- [x] 新增 MCP server 状态、来源和 discovery 类型；
- [x] 新增 `McpConfigStore`，支持 scope、enabled/disabled 和脱敏视图；
- [ ] 配置持久化和 UI 设置页。

### M2：连接与发现

- [ ] stdio transport；
- [ ] Streamable HTTP transport；
- [ ] 启动、停止、重连、断线和超时；
- [ ] tools/list、resources/list、prompts/list 及 list-changed 重同步。

### M3：统一工具管线

- [ ] namespace、schema 转换和来源元数据；
- [ ] MCP tool 通过 `ToolRuntime` 执行；
- [ ] permission、cancel、progress、result/modelView、audit 和错误分类测试。

### M4：API/Web 与验收

- [ ] MCP server 列表、disable/reconnect API；
- [ ] `/v1/tools` 返回 built-in/MCP 来源；
- [ ] fixture MCP server 完成发现、调用、取消和重连 smoke；
- [ ] 更新本日志、阶段状态和 checkpoint。

## 验证命令

```text
pnpm typecheck
pnpm test
git diff --check
```

## 风险与回滚

- MCP provider 是可选的；所有 server disabled 时，内置工具和既有 Session 不受影响；
- 连接或发现失败只影响对应 server，保留其他 server 和 built-in tool；
- tool generation swap 失败时不保留半套工具；
- 任何外部工具不得绕过 workspace、permission、取消或审计。

## 下一步

实现 `packages/mcp-client`，随后把 manager 接入 `AgentHost`/API，并补齐 fixture contract、权限和恢复测试。
