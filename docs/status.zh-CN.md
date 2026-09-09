# 当前状态

更新时间：2026-09-05

## 产品定位

本仓库是一个 TypeScript/Node.js Coding Agent：通过 Web 工作台驱动流式 Agent Loop，在受权限控制的 workspace 中读取、修改、验证代码，并把 Session、工具、权限和任务状态持久化到事件日志。

当前基础 Runtime 已经稳定，产品路线聚焦安全上线、日常编码交付、上下文质量和平台化能力。仓库名称保留早期命名。

## 评测结果

已在 SWE-bench Lite Easy-45 与 Medium-11 任务集上开展真实 Web Agent 评测。Easy-45 方向的 `pilot-01` 早期 12 条试点记录全部以 `resolved` 结束；严格复核确认 2 条完整 `resolved`，并保留核心修复、定向测试、范围问题和会话中断等分类结果。Medium-11 的 `django__django-15814` 完成目标修复，目标复现、72 项 `proxy_models` 测试和 754 项查询相关测试均通过；另有超时和会话失败样本，11 条任务全部通过兼容性预检。详细记录见 [评测结果摘要](evaluation/results-summary.zh-CN.md)。

## 命名迁移

- `code-review-agent` 是早期仓库名称；当前产品定位为通用 Coding Agent。

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

- AgentHost：turn → step → model → tool 的流式循环、并行工具、取消和错误恢复；模型产生非法工具参数时，运行时会记录结构化工具失败并继续下一轮，Anthropic Messages 序列化器会对历史非法参数使用协议兼容的空对象占位，避免整个 turn 被错误终止。
- Session/EventStore：SQLite append-only 事件、projection、SSE replay、断线重连、幂等命令和重启恢复。
- 工具与权限：文件、搜索、Patch、Git 只读、命令、Terminal、Job、Plan/Todo、AskUser，以及统一审批、审计和输出预算。
- MCP：stdio、SSE/HTTP、Streamable HTTP、tools/resources/prompts discovery、重连和权限桥接。
- 内部 Multi-Agent：parent/child Task 与 Session、one-shot/continuable child、report、artifact、取消、恢复、scoped replay 和权限/工具/MCP scope。
- 上下文与可靠性：tool-result artifact、microcompact、summary compact、session/project memory 契约与 compact/replay 基础、context recovery、worktree、LSP 基础能力和后台 Job；Memory adapter readiness 已通过 M0 接入 Host/API 能力投影，M1 已为默认 SQLite API Host 装配 bounded `FileSessionMemoryStore` 与无模型受限 fallback extractor，M2 已增加默认 `FileProjectMemoryStore`、topic frontmatter、writer policy、stale references 和原子写，M3 已增加 MEMORY.md manifest/词法召回、最多五个 topic、alreadySurfaced 去重、last-good/incomplete 观察、Memory projection、API inspector 和 Web presenter/replay。S0 已建立独立 `@coding-agent/skills` contract/registry，支持 provider、scope chain、rank shadow、cwd/AbortSignal、incomplete observation 和 `skills/change` 生命周期；S1 已增加只读本地 `SKILL.md` filesystem provider（project/user/custom/bundled roots、受限 frontmatter、realpath/symlink/gitignore/size/depth/数量安全边界、last-good 与手动 refresh）；S2 已增加 bounded catalog/digest、canonical Skill renderer、统一 ToolRuntime SkillTool、用户 `/name` ingress、交互审批和正文脱敏事件。CapabilityRegistry 保持 source trust/unknown-property 的正向权限评估。
- Web：三栏工作台、Conversation、Trajectory、Permission、Interaction、Task/Subagent、MCP、Settings 和恢复回放。
- 部分产品化：JWT/principal、tenant session、provider/model routing、credential metadata、SQLite backup/restore 和诊断指标。
- S4 插件：可选本地 bundle runtime，支持受限 manifest、版本 pin、原子安装缓存、enable/disable、reconcile、失败隔离和只读 inventory；插件贡献沿用 Skill/Tool/Prompt registry 及统一权限、workspace、事件管线。S5 已增加默认关闭的 `@coding-agent/skills-mcp`，按显式 server allowlist 发现 MCP `skill://` 资源，提供 bounded frontmatter/body、URL scheme/prefix 校验、TTL cache、超时/取消、资源变化失效和 last-good/incomplete fallback；远程正文保持 untrusted，不做 shell/参数展开，失败不影响本地 Skill。S6/M4 已接入 `read_skill_resource` 的 metadata-only durable event 与可选 host-owned immutable artifact replay；实时正文进入下一模型步骤，重启/compact 缺失快照时 fail-closed。

## 已知限制

这些限制会影响远程或多人部署：

1. Web 端认证当前覆盖 API Bearer/JWT；浏览器登录、token refresh、logout 和带认证的 SSE 进入后续收敛。
2. workspace root allowlist 与远程命令的统一 OS/container sandbox 进入后续安全建设。
3. 公共 Session projection/SSE 与内部审计结果的分层、命令输出和 artifact 的脱敏授权进入后续收敛。
4. Git 当前覆盖 status/diff/log/show 和 worktree；branch/commit/PR 的结构化交付进入后续建设。
5. RBAC、资源级 ACL、细粒度 quota、跨进程 Subagent、A2A 和 marketplace/远程插件生态列入平台化路线；S4 当前提供默认关闭的本地 bundle 最小运行时。
6. M1 的默认 Session Memory 使用 host-owned Markdown 文件，默认位于 SQLite 数据库同级、按数据库绝对路径哈希隔离的 `session-memory/<db-hash>/` 目录（可通过 `sessionMemoryRootDir` 覆盖）；M2/M3 的默认 Project Memory 使用同级 `project-memory/<db-hash>/<scopeKey>/`，支持 bounded `MEMORY.md`、topic frontmatter/references、显式 writer policy、原子写、stale 校验、manifest/词法召回和 last-good/incomplete scan；新增只读 `GET /v1/sessions/:id/memory` 与 Web Memory inspector。两类正文采用 host-owned 文件存储，EventStore/SSE 保存 bounded metadata；`sessionMemoryEnabled=false` 或 `projectMemoryEnabled=false` 可关闭并保留文件，恢复/损坏/写入失败均采用 fail-closed 策略。Memory 正文编辑 API 和 model-backed extractor 列入后续计划，默认 Project Memory validator 由宿主显式注入。S0–S5 的 Skill contract/registry、SKILL.md loader、catalog/SkillTool、动态失效、paths 条件激活、本地 plugin bundle、gated MCP provider 与 `/v1/skills` 只读面已落地；默认 API Host 会注册 filesystem provider，`skillToolEnabled=true` 时开启 SkillTool、模型 catalog 和 `/name` 实际调用。S3 watcher 默认关闭，`skillFilesystem.enabled=false` 可回滚；S5 MCP Skill provider 默认关闭，`mcpSkills.enabled=true` 并配置显式 server allowlist 后发现远程 `skill://` 资源；marketplace、任意 HTTP 抓取和语义搜索列入后续评估。当前 Web 已提供 API/client、catalog presenter 和 Skill tool row，legacy `index.html` composer suggestions 下拉列入后续交互完善；后续重点包括 `userInvocable` 用户侧约束、`allowed-tools` 到 ToolRuntime 的实际收缩、真实 fork 子 Session 和 `modelToolExposed` capability 投影。
7. Skill 资源包的 M0–M7 已落地：模型读取 `SKILL.md` 后可按 Skill-relative 路径调用 `read_skill_resource`，实时结果进入下一模型步骤；事件/SSE 保持正文脱敏，开启 `skillResourceArtifactReplay` 时可通过 host-owned immutable artifact 做 restart/replay/compact 恢复，快照缺失返回 unavailable；M7 增加真实 filesystem 多 step、references/scripts 窗口、资源变更不改写旧 result、API/SSE 脱敏验收 fixture。watcher、artifact 生产级持久化与 tenant ACL 仍需后续收敛。专项调研与实施方案见 [Skill 资源包与渐进式加载](reference/skill-resource-progressive-loading-research-and-implementation.zh-CN.md)。

## 推荐优先级

### 近期：安全可用

- Web auth + SSE 认证闭环；
- tenant workspace root allowlist、symlink 检查和远程执行隔离；
- public projection 脱敏、artifact ACL、CORS/trusted-origin 和 optional-auth 安全测试；
- 同步 README、测试契约和当前能力声明。

### 中期：日常编码交付与上下文质量

- branch → diff → test → commit 的结构化 Git 流程；
- 统一 API Host 高级配置，补足 LSP 和多语言 toolchain discovery；
- 收紧 Skill 的 `userInvocable`、`allowed-tools`、remote trust 和真实 fork 子 Session 语义；
- 增加可替换的 model-backed Session extractor、Project Memory validator/writer API 与 canonical worktree scope；
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
- 历史 Phase 计划和开发日志位于 [archive](archive/)，用于追溯；当前开发顺序以本页为准。

## Microcompact Slice E（2026-09-04）

Pressure-V2 microcompact 已完成 Slice E 诊断与评测收尾：`step/started.payload.toolResultBudget.microcompact`
提供 bounded strategy、pressure threshold、pre/post usage、checkpoint status 与 coverage；Storage、API/SSE
和 Web replay 统一投影并保留 checkpoint/failure metadata，不展示完整工具输出，也不由客户端推断 compact
成功。等价长检索 fixture 与验证矩阵见 [Slice E 评测收尾](evaluation/microcompact-slice-e-2026-09-04.zh-CN.md)。

## Skill 资源包 M4（2026-09-04）

`read_skill_resource` 的实时结果会进入下一模型步骤；持久事件只保留 bounded metadata 与 artifact receipt。启用 `skillResourceArtifactReplay` 并提供 host-owned immutable artifact store 后，重启、replay 与 compact 可恢复原始正文；artifact 缺失或校验失败时返回 `unavailable`，不会重新读取当前 Skill 目录。详情见 [M4 开发日志](development-log/skill-resource-m4-2026-09-04.zh-CN.md)。

## Skill 资源包 M5（2026-09-04）

filesystem Skill provider 已支持默认关闭的 bounded `fs.watch`：`SKILL.md` 和 Skill 目录变化经 debounce 推进 registry invalidation，`references/`、`scripts/`、`assets/` 等深层资源变化不刷新 catalog；watcher 失败保留 last-good 并标记下一次 observation incomplete，支持 retry、dispose 和 `maxWatchDirectories` 限制。workspace mutation 事件仅覆盖 `.claude/skills` catalog 路径。详情见 [M5 开发日志](development-log/skill-resource-m5-2026-09-04.zh-CN.md)。

## Skill 资源包 M6（2026-09-04）

filesystem Skill provider 已完成资源读取的 containment、symlink、special-file、TOCTOU、bytes/offset/line budget 和稳定错误码检查；`read_skill_resource` 与 SkillTool 按 host-derived tenant scope 解析 tenant-owned provider，Skill trust/unknown metadata 只收缩能力或触发审批。资源正文仍只作为实时 model view 或 host-owned artifact 存在，`scripts/` 不执行。详情见 [M6 开发日志](development-log/skill-resource-m6-2026-09-04.zh-CN.md)。生产级 workspace allowlist、跨进程 artifact/资源 ACL 和远程 provider 认证仍属于后续平台化工作。

## Skill 资源包 M7（2026-09-04）

M7 增加真实 filesystem 与模型多 step 验收：SkillTool 输出资源提示后，模型可在后续步骤显式读取 `references/` 与 `scripts/` 文本窗口；未引用资源不会触发隐式 read，资源文件更新只影响下一次读取且不改写旧 result。API JSON/SSE fixture 验证 durable `tool/result` 只含 bounded metadata/receipt，不暴露正文或绝对 provider 路径。详情见 [M7 开发日志](development-log/skill-resource-m7-2026-09-04.zh-CN.md)。
