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
| Phase 8：高级能力与产品化 | pending | 等前置阶段完成 |

## Phase 8 计划范围（accepted）

- [Phase 8：高级能力、DSH Web 对齐与产品化](phase-plans/phase-8-productization.zh-CN.md) 已扩展为 8.0 Web 对齐、8.1 Context Compaction、8.2 Worktree、8.3 LSP/Code Mode、8.4 后台任务与可靠性、8.5 产品化；
- [ADR：Phase 8 Web 与 DSH 前端行为对齐](adr/phase-8-web-dsh-alignment.zh-CN.md) 已接受，记录行为参考、REST/SSE 边界、typed Web 拆分、契约变更和回滚规则；
- Phase 8 仍为 `pending`。进入 8.0.0 编码前已复核 Phase 7 browser/replay gate、工作树和前端 parity matrix。

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
- 不新增 Event/Task/Permission contract，也没有把 deferred 的 Goal 编辑、暂停/恢复、Plan review 命令伪装成可用；这些能力进入下一切片，需先增加 host-backed idempotent command 和 CAS/replay contract；
- 定向 presenter 测试 9 项、Web 全量测试 92 项、`pnpm typecheck`、`pnpm build:web`、`pnpm test:phase7:browser` 和 `git diff --check` 通过；browser gate 五场景、1,250 条 trajectory replay 继续通过；
- 当前状态仍为 `pending`，该 checkpoint 只关闭 8.0.3 的 projection/presentation 基线，不代表 Phase 8 或 8.0 Web parity 完成。

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
