# Phase 1：AgentHost 与 Web Shell 开发日志

状态：`completed`

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
