# 阶段状态

本文记录当前开发阶段的实际状态。它不是长期架构决策；阶段完成以对应 Git checkpoint、测试命令和验收证据为准。

## 当前状态

| 阶段 | 状态 | Checkpoint/证据 |
|---|---|---|
| Phase 0：TypeScript 基线与契约 | completed | `codex/phase-0-typescript-foundation`；workspace、strict TS、contracts、依赖图检查通过 |
| Phase 1：Agentic Coding Core | completed（Phase 1A.0–1A.6 已完成） | Tool-calling loop、P0/P1 TypeScript 工具、permission preset、pending approval/terminal 恢复和真实 `read → edit → approve → test → summary` 已通过；本次 checkpoint 完成阶段退出记录 |
| Phase 2：事件、持久化与恢复 | completed | `a7f636f` + `5d5a198`；SQLite reopen/recovery、projection replay、SSE replay、queue、幂等 command 和 model failure 通过 |
| Phase 3：工具运行时与权限 | completed | `e1d3172`（替代 `5003dbd`）；工具禁用、显式覆盖、进程树终止、audit/modelView、权限过期/取消/重启恢复和 Web smoke 通过 |
| Phase 3B：Coding Agent 工具池与工具 Prompt 强化 | completed（2026-08-22） | 3B.0–3B.5、patch/diff、LSP 生命周期/恢复、job spill/恢复和 Web presentation 已闭合；隔离本地长任务与真实 DeepSeek long-task smoke 通过。普通基线测试未重复执行 |
| Phase 4：MCP Client | completed | `5477f16`；官方 SDK stdio/SSE/Streamable HTTP、discovery、ToolRegistry bridge、权限/取消/重连、API/Web MCP 状态和 fixture 验证通过 |
| Phase 4B：MCP 加固 | completed（2026-08-23） | 本 checkpoint；4B.0–4B.6、focused tests、API restart persistence 和 MCP browser smoke 通过；普通 baseline 未重复执行 |
| Phase 5：内部 Subagent / 多 Agent | completed（2026-08-23） | 5.0–5.4：Task/Descriptor durable projection、one-shot/continuable child、FIFO/authority/cold resume、report/MCP scope、API/SSE/Web catalog；定向 typecheck、storage/subagent/runtime/API 测试和 API/Web smoke 通过 |
| Phase 6：A2A | deferred（暂不作为 Phase 7 前置） | [ADR：Phase 7 Web 收敛不等待 A2A](adr/phase-7-web-with-a2a-deferred.zh-CN.md)；等待明确的外部 Agent 互操作需求 |
| Phase 7：DSH Web 前端收敛 | completed | 7.1–7.10 Web shell、连接与回放、Workspace/Session navigation、Conversation/Tool/Permission/Interaction、Trajectory、Task/Subagent/MCP、Settings/Deliverables、响应式与可访问性、五场景 browser/replay gate、Workspace reorder 与 Workspace rename/archive/delete lifecycle 已完成；`pnpm typecheck`、`pnpm test`、`pnpm test:phase7:browser` 和 `git diff --check` 通过；browser gate 总耗时 2.14s、trajectory full replay 19.03ms；独立 checkpoint `82326d6` |
| Phase 8：高级能力与产品化 | in_progress（8.0/8.1/8.2/8.4 已完成，8.3/8.5 partial） | Phase 8.0 的 600/900/1024 visual/accessibility matrix、9 个 Web parity browser 场景和独立 checkpoint 已完成；最新 Trajectory 滚动责任 checkpoint `b6a1cf7`；8.3/8.5 仍等待目标部署环境 smoke，不影响 8.0 关闭 |

## Phase 8 计划范围（accepted）

- [Phase 8：高级能力、DSH Web 对齐与产品化](phase-plans/phase-8-productization.zh-CN.md) 已扩展为 8.0 Web 对齐、8.1 Context Compaction、8.2 Worktree、8.3 LSP/Code Mode、8.4 后台任务与可靠性、8.5 产品化；
- [ADR：Phase 8 Web 与 DSH 前端行为对齐](adr/phase-8-web-dsh-alignment.zh-CN.md) 已接受，记录行为参考、REST/SSE 边界、typed Web 拆分、契约变更和回滚规则；
- Phase 8 曾于 2026-08-24 暂存归档在 checkpoint `c1aae6c`，随后持续恢复推进。8.0 的 aggregate Web parity contract、六个 600/900/1024 Shell/Settings 视觉基线、真实 in-app browser visual/accessibility evidence 和 9 个 DSH 对齐行为场景已在 `2026-08-25` 独立 checkpoint 中闭合；8.4 已补齐长任务与并发 Web recovery matrix，并新增真实 graphical browser recovery 第一批证据，8.5 已建立产品化边界、tenant-scoped Workspace/MCP/provider routing、credential reference lifecycle、JWT/principal catalog、external secret adapter 和 SQLite backup/restore/migration rollback 第一切片。当前剩余的是 8.3/8.5 的目标部署环境 OS/IdP/secret-manager/upgrade smoke，不再包含 8.0 browser parity 缺口。

## Phase 8.0 Web parity（completed，2026-08-25）

- 8.0.0–8.0.6 的 typed Web projection、Shell/Workspace/Conversation/Details/Settings、六个 600/900/1024 × 800 JPEG 基线、ARIA/focus/recovery 证据均已通过；Plugins 继续明确显示为 `deferred`。
- `docs/phase8-browser-evidence.json` 新增 8.0.7 真实浏览器场景证据：Goal/Plan/Question、Queue/Steer/Attachment、Workspace lifecycle、Tool/Permission/Diff/Job、Trajectory、Produced Files、Subagent interrupt/history、Settings/model failure、reconnect/replay/API restart，共 9 组场景。
- 使用 `PHASE8_WEB_LIVE_TURN=1`、`PHASE8_WEB_LIVE_DELAY_MS=2000` 的 SQLite/API/AgentHost fixture，在真实 Codex In-app Browser 中验证 running turn 的 Steer、queued follow-up、durable receipt 和 reload replay；没有把静态 DOM marker 当作交互成功。
- `pnpm typecheck`、`pnpm test`、`pnpm build:web`、`pnpm test:phase7:browser`、`pnpm test:phase8:web`、`pnpm test:phase8:settings`、`pnpm test:phase8:visual`、`pnpm test:phase8:parity`、`pnpm test:phase8:browser:evidence` 和 `git diff --check` 通过；8.0 独立 checkpoint 在本次提交建立。
- 8.0 回滚边界：只回滚本次 browser evidence JSON/gate、fixture live-control 开关和阶段文档；生产 Event/Tool/Task/Permission/Workspace contract 不变。

## Phase 8.0 Trajectory scroll ownership（completed，2026-08-25）

- 按 DSH 的 active view / single scrollport 结构，Trajectory 模式下外层 `#conversation` 不再承担纵向滚动，`.main-trajectory-scroll` 成为唯一内部垂直 scrollport；
- 补齐 Trajectory active view 的 `flex: 1 1 0`、`min-height: 0`、`height: 100%`，并使用 Composer `ResizeObserver` 提供动态 bottom clearance；
- Conversation 与 Trajectory 独立保存并恢复 `scrollTop`，tail-follow、Load older 和历史 prepend 补偿都操作当前 active view 的 scrollport；
- 在 `http://127.0.0.1:3210/` 重启服务后验证 Trajectory 红框区域滚轮滚动、外层 scrollTop 不竞争、连续切换 10 次和 per-view 位置恢复；`pnpm build:web`、`git diff --check`、health check 通过；
- 独立 checkpoint：`b6a1cf7 feat(phase8): align trajectory scroll ownership`；回滚该提交不会改变 Event、Tool、Task、Permission 或 Workspace contract。

## Phase 8 暂存归档（2026-08-24）

- 该节记录历史暂存动作；Phase 8 已从 `c1aae6c` 恢复推进，provider/model routing 已在 `c7e417c` 建立独立 checkpoint，credential lifecycle 已由本次恢复提交建立独立 checkpoint。
- 最后一轮全量 workspace 测试已结束并通过；本轮重点门禁 `pnpm test:phase8:productization`、`pnpm test:phase8:parity`、`pnpm typecheck`、定向 Runtime/Storage/API 测试和 `git diff --check` 均通过。
- 已归档的有效交付：8.1 Context Compaction、8.2 Worktree、8.0 aggregate Web parity，以及 8.3/8.4/8.5 的已实现切片和对应安全/恢复证据。
- 原恢复入口中的 tenant-scoped Workspace catalog/mutation、MCP config、provider/model routing 和 credential reference lifecycle 已分别建立独立切片；后续继续推进 8.3 OS-level isolation/deployment evidence、8.4 跨场景 recovery matrix、外部 IdP/JWT、principal catalog 和运维策略。
- 归档边界：该历史动作不代表 Phase 8 完成；当前阶段状态以本文件顶部 `in_progress` 和最新独立 checkpoint 为准。

## Phase 8.5 产品化第一切片（partial）

- 新增 [ADR：Phase 8.5 产品化边界与渐进式启用](adr/phase-8-5-productization-boundary.zh-CN.md)，明确 remote auth、multi-user/tenant、quota、provider/model routing、credentials 和运维能力的状态语义、默认禁用态与回滚边界；
- `packages/contracts` 新增 `ProductizationCapability` 和 `SessionOwnership`；Session/SessionProjection 的 ownership 通过 `session/created` 事件持久化，并在 SQLite 重启、fork 和子 Agent 创建时回放/继承；
- Runtime `AgentHost.productizationSettings()` 和 API `/v1/capabilities.productization` 返回真实 host-backed readiness；显式配置时支持静态 bearer token、tenant-scoped Session catalog、跨租户 404 隔离和 hard Session/Turn quota；默认本地 Host 保持 auth/tenant/quota/运维能力 `deferred` 或 `disabled`；
- Web Settings 和 typed browser bundle 展示 Productization 状态；`scripts/phase8-productization-gate.mjs` 与 `pnpm test:phase8:productization` 已覆盖认证、租户目录、跨租户拒绝、turn quota、credential lifecycle 和凭据脱敏边界；
- 当前仍未实现外部 IdP/JWT、完整 principal catalog、外部 secret manager、upgrade/deployment policy；backup/restore 与 migration rollback 仅完成第一切片，不能将 8.5 或 Phase 8 标记为完成。

## Phase 8.5 tenant-scoped Workspace slice（implemented，未完成整体 8.5）

- `AgentHost` 的 Workspace catalog、reorder、rename、archive/restore 和 soft delete 接受可选 `SessionOwnership` scope；认证 API 仅投影调用者 tenant 的 Session members。
- `workspace/updated` 与 `workspace/reordered` 的 tenant-scoped 事件携带 `tenantId`/`principalId`，metadata、排序和 mutation 只在同 tenant 回放；未认证本地 catalog 忽略 tenant-scoped metadata，保持旧行为并 fail closed。
- Authenticated cross-tenant Workspace catalog/mutation 返回隐藏式 404；同 tenant mutation 保留 command idempotency，Workspace delete 仍是软删除，不删除 Session、文件或 EventStore 历史。
- 已覆盖 Runtime InMemory tenant isolation、SQLite reopen/replay、API cross-tenant 404、产品化 browser fixture gate；`pnpm test:phase8:productization` 已通过。

## Phase 8.5 tenant-scoped MCP config slice（implemented，未完成整体 8.5）

- `packages/contracts` 的 `McpConfigRecord` 与 MCP `ToolSource` 支持可选 tenant ownership；SQLite schema v4 增加 `mcp_server_configs.tenant_id`，旧无租户数据库可迁移并保持兼容。
- `McpConfigStore`、`McpConnectionManager`、`ToolRuntime` 和 API MCP routes 按 tenant 过滤 config/list/catalog/resource/prompt/lifecycle；未认证本地只显示 legacy unscoped configs，跨租户访问统一 404。
- MCP tool discovery/model-visible list/execute 三层均检查 tenant；持久化只保留 scrubbed config 与 credential reference，secret material 不进入 SQLite、事件或公开 API。
- 已覆盖 MCP client tenant catalog/lifecycle conflict、Storage schema v4 persistence/reopen、API tenant catalog/404、产品化 gate；credential reference lifecycle 已由后续独立切片补齐，整体仍需外部 secret manager 和运维策略。

## Phase 8.5 tenant-scoped provider/model routing slice（implemented，未完成整体 8.5）

- `packages/contracts` 新增 `ModelRouteRecord` / `ModelRouteBackend`；route 只保存 provider/model/baseUrl 和 opaque credential reference，不保存 secret material。
- SQLite schema v5 新增 `model_routes`，支持旧数据库迁移和 reopen；存在持久 route 但缺少 model selector 时恢复 fail closed。
- Runtime 按 Session ownership 选择 tenant model，并将实际使用的 route metadata 写入 `turn/started` 与重启恢复的 `agent/status`；未配置 tenant route 的 Session 继续使用 host-local model。
- API `/v1/models` 支持 tenant-scoped GET/POST、route receipt 和 durable upsert；同一 API 下不同 tenant 的 route、current model 和 vision attachment capability 不互相泄露；Web typed client 保留 route projection。
- `apps/api/src/server.test.ts`、`packages/runtime/src/index.test.ts`、`packages/storage/src/index.test.ts` 覆盖 API/Runtime/SQLite/recovery metadata；`scripts/phase8-productization-gate.mjs` 增加 tenant model routing 与 cross-tenant denial。
- 本切片验证通过 `pnpm typecheck`、Runtime 32 项、Storage 14 项、API 34 项、`pnpm test:phase8:productization` 和 `git diff --check`；当前仍需外部 IdP/JWT、OS-level isolation/deployment evidence、browser recovery matrix 和运维策略。

## Phase 8.5 tenant-scoped credential reference lifecycle slice（implemented，未完成整体 8.5）

- `packages/contracts` 新增 `CredentialRecord` / `CredentialBackend`，`McpCredentialReference.version` 用于轮换后的 stale reference 检测；metadata 只保存 tenant、kind、状态、版本和时间。
- SQLite schema v6 新增 tenant-scoped `credentials` metadata table，支持旧数据库迁移、reopen、InMemory fixture 和 cross-tenant query isolation；secret material 不进入 SQLite、EventStore 或公开 projection。
- `apps/api/src/credentials.ts` 提供 host-owned `CredentialVault`：create、rotate、revoke、delete、reference validation 和 resolver；未配置 backend、跨租户、吊销或 stale reference 均 fail closed。
- API 增加认证 tenant-scoped credential catalog/mutation endpoints；删除仍受 model route/MCP reference 阻止，响应、Web typed client 和错误边界均不返回 secret material。
- model route 在 rotation 时重绑新 version，在 revoke 时清除 tenant route 并回退 host-local；MCP resolver 按 tenant 解析，live connection 在 lifecycle mutation 时停止/重连，不可用 reference 显示 `needs_auth`。
- 已覆盖 CredentialVault、SQLite v6、MCP resolver/invalidation、API lifecycle、Web typed client 和 productization gate；当前仍需外部 secret manager、外部 IdP/JWT、OS-level isolation/deployment evidence、browser recovery matrix 和运维策略。

## Phase 8.5 SQLite backup/restore 与 migration rollback slice（implemented，未完成整体 8.5）

- `packages/storage` 新增 SQLite inspection、consistent backup、restore migration 和 rollback API；备份只包含事件、projection、配置 metadata 和脱敏 credential metadata，不包含 secret material。
- restore 通过临时副本运行现有 schema migration、projection rebuild 和 integrity check；legacy schema v5 可恢复到 v6，目标库覆盖前保留 rollback artifact，rollback 后原库事件和 projection 可继续恢复。
- `AgentHost.productizationSettings().operations` 与 SQLite-backed API capability 报告 `backup: available`、`migration: available`、`upgrade: deferred`；不把 migration rollback 宣称为完整 deployment upgrade policy。
- `scripts/phase8-operations-gate.mjs` 已覆盖 schema v6 backup、v5 → v6 restore、overwrite rollback、event preservation、integrity check 和 secret redaction；`pnpm test:phase8:operations` 已通过。
- 当前仍需外部 secret manager、外部 IdP/JWT、完整 principal catalog、8.3 OS-level isolation/deployment evidence、graphical browser recovery matrix 和 upgrade/deployment policy。

## Phase 8.5 外部 IdP/JWT 与 durable principal catalog slice（implemented，仍需 secret manager/upgrade policy）

- `packages/contracts` 新增 `PrincipalRecord` / `PrincipalBackend`；principal 只保存 subject、tenant、roles、status 和时间，不保存 token 或 secret material。
- SQLite schema v7 新增 `principals`，支持旧 v5/v6 数据库迁移、reopen、subject lookup、tenant filter 和备份/恢复；InMemory fixture 与 SQLite 共用 principal contract。
- API 新增独立 JWT verifier：支持 host-provided HS256/RS256 key set 与可选 JWKS refresh hook，校验 `kid`、issuer、audience、signature、`exp`、`nbf` 和 tenant claim；JWT subject 必须命中 active principal catalog，否则 401 fail closed。
- `GET /v1/principals` 与 detail route 只投影调用者 tenant 的 principal metadata；JWT capability 报告 `auth.mode=jwt`、`multiUser.principalCatalog=external`，静态 bearer 继续作为 local/test adapter。
- `apps/api/src/auth.test.ts`、`jwt-server.test.ts`、Storage principal/reopen test 和 operations gate 已覆盖签名失败、时间窗、JWKS rotation、unknown/disabled principal、tenant mismatch、API 401、catalog filter 和 schema v7 recovery。
- 本 slice 未改变 Session/Event/Tool/Permission/Workspace event contract；剩余 8.5 缺口为 external secret manager、upgrade/deployment policy，以及将 JWT/JWKS 在真实 IdP/Docker deployment 中做现场 smoke。

## Phase 8.5 external secret manager 与 upgrade/deployment policy slice（implemented，真实部署 smoke 仍 deferred）

- `apps/api/src/credentials.ts` 新增 `SecretProvider`、`HostOwnedSecretProvider` 和 `ExternalSecretProvider`；CredentialVault 通过 `(tenant, credential, version)` 管理 material，rotation/revoke/remove 只操作对应版本，provider failure 明确 fail closed。
- API `ApiServerOptions.secretProvider` 支持 host 注入 external secret-manager adapter；capability 在 external provider 下报告 `credentials.secretStore=external`，未注入时保持 host-only；现有 API/route/MCP/SSE/redaction contract 不保存 secret material。
- `packages/storage` 新增 `SQLITE_UPGRADE_POLICY` 与 `assessSqliteUpgrade`，固定 schema v5–v7 支持范围、升级前备份、migration lock、health/integrity/SSE readiness 和 retained rollback artifact。
- `docs/phase8-deployment-policy.json` 与 `scripts/phase8-upgrade-policy-gate.mjs` 审计 Docker non-root/read-only/no-new-privileges/cap-drop、bounded workspace 和 `upgrade=deferred-until-deployment-smoke`；`phase8-operations-gate` 已将 policy 与 v5 → v7 restore/rollback 联合验证。
- credential unit、operations、upgrade-policy 和 productization gates 已通过；真实云端 secret manager、IdP/Docker deployment smoke 仍需在目标部署环境执行，因此公开 upgrade capability 继续 `deferred`。

## Phase 8.3 OS/container isolation 与 deployment evidence slice（implemented，宿主能力依赖）

- `packages/tools/src/code-mode.ts` 新增 `CodeModeIsolationAdapter`，将真正的 OS/container network boundary 与现有 process-policy 分开；`os-required` 在 adapter 缺失或探测失败时保持 `CODE_MODE_OS_ISOLATION_UNAVAILABLE`。
- Linux adapter 使用 `unshare` network namespace；Docker adapter 使用 ephemeral `--network none`、read-only rootfs、`no-new-privileges`、`cap-drop ALL`、numeric non-root user 和 `/workspace` bind。两者都暴露 kind/reason/evidence，执行结果和 progress 只记录实际 adapter。
- `docker-compose.yml` 默认 API service 增加 read-only rootfs、tmpfs、no-new-privileges、capability drop，`Dockerfile` 保持 uid 10001 non-root runtime；新增 `scripts/phase8-deployment-audit.mjs` 与 `pnpm test:phase8:deployment`。
- 工具单测覆盖 explicit adapter launch、unavailable adapter 和默认 fail-closed；`pnpm test:phase8:lsp:exit` 继续报告 `status: partial`，因为具体宿主的 unshare/Docker runtime availability 仍需部署环境现场证明。
- 本切片没有新增 Event/Tool/Task/Permission/Workspace contract；回滚只需移除 adapter 配置和部署 hardening，保留默认 process-policy 与安全拒绝路径。

## Phase 8 历史暂停归档（2026-08-24）

- 本次历史收尾 checkpoint：`61cd9ca`（`feat(phase-8.5): add tenant-scoped mcp config`）。
- 收尾验证：`pnpm typecheck`、`pnpm test:phase8:parity`、`pnpm test:phase8:productization` 和 `git diff --check` 均通过；产品化 gate 覆盖 auth、tenant Session/Workspace/MCP catalog、跨租户拒绝、turn quota 和 credential redaction。
- 暂停边界：8.1、8.2 和已实现的 8.0/8.3/8.4/8.5 切片保留；Phase 8 与 Phase 8.5 均未达到整体退出条件，不得标记为 completed。
- 历史恢复入口：从 `61cd9ca` 继续，优先推进 tenant-scoped provider/model routing、credential reference 生命周期、8.3 OS-level isolation/deployment evidence、8.4 跨场景 browser recovery matrix，以及 backup/restore、migration rollback 和 upgrade/deployment policy。

## Phase 6 A2A 暂缓决策

Phase 5 已经稳定了内部 parent/child Task、Session、权限、workspace、MCP scope、report、cancel 和恢复语义。当前产品目标是 Web Coding Agent，暂无跨产品或跨组织 Agent 互操作的验收场景，因此 Phase 6 A2A 暂缓，不阻塞 Phase 7 Web 收敛。

具体决策见 [ADR：Phase 7 Web 收敛不等待 A2A](adr/phase-7-web-with-a2a-deferred.zh-CN.md)。未来只有在出现外部 Agent 调用、跨进程/主机协作、跨组织标准化 task/artifact/streaming 或私有集成维护成本明确上升时，才重新开启 Phase 6。

Phase 7 的 DSH Web 调研与分步计划：

- [DSH Web 前端与 Agent 能力调研](phase-7-dsh-web-research.zh-CN.md)
- [Phase 7：DSH Web 前端收敛与可观测工作台](phase-plans/phase-7-web-convergence.zh-CN.md)

## Phase 8.0.3 Goal/Plan/Todo/Question vertical slice（当前 checkpoint）

- `apps/web/src/presentation/goal-presenter.ts`：从 durable GoalProjection 生成 GoalBar render intent；目标条件只有在 goal completed 事件存在时才标记 satisfied，缺少 host command surface 时明确标记 deferred；
- `apps/web/src/presentation/plan-presenter.ts`：将 PlanProjection 转为 draft/active/approved/rejected/cleared review intent，bounded 内容和不可用原因来自 presenter；
- `apps/web/src/presentation/todo-presenter.ts`：提供 pending/in_progress/completed/cancelled 的 TodoPanel 投影、计数、折叠提示和 bounded detail；
- `apps/web/src/presentation/question-presenter.ts`：提供按 turn/standalone 批次筛选、多问题、选项、freeform、expiry、恢复标记和状态计数；
- `apps/web/src/browser.ts`：typed Web bridge 暴露四个 presenter；`apps/web/index.html` 增加 GoalBar、Plan toolbar 入口和 Goal/Plan/Todo/Questions details panel，所有事实仍来自 SessionStore/SessionProjection；
- `packages/contracts` / `packages/storage` / `packages/runtime`：Goal 增加 durable `paused` 状态；`getCommand` 支持重启后的幂等检查；Goal、Plan、Todo host command 使用 command idempotency 与 `lastSequence` CAS，冲突返回 `COMMAND_CONFLICT` 且不追加事件；
- `apps/api` / `apps/web/src/client/api.ts`：新增 Goal、Plan、Todo command API，GoalBar pause/resume/edit/clear 与 Plan review 只在 host command surface 存在时启用；
- 当前状态仍为 `pending`，8.0.3 的 projection/presentation 与 Goal/Plan/Todo command 闭环已具备，但 Question batch 仍需 browser fixture，8.0.0–8.0.7 和 Phase 8 其余工作流尚未完成；
- 定向 presenter、Runtime 20 项、API 25 项，Web 全量 93 项、`pnpm typecheck`、全量 `pnpm test`、`pnpm build:web`、`pnpm test:phase7:browser` 和 `git diff --check` 通过；browser gate 五场景、1,250 条 trajectory replay 继续通过。

## Phase 8.1 Context Compaction（completed）

- 新增 `packages/compaction`：bounded token estimate、tool result microcompact、旧消息摘要、tool-call/tool-result 边界修复和 protected pending tool result；
- `packages/runtime` 在每个模型 step 前按 context budget 压缩消息，成功追加 `context/compacted`，失败追加 `context/compaction_failed` 并继续使用原上下文；pending permission/interaction 对应 tool call 会进入 protected set；
- `SessionProjection.contextCompaction` 和 Web `ContextMeter` 展示压缩状态、估算 token、丢弃消息数和失败原因；未配置 provider budget 时显示 `unknown`；
- `packages/compaction` unit 3 项、Runtime 25 项、Storage 12 项、API 27 项、Web 98 项已通过；新增 `/v1/capabilities.context` budget metadata、Settings context capability、compaction failure continuation、SQLite restart replay 和 `scripts/phase8-compaction-gate.mjs`；
- `pnpm typecheck`、`pnpm build:web`、`pnpm test:phase8:compaction` 和 `git diff --check` 通过；8.1 的长上下文、预算可见性、失败恢复和重启回放退出条件已满足。

## Phase 8.2 Worktree（completed）

- `packages/workspace` 的 `GitWorktreeManager` 已完成 Git repository/main-root/linked-worktree 识别、list/create/inspect/cleanup、branch/id/path 边界、dirty/conflicted protection、主仓库禁止 cleanup 和无 shell的 Git 执行；
- `packages/runtime` 已将 create/attach/switch/cleanup 接入 durable `worktree/*` 事件、command idempotency、per-session operation lock、active worktree root、pending create recovery 和重复路径冲突保护；工具、权限和 system prompt 使用 active worktree root，Session 的主 `workspaceRoot` 保留不变；
- `packages/storage`、Web SessionStore/SSE、API `/v1/sessions/:id/worktrees` 及 Web Worktree presenter/details panel 已接入 replay；
- 已新增 linked worktree、SQLite reopen/replay、pending side-effect recovery、并发 create 去重、dirty cleanup protection 和 API/Web client tests；
- `pnpm typecheck`、Workspace 6 项、Runtime 24 项、Storage 12 项、API 26 项、Web 98 项、`pnpm build:web`、`pnpm test:phase7:browser`、`pnpm test:phase8:worktree` 和 `git diff --check` 通过；本组变更建立独立的 Phase 8.2 Git checkpoint。

## Phase 8.0 Web parity、Phase 8.3 LSP/Code Mode（进行中）；Phase 8.4 Reliability（completed）

- `c0cf1d3`：新增独立 `scripts/phase8-web-gate.mjs`，使用真实 SQLite/API/AgentHost fixture 验证 Goal/Plan/Todo/Question replay、回答/取消、Plan review、Goal CAS conflict、Todo idempotency 和 browser bundle；Trajectory Inspector 增加 Options、Usage、Diff、Request、Tool catalog、Rendered、Raw、Input、Output、Schema 等 bounded sections；
- `presentLspTool` 与 Web LSP details surface 已接入，diagnostics、definition、references、source location、restart/crash 和失败状态均保持 host-backed；
- `CodeModeSandbox` 已接入可选 `code_mode` builtin，默认 disabled；支持 workspace-bound child process、`node` allowlist、网络禁用、runtime/output/code budget 和取消；API `/v1/capabilities` 与 Settings 暴露 Code Mode/LSP metadata；
- Code Mode 的网络策略继续保持 deny-by-default，并额外拦截 `globalThis.fetch`、`globalThis.WebSocket` 与 `process.getBuiltinModule` 入口；该策略仍是进程内策略检查，不等同于 OS 级网络隔离。
- Code Mode capability metadata 现在显式暴露 `networkEnforcement`：默认 `process-policy`，并报告 `osNetworkIsolation: false`；若配置 `os-required`，host 会以 `CODE_MODE_OS_ISOLATION_UNAVAILABLE` fail closed，不会把进程内检查冒充为 OS 级隔离。
- 新增 `scripts/phase8-lsp-codemode-exit-gate.mjs` 与 `pnpm test:phase8:lsp:exit`，对 workspace/process boundary、网络 deny-by-default、OS-required fail-closed、资源预算、LSP restart/timeout/cancel 和 Web host-backed surface 做可重复审计；gate 通过但状态明确为 `partial`，残余风险是缺少 OS-level network isolation adapter 和部署级证据。
- `scripts/phase8-lsp-codemode-gate.mjs` 现在同时检查 Web LSP details 文案和 typed browser bundle；`pnpm test:phase8:lsp` 与 Code Mode 定向测试通过。
- `pnpm test:phase8:web` 已通过（planning/question replay gate）；`pnpm test:phase8:lsp` 已通过（LSP/Code Mode safety/recovery gate）；Web 100 tests、Tools 56 tests、API 27 tests、Runtime 25 tests 和 `pnpm typecheck` 通过；
- `6ac8e7e`：8.3 第一阶段 checkpoint 已建立；随后新增 `scripts/phase8-lsp-fixture-server.mjs` 与 `scripts/phase8-lsp-web-gate.mjs`，真实 SQLite/API/AgentHost/Web replay 已覆盖 diagnostics、definition、references、Code Mode 成功结果和网络拒绝结果；`pnpm test:phase8:lsp:web` 已通过。网络 boundary assessment 已记录，当前 host 仍没有 OS 级网络隔离；完整退出审计仍待补齐。
- 当前已进入 `Phase 8.4 Reliability`：`JobManager` 已持久化可重试 executable/args 元数据，支持 bounded retry、deadline 结构化失败、取消原因和 graceful shutdown；`AgentHost` 提供 job action、session export/replay 和 structured diagnostics；API 暴露 `/v1/sessions/:id/jobs`、`/retry`、`/cancel`、`/export` 与 `/v1/diagnostics`；Web Job center 已提供 Cancel/Retry actions。
- `AgentHost` 已支持显式 `fallbackModels`：主模型在产生部分输出前失败时切换到下一个模型，并追加 `MODEL_FALLBACK` 审计事件；`metrics()` 与 API `/v1/metrics` 提供 turns、fallback、tool failure counters；每个 turn 的 `traceId` 会在 started/ended/error 边界中保持一致。
- 新增 `scripts/phase8-job-fixture-server.mjs` 与 `scripts/phase8-job-browser-gate.mjs`，使用真实 SQLite、AgentHost、ToolRuntime、API 和 Web bundle 验证 running/failed job、Cancel、Retry、spill metadata、job lifecycle replay、diagnostics、session export 以及重复 action 的幂等行为；`pnpm test:phase8:jobs` 已通过。
- `AgentHost.retryJob` / `killJob` 与 API Job action route 现在消费 `Idempotency-Key`，通过 durable command claim 防止重复 Retry/Cancel 产生重复副作用；Runtime 定向测试与 API server tests 已通过。
- 8.4 的真实 Job Center action slice 已闭合；`pnpm test:phase8:jobs` 已覆盖真实页面的 Cancel/Retry、lifecycle replay、diagnostics、export 和重复 action 幂等。
- 新增 `scripts/phase8-job-recovery-fixture-server.mjs` 与 `scripts/phase8-job-recovery-gate.mjs`，通过 seed → API/SQLite shutdown → fresh AgentHost/API reopen 验证 orphaned/completed job、interrupted session、terminal recovery、SSE replay、`after_sequence` tail cursor、diagnostics 和 export；`pnpm test:phase8:job-recovery` 已通过。
- 8.4 的 API restart、断线 SSE replay、orphaned/interrupted recovery slice 已闭合；`pnpm test:phase8:job-recovery` 已覆盖 fresh AgentHost/API reopen、terminal recovery、tail cursor、diagnostics 和 export；跨场景真实长任务恢复矩阵仍需继续扩展。
- 新增 `scripts/phase8-job-recovery-matrix-gate.mjs` 与 `pnpm test:phase8:job-recovery:matrix`，重复执行 seed → reopen → reopen-again，覆盖 Job Center Web surface、orphaned/completed 状态、SSE replay、terminal tail cursor、export/diagnostics 和无重复 projection；本次继续扩展真实 live fixture，覆盖三个并发长任务、交错 output、单 job cancel、其余 job completion、断线后的 SSE tail reconnect 和 sequence 去重。
- 新增 `scripts/phase8-reliability-gate.mjs`，覆盖 retry、deadline、shutdown、session export、diagnostics 和 metrics；`pnpm test:phase8:reliability` 已通过。8.4 的自动化退出条件已完成。
- Reliability gate 现在额外检查 Web Job Center 的 `Cancel job`、`Retry job` 和 `Terminal & long-running jobs` surface；真实 Job fixture 已由 `pnpm test:phase8:jobs` 覆盖，`pnpm test:phase8:job-recovery:matrix` 现已补充长任务并发、取消/完成和断线 tail reconnect 证据；更广泛的 graphical browser matrix 仍待扩展。
- `scripts/phase8-job-recovery-fixture-server.mjs` 现在支持 bounded `PHASE8_JOB_RECOVERY_LIVE_ITEMS`/`PHASE8_JOB_RECOVERY_LIVE_DELAY_MS` 时序参数；in-app browser 真实验证了三个 running jobs、展开详情后的 `Cancel job`、取消后一个 cancelled/两个 running，以及刷新后的 `Connected` replay 状态。该证据补齐 graphical recovery 第一批场景，更广泛的多 viewport、断线交错和 Job action 组合矩阵仍待扩展。
- 8.4 退出审计已完成：`pnpm test`、`pnpm test:phase8:jobs`、`pnpm test:phase8:reliability`、`pnpm test:phase8:job-recovery:matrix` 和 `git diff --check` 均通过；图形浏览器已覆盖 600/900/1024 viewport、三个并发长任务、取消后的 projection 和 reload replay。剩余 Phase 8 缺口为 8.0 完整 visual/accessibility matrix、8.3 OS-level isolation/deployment evidence，以及 8.5 的外部 IdP/JWT、principal catalog、secret manager 和 upgrade/deployment policy。
- 状态修订：前文“更广泛 graphical browser matrix 仍待扩展”的历史描述由本条和 8.4 退出审计记录 supersede；8.4 graphical recovery evidence 已与 HTTP/SSE matrix 合并收口。
- 修复 API restart recovery：graceful shutdown 不再取消处于 pending user interaction 的 turn，避免在数据库关闭前追加 `interaction/resolved(cancelled)`；`apps/api` 27 项 server tests 已通过。
- 当前 Web parity 收口新增 Workspace Browser 的 Tree/Flat 视图与 Recent/Name/Path 确定性排序；搜索、Archived 筛选、父子 Session 展示和 active Session 保持现有回放状态；真实页面切换回归已通过。
- 本次导航改动验证：`pnpm typecheck`、Web 101 tests、`pnpm build:web`、`pnpm test:phase8:web`、`pnpm test:phase8:reliability` 和 `git diff --check` 均通过；独立 checkpoint 为本次提交。
- Settings 的 Model section 现在保留 host-backed loading/ready/error 状态、provider failure 文案、Retry model catalog 操作和模型选择 receipt；模型目录失败不会把整个 Web boot 误判为连接失败。
- Settings 新增 host-backed Plugins capability section；`/v1/capabilities` 的 `plugins` 字段当前明确为 `deferred`，并说明插件运行时等待 Phase 8.5 产品化需求，不把未实现能力显示为可用。
- `scripts/phase8-web-gate.mjs` 已增加 Workspace view/sort 与 Settings model retry surface 检查；Web presenter 102 tests、`pnpm typecheck`、`pnpm build:web` 和 `pnpm test:phase8:web` 通过。
- 新增 `scripts/phase8-settings-gate.mjs` 与 `PHASE8_MODEL_FAILURES` fixture：首个 `/v1/models` 请求返回 503，页面保持 Connected 并显示 Settings error/Retry，点击 Retry 后恢复 fixture-model；真实页面回归已通过。
- 新增 `scripts/phase8-parity-gate.mjs` 与 `pnpm test:phase8:parity`，聚合 Goal/Plan/Question、Workspace、Job、LSP、Settings、Deliverables、Task/Subagent、typed presenters、响应式和可访问性 contract；gate 已通过。
- 新增 `docs/phase8-visual-baselines/manifest.json`、六个真实 JPEG 基线和 `scripts/phase8-visual-gate.mjs`；`pnpm test:phase8:visual` 已通过，校验 Shell/Settings 的 600/900/1024 尺寸、格式和 Plugins deferred 说明。
- 8.0 当前已关闭完整 600/900/1024 visual/accessibility evidence、移动侧栏/Details/Settings focus restore 和 provider failure → Retry → selection receipt 场景；其余 DSH 行为场景的完整真实 browser matrix 仍需继续扩展。真实 Job 浏览器 action/replay fixture、Plugins 状态和 aggregate parity contract 已关闭。
- 新增 `docs/phase8-browser-evidence.json`、`scripts/phase8-browser-evidence-gate.mjs` 与 `pnpm test:phase8:browser:evidence`；该 gate 固化真实 Codex In-app Browser 的视口、焦点、ARIA、Settings recovery 和视觉基线证据，不把静态 HTML marker 当作浏览器成功。

## Phase 7 Workspace lifecycle controls（当前 checkpoint）

- `packages/contracts` / `docs/event-contract.md`：新增 `workspace/updated` 事件和 Workspace 生命周期元数据字段；
- `packages/runtime/src/index.ts`：Workspace catalog、rename、archive/restore、soft delete 和幂等 replay；delete 不删除 Session、文件或事件历史；
- `apps/api/src/server.ts` / `apps/web/src/client/api.ts`：Workspace catalog 与生命周期命令 API；
- `apps/web/index.html` / `apps/web/src/presentation/navigation-presenter.ts`：Workspace actions 菜单、动态 Rename 文案、active/archived/deleted 导航筛选；catalog 缺失的已删除 Workspace 不再继续显示，但 Session 历史仍保留；
- `scripts/phase7-browser-gate.mjs`：覆盖 rename、archive/restore、delete、幂等和事件回放；
- 验证：`pnpm typecheck`、Runtime 19 项、API 24 项、Web 17 项生命周期定向测试、`pnpm test:phase7:browser` 通过；真实 browser fixture 验证删除确认、导航隐藏和历史保留。

## Phase 7 typed Web client、Tool surface、Trajectory foundation 与 inspector（历史 checkpoint）

- `apps/web/src/client/api.ts` 已统一 Web API 的 URL、JSON response、HTTP error 和 idempotency header；
- `apps/web/src/client/store.ts` 已提供 Session baseline、事件去重、higher-sequence-wins、Session projection 和可订阅 immutable snapshot；
- `apps/web/src/client/connection.ts` 已提供 generation 隔离、history replay、SSE live stream、指数 backoff、断线重连和旧 Session callback 丢弃；
- `apps/web/src/projection/conversation.ts` 已提供 keyed Conversation/Tool/Permission/Interaction/Task projection，assistant chunk 合并和未知事件 generic fallback；
- `apps/web/src/projection/tool-call-tree.ts`、`presentation/tool-presenter.ts` 已提供 bounded lineage、cycle/orphan/depth guard、source/risk/status summary、modelView 优先和敏感字段脱敏；
- `apps/web/src/projection/trajectory.ts` 已从共享 event window 生成 turn/step/assistant/tool/task/permission/interaction/error ledger，running record 不虚构 duration；`SessionStoreSnapshot` 同时发布 Conversation、ToolCallTree 和 Trajectory；
- `apps/web/src/presentation/safe-value.ts`、`trajectory-presenter.ts` 已提供统一 bounded JSON、敏感字段脱敏、untrusted/truncated 标记、query/kind/runningOnly/limit 过滤、稳定 lane 分组和 Overview/Timing/Source/Rendered detail inspector；
- `apps/web/src/browser.ts` 已暴露 `queryTrajectory` 和 `inspectTrajectory`，静态 Web details panel 已接入搜索、running-only、record 选择、lane 列表和 inspector；UI 的搜索/选中项仅是可丢弃的交互状态，事实仍来自 `SessionStoreSnapshot`；
- `apps/web/src/presentation/task-presenter.ts` 已把 TaskProjection 转为 bounded task/child-agent render intent，包含 mode/provider、parent/child lineage、report/artifact、diagnostics、resumable/cancellable；details panel 同时消费 Session task projection 和 Subagent catalog，不复制 Task 事实；
- `apps/web/src/presentation/mcp-presenter.ts` 已把 MCP server/config/catalog/retry view 转为 bounded render intent，details panel 展示 scope、transport、revision/generation、auth、catalog policy、retry/error 和安全 raw detail；MCP config/env/credential 仍由 host/API 提供脱敏值；
- `apps/web/src/presentation/settings-presenter.ts`、`apps/web/src/browser.ts` 和 `apps/web/index.html` 已提供 host-backed Settings/general/model/permission/capability 对话框；工具风险统计、MCP attention、内部 Subagent availability 和 A2A `deferred` 状态均来自既有 catalog/Session projection，不把 UI 状态写入 EventStore；
- `apps/web/src/presentation/deliverables-presenter.ts`、`apps/web/src/browser.ts` 和 `apps/web/index.html` 已提供 bounded Produced Files/Artifacts render surface；workspace、external、unsafe、unknown 分类、preview、source task 和 disabled action reason 均来自 TaskProjection.artifacts，UI 不根据不可信路径执行打开/下载；
- `apps/api/src/artifacts.ts`、`apps/api/src/server.ts` 和 `apps/web/src/client/api.ts` 已提供 workspace-scoped artifact metadata/content API；每次读取都重新校验 Session workspace、artifact id、regular file 和 symlink 边界，支持受控 inline/download，external/blocked/pathless artifact 仍保持不可用；
- `apps/web/src/presentation/focus-trap.ts`、`apps/web/src/browser.ts` 和 `apps/web/index.html` 已为 Workspace picker/Settings dialog 提供 Tab 循环、Escape 关闭、dialog/aria 语义和 opener focus restore；typed bridge 缺失时仍保留静态 fallback；
- `apps/web/src/presentation/connection-presenter.ts`、`apps/web/src/client/store.ts` 和 `apps/web/index.html` 已提供 loading/reconnecting/failed 的 bounded connection banner、Retry 入口和 aria-live 状态；SessionStore 在恢复到 connected/idle 时清理 stale transport error，正常连接不显示多余 banner；
- `apps/web/src/presentation/navigation-presenter.ts` 已把 Workspace→Session tree、archived/deleted filter、search、跨平台 workspace key、relative time、parent/child lineage 和 explicit empty state 转为纯 typed render intent；`apps/web/src/browser.ts` 暴露该 presenter，`apps/web/index.html` 在 typed bridge 存在时消费它并保留旧 DOM fallback；
- 导航树现在渲染 child Session 的嵌套 lineage，Session 切换仍通过 `SessionConnectionController` identity boundary 清理旧订阅和可丢弃 selection；Workspace reorder、rename、archive/restore、soft delete 生命周期 API 已接入并通过 replay gate。
- `apps/web/src/shell/layout.ts` 已提供 Shell layout state、reducer、responsive viewport 和 class render intent；sidebar/details/mobile-sidebar actions 通过 typed bridge 驱动，600px 窄屏可实际打开/收起侧栏，旧 class toggle 仍作为 fallback；
- `apps/web/src/presentation/request-presenter.ts` 已把 Permission/Interaction node 转为 time-aware、bounded、redacted render intent；pending request 在 deadline 到达但 resolved event 尚未抵达时会先禁用操作并显示 expired，interrupted/reconnecting session 会标记可恢复请求；details panel 增加 pending/recovered/expired 计数；
- `apps/web/src/presentation/job-presenter.ts` 已把 durable job/terminal 事件折叠为 bounded、redacted、可恢复的 diagnostics render intent；未收到 terminal event 且 Session interrupted 的 job 显示 orphaned，失败 job 保留 exit code/signal/diagnostics，details panel 展示输出和 spill metadata；
- `apps/web/src/presentation/trajectory-presenter.ts` 新增 `buildTrajectoryTimeline()`：复用查询结果按 source sequence 建立 bounded timeline，计算 recorded span、nested tool depth、offset/width；running/unknown record 保持未知 timing，不伪造 duration；
- `apps/web/index.html` 的 Trajectory details 增加 timeline record `<details>` 折叠、lane 折叠和 `Following tail`/`Paused` 控件；这些状态只存在于当前 Web session，刷新后由 EventStore replay 重建事实；
- `packages/contracts`、`packages/storage`、`packages/runtime` 和 `apps/api` 已增加兼容的 `EventPage`/`listPage`、`before_sequence`、`limit`、older/newer cursor 和 bounded JSON replay；无分页参数的旧 `/events?format=json` 仍返回原始事件数组；
- `apps/web/src/client/connection.ts`、`store.ts` 支持最近窗口初始化、`loadOlder()`、prepend 去重和 projection rebuild；older history 使用独立 cursor，不改变 SSE newest cursor，tail-follow 暂停时仍接收事件但不强制滚动；
- `apps/api/src/fixtures/trajectory.ts` 与 `scripts/phase7-trajectory-fixture-server.mjs` 提供 1,250 条 completed read-only tool records；搜索可覆盖完整历史，ledger 默认 bounded 到 200 条，timeline 默认 bounded 到 1,000 行；
- `packages/tools/src/runtime.ts` 与 `packages/runtime/src/index.ts` 已恢复 durable Interaction：API/AgentHost 重启后可以重新挂载 pending question，回答会追加 synthetic `tool/result` 并恢复原 turn；过期恢复请求会追加 `interaction/resolved(expired)` 和 bounded tool result；
- `packages/tools/src/runtime.ts` 的 permission/interaction expiry timer 会在定时器提前唤醒时重新检查绝对截止时间，避免短 TTL 下把 `expired` 错记为 `cancelled`；
- `conversation.ts` 和 Shell permission/interaction surface 已保留 caller、workspaceRoot、expiresAt、allowFreeform、cancelled/expired/resolved 状态；按钮命令使用 idempotency key；
- `apps/api/src/fixtures/delegation.ts` 与 `scripts/phase7-delegation-fixture-server.mjs` 提供隔离、非空、可回放的 completed child 和 cancellable child；fixture 显式携带 workspace、permission、tool/MCP allowlist、report、artifact 和 child transcript；
- API/replay/security 已覆盖 parent/child catalog、report/artifact projection、scoped event replay、sibling authority rejection、cancel 和 live-state cleanup；浏览器 smoke 已验证取消后 parent `2 tasks · 0 live`、刷新回放保持 `cancelled`、child Session 不残留 parent tasks；
- 现有 Shell 通过 `/web/browser.js` bridge 使用 typed 主 Session 连接，并优先从统一 `SessionStoreSnapshot` 渲染 Conversation/Tool/Turn/Permission/Interaction 节点；旧 inline EventSource 和 event renderer 保留为 bundle 缺失时的 fallback，未改变 API/Runtime/EventStore 事实来源；
- 定向与全量验证：`pnpm typecheck`、`pnpm test`（全 workspace 通过）、`pnpm --filter @code-review-agent/web test`（50 tests）、`pnpm --filter @code-review-agent/tools test -- --run src/index.test.ts`（30 tests）、`pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts`（13 tests）、`pnpm --filter @code-review-agent/api test -- --run src/server.test.ts`（18 tests）、`pnpm --filter @code-review-agent/storage test -- --run src/index.test.ts`（10 tests）、`pnpm -F @code-review-agent/web run build:browser`、`git diff --check`；API/AgentHost recovery fixture、Delegation browser replay/cancel、child Session identity/artifact isolation、Trajectory timeline/fold/tail-follow、load older/prepend、1,250-record search/bounded render、paused tail append、Settings/Workspace dialog Tab/Escape/focus restore、connection banner connected/empty/error presenter 和 Deliverables workspace/external/blocked/empty smoke 均通过，browser console 无 warning/error。

Phase 7.final 退出审计已完成：交付物与“不包含”边界已同步，Event/Tool/Task/Permission/Workspace contract、阶段计划、状态和开发日志一致；五场景 browser/replay、全 workspace tests、类型检查和 diff 检查均通过。下一阶段入口为 Phase 8。

## Phase 5 Subagent / Multi-Agent 验收证据（2026-08-23）

- `packages/contracts`：Task/Subagent/Descriptor/Report/Artifact/authority contract 和事件类型；
- `packages/storage`：SQLite schema v3 child metadata、parent/child catalog、Task folding、重复 terminal 保护、projection rebuild 和 restart recovery；
- `packages/subagent`：provider catalog、foreground/background one-shot、continuable FIFO/child lock、ancestor authority、descriptor cold resume、direct-parent report 和 settlement；5 项 targeted tests 通过；
- `packages/runtime` / `packages/tools`：独立 child AgentHost adapter、ToolRuntime 仍为唯一执行入口、tool/MCP allowlist 和 model-facing subagent tools/prompt sections；
- `apps/api`：`/v1/sessions/:id/subagents`、prompt/interrupt、task query/output/cancel、parent/child scoped SSE replay；API 15 项测试通过；
- `apps/web`：parent/child tree、ready/running/failed 状态、report/task projection 和 child cancel/history 入口；
- 门禁：`pnpm exec tsc -b --pretty false`、storage 9 项、subagent 5 项、runtime 12 项、API 15 项 targeted tests 通过；tools 全包测试有一个 Windows 临时目录锁定的既有 JobManager 环境型失败，未作为 Phase 5 代码失败处理；普通 baseline 未重复执行。

## Phase 4B 加固进展（2026-08-23）

已完成 4B.0–4B.5 的实现切片：

- 新增 [MCP 4B 契约审计](mcp-4b-contract-audit.zh-CN.md)，冻结 DSH R0 对照、scope visibility、credential reference、generation 和 hostile fixture 矩阵；
- SQLite schema v2 增加 durable MCP config、scope/binding、enabled、revision、credential reference 和 scrubbed config；API 启动时自动恢复 enabled config；
- manager 增加 per-server generation guard、list-changed debounce/serialized sync、ToolRegistry atomic replace、稳定窗口 retry diagnostics 和 scoped event projection；
- MCP schema 保留组合字段，public namespace 使用 SHA-256 identity；server/tool policy 支持 allowlist、risk、approval 和 catalog disabled reason；
- resource/prompt adapter 增加 timeout/cancel、bounded modelView、untrusted trust marker 和 `mcp/resource`/`mcp/prompt` 脱敏事件；
- Web MCP panel 展示 scope、revision、generation、auth、retry 和 catalog 统计。

最终验证：`pnpm typecheck`、`packages/storage` 9 项测试、`packages/mcp-client` 9 项测试、`apps/api` 14 项测试、`git diff --check` 和 MCP browser smoke 通过；普通 workspace baseline 未重复执行。该记录是 Phase 4B 的历史退出证据，随后已进入并完成 Phase 5。

## Phase 7 Web Coding 工作模式修复（2026-08-22）

Web 工作台现在支持 Session 级工作模式：新建 Session 可以选择 `read-only`、`ask-on-write`、`workspace-write`、`ask-on-execute` 和 `danger-full-access`，已有 Session 可以从 composer 的 Mode 菜单切换。权限模式已经进入 Session 事件与 projection，ToolRuntime 会按 Session 选择可见工具和执行策略。默认 `ask-on-write` 允许读操作自动执行，写入和命令执行需要确认。

验证：`pnpm typecheck`、`pnpm test` 和 Runtime 工作模式合同测试通过。该修复属于 Phase 7 Web 可用性收敛，同时补齐 Session/Permission contract 的实际入口。

## Phase 1 真实模型增强（2026-08-22）

Phase 1 的 provider-neutral adapter 现在已接入 API CLI 启动路径：通过根目录本地 `.env` 配置 `DEEPSEEK_API_KEY`，`MODEL_PROVIDER=auto` 会选择 DeepSeek；没有 Key 时保留 Echo fallback。默认模型为 `deepseek-v4-flash`，并可在 API/Web 中切换到 `deepseek-v4-pro` 或 `deepseek-v4-flash-vision-exp`。`.env`、`.env.*`（`.env.example` 除外）均被 Git 忽略，API health、事件和 Web 响应只展示不含凭据的 provider/model/configured 信息。fake-fetch API/LLM 测试已证明真实流式路径和 Authorization header 行为，Phase 1A.1–1A.3 的 tool-calling loop 以及 Phase 1A.6 的真实 DeepSeek Coding smoke 均已完成。

## Phase 1 状态校正（2026-08-22）

本次校正不是否定已完成的基础设施 checkpoint，而是把“产品可用”与“基础设施已存在”分开：

- `packages/tools` 已有 9 个内置工具，`ToolRuntime` 已有 schema、workspace、权限、取消、超时、输出预算和审计能力；
- `packages/mcp-client` 已能发现并桥接外部工具；
- 第一批 `packages/contracts`、`packages/llm` 和 `packages/runtime` 已携带工具 schema、解析 `delta.tool_calls` 并执行 model → tool → model 循环；进程重启后的 pending approval/turn continuation 已在 Phase 1A.5 完成；
- 当前 `packages/tools/src/builtin.ts` 的工具池已经是 TypeScript 实现；旧 Python 工具实现已从工作树移除，新 Runtime 只使用 TypeScript 工具；
- 因此当前阶段目标改为 `Phase 1A：Agentic Core + TypeScript Tool Pool`，该目标现已通过工具调用层、Terminal、Plan/Todo、AskUser、权限恢复和真实垂直场景门禁；
- Phase 5 Subagent、Phase 6 A2A 和 Phase 8 高级能力的核心实现必须等待本门禁通过（历史约束，Phase 5 已完成）。

执行计划：[phase-1-agentic-coding-core.zh-CN.md](phase-plans/phase-1-agentic-coding-core.zh-CN.md)。

## Phase 1A 实现进展（2026-08-22）

本次 checkpoint 已完成 Phase 1A.1–1A.3 的第一批实现：

- `packages/contracts` 增加 provider-neutral tool call、tool result、tool schema、step event 和 content message 类型；
- `packages/llm` 请求会发送工具 schema，并解析 OpenAI/DeepSeek-compatible `delta.tool_calls`、参数增量和结束事件；
- `packages/runtime` 已能执行多 step model → tool → model 循环，工具结果会作为下一次模型上下文；
- permission ask 会暂停当前 turn，批准/拒绝后继续同一个 turn；
- 多工具上下文、tool-call replay 基础和 API/Web SSE step 事件订阅已补齐；
- 新增 LLM、Runtime、多 step、权限恢复和历史 tool context 测试。

## Phase 1A.4 P1 工具闭包（2026-08-22）

已完成并接入统一 ToolRuntime：

- `terminal_open/send/read/signal/close/list`：TypeScript 持久 terminal manager，按 Session + workspace 隔离 cwd、环境、进程、输出缓冲、增量读取和进程树终止；
- `delete_file`：workspace 内路径校验，默认移动到 `.agent-trash`，永久删除必须显式 `permanent=true` 并经过写权限审批；
- `git_log` / `git_show`：固定 workspace cwd、ref/path 校验、提交结构化解析和输出预算；
- `ask_user`：`interaction/requested` / `interaction/resolved` 事件、API answer endpoint 和 Agent Loop 暂停/恢复；
- `plan` / `todo_write`：`plan/updated` / `todo/updated` 全量 projection 事件，刷新、SSE 和回放不依赖内存镜像；
- Web 已增加 interaction card 和回答控件，P1 事件进入 SSE 订阅。

验证证据：`packages/tools` 20 项测试、`packages/storage` 7 项测试、`apps/api` 11 项测试覆盖 terminal 生命周期、删除审计、Git 读取、interaction resume 和 projection replay。

当时尚未完成的真实 DeepSeek `read → edit → approve → test` smoke 已在 Phase 1A.6 完成；Phase 1A.5 的 permission preset、模型工具过滤、MCP 统一管线和恢复整合均已完成。

## Phase 1A.5 权限与恢复整合（2026-08-22）

已完成：

- `read-only`、`workspace-write`、`ask-on-write`、`ask-on-execute`、`danger-full-access` 五种 permission preset；
- 模型发现阶段过滤 deny 工具，执行阶段再次进行 policy 校验；内置工具和 MCP 工具继续共享 ToolRuntime、审计、取消和输出预算；
- SQLite/InMemory 事件回放后，pending permission 可在新 `AgentHost` 中恢复，并在所有审批解决后继续原 turn；重复批准/拒绝/取消保持幂等；
- `PermissionProjection` 保留 `turnId`，确保 pending approval 能关联到 interrupted turn；
- 新增 `terminal/session` 事件。重启后最近仍为 `running` 的终端只恢复元数据并标记为 `interrupted`，`terminal_list` 可展示该状态，发送输入不会伪造旧进程；
- `waitForTurn` 等待真实 `turn/ended`，避免取消或重启恢复时因中间 `agent/status` 事件提前返回。

验证证据：`packages/tools` 22 项测试、`packages/runtime` 9 项测试覆盖 preset、模型工具过滤、pending approval restart、terminal interrupted replay、取消和幂等恢复。

## Phase 1A.6 真实 Coding 垂直切片（2026-08-22）

已使用真实 DeepSeek 配置完成隔离 workspace smoke：

- API health 确认 provider 为 `deepseek`、模型为 `deepseek-v4-flash`，只返回脱敏配置状态；
- Agent 先调用 `read_file`，通过 `ask_user` 请求用户确认，再生成 `edit_file`；
- 用户批准 `edit_file` 写权限后，Agent 调用 `run_command` 执行 `node fixture.js`，返回修改后的 stdout 和 exit code 0；
- Agent 调用 `git_diff` 并返回单行 diff 总结；
- 通过事件 JSON replay 检查 `tool/*`、`interaction/*`、`permission/*`、`diff/preview`、`step/*` 和 `turn/ended`，未发现 API key 或 Authorization 内容。

该 smoke 证明真实 provider 已能驱动本项目的 model → tool → approval → tool → summary 闭环；自动化测试仍保持 fake/local model，不依赖网络或真实凭据。

## Phase 1A 退出后的 System Prompt 行为强化（2026-08-22）

本次更新没有扩大工具或协议范围，而是把现有 AgentHost 的短字符串 prompt 重构为可测试的 section builder：

- 明确 Coding Agent 的任务目标和 `理解 → 检索 → 计划 → 修改 → 验证 → 总结` 工作循环；
- 每个 turn 注入真实 workspace、经过 ToolRuntime policy 过滤的可见工具及风险/审批/调度元数据；
- 增加 read-before-edit、保留用户修改、搜索后断言、失败诊断、权限不可绕过和完成前验证规则；
- 把仓库内容、命令输出、工具/MCP 结果视为不可信数据，避免 prompt injection 改写运行规则；
- 对重启审批恢复 turn 增加 recovery section；自定义 `systemPrompt` 只能追加低优先级应用指令，不能覆盖安全基线；
- 明确不宣称当前尚未实现的 Subagent、A2A、LSP、Worktree、Web Search、Skills、上下文压缩和图像/Notebook 能力。

实现与设计说明见 [system-prompt-design.zh-CN.md](system-prompt-design.zh-CN.md)。

验证证据：`packages/runtime` 11 项测试覆盖 workspace/tool-use contract、动态工具过滤、自定义指令和 recovery prompt；全 workspace `pnpm typecheck` 与 `pnpm test` 作为本次 checkpoint 门禁。

## Phase 1A.0 迁移边界收尾（2026-08-22）

新增 [工具迁移矩阵](tool-migration-matrix.zh-CN.md)，明确 DSH/Claude Code 行为参考、P0/P1 工具的 source/risk/execution/approval/workspace contract，以及行为 fixture 和安全回归索引。`packages/tools/src/behavior-fixtures.ts` 提供跨平台的 P0 contract fixture，新增 registry 对齐测试。

## Phase 4 验收证据

### 自动化检查

```text
pnpm typecheck   ✓
pnpm test        ✓
git diff --check ✓
```

Phase 4 新增证据：

- `packages/mcp-client`：5 项测试，覆盖真实 stdio 子进程、Streamable HTTP、配置 secret 脱敏、tools/resources/prompts discovery、namespace/schema bridge、MCP error、ToolRuntime approval/cancel、统一事件和断线重连；
- `apps/api`：9 项测试，覆盖 MCP server 配置、列表、disable/delete、`/v1/tools` 来源字段、真实模型适配注入、模型切换和既有 Session/工具回归；
- `apps/web`：MCP server 状态侧栏、Reconnect/Enable/Disable 操作、MCP tool 来源卡片和 `mcp/*` 事件回放；
- 连接失败只影响对应 server，MCP provider 可以全部关闭，内置工具和既有 Session 保持可用。

### Phase 4 退出条件对照

- 至少一个 MCP server 可配置、发现、调用、取消和重连：真实 stdio/HTTP fixture 与 ToolRuntime 测试通过；
- MCP 工具与内置工具共享统一审计和事件：`tool/*`、`permission/*`、`mcp/*` 事件及 API/Web 回放通过；
- 外部工具不能绕过权限、超时、取消和输出预算：MCP approval/error/cancel 测试通过，默认未知 MCP 风险为 `network` 并由本地 policy 拒绝；
- 关闭所有 MCP provider 不影响现有功能：无 MCP 配置的 API/runtime 全量回归通过。

## Phase 2 验收证据

### 自动化检查

```text
pnpm typecheck   ✓
pnpm test        ✓
```

Phase 2 新增证据：

- `packages/storage`：SQLite schema migration、事务追加、projection 重建、跨 reopen 持久化、进程重启 interrupted 标记、命令幂等、并发 sequence 和 fixture replay；
- `packages/runtime`：单 Session queue、重复 send/cancel/resume/fork command、queued turn 恢复和取消；
- `apps/api`：SQLite 默认持久化、`after_sequence`/`Last-Event-ID` SSE、resume/fork、Idempotency-Key、API 进程重启历史恢复；
- 进程级 smoke：关闭并重启 API 后保留 Session、两条消息和完整 event sequence。

### Phase 2 退出条件对照

- 进程重启后 Session 历史完整：通过 SQLite API restart smoke；
- 任意 sequence 断线后可以补发且不重复渲染：SSE historical replay、buffered live events 和 sequence 去重测试/实现；
- 重复 command 不产生重复副作用：storage/runtime/API idempotency tests；
- 中途取消、模型错误和客户端断开都有可解释事件：cancel/turn-ended、agent/error 事件和 SSE close handling；
- SQLite schema migration 和并发追加：SQLite migration 初始化及 concurrent append test；
- 从事件 fixture 重建的 projection 与 API 返回一致：`replayProjection` test 及启动 projection rebuild。

## Phase 1 验收证据

### 自动化检查

```text
pnpm typecheck   ✓
pnpm test        ✓
```

当前 workspace 测试覆盖：

- `packages/contracts`：branded ID；
- `packages/llm`：Echo stream、OpenAI-compatible SSE parser；
- `packages/storage`：monotonic sequence、projection、session isolation；
- `packages/workspace`：workspace path traversal；
- `packages/runtime`：streaming turn、event persistence、cancel；
- `apps/api`：health、Session、message、web shell、SSE replay。

### 人工/运行时 smoke

- Node API：`GET /health` 返回 TypeScript runtime；
- HTTP：创建 Session → 发送消息 → projection 出现 `Echo: ...`；
- SSE：历史事件按 sequence 回放，并在空闲连接发送 `: connected` heartbeat；
- Browser：页面显示 Session sidebar、composer 和 Connected 状态；发送消息后显示 user message、turn event 和 assistant response。

## Phase 1 的明确边界（历史记录）

已完成：

- TypeScript/Node.js monorepo；
- provider-neutral model interface 和 OpenAI-compatible streaming adapter；
- in-memory EventStore；
- AgentHost、Session、Turn、cancel；
- Node HTTP API、SSE 和最小 DSH 风格 Web Shell。

尚未实现且属于后续阶段：

- SQLite durable EventStore 和进程重启恢复（已在 Phase 2 完成）；
- 文件/终端工具、permission approval 和 diff；
- MCP、Subagent、A2A；
- 完整 DSH UI 组件闭包。
