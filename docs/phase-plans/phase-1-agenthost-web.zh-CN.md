# Phase 1：最小 AgentHost 与 DSH 风格 Web Shell

## 目标

建立第一个可运行的 TypeScript 垂直切片：浏览器创建 Session，发送一条消息，AgentHost 调用模型并通过 SSE 流式返回 assistant 事件。

本阶段先证明新的 TypeScript 后端和 Web 方向可行，不迁移旧 Python Runtime，也不引入 MCP、Subagent 或 A2A。

## 参考入口

DSH：

- `D:/Develop/deepseek-harness-fork/packages/core/agent-loop/src/agent.ts`
- `D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/sessions.ts`
- `D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/events.ts`
- `D:/Develop/deepseek-harness-fork/packages/client/web`
- `D:/Develop/deepseek-harness-fork/apps/web`

Claude Code：

- `D:/Develop/claude-code/src/query.ts`
- `D:/Develop/claude-code/src/services/api/claude.ts`
- `D:/Develop/claude-code/src/services/tools/StreamingToolExecutor.ts`

参考原则：采用 DSH 的 Session/事件/API 组织，采用 Claude Code 的流式 turn 控制和终止语义；不复制完整 Cordis 或 CLI。

## 交付物

- `packages/contracts`：Session、Turn、Event、Model stream 类型；
- `packages/llm`：provider-neutral `ChatModel` 和 mock stream；
- `packages/runtime`：`AgentHost`、`SessionService`、最小 `TurnRunner`；
- `packages/storage`：先提供 in-memory `EventStore` 接口实现；
- `apps/api`：health、Session create/list、send message、SSE events；
- `apps/web`：DSH 风格 sidebar、conversation、composer、assistant stream；
- Read-only 的端到端 smoke fixture。

## 工作流任务

### Contracts

1. 定义 branded ID 和 `AgentEvent` envelope；
2. 固定 `session/created`、`user/message`、`turn/started`、`assistant/chunk`、`assistant/message`、`turn/ended`；
3. 为事件增加 sequence、幂等键和 schema version。

### Runtime/LLM

1. `AgentHost.createSession()` 创建 Session 并追加事件；
2. `TurnRunner` 按 turn → step → model stream 顺序执行；
3. 支持 mock provider，便于无 API key 测试；
4. OpenAI-compatible adapter 只负责请求和流解析，不负责 Session 状态。

### API/Web

1. API 事件先写 EventStore，再广播 SSE；
2. Web 根据事件 reducer 更新 UI，不维护第二套事实状态；
3. Composer 支持发送和停止；
4. 断开后用 `after_sequence` 重新请求已有事件。

## 不包含

- 文件写入、shell、MCP、A2A、Subagent；
- SQLite 迁移和复杂 projection；
- 完整 DSH UI 组件闭包；
- 多用户认证、配额和远程部署。

## 测试与验收

- 单元：事件序列、turn 生命周期、mock stream、取消；
- 合同：API JSON 和 SSE frame；
- e2e：创建 Session → 发送消息 → 收到 assistant 增量 → 停止；
- 回放：从事件列表重建 Web conversation；
- 安全：Session ID 隔离，不能读取另一个 Session 的事件。

退出条件：Web 页面能完成一次稳定的流式对话，刷新或重连后能显示已有事件，并且新 Runtime 没有 Python import。

## 回滚点

保留旧 Python 服务不动；Phase 1 的回滚范围只包括新增的 `packages/`、`apps/api` 和 `apps/web`，不修改旧业务模块。
