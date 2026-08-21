# Phase 1：AgentHost 与 Web Shell 开发日志

状态：`reopened`（Web Shell checkpoint 已完成；Agentic Coding Core 尚未完成）

阶段计划：[phase-1-agenthost-web.zh-CN.md](../phase-plans/phase-1-agenthost-web.zh-CN.md)

## 2026-08-21：阶段完成记录

### 主要交付

- 建立 TypeScript/Node.js monorepo：`packages/contracts`、`llm`、`storage`、`runtime`、`workspace`；
- 建立 `AgentHost`、Session、Turn、in-memory EventStore 和 Echo/OpenAI-compatible model adapter；
- 建立 Node HTTP API、SSE、取消和最小 DSH 风格 Web Shell；
- Web 完成 Session sidebar、Conversation、composer、Connected 状态和 assistant 增量展示。

### 验证证据

- 主要实现提交：`87401da feat: add phase one typescript agent host`；
- `pnpm typecheck`、`pnpm test` 通过；
- HTTP/SSE smoke 通过；
- 浏览器 Read-only smoke：页面连接 SSE、发送消息、显示 assistant 增量；
- 修复了 SSE JSON/流式读取、空流 heartbeat 和 Session 列表 payload 问题。

### 后续移交

Phase 1 保留 in-memory store 作为测试实现，SQLite durable EventStore、projection 重建、重启恢复和幂等 command 移交 Phase 2。

## 2026-08-22：重新打开 Phase 1 的 Coding Agent 门禁

### 诊断

- 当前 Web 页面已经可以创建 Session、选择 workspace、选择模型并显示流式文本；
- 当前 `packages/tools/src/builtin.ts` 的 9 个内置工具已经是 TypeScript 初版，ToolRuntime 已能通过 API 直接执行，并具备 workspace、schema、权限、取消、超时、输出预算和审计能力；旧 `src/code_review_agent/tools/` 只保留为 Python legacy/reference；
- 但模型请求只包含 `messages`，adapter 只解析文本增量，AgentHost 没有把模型 tool call 转换为 ToolRuntime 执行，也没有把 tool result 作为下一次模型上下文；
- 所以已有实现是 Coding Agent Runtime 基础设施，不是完整的 DSH/Claude Code 风格 Coding Agent。

### 决策

Phase 1 不再以 Web Shell 完成为退出条件，改以 [Agentic Coding Core 计划](../phase-plans/phase-1-agentic-coding-core.zh-CN.md) 的 Phase 1A.0–1A.6 门禁为准。下一步先做 contracts → DeepSeek tool-call adapter → Agent Loop → P0 TypeScript 工具池 → permission resume，再完成真实 `read → edit → approve → test` smoke；Terminal、Plan/Todo、AskUser 已提升为 Phase 1A 的 P1，Subagent/A2A 暂不进入核心实现。

### 2026-08-22：Phase 1A.1–1A.3 首批实现

- `packages/contracts` 增加 tool call、tool result、model tool schema、content message 和 step event contract；
- `packages/llm` 支持发送工具 schema并解析 OpenAI/DeepSeek-compatible `delta.tool_calls` 参数增量；
- `packages/runtime` 支持多 step model → tool → model、并行工具调用、tool result continuation、max steps 和 malformed tool call；
- permission ask 会等待用户批准/拒绝后继续同一个 turn；
- 多轮上下文会从事件重建 assistant tool call 和 tool result；
- Web SSE 订阅 `step/started` / `step/ended`，并保留既有 tool/permission 展示。

### 当前未完成

- 真实 DeepSeek API 下的 `read → edit → approve → test` 垂直验收；
- 进程重启后的 pending turn continuation；
- Phase 1A.4 的持久 Terminal、AskUser、Plan/Todo、delete/git read 工具扩展；
- P1 工具的完整行为 fixture 和 DSH/Claude Code 对照回归。

## 2026-08-22：真实模型配置接入

### 变更

- API CLI 启动入口新增本地 `.env` 加载；根目录 `.env` 已加入 Git 忽略，仓库只保留不含密钥的 `.env.example`；
- `MODEL_PROVIDER=auto` 在存在 `DEEPSEEK_API_KEY` 时选择 DeepSeek，否则保持 Echo，避免测试和无密钥开发被真实网络调用阻塞；
- DeepSeek 默认模型改为 `deepseek-v4-flash`，并登记 `deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp` 三个可选模型；
- API 新增 `GET /v1/models` 和 `POST /v1/models`，Web 顶栏提供模型下拉切换；切换只影响后续 turn，重启后回到 `.env` 中的 `DEEPSEEK_MODEL`；
- `MODEL_PROVIDER=deepseek` 在缺少 Key 时快速失败，错误不会回显 Key；
- API `/health` 仅返回 provider、model、base URL 和 `configured` 状态，不返回 API Key；
- API 测试使用 fake fetch 验证 Authorization header 和真实流式消息路径，未使用真实凭据。

### 验证

- `pnpm typecheck` 通过；
- `pnpm test` 通过；
- DeepSeek-compatible SSE adapter、无 Key fallback、显式缺 Key 错误、Key 不进入请求体/health/events 均有测试。
- 模型目录、合法切换、后续 turn 使用新模型和非法模型拒绝均有 API 测试。

### 使用方式

在仓库根目录执行 `Copy-Item .env.example .env`，只在本机 `.env` 中填写 `DEEPSEEK_API_KEY`，然后运行 `pnpm dev:api`。真实 Key 不需要也不应该发送到 Web API。
