# 当前状态

更新时间：2026-09-01

## 产品定位

本仓库是一个 TypeScript/Node.js Coding Agent：通过 Web 工作台驱动流式 Agent Loop，在受权限控制的 workspace 中读取、修改、验证代码，并把 Session、工具、权限和任务状态持久化到事件日志。

当前基础 Runtime 已经稳定，后续工作应优先围绕安全上线、代码交付和 Code Review 价值展开，而不是继续扩展历史阶段数量。

## 命名迁移

- 当前产品、私有 workspace scope、Docker service/image、MCP client 和 `/health` 的
  `service` 值统一使用 `Coding Agent` / `coding-agent`。
- `CODING_AGENT_*` 是当前环境变量前缀。`CODE_REVIEW_AGENT_DB_PATH`、
  `CODE_REVIEW_AGENT_PWSH`、`CODE_REVIEW_AGENT_PORT` 和
  `CODE_REVIEW_WORKSPACE_HOST_ROOT` 在迁移期继续作为 fallback；新变量优先。
- 默认 SQLite 路径已改为 `coding-agent.sqlite`，并会在新文件不存在且旧
  `code-review-agent.sqlite` 已存在时复用旧文件。Docker 仍保留旧命名数据 volume，
  避免已有本地 Session 丢失。
- 远程 GitHub 仓库仍需要由具有仓库管理权限的维护者改名为 `coding-agent`；完成后再更新
  `origin` URL。JWT audience 由部署配置决定，使用旧值的部署应与 IdP 配置一起迁移。

## 已实现能力

- AgentHost：turn → step → model → tool 的流式循环、并行工具、取消和错误恢复。
- Session/EventStore：SQLite append-only 事件、projection、SSE replay、断线重连、幂等命令和重启恢复。
- 工具与权限：文件、搜索、Patch、Git 只读、命令、Terminal、Job、Plan/Todo、AskUser，以及统一审批、审计和输出预算。
- MCP：stdio、SSE/HTTP、Streamable HTTP、tools/resources/prompts discovery、重连和权限桥接。
- 内部 Multi-Agent：parent/child Task 与 Session、one-shot/continuable child、report、artifact、取消、恢复、scoped replay 和权限/工具/MCP scope。
- 上下文与可靠性：tool-result artifact、microcompact、summary compact、session/project memory 契约与 compact/replay 基础、context recovery、worktree、LSP 基础能力和后台 Job；Memory adapter readiness 已通过 M0 接入 Host/API 能力投影。
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
7. Session/Project Memory 的默认 durable adapter 尚未装配；未显式注入 adapter 时，Host/API 将能力状态报告为 `unavailable`，M1 才实现默认持久化 adapter。

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
- `pnpm test`：通过（12 个 workspace，全部测试通过）。
- `docker compose config --quiet` 与 `node scripts/phase8-deployment-audit.mjs`：通过。

## 文档使用规则

- 当前能力、限制和优先级以本页为准。
- 架构和安全不变量以 [架构决策](architecture-decisions.md)、[事件契约](event-contract.md)、[工具契约](tool-contract.md) 和 [协议边界](protocol-boundaries.md) 为准。
- 历史 Phase 计划和开发日志位于 [archive](archive/)，只用于追溯，不代表当前开发顺序。
