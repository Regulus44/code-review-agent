# Phase 0 执行清单

Phase 0 的目标不是开始迁移旧 Python 模块，而是把新的 TypeScript 后端边界锁定，使后续实现有一个可回滚、可验证的起点。

## 0.1 仓库基线

- [ ] 根目录 `AGENTS.md` 已建立并明确治理级别；阶段切换的当前状态和门禁记录在 `docs/phase-status.zh-CN.md`，不要求例行修改 `AGENTS.md`。
- [ ] 根目录增加 `package.json`、`pnpm-workspace.yaml` 和 TypeScript solution 配置。
- [ ] 建立 `packages/*` 与 `apps/*` 的最小 workspace；新包全部使用 ESM 和 strict TypeScript。
- [ ] 定义 `typecheck`、`test`、`lint`、`dev` 和最小 API smoke 命令。
- [ ] 明确 Node.js 版本和 pnpm 版本；不要求 Bun 作为后端运行时。
- [ ] 现有 `pyproject.toml` 和 Python 测试保持可运行，但新包不得 import `src/code_review_agent`。
- [ ] 在 CI 或本地 gate 中检查新 Runtime 的依赖图不包含 Python 包。

## 0.2 公共类型和事件

- [ ] 在 `packages/contracts` 定义 `SessionId`、`TurnId`、`TaskId`、`ToolCallId` 和 `WorkspaceId`。
- [ ] 定义 `AgentEvent` envelope、事件类型联合和 `schemaVersion`。
- [ ] 定义 `ToolDefinition`、`ToolResult`、`PermissionRequest` 和 `TaskReport`。
- [ ] 定义 provider-neutral 的 `ChatModel` streaming interface，不暴露某个供应商 SDK 的类型。
- [ ] 为事件 sequence、幂等键、取消和错误 code 写单元测试。

## 0.3 最小 Runtime 设计

- [ ] `packages/storage` 提供 `EventStore` interface，先允许 in-memory 实现，随后接 SQLite。
- [ ] `packages/runtime` 提供 `AgentHost`、`SessionService` 和 `TurnRunner` 的空心但可运行实现。
- [ ] `AgentHost` 只负责 Session/Turn 编排，不直接实现文件、shell 或 MCP 工具。
- [ ] `packages/llm` 提供 mock stream 和 OpenAI-compatible adapter 的接口占位。
- [ ] `packages/workspace` 只定义 workspace resolver 和 policy interface，不先复制旧 Python 安全实现。

## 0.4 API 与 Web 入口

- [ ] `apps/api` 提供 `health`、Session create/list、send message 和 SSE events 的最小端点。
- [ ] `apps/web` 建立 DSH 风格 Shell 的最小布局：sidebar、conversation、tool/event row、composer。
- [ ] Web 只依赖 `packages/contracts` 和 API client，不直接依赖 DSH 的内部包。
- [ ] SSE 先回放历史事件，再订阅新事件；客户端按 sequence 去重。

## 0.5 复用和来源门禁

- [ ] 每个复制或大量改编的 DSH/Claude Code 文件登记到 `source-reuse-register.md`。
- [ ] DSH 代码复用保留 MIT notice；Claude Code 代码复用前逐文件确认许可证。
- [ ] 不把 DSH Cordis、桌面端、CLI 或全部插件作为 Phase 0 依赖。
- [ ] 不把 Claude Code 的账户、遥测、商业 provider 或 CLI 入口带入新 Runtime。

## Phase 0 退出条件

只有同时满足以下条件，才进入 Phase 1：

1. `pnpm typecheck` 和最小 TypeScript 测试通过；
2. API 可以创建 Session、接收一条消息并通过 SSE 返回事件；
3. 事件可以从空 Session 回放出同样的状态；
4. 新 Runtime 依赖图没有 Python import；
5. Web Shell 能显示 Session、用户消息和 assistant 增量；
6. 关键来源和许可证已经登记；
7. 有一个可回滚的 Git checkpoint。

## Phase 0 回滚点

Phase 0 的提交只允许包含 workspace、公共类型、最小 host、测试、文档和 Web Shell。不得在同一提交中加入 MCP Server、A2A、Subagent、LSP、Worktree 或大规模旧代码搬迁。这样可以在方向调整时删除新 workspace，而不破坏旧 Python 参考实现。
