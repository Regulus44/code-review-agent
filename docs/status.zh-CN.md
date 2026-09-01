# 当前状态

更新时间：2026-09-01

## 产品定位

本仓库是一个 TypeScript/Node.js Coding Agent：通过 Web 工作台驱动流式 Agent Loop，在受权限控制的 workspace 中读取、修改、验证代码，并把 Session、工具、权限和任务状态持久化到事件日志。

当前基础 Runtime 已经稳定，后续工作应优先围绕安全上线、代码交付和 Code Review 价值展开，而不是继续扩展历史阶段数量。

## 已实现能力

- AgentHost：turn → step → model → tool 的流式循环、并行工具、取消和错误恢复。
- Session/EventStore：SQLite append-only 事件、projection、SSE replay、断线重连、幂等命令和重启恢复。
- 工具与权限：文件、搜索、Patch、Git 只读、命令、Terminal、Job、Plan/Todo、AskUser，以及统一审批、审计和输出预算。
- MCP：stdio、SSE/HTTP、Streamable HTTP、tools/resources/prompts discovery、重连和权限桥接。
- 内部 Multi-Agent：parent/child Task 与 Session、one-shot/continuable child、report、artifact、取消、恢复、scoped replay 和权限/工具/MCP scope。
- 上下文与可靠性：tool-result artifact、microcompact、summary compact、session/project memory、context recovery、worktree、LSP 基础能力和后台 Job。
- Web：三栏工作台、Conversation、Trajectory、Permission、Interaction、Task/Subagent、MCP、Settings 和恢复回放。
- 部分产品化：JWT/principal、tenant session、provider/model routing、credential metadata、SQLite backup/restore 和诊断指标。

## 已知限制

这些限制会影响远程或多人部署：

1. Web 端认证尚未完全贯通。API 支持 Bearer/JWT，但浏览器登录、token refresh、logout 和带认证的 SSE 仍需补齐。
2. workspace root 仍缺少产品级 allowlist；远程模式也尚未对所有命令统一使用 OS/container sandbox。
3. 公共 Session projection/SSE 与内部审计结果仍需进一步分离，命令输出和 artifact 需要更严格的脱敏与资源授权。
4. 仓库尚无独立的 Code Review findings、baseline、inline comment、SARIF 导出和 Git provider review contract。
5. Git 当前以 status/diff/log/show 和 worktree 为主，branch/commit/PR 的结构化交付闭环尚未完成。
6. RBAC、资源级 ACL、细粒度 quota、跨进程 Subagent、A2A 和完整插件运行时尚未落地。

## 推荐优先级

### 近期：安全可用

- Web auth + SSE 认证闭环；
- tenant workspace root allowlist、symlink 检查和远程执行隔离；
- public projection 脱敏、artifact ACL、CORS/trusted-origin 和 optional-auth 安全测试；
- 同步 README、测试契约和当前能力声明。

### 中期：日常交付与 Code Review

- Review session、baseline、finding、inline comment、聚合验证和 SARIF/Markdown/JSON 导出；
- branch → diff review → test → commit 的结构化 Git 流程；
- 统一 API Host 高级配置，补足 LSP 和多语言 toolchain discovery；
- 长会话 projection、event retention 和 artifact 引用化。

### 后续：团队与平台化

- RBAC/resource ACL、rate limit、并发和 token budget；
- structured logs、OpenTelemetry、告警、readiness/liveness 和升级回滚；
- MCP 复合身份、PTY、跨进程 Subagent provider；
- 只有出现明确外部互操作需求时再启动 ACP/A2A；插件和 Workflow 也按具体验收场景引入。

## 验证状态

- `pnpm typecheck`：通过。
- `pnpm test`：当前 API shell 测试仍有一个命名契约失败，测试期待 `Code Review Agent`，Web title 已为 `Coding Agent`；其余相关 Subagent、Storage、Runtime 和 Web 测试通过。

## 文档使用规则

- 当前能力、限制和优先级以本页为准。
- 架构和安全不变量以 [架构决策](architecture-decisions.md)、[事件契约](event-contract.md)、[工具契约](tool-contract.md) 和 [协议边界](protocol-boundaries.md) 为准。
- 历史 Phase 计划和开发日志位于 [archive](archive/)，只用于追溯，不代表当前开发顺序。
