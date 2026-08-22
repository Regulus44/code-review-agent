# Phase 4 开发日志：MCP Client

## 状态

`completed`

## 2026-08-23：后续 MCP/A2A 执行计划建立

Phase 4 原有 MCP Client 退出门禁保持完成。复核当前实现与 DSH 后，下一步拆为 Phase 4B MCP 加固、Phase 5 内部 Task/Subagent 和 Phase 6 A2A inbound adapter。详细计划见 [MCP 与 A2A 演进执行计划](../phase-plans/mcp-a2a-execution-plan.zh-CN.md)。

本计划额外标注了 DSH R0/R1/R2 关注等级。R0 工作项必须逐文件对照 DSH 的 connection supervisor、tool generation swap、Subagent lifecycle、authority、ACP codec 和 Host event mux，并为每项差异补充行为 fixture；A2A 外部 envelope 以官方协议为准，DSH 只提供内部生命周期参考。

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

- [x] stdio transport；
- [x] SSE 兼容与 Streamable HTTP transport；
- [x] 启动、停止、重连、断线和超时；
- [x] tools/list、resources/list、prompts/list 及 list-changed 重同步。

### M3：统一工具管线

- [x] namespace、schema 转换和来源元数据；
- [x] MCP tool 通过 `ToolRuntime` 执行；
- [x] permission、cancel、progress、result/modelView、audit 和错误分类测试。

### M4：API/Web 与验收

- [x] MCP server 列表、disable/reconnect API；
- [x] `/v1/tools` 返回 built-in/MCP 来源；
- [x] fixture MCP server 完成发现、调用、取消和重连 smoke；
- [x] 更新本日志、阶段状态和 checkpoint。

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

实现 `packages/mcp-client`，随后把 manager 接入 `AgentHost`/API，并补齐 fixture contract、权限和恢复测试（已在本日志的实现 checkpoint 完成）。

## 2026-08-21：MCP Client 最终 checkpoint

### 变更范围

- 新增 `packages/mcp-client`，基于官方 `@modelcontextprotocol/sdk` 实现 `McpConfigStore`、`McpConnectionManager`、stdio/SSE/Streamable HTTP transport、discovery、tool/resource/prompt adapter；
- MCP 工具通过 `mcp__<server>__<tool>` namespace 注册到共享 `ToolRegistry`，保留 `source` 元数据并使用 schema/risk/permission/timeout/cancel/progress/result/audit 统一管线；
- 新增 `mcp/server`、`mcp/tool` 事件，生命周期事件只保存 server identity、状态和脱敏错误；
- API 增加 MCP server 配置、列表、删除、enable/disable/reconnect、resource read 和 prompt get 路由；
- `/v1/tools` 和 Web 工具卡片展示 built-in/MCP 来源，侧栏展示 MCP 状态和恢复操作；
- API/契约测试覆盖 secret redaction，MCP package 覆盖真实 stdio fixture、Streamable HTTP fixture、tool discovery、resources/prompts discovery、schema bridge、MCP error、取消、reconnect 和统一事件审计。

### 失败与修复

- 首版 HTTP fixture 复用了有状态 transport，导致 Streamable HTTP client 在第二个请求上失败；按 SDK/DSH 的 stateless 模式改为每个 HTTP 请求创建 server + transport，并让 SDK 自己读取 request body；
- 首版 reconnect 在每次失败时重置 attempt counter，可能无限重启；拆分 manual start 与 reconnect start，只有人工 reconnect/首次启动重置预算；
- `ToolRuntime` 原本把 MCP adapter 错误统一成 `TOOL_EXECUTION_FAILED`，现保留安全格式的 adapter error code（例如 `MCP_TOOL_ERROR`、`MCP_REQUEST_FAILED`）。

### 验证

```text
pnpm typecheck
pnpm test
git diff --check
```

MCP package 当前 5 个测试通过；全 workspace 回归和 API MCP route 测试通过。真实 stdio 与 Streamable HTTP fixture 均已连接并发现工具，ToolRuntime 取消和 MCP error 均有结果事件。

最终实现 checkpoint：`5477f16 feat: add phase four mcp client`。

### 未包含与风险

- 配置持久化、独立 Settings 页面和资源/Prompt 的 Web 消费仍是后续增强；当前已提供 manager/API adapter 和 discovery contract；
- MCP provider 可完全 disabled，关闭所有 provider 不影响 built-in tools 或既有 Session；
- 外部 server 的实际副作用仍由 server 自己负责，默认未知工具使用 `network` 风险并被本地 policy 拒绝；显式降低风险级别必须由用户配置并经过现有审批策略。

Phase 4 退出条件已满足：至少一个 MCP fixture server 可以配置、发现、调用、取消和重连；stdio 与 Streamable HTTP 均有真实 transport 测试；MCP 工具和内置工具共享 schema、policy、approval、timeout、cancel、progress、structured result、audit 和事件模型；关闭 MCP provider 不影响既有 built-in tools 和 Session。
