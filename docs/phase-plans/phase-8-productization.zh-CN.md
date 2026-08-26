# Phase 8：高级能力、DSH Web 对齐与产品化

状态：`in_progress`（8.0/8.1/8.2/8.4 已完成；8.3/8.5 partial，2026-08-25）。Phase 7 已完成并保留独立 checkpoint；Phase 8 后续工作继续按 8.3/8.5 的部署环境 smoke 边界推进。

## 1. 阶段目标

Phase 8 在稳定的 Agent、Event、Tool、Task、Permission、Workspace contract 之上，推进两条相互依赖的产品线：

1. **DSH Web 对齐**：吸收 DSH 的 Web 信息架构、状态投影、Composer、Goal/Plan/Todo、Trajectory、Settings 和浏览器验收行为，形成可维护的 TypeScript Web 工作台。
2. **高级 Coding Agent 能力**：补齐上下文压缩、Worktree、LSP/Code Mode、后台任务可靠性和产品化基础设施。

Phase 8 的第一优先级是 Web 对齐，因为 Goal/Plan/Todo、Trajectory Inspector、Settings 和可靠性诊断需要先有稳定的 Web 组件边界与 presenter contract。

## 2. 核心架构决策

### 2.1 采用 DSH 的行为与信息架构

- 三栏 AppFrame：Sidebar、Conversation、Details；
- Workspace/Session Browser、父子 Session 树、搜索、排序和生命周期操作；
- Conversation snapshot、Tool render intent、Permission/Question card、Queue dock；
- GoalBar、Plan/Todo、Job、Subagent、MCP、Deliverables 和 Settings 面板；
- Trajectory ledger、timeline、search、fold、older page、tail-follow 和 inspector；
- loading、empty、error、reconnecting、expired、recovered 和 blocked 的显式状态；
- 组件测试、浏览器 e2e、恢复测试和视觉基线。

### 2.2 保留本项目的运行时边界

- Web 只消费 `packages/contracts`、API projection 和 SSE；
- EventStore 是唯一事实来源，浏览器状态只保存可丢弃的选择、折叠和布局状态；
- 继续使用 REST + SSE、generation guard、sequence replay 和 idempotency；
- 不引入 DSH Cordis、完整插件 graph、账户、桌面端、CLI、遥测或发布系统；
- 不直接复制 DSH 组件或内部类型；行为参考登记在 `docs/source-reuse-register.md`；
- 缺少后端事实的字段显示 `unknown`、`unavailable` 或 `deferred`，不由 UI 猜测成功状态。

### 2.3 契约变更规则

Phase 8.0 默认只增加 Web projection/query DTO。若必须新增 Event、Task、Permission 或 Workspace 字段，必须同时更新：

- `packages/contracts`；
- `docs/event-contract.md` 或 `docs/tool-contract.md`；
- Storage projection/replay；
- API/SSE contract test；
- browser fixture 和恢复测试；
- 对应 ADR 或阶段日志。

## 3. DSH 源码对照矩阵

| DSH 能力 | DSH 参考入口 | 当前项目入口 | 当前差距 | Phase 8 目标 |
|---|---|---|---|---|
| Boot/失败边界 | `packages/client/web/src/AppRoot.tsx`、`boot.tsx`、`app-shell.ts` | `apps/web/src/shell/boot.ts`、`apps/web/index.html` | 有 boot reducer 和 fallback，缺少 entry graph 与可观测 boot report | typed boot boundary、失败详情、feature registry |
| Shell/Layout | `packages/client/ui-layout/src/client/AppFrame.tsx` | `apps/web/src/shell/layout.ts`、`app-frame.ts` | 三栏和响应式已有，缺少拖拽 resize、concession 和完整 slot mount | 组件化 AppFrame、resize、details identity、rail/drawer 动画 |
| Sidebar | `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` | `apps/web/index.html` | rail、折叠、Workspace tree 已有，缺少 DSH 的滚动条、tooltip 和过渡策略 | SidebarRoot typed surface、滚动和可访问性一致 |
| Workspace Browser | `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx`、`tree.ts`、`rows/Rows.tsx` | `navigation-presenter.ts`、Workspace API | 树、搜索、生命周期和 reorder 已有；flat/group、排序菜单、拖拽排序不完整 | Workspace/Flat、排序、拖拽、row action 和 picker 统一 |
| Conversation | `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx`、`ConversationSession.tsx`、`InputBar.tsx` | `projection/conversation.ts`、`index.html` | typed node 和 Markdown 已有；branch、context meter、message action、Todo surface 不完整 | Conversation/Composer 分层和稳定 input state machine |
| Tool/ Diff | `packages/client/ui-tool`、`core/tools/presentation.ts` | `tool-presenter.ts`、`tool-call-tree.ts` | generic、source/risk、递归 tree、redaction 已有；专用 tool view 和 path action 较薄 | 专用 presenter、path action、bounded diff 和 generic fallback |
| Permission/Question | `ui-conversation/skeleton/ApprovalPanel.tsx`、`ui-user-questions/QuestionComposer.tsx`、`PlanReviewPanel.tsx` | `request-presenter.ts`、interaction card | approve/deny/cancel、expiry、recovery 已有；批次 question、plan review 不完整 | batch question、plan review、receipt、CAS 和恢复 |
| Queue/Steer/Attachment | `ui-conversation` queue/input tests、`steering.e2e.ts` | `queue-presenter.ts`、`api.ts`、`index.html` | queue、reorder、steer、attachment 已有 host path；视觉和状态机仍分散 | 统一 composer input machine 和 queue dock |
| Goal | `packages/client/ui-goal/src/client/GoalBar.tsx` | contracts/storage projection、generic event row | 没有 GoalBar 的 pause/resume/edit/clear | GoalBar + CAS error + composer dock |
| Plan/Todo | `ui-conversation/src/client/skeleton/TodoPanel.tsx`、`ui-user-questions/PlanReviewPanel.tsx` | plan/todo projection、静态 Plan 按钮 | 缺少独立面板、审批和编辑流程 | Plan mode、TodoPanel、PlanReviewPanel |
| Jobs/Terminal | `packages/client/ui-jobs/src/client/JobListAction.tsx` | `job-presenter.ts`、details diagnostics | output、exit、orphaned、interrupted 已有；action surface 不完整 | job list、cancel/retry/open、terminal details |
| Subagent | `packages/client/ui-subagent`、`host/apiproxy/src/api/subagents.ts` | `task-presenter.ts`、Subagent API | parent/child、report/artifact、cancel、scoped replay 已有 | child action、continuation、history navigation 视觉统一 |
| MCP | DSH MCP roster/panels | `mcp-presenter.ts`、MCP API | status、scope、generation、catalog、retry 已有 | server/tool/resource/prompt tabs 和 trust marker |
| Deliverables | `packages/client/ui-deliverables/src/client/ProducedFiles.tsx` | `deliverables-presenter.ts`、artifact API | workspace/external/blocked、preview/open/download 已有 | produced file mentions、preview、action reason 和 empty/loading |
| Trajectory | `ui-trajectory/TrajectoryView.tsx`、`TrajectoryTable.tsx`、`TrajectoryTimeline.tsx`、`TrajectoryToolbar.tsx` | `trajectory-presenter.ts`、`projection/trajectory.ts` | ledger、timeline、paging、fold、tail-follow 已有；Inspector 栏目和 usage metadata 较少 | Usage、Options、Request、Diff、Raw/Input/Output/Schema inspector |
| Settings/Models | `ui-settings-general`、`ui-settings-models`、`ui-settings-plugins` | `settings-presenter.ts`、settings modal | host-backed summary 已有；多 section、provider onboarding、failure/retry 不完整 | General/Models/Permission/Capabilities/MCP/Plugins sections |
| Visual/e2e | DSH `apps/web/tests/*.e2e.ts`、`packages/client/*/tests` | Phase 7 gate、Web/Vitest | 核心 replay 和恢复已有；视觉 snapshot、Goal/Plan/Question 矩阵不足 | Phase 8 Web parity gate 和视觉基线 |

## 4. Phase 8.0：DSH Web 对齐工作流

### 8.0.0 Parity contract、设计 token 与基线

交付物：

- DSH → 本项目功能矩阵冻结；
- `apps/web/src` 的 Shell、Sidebar、Conversation、Composer、Details、Panels 边界；
- spacing、color、typography、state、focus 和 density token；
- 600×800、900×800、1024×800 当前页面截图基线；
- Web parity ADR 和 source-reuse 记录。

依赖：Phase 7 完成、工作树干净、`pnpm typecheck` 和 `pnpm test` 通过。

验收：矩阵中的每项标记为 complete、partial 或 deferred；没有隐含的 DSH 全量复制承诺。

回滚：只提交文档、token 和测试 fixture，不改变生产运行时。

### 8.0.1 Shell、Sidebar 与组件化

交付物：

- typed AppFrame mount/apply contract；
- Sidebar rail/drawer、details open/close、resize handle 和 concession；
- Session 切换时关闭 details，保持主 Session identity；
- boot/loading/error/retry banner；
- 旧 `index.html` fallback 保持可用。

参考：DSH `ui-layout/AppFrame.tsx`、`ui-sidebar/SidebarRoot.tsx`、`web/AppRoot.tsx`。

验收：600/900/1024 viewport 无横向溢出；拖拽、折叠、Escape、Tab 和 focus restore 均通过浏览器测试。

### 8.0.2 Workspace/Session Browser

交付物：

- Workspace/Flat 视图切换；
- manual/updated 排序菜单；
- Workspace 拖拽排序和现有 host-backed reorder；
- row 状态点、更新时间、permission mode、context menu；
- picker、rename、archive、restore、delete 视觉统一。

参考：DSH `ui-workspace/WorkspaceBrowser.tsx`、`tree.ts`、`rows/Rows.tsx`。

验收：active/archived/deleted、搜索、父子 Session、刷新回放和重复 command 一致；导航不保存第二套事实。

### 8.0.3 Conversation/Composer、Goal、Plan、Todo、Question

交付物：

- Conversation node renderer 和 composer state machine；
- GoalBar：active/paused/blocked、edit/pause/resume/clear、CAS error；
- TodoPanel：queued/running/completed、折叠和 bounded detail；
- Plan mode 和 PlanReviewPanel；
- QuestionComposer：多问题批次、选项、freeform、cancel、expiry、恢复；
- queue dock、steer、attachment、permission preset、model/reasoning selector 统一到 composer。

参考：DSH `ui-goal/GoalBar.tsx`、`ui-conversation/skeleton/InputBar.tsx`、`TodoPanel.tsx`、`ui-user-questions/QuestionComposer.tsx`、`PlanReviewPanel.tsx`。

契约要求：问题批次、Goal CAS 或 reasoning metadata 若缺少后端字段，先补 contract 和 replay fixture，再实现 UI。

验收：Read-only、Edit、Question、Plan review 四个真实浏览器场景通过；刷新、重连、API 重启不重复提交回答或计划。

### 8.0.4 Tool、Diff、Terminal、Job、MCP、Deliverables

交付物：

- read/edit/grep/glob/bash/patch/diff/terminal/MCP/subagent 专用 presenter；
- generic JSON fallback、source/risk/permission、recursive call tree；
- job list、cancel/retry/open output、orphaned/interrupted diagnostics；
- MCP server/tool/resource/prompt tabs、scope、generation、trust marker；
- Produced Files preview、mentions、open/download、disabled reason。

参考：DSH `ui-tool`、`ui-jobs/JobListAction.tsx`、`ui-deliverables/ProducedFiles.tsx` 及 MCP panels。

验收：Edit、Test/Recovery、Delegation、Deliverables 场景通过；路径越界、symlink、未授权工具和敏感输出安全测试通过。

### 8.0.5 Trajectory parity

交付物：

- `TrajectoryTable` 风格的 turn/assistant/tool/request ledger；
- search index、kind filter、running-only、fold、selection、older page、tail-follow；
- actual/recorded duration 和 timeline range；
- Inspector sections：Overview、Options、Usage、Timing、Diff、Request、Tool catalog、Rendered、Raw、Source、Input、Output、Schema；
- token/usage/TTFT/provider/model 字段缺失时显示 `unknown`。

参考：DSH `ui-trajectory/TrajectoryView.tsx`、`TrajectoryTable.tsx`、`TrajectoryTimeline.tsx`、`TrajectoryToolbar.tsx`。

验收：1,250+ records、prepend replay、running duration、redaction、unknown fields、Conversation selection 联动通过。

### 8.0.6 Settings、响应式与可访问性

交付物：

- General、Models、Permission、Capabilities、MCP、Plugins 分区；
- provider/model loading、failure、retry 和 selection receipt；
- settings dialog、menu、toast、focus trap、aria-live 统一；
- mobile drawer、rail、details、composer 的主题和品牌 token。

参考：DSH `ui-settings-general`、`ui-settings-models`、`ui-settings-plugins`、`ui-primitives`。

验收：keyboard smoke、focus restore、axe-like aria 检查、600/900/1024 视觉基线和错误/空态/加载态通过。

当前执行证据（2026-08-24）：

- `docs/phase8-browser-evidence.json` 记录真实 Codex In-app Browser 的 600/900/1024 视口结果：无横向溢出、移动侧栏抽屉、Details 开关、Settings `aria-modal`/标题关联、Escape、focus restore 和可访问名称检查；
- `scripts/phase8-browser-evidence-gate.mjs` 与 `pnpm test:phase8:browser:evidence` 对证据结构、六个视觉基线、Shell markers 和 fixture 来源做可重复审计；
- `scripts/phase8-settings-gate.mjs` 现在同时覆盖 provider failure → Retry → model selection → durable current model，标准 fixture 为选择器提供可回放的 `fixture-model`；
- 真实浏览器已验证 Settings failure → `Retry model catalog` → `ready` → `Selected fixture-model`，不把错误态误报为连接失败。

8.0.6 状态：`completed`（2026-08-25）。

### 8.0.7 Web parity gate

将 DSH 行为场景转为本项目自己的 fixture，不复制 DSH 测试代码：

- GoalBar；
- Plan review；
- Question composer；
- Queue/steer/attachment；
- Workspace navigation/lifecycle；
- Tool/permission/diff/job；
- Trajectory virtualization/inspection；
- Produced files；
- Subagent interrupt/history；
- Settings/model failure；
- reconnect/replay/API restart。

门禁命令：

```powershell
pnpm typecheck
pnpm test
pnpm build:web
pnpm test:phase7:browser
pnpm test:phase8:web
pnpm test:phase8:settings
pnpm test:phase8:visual
pnpm test:phase8:parity
pnpm test:phase8:browser:evidence
git diff --check
```

退出条件：所有已承诺能力有 unit、contract、recovery、security 和 browser 证据；未实现能力不会显示为可用。

8.0.7 状态：`completed`（2026-08-25）。真实 Codex In-app Browser evidence 已覆盖计划列出的 9 组行为场景；`docs/phase8-browser-evidence.json` 和 `scripts/phase8-browser-evidence-gate.mjs` 对场景、fixture 参数、视口、ARIA/focus、Settings recovery 和六个视觉基线做可重复审计。8.0 关闭后，Phase 8 继续保留 8.3/8.5 的目标部署环境 smoke 作为 partial 边界。

## 5. Phase 8.1：Context Compaction

交付物：

- token budget、tool result budget、microcompact、collapse、autocompact；
- Session Memory Compact：复用已有会话摘要，按摘要边界保留近期消息，保持 tool pair/streaming response 完整，并在边界不可恢复时安全回退；
- LLM Summary Compact：在 Session Memory 不可用时使用无工具摘要模型，清理摘要输入并对 prompt-too-long 执行有界 API-round 重试；
- `tool_use/tool_result`、thinking、Task 和 Permission 状态的不可破坏边界；
- 压缩前后的 durable summary、source sequence 和恢复 cursor；
- Web Context meter、compaction status 和恢复诊断。

参考：DSH `packages/compaction`；Claude Code `src/services/contextCollapse`、`src/utils/context*`。

验收：长上下文、工具结果超预算、pending approval、running Task、压缩失败和重启恢复均可回放。

### 5.1 当前执行切片：M08 Compact Boundary 与 Post-Compact Rebuild

交付物：

- ContextBoundaryMetadata、compact/micro marker、preserved segment head/anchor/tail 和 context/compact_boundary durable event；
- boundary → summary → preserved → attachments 的固定 model-view 顺序；
- 最近文件最多 5 个、单附件/总附件/skill token cap、ID 去重和 bounded truncation；
- host-owned postCompactAttachmentProvider，以及默认 active/draft/approved plan 恢复；
- SQLite/InMemory projection replay：重启或新 turn 依据 preserved head 重建最近历史并重新注入缺失附件；
- context/post_compact_rebuild_failed 的 fail-soft receipt。

参考：Claude Code src/utils/messages.ts:4967-5093、src/services/compact/compact.ts:336-389,541-669,1467-1650；本项目 packages/context/src/{boundary,attachments,post-compact}.ts、packages/runtime/src/index.ts、packages/storage/src/index.ts。

契约与安全边界：

- EventStore transcript 永远保存完整原文，boundary 只保存 bounded metadata；附件原文、完整工具结果、provider body、凭据和 secret 不进入事件；
- preserved head 无法在 transcript 中定位时不猜测边界，继续兼容完整历史；
- attachment provider 失败不撤销已成功的 compact boundary；重复附件按 ID 去重；
- M08 不包含 reactive overflow recovery、provider prompt-cache edit、完整 Session Restore、Session Memory extraction 或 Project Memory。

验收命令：

    pnpm typecheck
    pnpm --filter @code-review-agent/context test -- --run
    pnpm --filter @code-review-agent/storage test -- --run
    pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts
    git diff --check

### 5.2 当前执行切片：M10 Transcript、Boundary Replay 与 Session Restore

状态：`completed`（2026-08-26）。

交付物：

- `context/transcript_segment` durable link：保存 boundaryId、algorithmVersion、sourceSequence 和 preserved head/anchor/tail；
- `context/session_restored` restore receipt，以及 `SessionProjection.contextTranscript/contextRestore` replay projection；
- `restoreModelViewFromTranscript()` 纯函数：从完整 EventStore transcript 重建 boundary → summary → preserved suffix；
- Runtime `conversationMessages()`、queued turn restore 和 resumed turn 使用 durable eventId，避免把 Runtime-only turnId/responseId 当作跨重启锚点；
- SQLite/InMemory close/reopen、Host restart、SSE replay 和 stale/mismatch anchor 的安全回退验证；
- M08 旧 boundary（无 algorithmVersion）兼容读取，无法证明边界时回退完整 transcript。

参考：Claude Code `src/services/sessionTranscript/`、`src/utils/sessionRestore.ts`、`src/utils/messages.ts:5043-5090`；本项目 `packages/context/src/transcript-replay.ts`、`packages/runtime/src/index.ts`、`packages/storage/src/index.ts`、`packages/contracts/src/index.ts`。

契约与安全边界：

- EventStore transcript 永远保存完整 user/assistant/tool 原文，M10 metadata 和 receipt 不复制消息正文；
- segment 缺 boundary、boundary/segment linkage 不一致、head 缺失或 head 不在 transcript 中时，必须完整回退，不猜测 sequence；
- replay builder 不修改 transcript，不重复追加 boundary 或 transcript segment；
- M10 不包含 JSONL 文件轮转、context-collapse、Session Memory extraction、Project Memory、hooks 或 provider cache edit。

验收命令：

    pnpm typecheck
    pnpm --filter @code-review-agent/context test -- --run
    pnpm --filter @code-review-agent/storage test -- --run
    pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts
    pnpm test
    git diff --check

### 5.3 当前执行切片：M11 Session Memory Extraction

状态：`completed`（2026-08-26）。

交付物：

- `packages/context/src/session-memory.ts`：Claude Code 式初始化 token、token growth、tool-call/natural-break gate；session-scoped state migration；per-session serial scheduler；AbortSignal；exact-path memory write guard；
- `SessionMemoryExtractor` host adapter：只接收不可变 transcript、当前 memory、source cursor 和 restricted capabilities，不继承父 Agent 工具、workspace write 或 execute 能力；
- `SessionMemoryStore.save()`/`memoryPath()`：memory 正文由 host-owned store 持久化，EventStore 只保存 bounded extraction metadata；
- `context/session_memory_extraction_started/completed/failed/cancelled` 事件和 `SessionProjection.contextSessionMemory`；InMemory/SQLite 共用 replay reducer；
- Runtime 在成功 turn 后异步调度 extraction，主 turn 不等待；失败/取消不改变主 turn 结果；Host restart 恢复 running/queued extraction，并对已保存 source cursor 做幂等完成；
- Context/Runtime/Storage 测试、M11 实施说明、开发日志、ADR-023 和 CC-012。

参考：Claude Code `D:/Develop/claude-code/src/services/SessionMemory/sessionMemoryUtils.ts:16-210`、`sessionMemory.ts:135-181,273-357`；本项目 `packages/context/src/session-memory.ts`、`packages/runtime/src/index.ts`、`packages/storage/src/index.ts`、`packages/contracts/src/index.ts`。

契约与安全边界：

- token threshold 始终必需；tool threshold 不能单独触发 extraction；
- memory extraction 与主 Agent 隔离，不能调用父工具、写 workspace 或执行命令；
- memory 正文不进入 EventStore、SSE、projection 或 Web；事件只记录 cursor、长度、统计、状态和 bounded error；
- extractor 失败不使主 turn 失败；`save` 成功但 receipt 丢失时重启不重复写入；
- M11 不包含 Project Memory/memdir、JSONL transcript rotation、hooks、provider cache edit 或 Web context inspector。

验收命令：

    pnpm typecheck
    pnpm --filter @code-review-agent/context test -- --run
    pnpm --filter @code-review-agent/storage test -- --run
    pnpm --filter @code-review-agent/runtime test -- --run
    pnpm test
    git diff --check

### 5.4 当前执行切片：M12 Project Memory / memdir

状态：`completed`（2026-08-26）。

交付物：

- `packages/context/src/project-memory.ts`：bounded `MEMORY.md`（200 行/25,000 UTF-8 bytes）、safe index parser、user/feedback/project/reference taxonomy、topic relevance、去重和 path/symbol/flag stale validation；
- `ProjectMemoryStore` host adapter：按 active workspace、tenant ownership 和 host-derived scope key 提供入口、topic headers 和按需 topic 内容；
- `AgentHost` canonical context 接入：每个 turn 加载 bounded prompt，按当前 query 召回最多 5 个 topic，以 untrusted `memory` attachment 注入；用户明确忽略或 adapter 失败时 fail closed；
- `context/project_memory_loaded/recalled/stale/disabled` 事件与 `SessionProjection.contextProjectMemory`；InMemory/SQLite 共用 replay reducer，事件不保存 memory 正文；
- Context/Runtime/Storage 测试、M12 实施说明、开发日志、ADR-024 和 CC-013。

参考：Claude Code `D:/Develop/claude-code/src/memdir/memdir.ts:34-315,419-470`、`findRelevantMemories.ts`、`memoryTypes.ts`、`memoryScan.ts`；本项目 `packages/context/src/project-memory.ts`、`packages/runtime/src/index.ts`、`packages/storage/src/index.ts`、`packages/contracts/src/index.ts`。

契约与安全边界：

- memory 是历史、不可信上下文，不能覆盖 system prompt、权限、workspace、工具或当前代码事实；
- topic path 拒绝绝对路径、反斜杠和 `..` traversal；stale reference 不进入 model view；
- scope key 不从 memory 内容读取；workspace/tenant memory 不能互相泄露；
- 事件和 projection 只保留 bounded metadata、topic id、状态和时间，不保存入口/topic 正文；
- M12 不包含自动 memory writer agent、JSONL memory rotation、hooks、Context diagnostics 或 Web inspector。

验收命令：

    pnpm typecheck
    pnpm --filter @code-review-agent/context test -- --run
    pnpm --filter @code-review-agent/storage test -- --run
    pnpm --filter @code-review-agent/runtime test -- --run
    pnpm test
    git diff --check

## 6. Phase 8.2：Workspace/Worktree

交付物：

- branch/worktree create、attach、switch、cleanup；
- Workspace 与 Session/Task 绑定；
- 并发修改、冲突、dirty tree、回收和失败清理；
- Web Worktree picker、状态、冲突和安全提示。

参考：DSH `packages/workspace`；Claude Code `EnterWorktree` 工具。

验收：路径边界、权限、并发冲突、进程崩溃、重启恢复和回收幂等通过。

## 7. Phase 8.3：LSP/Code Mode

交付物：

- 受控 LSP server lifecycle、诊断、符号和跳转；
- Code Mode sandbox、命令 allowlist、资源/网络预算；
- Web LSP diagnostics、source location、跳转失败和 server restart 状态。

参考：DSH `packages/lsp`、`packages/guard`；Claude Code `builtin-tools/src/tools/LSP*`、`REPL*`。

验收：LSP 超时、server 崩溃、恶意 executable、路径穿越、网络越权和取消恢复通过。

### 8.3.1 当前执行切片：OS/container isolation 与 deployment evidence

该切片补齐 Code Mode 现有 process-policy 与完整 8.3 退出条件之间的安全边界。DSH 对照采用 `packages/guard` 的 host-owned guard boundary 和 `packages/lsp` 的受控 server lifecycle；本项目不复制 DSH 代码，只把“能力可用性必须由 host 明确声明、缺失时 fail closed”的行为落到 Code Mode adapter contract。

交付物：

- `CodeModeIsolationAdapter` 明确区分 OS/container boundary 与 Node permission/process policy；`os-required` 没有可用 adapter 时拒绝执行；
- Linux `unshare --user --map-root-user --net --pid --fork --mount-proc` adapter 和 Docker `--network none` ephemeral worker adapter 均保留可审计的 kind、reason、evidence 与 launch flags；
- Code Mode progress、result 和 Settings capability 只报告 host 提供的真实 isolation metadata，不将普通 child process 或 Node permission flags 误报为 OS isolation；
- Docker Compose 默认部署增加 non-root、read-only、no-new-privileges、capability drop 和 bounded workspace/tmpfs；
- `scripts/phase8-deployment-audit.mjs` 固定 source/deployment evidence；`pnpm test:phase8:deployment` 与现有 `pnpm test:phase8:lsp:exit` 共同作为退出审计输入。

契约与安全边界：

- 不新增 Event、Tool、Task、Permission 或 Workspace event；adapter 只影响 Code Mode process launch boundary，模型可见状态仍通过既有 tool result/progress/event pipeline；
- adapter availability 不能仅由配置字符串推断，Linux/Docker 能力探测失败时必须 `CODE_MODE_OS_ISOLATION_UNAVAILABLE`；
- Docker audit 证明部署策略，不代表当前开发机拥有 Docker daemon；宿主能力不可用时继续显示 `unavailable`/`partial`，不伪造完整 8.3 完成；
- 回滚时移除 adapter 注入和 Compose hardening 即可，默认 `process-policy` 与 `os-required` fail-closed 行为保持不变。

验收命令：

```powershell
pnpm typecheck
pnpm --filter @code-review-agent/tools test
pnpm test:phase8:deployment
pnpm test:phase8:lsp:exit
git diff --check
```

## 8. Phase 8.4：后台任务与可靠性

交付物：

- background jobs、retry、model fallback、deadline、graceful shutdown；
- session fork/replay/export；
- structured diagnostics、metrics、tracing；
- Web Job center、恢复提示和导出状态。

参考：DSH `packages/terminal`、`packages/workflow`、`packages/guard`；Claude Code `src/services`。

验收：重试、取消、幂等、进程重启、断线、deadline、fork/export 和敏感信息审计通过。

### 8.4.1 当前执行切片：长任务与并发 Web recovery matrix

该切片补齐已有 Job Center recovery slice 与完整 8.4 退出条件之间的 browser evidence gap。DSH 对照采用 `packages/client/connection/src/client/connection.ts` 的 generation/reconnect 语义、`packages/client/runtime/src/client/sessions/session.ts` 的 history-baseline + live-frame stitching，以及 `packages/client/ui-jobs/src/client/JobListAction.tsx` 的 job action/replay 边界。本项目继续使用 REST + SSE 和本地 typed Web bundle，不复制 DSH 代码或内部类型。

交付物：

- recovery fixture 增加真实并发长任务场景，使用现有 AgentHost/JobManager/SQLite/API 路径启动三个 live jobs，并保留每个 job 的 durable ID；
- matrix gate 同时验证 Job Center shell/browser surface、多个 job 的交错 started/output、取消一个 job 与其余 job 正常完成；
- 首次 SSE 连接中断后，以实际 tail sequence 重新连接，验证只接收后续 `job/ended` 事件、没有重复 sequence，并通过公开 `/jobs` 与 EventStore replay 校验最终状态；
- 既有 seed → reopen → reopen-again、orphaned/completed、export/diagnostics 和 tail cursor 断言继续作为同一矩阵的基础场景。

契约与安全边界：

- 不新增事件类型、API endpoint 或 Web 事实来源；fixture 只消费现有 Job/SSE/Session projection contract，gate 失败不能被解释为运行时成功；
- job output 仍受现有 bounded event/spill/redaction 规则约束，断线恢复只允许按 sequence 重放，不重新执行 job；
- 回滚时移除 live matrix fixture/gate 扩展即可，既有 Job recovery gate 和运行时持久化保持不变。

验收命令：

```powershell
pnpm test:phase8:job-recovery:matrix
git diff --check
```

### 8.4.2 当前执行切片：graphical browser recovery evidence

该切片继续补齐 8.4 的 browser evidence gap，重点验证图形 Web Shell 实际消费恢复后的 Job projection。DSH 对照继续采用 `packages/client/connection/src/client/connection.ts` 的 generation/reconnect、`packages/client/runtime/src/client/sessions/session.ts` 的 history-baseline + live-frame stitching，以及 `packages/client/ui-jobs/src/client/JobListAction.tsx` 的 action/replay 边界；本项目使用 in-app browser 检查真实本地页面，不复制 DSH 代码或内部类型。

交付物：

- live recovery fixture 的任务条数和单步延迟通过受范围约束的环境参数控制：`PHASE8_JOB_RECOVERY_LIVE_ITEMS`（1–200）和 `PHASE8_JOB_RECOVERY_LIVE_DELAY_MS`（0–5000）；默认值保持现有 matrix 行为；
- 图形浏览器从真实 `/` Shell 加载同一 SQLite/API/AgentHost fixture，确认三个并发 Job 显示为 running，并在展开 Job 详情后显示 `Cancel job` action；
- 通过页面 action 取消一个 Job，确认 Web projection 显示一个 cancelled、两个仍 running；刷新页面后连接恢复，取消状态仍由事件回放保留；
- HTTP/SSE matrix 继续作为自动化基础 gate，图形浏览器结果作为真实 UI recovery evidence，不新增 Web 事实来源。

契约与安全边界：

- 不新增 Event、Tool、Task、Permission 或 HTTP contract；只增强 fixture 的可重复时序参数，并验证现有 Job action 与 connection generation 边界；
- fixture 参数只接受有限整数，避免把未校验字符串拼入 child command；生产 Host 不读取这些测试参数；
- 回滚时移除 bounded live timing 参数和 graphical evidence 记录即可，现有 `phase8-job-recovery:matrix` 与 Job Center action gate 保持不变。

验收：

```powershell
node --check scripts/phase8-job-recovery-fixture-server.mjs
pnpm test:phase8:job-recovery:matrix
git diff --check
```

图形证据场景：`liveItems=200`、`liveDelayMs=1000`；页面显示 `Running jobs = 3`，展开任一 running Job 执行 `Cancel job` 后显示 `cancelled = 1`、`Running jobs = 2`，刷新后仍保持该 projection 且页面状态为 `Connected`。

### 8.4 退出审计（2026-08-24）

8.4 的退出条件已闭合。自动化 gate 覆盖 retry、cancel、deadline、fallback、graceful shutdown、API/SQLite restart、SSE replay、tail cursor、fork/export、diagnostics、metrics、幂等和敏感信息审计；真实图形浏览器矩阵补充 600/900/1024 viewport、三个并发长任务、交错 output、Job Center action surface、取消后的 projection 和 reload replay。DSH 的 generation/reconnect、history-baseline + live-frame stitching 与 Job action/replay 边界均有本项目 fixture 证据映射。

验收命令：

```powershell
pnpm test
pnpm test:phase8:jobs
pnpm test:phase8:reliability
pnpm test:phase8:job-recovery:matrix
git diff --check
```

8.4 完成后，Phase 8 的剩余工作集中在 8.0 的完整 visual/accessibility matrix、8.3 的 OS-level isolation/deployment evidence，以及 8.5 的外部 IdP/JWT、principal catalog、secret manager 和 upgrade/deployment policy。

## 9. Phase 8.5：产品化

交付物：

- remote auth、multi-user、tenant、quota；
- provider/model routing；
- secrets/credentials 管理；
- deployment、backup、migration、upgrade policy；
- 必要时再增加 desktop wrapper。

验收：认证、租户隔离、quota、凭据脱敏、备份恢复、migration rollback 和部署 smoke 通过。

### 9.1 当前执行切片：tenant-scoped provider/model routing

该切片属于 Phase 8.5，目标是把现有 host-local model selector 收敛为可恢复的 tenant-scoped route。DSH 参考 `packages/client/ui-model-selection`、`packages/client/runtime` 的 `modelSelection` 和 `packages/sdk/client` 的 provider/model handshake；本项目只采用其行为和职责分层，不复制 DSH runtime 或内部类型。

交付物：

- `packages/contracts` 提供 `ModelRouteRecord` / `ModelRouteBackend`，route 只保存 provider/model/baseUrl 和 opaque credential reference；
- SQLite schema v5 持久化 tenant route，旧数据库可迁移，重启时在 selector 缺失时 fail closed；
- Runtime 按 Session ownership 选择模型，turn started/recovery event 写入选中的 route metadata；不同 tenant 的 Session 不共享模型实例或 route；
- API `/v1/models` 支持 tenant-scoped catalog、selection receipt 和 durable update；未认证本地保持 host-local 行为，跨租户 route 不可见；
- Web typed client 保留 route projection，Settings 继续消费现有 provider/model loading、failure、retry 和 selection receipt；
- productization gate 覆盖 tenant selection、cross-tenant denial、turn event metadata、SQLite reopen 和 credential redaction。

契约与安全边界：

- 不新增独立 model route event type；ModelRouteBackend 是配置事实来源，实际使用的 route 必须进入所属 Session 的 `turn/started` 或恢复 `agent/status` 事件；
- route mutation 先 durable upsert，再更新 Runtime 内存选择；没有 durable backend 或 selector 时 fail closed；
- credential reference 生命周期已由后续 9.2 切片补齐；外部 IdP/JWT、完整 principal catalog 和 upgrade/deployment policy 保持后续工作，backup/restore 与 migration rollback 由 9.3 继续收口；
- 回滚时删除 tenant routing backend/selector 配置即可回到 host-local `/v1/models`，schema v5 保留向后兼容迁移，不删除既有 Session/EventStore 历史。

验收命令：

```powershell
pnpm typecheck
pnpm --filter @code-review-agent/runtime test
pnpm --filter @code-review-agent/storage test
pnpm --filter @code-review-agent/api test
pnpm test:phase8:productization
git diff --check
```

### 9.2 当前执行切片：tenant-scoped credential reference lifecycle

该切片继续属于 Phase 8.5，补齐 provider/model route 与 MCP config 已经依赖的 credential reference 生命周期。DSH 没有被复制为凭据实现；行为参考采用 `packages/client/ui-model-selection` 的 Host-owned selection、选择失败保留可解释状态，以及 `packages/sdk/client` 的 provider handshake/retry 生命周期。本项目的 secret material 仍由 API host-owned resolver 管理。

交付物：

- `packages/contracts` 提供 `CredentialRecord` / `CredentialBackend`，`McpCredentialReference.version` 用于轮换后的 stale reference 检测；记录只保存 tenant、kind、状态、版本和时间，不保存 secret material；
- SQLite schema v6 增加 tenant-scoped `credentials` metadata table，旧数据库可迁移、reopen 和跨租户查询隔离；InMemory fixture 与 SQLite 共享同一 metadata contract；
- API 提供认证 tenant-scoped 的 `GET/POST /v1/credentials`、`POST /:id/rotate`、`POST /:id/revoke`、`DELETE /:id`；响应只返回 metadata，删除仍被 route/MCP 引用阻止；
- host-owned `CredentialVault` 只在进程内保存 material，创建、轮换、吊销、删除、引用校验和 resolver 均 fail closed；轮换递增 version，旧 reference 不再解析；
- model route 在轮换时重绑到新 reference，吊销时清除 tenant model route 并回退 host-local；MCP live connection 在轮换/吊销前停止，轮换后用新 reference reconnect，缺少 resolver、租户不匹配、吊销或 stale reference 显示 `needs_auth`；
- Web typed client 增加 credential catalog/mutation 和带 credential reference 的 model selection 方法；productization gate 覆盖 create、redaction、in-use deletion、rotation、revoke、route invalidation 和 cross-tenant scope。

契约与安全边界：

- Credential metadata 属于 control-plane 配置事实，不新增 Session event type；任何 model-visible route 仍只通过所属 Session 的 `turn/started` 或恢复 `agent/status` 事件记录实际 route metadata；
- secret material 不进入 EventStore、SQLite metadata、route、MCP config、SSE、diagnostics、Web projection 或错误消息；`SecretProvider` 已区分 host-only 与 external adapter，provider 缺失或取 secret 失败时必须 fail closed；具体 KMS/Vault/Secrets Manager deployment 仍需 host 注入和现场 smoke；
- credential ID 以 `(tenantId, id)` 为边界，cross-tenant list/get/resolve/mutate 统一隐藏或失败；删除前检查 model route 与 MCP config 引用，吊销优先于删除；
- 回滚时停用 credential API/resolver 和 tenant route/MCP wiring，保留 schema v6 metadata 与既有 Session/EventStore 历史；未配置 credential backend 时 mutation 返回配置错误，不退化为不受控的 host-wide secret storage。backup/restore 与 migration rollback 已由 9.3 提供第一切片，完整 upgrade/deployment policy 仍保持后续工作。

验收命令：

```powershell
pnpm typecheck
pnpm --filter @code-review-agent/storage test
pnpm --filter @code-review-agent/mcp-client test
pnpm --filter @code-review-agent/api test
pnpm --filter @code-review-agent/web test -- --run src/client/api.test.ts
pnpm test:phase8:productization
git diff --check
```

### 9.3 当前执行切片：SQLite backup/restore 与 migration rollback

该切片补齐 Phase 8.5 运维范围中可以由当前 TypeScript/SQLite Host 独立证明的部分。DSH 只作为 Host-owned deployment/configuration 边界参考，采用 `docs/config-catalog.zh.md` 的 deployment-axis 约束和 `packages/host/webserver/README.md` 的默认安全绑定语义；本项目没有复制 DSH 代码。upgrade/deployment policy 仍需后续真实部署环境证据。

交付物：

- `packages/storage` 暴露 SQLite schema inspection、consistent backup、restore、legacy migration 和 rollback operation；backup 使用 SQLite 快照，不读取或保存 host-owned secret material；
- restore 先复制到临时库，再运行现有 schema migration、projection rebuild 和 integrity check；覆盖已有目标时保留 rollback database，失败时不替换原目标；
- `AgentHost.productizationSettings().operations` 和 API capability 显示 backup/migration 已 available，upgrade 继续 deferred；
- `scripts/phase8-operations-gate.mjs` 覆盖 schema v7 backup、v5 → v7 restore migration、upgrade policy、overwrite rollback、event preservation、integrity check 和 credential redaction；
- 该切片不提供面向普通用户的公开 restore endpoint；运维操作由受控部署命令/Host owner 执行，避免远程请求直接替换事件库。

契约与安全边界：

- backup/restore 不新增 Session event type，不改变 EventStore 的事实来源；恢复后的事件和 projection 继续由现有 SQLite/EventStore 回放产生；
- destination 已存在时必须显式 `overwrite`，旧库保留为 rollback artifact；源库 schema 高于当前支持版本、integrity check 失败、路径为 `:memory:`/URI 或快照缺少 migration ledger 时 fail closed；
- secret material 不进入 backup metadata、SQLite credential table、公开 capability 或 gate 输出；upgrade 仍为 `deferred`，不能将 schema migration rollback 误称为完整 deployment upgrade policy；
- 回滚时保留被替换目标和 rollback 后的 displaced artifact，失败恢复不删除原始数据。

验收命令：

```powershell
pnpm test:phase8:operations
pnpm test:phase8:productization
pnpm typecheck
git diff --check
```

### 9.4 当前执行切片：外部 IdP/JWT 与 durable principal catalog

该切片补齐现有静态 bearer fixture 与完整 remote auth 边界之间的缺口。DSH 对照采用 `packages/client/connection/src/client/connection.ts` 的连接身份边界和 `packages/guard` 的 host-owned policy boundary；本项目不复制 DSH 代码，只实现独立 JWT verifier、JWKS refresh hook 和 principal catalog。

交付物：

- `packages/contracts` 提供 `PrincipalRecord` / `PrincipalBackend`，记录 subject、tenant、roles、status 和时间；secret/token 不进入 catalog；
- SQLite schema v7 持久化 principal catalog，支持 v5/v6 旧库迁移、reopen、按 tenant 查询和 subject lookup；InMemory 与 SQLite 共享 contract；
- API 支持 `HS256`/`RS256` JWT，验证签名、`kid`、issuer、audience、`exp`、`nbf` 和 tenant claim；JWKS refresh 由 host 提供，便于 key rotation 且不隐含网络权限；
- verified subject 必须在 active principal catalog 中存在，并映射到唯一 tenant/principal ownership；disabled、unknown、tenant mismatch 和缺少 catalog 均 fail closed；
- `GET /v1/principals` 与 tenant-scoped detail 只返回 principal metadata；静态 bearer 保留为受控 local/test adapter，JWT capability 明确显示 `auth.mode=jwt`、`principalCatalog=external`；
- auth、catalog、key rotation、API 401、跨租户过滤和 SQLite recovery 有独立 unit/API/storage evidence。

契约与安全边界：

- JWT/principal 是 control-plane identity contract，不新增 Session event type；Session ownership 仍由既有 `session/created` 事件和 EventStore 回放承载；
- JWT claims 不能绕过 principal catalog、tenant ownership、quota、workspace、permission 或 diagnostics boundary；认证失败统一 401，跨租户 catalog 只返回同 tenant 数据；
- JWKS provider 是显式 host capability，未配置或刷新失败时不会降级为未验签 token；算法仅允许 `HS256`/`RS256`，不接受 `none`；
- 回滚时停用 JWT adapter/API catalog，保留 schema v7 principal metadata 和既有静态 bearer fixture；旧 schema migration 不删除 Session/EventStore 历史。

验收命令：

```powershell
pnpm typecheck
pnpm --filter @code-review-agent/storage test
pnpm --filter @code-review-agent/api test -- --run src/auth.test.ts src/jwt-server.test.ts
pnpm test:phase8:operations
git diff --check
```

### 9.5 当前执行切片：external secret manager adapter 与 upgrade/deployment policy

该切片补齐 credential lifecycle 与真实生产运维之间的边界。DSH 只作为 host-owned configuration/deployment boundary 行为参考，采用 `docs/config-catalog.zh.md` 和 `packages/host/webserver/README.md` 的安全绑定语义；本项目不复制 DSH 代码，也不把一个内存 fake 声称为云端 secret manager。

交付物：

- `apps/api/src/credentials.ts` 提供 `SecretProvider`、host-only provider 和 external provider adapter；CredentialVault 的 metadata、route、MCP config、event、SSE、diagnostics 永不保存 secret material；
- external provider 负责按 `(tenant, credential, version)` 保存、读取、轮换删除 material；credential revoke/remove 会删除对应版本，provider failure 返回明确错误并 fail closed；
- `docs/phase8-deployment-policy.json` 固定 schema supported range、upgrade-before-backup、migration lock、health/integrity/SSE readiness、retained rollback 和 runtime hardening；
- `packages/storage` 提供 `assessSqliteUpgrade` / `SQLITE_UPGRADE_POLICY`，`phase8-operations-gate` 将 policy 与 v5 → v7 restore/rollback 联合验证；
- `scripts/phase8-upgrade-policy-gate.mjs` 与 `pnpm test:phase8:upgrade-policy` 审计 Docker non-root/read-only/no-new-privileges/cap-drop、bounded workspace 和 upgrade capability deferred 状态；
- 公开 `productization.operations.upgrade` 在真实 deployment smoke 前继续 `deferred`，避免把 schema migration/rollback 误报为已完成的 rolling upgrade。

契约与安全边界：

- SecretProvider 和 upgrade policy 属于 host/deployment contract，不新增 Session event type；EventStore 仍是 Session/Turn/Task 状态唯一事实来源；
- external adapter 的网络、租户授权、版本和审计由 host 提供；未配置 provider、stale version、读取失败或 rotation failure 不回退到 host-wide secret storage；
- upgrade 必须先备份并持有 migration lock，完成 health、SQLite integrity 和 SSE replay readiness 后才可标记部署 ready；失败保留 displaced rollback artifact；
- 回滚时停用 external provider wiring 或 upgrade command，保留 metadata schema、principal/session history 和原始数据库文件。

验收命令：

```powershell
pnpm typecheck
pnpm --filter @code-review-agent/api test -- --run src/credentials.test.ts
pnpm test:phase8:operations
pnpm test:phase8:upgrade-policy
pnpm test:phase8:productization
git diff --check
```

## 10. 阶段依赖与执行顺序

```text
8.0.0 parity contract
  ↓
8.0.1 shell/components
  ↓
8.0.2 workspace browser ─────┐
  ↓                          │
8.0.3 composer/goal/plan ────┤
  ↓                          ├→ 8.0.7 Web parity gate
8.0.4 tool/details ──────────┤
  ↓                          │
8.0.5 trajectory ────────────┤
  ↓                          │
8.0.6 settings/a11y ─────────┘

8.1 compaction → 8.2 worktree → 8.3 LSP/Code Mode
                                      ↓
                               8.4 reliability
                                      ↓
                               8.5 productization
```

8.0.x 可以在 8.1–8.3 的调研阶段并行，但不能让 Web UI 伪造尚未完成的后端能力。

## 11. 每个 checkpoint 的固定要求

每个 8.x checkpoint 必须：

1. 说明属于哪个 Phase 和工作流；
2. 说明是否改变 Event/Tool/Task/Permission/Workspace contract；
3. 登记 DSH/Claude Code 行为参考和许可证边界；
4. 提供 unit、contract、recovery、security、browser 验收；
5. 运行匹配范围的 typecheck/test/build；
6. 创建独立 Git checkpoint，提交信息包含 `Phase 8`、范围和验证结果；
7. 提供 feature flag、禁用行为和回滚方式。

## 12. 阶段进入条件

- Phase 7 退出条件全部满足；
- `pnpm typecheck`、`pnpm test`、`pnpm test:phase7:browser` 通过；
- 工作树干净；
- Phase 8.0 parity ADR 已创建，进入 8.0.0 编码前必须接受；
- 当前 DSH 对照矩阵、source-reuse 登记和本计划一致；
- 前端新增能力有对应的 fixture 和禁用态设计。

## 13. 阶段退出条件

- 8.0 Web parity gate 通过，且未承诺能力没有伪成功状态；
- 选择进入的 8.1–8.5 工作流均完成对应验收或明确延期；
- 长会话、断线、重启、并发、取消和权限安全不变量保持成立；
- Event/Tool/Task/Permission/Workspace contract、ADR、阶段状态、开发日志和 source-reuse 已同步；
- 每个工作流均有独立 checkpoint、feature flag 和回滚验证；
- 下一阶段或产品发布入口有明确命令与运行结果证明。

## 14. 明确不包含

- 复制 DSH Cordis/plugin runtime 或内部类型；
- DSH 账户、桌面端、CLI、遥测、商业 provider 和发布系统；
- 没有用户场景的完整 workflow/plugin 平台；
- 没有安全评估的任意代码执行或网络访问；
- 为了视觉相似而绕过 EventStore、Permission、Workspace 或审计边界；
- 通过前端文本伪造 goal、plan、usage、artifact、LSP、worktree 或 compaction 状态。

## 15. 回滚策略

- 8.0 Web 组件通过 typed bridge 和 capability flags 启用；失败时回退 Phase 7 Shell/generic presenter；
- 8.1–8.4 每项能力独立 feature flag、migration 和禁用态；
- 8.5 认证、租户和 quota 以独立配置开关部署；
- 数据迁移保持向后兼容，失败时可回到上一 schema checkpoint；
- 每个 checkpoint 使用独立 Git commit，不跨工作流混合提交。

## 16. 阶段决策七问

| 问题 | Phase 8 统一回答 |
|---|---|
| 属于哪个 Phase | Phase 8；8.0 为 DSH Web 对齐，8.1–8.5 为高级能力与产品化 |
| 解决什么问题 | UI 组件边界、Coding Agent 可观测性、长会话可靠性、Worktree/LSP 和生产部署能力 |
| 是否改变公共 contract | 默认只增加 projection/query DTO；事实 contract 变化必须同步事件、回放和安全测试 |
| 参考哪些入口 | DSH `packages/client/*`、`packages/compaction`、`packages/workspace`、`packages/lsp`、`packages/terminal`；Claude Code 只参考行为与边界 |
| 是否登记来源 | 行为参考登记文档；直接改编 DSH 文件前确认 MIT notice 并登记具体来源；无明确许可证的快照只做行为参考 |
| 验收场景 | Web parity、Read-only、Edit、Test/Recovery、Delegation、Inspection、长上下文、Worktree、LSP、后台任务和产品化安全场景 |
| 如何回滚或禁用 | 每个工作流独立 checkpoint、feature flag、migration 和 fallback；Web 保留 Phase 7 Shell/generic fallback |
