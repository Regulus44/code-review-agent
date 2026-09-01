# Phase 7：DSH Web 前端与 Agent 能力调研

## 研究结论

本轮调研的目标是吸收 DeepSeek Harness（DSH）的 Web 工作台、前端消费的 Agent/Session/Tool/Permission/Subagent 接口，以及可见运行轨迹的组织方式。结论如下：

1. 本项目不应把 DSH 的 Web 包或 Cordis runtime 作为依赖。应复用信息架构、状态投影、交互顺序和可观测性设计，并用本项目的 `packages/contracts`、EventStore、API 和 SSE 实现。
2. DSH Web 的关键价值不在三栏视觉本身，而在“持久 Session 事实 → 客户端 snapshot → 可组合 slot → 具体视图”的分层。UI 不维护 Agent 事实，也不把一条 SSE 消息直接当作最终显示模型。
3. 当前 `apps/web/index.html` 已经具备垂直切片，但仍是单文件 DOM renderer。Phase 7 应先建立 typed client store、connection/replay 层和 Conversation/Tool/Trajectory projection，再拆分组件，避免把单文件拆成多个仍然互相修改 DOM 的模块。
4. DSH 的 Trajectory 是独立的投影目标，不是简单的事件列表。它把 request、assistant、tool、subtool、compaction、turn 和错误关联成可搜索、可折叠、可按时间分析的记录，并提供详情检查器。这应成为 Phase 7 的主线能力。
5. 工具展示应采用“host 计算的 render intent + 通用 fallback + 专用 presenter”的策略。UI 不应读取 ToolRegistry 内部对象，也不应为每种工具重新猜测状态。
6. 当前项目的内部 Subagent 已足够支撑 Coding Agent 的 Multi-Agent 体验。A2A 不属于本轮 Web 收敛的前置能力；如未来需要跨进程、跨产品或跨组织 Agent 互操作，再把外部 A2A adapter 映射到已有 Task/Session/Subagent。

## 研究范围与证据等级

研究对象为本地 DSH 快照 `D:/Develop/deepseek-harness-fork`，当前调研记录的 commit 为 `b1d511b`。DSH 根仓库声明 MIT。Claude Code 只作为行为参考；本地快照未发现可供本项目直接复制的根许可证，因此本项目只采用行为和边界参考。

证据等级：

| 等级 | 含义 | 本轮结果 |
|---|---|---|
| R0 | 直接阅读源码、类型和测试 | 已覆盖 Web boot、连接、Session API、事件、Conversation、Tool、Subagent、Trajectory 及主要辅助面板 |
| R1 | 阅读 package README、bundle/roster、契约和 fixture | 已覆盖 Web feature composition、Trajectory 行为说明、session history/replay 约束 |
| R2 | 启动本地 Web 并完成真实浏览器操作 | 当前 Windows 环境未形成可复用的 DSH live page 证据；`pnpm dsh --profile web --help` 在 workspace 供应链检查阶段未给出可用页面，因此本计划不把 R2 结果冒充为源码证据 |

本轮不修改 DSH 仓库，也没有复制 DSH 代码。未来若直接改编 DSH 文件，必须按 [source-reuse-register.md](../../source-reuse-register.md) 增加具体来源和 MIT notice。

## 1. DSH Web 的整体分层

### 1.1 Boot 与失败边界

参考入口：

- `D:/Develop/deepseek-harness-fork/apps/web/src/main.ts`
- `D:/Develop/deepseek-harness-fork/packages/client/web/src/boot.tsx`
- `D:/Develop/deepseek-harness-fork/packages/client/web/src/AppRoot.tsx`
- `D:/Develop/deepseek-harness-fork/packages/client/web/src/app-shell.ts`

DSH 的 `apps/web/src/main.ts` 只查找 `#root` 并启动 `AppWebEntry`。真正的 Web boot 会：

1. 解析 `window.__DSH_BOOT__`，把启动配置分成模块视图和插件视图；
2. 预加载 `immediately` 层插件；
3. 启动 Cordis Loader 和模块系统；
4. 为每个插件创建 fiber，并把 fiber 状态投影到 loading/error 页面；
5. 等所有 entry active 后才切换到真实 `AppRoot`；
6. 任一插件失败时保留可解释的失败页，而不是渲染一个部分可用的假工作台。

可吸收的设计是“boot 状态可见、失败可解释、真实 UI 只有在依赖准备好后出现”。本项目不需要复制 Cordis Loader，但应把 `booting / connected / reconnecting / failed / ready` 做成明确的 Web 状态。

### 1.2 Shell、slot 与可选能力

参考入口：

- `D:/Develop/deepseek-harness-fork/packages/bundle/web-app/cordis.patch.yml`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-layout/src/client/AppFrame.tsx`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-sidebar/src/client/SidebarRoot.tsx`
- `D:/Develop/deepseek-harness-fork/packages/client/web/src/app-shell.ts`

DSH Web roster 把能力拆成可组合的 UI package，主要包括：

- `client-connection`、`client-runtime`、`api-remotes`；
- `ui-layout`、`ui-sidebar`、`ui-workspace`、`ui-settings`；
- `ui-conversation`、`ui-tool`、`ui-input-trigger`、`ui-commands`；
- `ui-subagent`、`ui-plan`、`ui-goal`、`ui-jobs`、`ui-deliverables`；
- `ui-model-selection`、`ui-permission-presets`、`ui-user-questions`；
- `ui-trajectory`。

`AppFrame` 负责三栏几何、sidebar/details 拖动、窄屏折叠和 slot render；Session 切换不由每个视图自行处理。这个边界说明了 Phase 7 的拆分方向：布局状态、Session 状态、Conversation 状态和功能面板状态要各有 owner。

### 1.3 连接层：unary command 与实时 stream 分离

参考入口：

- `D:/Develop/deepseek-harness-fork/packages/client/connection/src/client/api.ts`
- `D:/Develop/deepseek-harness-fork/packages/client/connection/src/client/connection.ts`
- `D:/Develop/deepseek-harness-fork/packages/client/connection/src/client/web-api-client.ts`

DSH 浏览器连接由两部分组成：

```text
HTTP unary API                  WebSocket mux stream + host stream
list/create/prompt/cancel       session/approval/question/host frames
```

`ConnectionController` 维护 generation、连接状态、双流握手、指数退避、stream pump 和 sink 隔离。每次 generation 建立后，先完成 `host.describe` 和 stream open，再触发基线恢复；sink 层抛错不会杀死底层连接。

本项目当前使用 REST + SSE，Phase 7 不需要立即改成 WebSocket，但应吸收以下语义：

- 所有命令走 typed API client；
- 实时流有明确 generation/connection state；
- 首次连接先取 history/baseline，再消费 live frames；
- 重连时按 cursor/sequence replay，不重新执行工具；
- UI sink 错误与 transport 重连相互隔离。

## 2. DSH 前端消费的 Agent/Session 接口

### 2.1 Session API

参考 `D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/sessions.ts`。

| 接口 | 前端用途 | 本项目对应方向 |
|---|---|---|
| `list` | sidebar/session tree 的摘要、运行状态、parent/child、workspace | 已有 `/v1/sessions`，需抽成 typed store |
| `search` | 侧栏搜索和快速打开 | 当前按 DOM 过滤，需后端或 client index 明确边界 |
| `create` | 新建 Session、cwd、preset、model | 已有 Session 创建和 mode，需接入统一 composer |
| `history` | 分页加载历史，尾部携带 projection baseline | 已有事件历史，需补消息边界分页和 snapshot baseline |
| `models` | provider/model/reasoning catalog | 已有 model API/popover，需统一 loading/error/retry |
| `selectModel` | 当前 Session 模型切换 | 已有 API，需进入 Session snapshot 和轨迹 request header |
| `rename` | sidebar 标题编辑 | 部分已有，需补 optimistic/失败回滚 |
| `prompt` | queue/steer、文本/图片、slash command、timezone | 当前 composer 主要发文本，需明确 queue 与 steer |
| `attachment` | 图片/文件附件 | 需按能力 gate 和大小/类型限制接入 |
| `updateQueue` | 查看、删除、重排待发送消息 | 后端已有 queue 事件，Web 尚未形成 queue dock |
| `cancel` | 取消当前 turn/job | 已有部分 cancel，需与状态 reducer 和 trajectory settlement 对齐 |
| `fork` | 从历史建立新 Session | 后续可作为 Phase 7.9 或 Phase 8，不应伪造前端成功 |

DSH 的 history 有三个关键约束：按消息边界分页；tail page 携带 partial assistant 和 projection baseline；projection 使用 `asOfSeq`，客户端采用 higher-seq-wins。历史读取不会激活 Agent。

### 2.2 Event/Mux/Host frames

参考 `D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/events.ts`。

Session/mux 侧可见帧包括：

- `session/event`、`session/subscribed`；
- `approval/requested/resolved`；
- `question/requested/resolved`；
- `session/queue`、`session/jobs`；
- `session/projection`；
- `stream/error`。

Host 侧可见帧包括：

- session added/removed/status；
- agent-error；
- workspace changed/removed/order；
- archived sessions changed；
- allowlisted remote events。

可吸收的状态原则：

1. `queue` 和 `jobs` 使用完整快照，避免客户端在丢帧后出现半棵状态树；
2. projection frame 带 projection key 和 seq；
3. history tail 是 baseline，live frame 是增量；
4. approval/question 是 server request，需要 response receipt；普通 session event 只负责推送；
5. 所有 reducer 都按 sequence/generation 做幂等。

### 2.3 Subagent、Goal、Job、Workspace 和辅助控制面

| 能力 | DSH 参考入口 | 对 Web 的意义 | 本项目状态 |
|---|---|---|---|
| Subagent | `packages/host/apiproxy/src/api/subagents.ts`、`packages/client/ui-subagent` | parent/child catalog、child history、continuable prompt、interrupt、parent availability | Phase 5 后端和基础 Web catalog 已有，需完整 child tree/history surface |
| Goal | `packages/host/apiproxy/src/api/goals.ts`、`packages/client/ui-goal` | 目标条、revision CAS、pause/resume/complete/clear | 后端 projection 已有，缺少稳定 GoalBar |
| Job | `packages/host/apiproxy/src/api/jobs.ts`、`packages/client/ui-jobs` | session header 中显示后台工作和状态 | 后端 job event 已有，Web 仅部分展示 |
| Workspace | `packages/host/apiproxy/src/api/workspace.ts`、`packages/client/ui-workspace` | workspace picker、创建/重命名/排序/归档 | 已有树和 picker，需生命周期闭环 |
| Agent preset | `packages/host/apiproxy/src/api/agent-presets.ts` | system/user trust、默认 preset、坏 preset 提示 | 当前 permission mode 已有，preset UI 需拆出 |
| LLM/model | `packages/host/apiproxy/src/api/llm.ts`、`packages/client/ui-model-selection` | provider/model/reasoning effort、失败提示 | 有 model popover，需补 provider failures 和回放 |
| Question | `packages/host/apiproxy/src/api/questions.ts`、`packages/client/ui-user-questions` | 一次回答一个问题批次，支持 plan review | 当前 `ask_user` 有基础卡片，需支持批次和取消 |
| Approval | `packages/host/apiproxy/src/api/approvals.ts`、`packages/client/ui-permission-presets` | allowed-once/rejected、preset 和高风险确认 | 已有 permission card，需区分一次批准与 preset |
| Deliverable | `packages/client/ui-deliverables` | produced files、show in folder、bounded artifact | 有 diff/result，缺少产物索引 |

## 3. Conversation 与运行轨迹模型

### 3.1 Conversation snapshot

参考入口：

- `D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/sessions/conversation.ts`
- `D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/contract/conversation.ts`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-conversation/src/client/conversation-nodes`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-conversation/src/client/chat`

DSH Conversation node 不是简单的 `event[]`，而是有稳定 identity 和业务语义的 projection。节点种类包括：

- user、assistant、reasoning、image；
- tool-call、tool-result、command；
- steering、context、compaction；
- model-retry、turn-error、turn-max-tokens、unknown。

`ConversationSnapshot` 还携带 pending interactions、queue、running、subagent address、composer phase（blank/engaging/active）、openState、hasMore、loadingOlder、promptError、lastAgentError。

`ui-conversation` 用 Definition 注册器把 Session event 映射成 node，再由 Chat snapshot builder 维护 keyed 节点和 tail/older loading。这样可以让新增一个 UI node 不改变事件事实，也能让相同 Session 数据被 Chat、Trajectory 和 Details panel 以不同 projection 消费。

### 3.2 Tool call recursive tree

参考 `D:/Develop/deepseek-harness-fork/packages/client/runtime/src/client/sessions/tool-call-tree.ts`。

工具调用按 `callId/rootCallId/parentCallId` 组装成递归树：

```text
root tool call
  ├─ child sub-call
  └─ child sub-call
```

根调用在 Chat 中占一个业务节点，子调用保持嵌套关系；start 不在当前历史窗口时，settlement 仍可显示为 bounded result。实现必须防循环和深度爆炸，更新只复制祖先链，保持未变化 sibling 的 identity。

### 3.3 Trajectory 独立投影

参考入口：

- `D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/trajectory-contract.ts`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/trajectory-record.ts`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/trajectory-snapshot-builder.ts`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/timeline.ts`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/TrajectoryView.tsx`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/TrajectoryTable.tsx`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-trajectory/src/client/TrajectoryToolbar.tsx`

Trajectory 的 `Contribution` 目标包括 node、assistant、tool、request-header、compaction、session-end、turn-end。它会：

1. 按 request、tool、assistant、compaction 和 turn error 关联事件；
2. 给每条记录分配稳定 identity、sourceSeq、callId、startedAt、duration；
3. 保存 prompt、tool schema、model config、location 等 request-header；
4. 记录 token usage、TTFT、throughput、provider/model；
5. 保留 raw/source/input/output/schema 等检查对象；
6. 用 timeline 的 sequence、duration、recorded time、actual time 进行分析。

Trajectory UI 的三个 lane 是：

- system/context；
- message/compaction；
- tool/subtool。

它支持搜索、折叠 turn、折叠 assistant、虚拟化、加载更早历史、选择、时间区间筛选和详情检查。Details inspector 的栏目包括 Overview、Options、Usage、Timing、Diff、System prompt、Tool catalog、Rendered、Raw、Source、Input、Output、Schema。

对本项目的关键取舍：

- EventStore 仍是唯一事实来源；Trajectory 只是可重建的 projection；
- 第一版只使用本项目已有 `turn/*`、`step/*`、`assistant/*`、`tool/*`、`permission/*`、`interaction/*`、`diff/*`、`task/*`、`mcp/*` 事件；
- 需要 request-header、token usage 或 raw schema 时，先补事件 contract 和脱敏字段，不能由 Web 私自拼造；
- running record 不显示虚构 duration，取消/失败记录冻结在最后一个已知时间点；
- 轨迹查看应与 Chat 视图共享 Session event window，不复制第二套事实 fold。

## 4. Tool Presentation 与交互模式

### 4.1 Host-computed render intent

参考入口：

- `D:/Develop/deepseek-harness-fork/packages/core/tools/src/types.ts`
- `D:/Develop/deepseek-harness-fork/packages/core/tools/src/presentation.ts`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-tool/src/client/tool/ToolCallTree.tsx`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx`
- `D:/Develop/deepseek-harness-fork/packages/client/ui-tool/src/client/tool/toolviews/*`

DSH 的 ToolDefinition 同时定义 schema、canonical output、render/presentation metadata、presentCall、presentResult、timeout、concurrency 和取消上下文。前端接收 host 计算出的 `tool/call` 和 `tool/result` view，而不是访问 ToolRegistry 内部对象。

工具 UI 的共同形态：

- 一行 compact summary；
- 状态点显示 running/error/stopped；
- 默认折叠，点击或键盘展开；
- 展开后显示 bounded detail；
- 文件路径可打开，diff 独立显示；
- 根调用可展开嵌套 sub-call；
- 没有专用 presenter 时始终使用 generic JSON card。

专用视图包括 read、grep/glob、file mutation/diff、bash/terminal、web、todo、plan、ask question。专用视图可以改善摘要和结构化内容，但不能删除 generic fallback。

### 4.2 本项目的 render intent 适配

当前项目事件已经有 `tool/call`、`tool/progress`、`tool/result`、`diff/preview`、`patch/*`、`terminal/session`、`job/*` 和 `mcp/*`。Phase 7 应新增 Web-facing `ToolCallView`/`ToolResultView` projection 或 DTO，字段至少包含：

- tool identity、source（builtin/MCP/subagent）、risk 和 permission state；
- callId/rootCallId/parentCallId、sequence 和 startedAt；
- compact summary、status、duration（仅在有结束时间时）；
- bounded input/modelView/output；
- file paths、diff refs、terminal/job refs；
- error code、cancelled/stopped reason；
- redaction marker 和 truncation marker。

这些字段应来自 EventStore/API projection，不能由 DOM renderer 直接从原始事件猜测权限或 workspace。

## 5. 前端状态与交互模式

### 5.1 Session 切换与恢复

DSH 使用 SessionProvider 和 key remount 重建 session subtree，避免旧 Session 的 queue、pending interaction 或 detail selection 泄漏到新 Session。当前项目应建立 `SessionStore`：

- `currentSessionId`、session summaries、workspace tree；
- per-session history baseline、lastAppliedSeq、connection state；
- per-session Conversation/Trajectory snapshot；
- pending permission/question/queue/job/subagent projection；
- loading/openError/promptError/lastAgentError。

所有 store 更新都必须通过 sequence/generation guard。刷新和断线恢复要得到与首次打开相同的 snapshot。

### 5.2 Composer 与 pending interaction

DSH 的 composer 是一个 slot surface，model、reasoning effort、permission、plan、goal、attachments、input triggers、queue 和 question/approval 都可以占据明确位置。Question/approval 是 server request，不应作为普通 assistant message 伪造。

本项目应先完成：

1. permission request 的一次批准/拒绝/取消和 preset 区分；
2. ask-user 的多问题批次、自由文本、取消和过期；
3. queue 与 steer 的明确 semantics；
4. model/provider/reasoning effort 的加载、选择、失败和重试；
5. plan/goal 状态的 header/composer surface。

### 5.3 可访问性与窄屏

DSH 组件普遍使用 button/menu semantics、键盘 Escape/Arrow、focus restore、portal、aria labels 和 responsive column concession。Phase 7 需要把这些行为写入浏览器验收，不只做视觉截图：

- sidebar/details 可折叠且不丢当前 Session；
- tool row、trajectory row、permission/question card 可键盘打开；
- menu、dialog、toast 具有可读的状态和错误；
- 1024px 以下窄屏自动收起 sidebar，仍可手动展开；
- loading/error/empty/reconnecting 不是空白页面。

## 6. DSH 到本项目的复用/差距矩阵

| DSH 能力 | 参考入口 | 当前项目入口 | 当前状态 | Phase 7 处理 |
|---|---|---|---|---|
| Web boot/status | `client/web`, `AppRoot` | `apps/web/index.html` | 单文件静态入口，无 typed boot store | 7.1 建立 boot/error/ready 状态 |
| Layout | `ui-layout/AppFrame` | CSS 三栏静态 shell | 有布局，缺少独立 layout store/drag contract | 7.1 抽 layout shell，保留本项目品牌 |
| Connection | `client/connection` | REST + SSE | 可用但无统一 generation/reconnect client | 7.2 建 connection client 和 baseline/replay |
| Session list | `api/sessions`, `ui-sidebar` | `/v1/sessions`, DOM state | 有 workspace/session tree | 7.3 typed SessionStore、搜索、归档和错误 |
| History/baseline | `sessions.history` | `/events?format=json` | 全事件回放，消息边界和 baseline 较弱 | 7.4 增加 snapshot/replay contract |
| Conversation nodes | `ui-conversation` | `renderEvent` DOM | 初步渲染 user/assistant/tool | 7.4 typed node definitions 和 keyed reducer |
| Composer | `InputBar`, queue | textarea + send | 有文本发送和基础 mode | 7.6 queue/steer/attachment/question/approval |
| Tool row | `ui-tool` | `appendTool`/DOM card | 基础卡片 | 7.5 render intent、递归树、专用 presenter |
| Diff | `toolviews`, diff tool | diff/patch cards | 有 preview/applied | 7.5 bounded diff、path action、rollback state |
| Terminal/job | bash view, `ui-jobs` | terminal/job events | 有事件和部分展示 | 7.5/7.7 session header 与 output viewer |
| Permission | approvals/presets | approval card | 可批准/拒绝/取消 | 7.6 preset/once/risk confirmation/replay |
| AskUser | questions | interaction card | 单问题基础流程 | 7.6 batch question、answer receipt、expiry |
| Model selection | `ui-model-selection` | model popover | 已有 | 7.7 provider/model/reasoning/error |
| Plan/Todo | `ui-plan`/`TodoPanel` | plan/todo events | 后端有 projection | 7.7 composer/header surface |
| Goal | `ui-goal` | goal events/projection | 后端有 | 7.7 GoalBar + CAS error |
| Subagent | `ui-subagent`, `api/subagents` | child list/API | Phase 5 已有 catalog/history/control | 7.7 parent/child tree、child session、report |
| Workspace | `ui-workspace` | workspace picker/tree | 初步可用 | 7.3 lifecycle/create/rename/reorder/archive |
| Deliverables | `ui-deliverables` | diff/result | 结果分散 | 7.9 produced files/artifact list |
| MCP | MCP roster/panels | MCP sidebar/events | 后端与状态已完成 | 7.9 server/tool/resource/prompt status |
| Trajectory | `ui-trajectory` | event timeline | 有粗粒度 timeline，无独立 ledger | 7.8 ledger/timeline/inspector |
| Settings | `ui-settings*` | details panel | 简化 | 7.9 typed settings and capability flags |
| Visual/e2e | DSH web tests/snapshots | browser smoke | 有少量 smoke | 7.10 replay/e2e/visual/perf |

## 7. 建议的目标 Web 结构

Phase 7 完成后的最小结构建议为：

```text
apps/web
  ├─ boot/                  # mount、boot status、error boundary
  ├─ client/                # typed API、SSE connection、generation/replay
  ├─ stores/                # session/workspace/layout/interaction stores
  ├─ projection/            # conversation/tool/trajectory/task projections
  ├─ shell/                 # sidebar | conversation | details | overlays
  ├─ conversation/          # composer、message、reasoning、turn tail
  ├─ tools/                 # ToolRow、ToolCallTree、presenters、generic fallback
  ├─ trajectory/            # ledger、timeline、toolbar、inspector
  └─ panels/                # permission、question、plan、goal、job、MCP、settings
```

此结构可以先以一个构建入口实现，再逐步拆文件；目录拆分本身不是验收目标。每个 projection 都应该声明输入 event types、输出 snapshot、sequence 规则和 loading/error 状态。

## 8. 明确的吸收边界

### 采用 DSH 行为和信息架构

- 三栏工作台、可拖动/可折叠 sidebar/details；
- Session sidebar、Workspace 分组和 parent/child 树；
- Conversation、Tool row、Diff、Permission、Terminal、Plan、Goal、Subagent、Settings 分区；
- typed projection、baseline + live frame、higher-seq-wins；
- tool render intent、递归调用树、generic fallback；
- Trajectory ledger/timeline/inspector；
- loading/empty/error/reconnecting/permission/question 的显式状态。

### 由本项目自行实现

- `packages/contracts` 公共类型和 EventStore 事实模型；
- REST/SSE API client 与 workspace/permission/security policy；
- ToolCallView、TrajectoryProjection、redaction 和 output budget；
- 品牌、图标、颜色、文案和所有数据展示；
- 浏览器 e2e、replay、恢复和安全测试。

### 暂不引入

- 完整 DSH Cordis/plugin runtime；
- DSH 账户、桌面端、CLI、遥测和发布系统；
- A2A 作为 Web 或内部 Subagent 的 transport；
- 没有后端事件支持的“假” LSP、Worktree、压缩、远程 Agent 或 artifact 状态。

## 9. Phase 7 验收场景

1. **Read-only**：打开 workspace 和 Session，加载历史，发送只读请求，看到 assistant、reasoning、工具调用、工具结果和可搜索 trajectory；刷新/断线后状态一致。
2. **Edit**：Agent 读取文件、请求写权限、展示 diff、批准后应用修改、运行测试；permission、diff、terminal、job 和 trajectory 可回放。
3. **Test/Recovery**：长任务输出持续更新，页面滚动到历史后不被新事件拉回；断线、重连、刷新和 API 重启后不重复执行工具，running 状态可解释。
4. **Delegation**：主 Agent 创建 child，Web 显示 parent/child tree、child status、report、child history 和 cancel；child 权限、workspace、MCP scope 不越界。
5. **Inspection**：选中一条 tool/assistant/turn 记录，打开详情检查器，查看 bounded input/output、timing、usage、diff/raw/source；敏感字段被脱敏，未加载历史不伪造 duration。

## 10. 后续实现的决策门

Phase 7 每个切片都要回答根治理文件的七个问题：

| 问题 | Phase 7 统一回答 |
|---|---|
| 属于哪个 Phase | Phase 7；A2A 暂缓不作为 Web 收敛前置 |
| 解决什么问题 | 主要是 UI、Web projection、连接恢复和可观测性；不重定义 Agent Loop |
| 是否改变公共 contract | 优先只增加 Web projection/query DTO；任何 Event/Tool/Task/Permission/Workspace 变化必须同步契约和回放测试 |
| 参考哪些入口 | DSH `packages/client/*`、`host/apiproxy`、`ui-tool`、`ui-trajectory`；Claude Code 只参考流式 turn、工具状态和任务协调行为 |
| 是否登记来源 | 只读/行为参考写入本调研；直接复制或大量改编 DSH 文件时更新 `source-reuse-register.md` 并保留 MIT notice；Claude Code 默认不复制代码 |
| 验收场景 | Read-only、Edit、Test/Recovery、Delegation、Inspection 五个场景 |
| 如何回滚 | 每个切片独立 checkpoint；保留现有静态 shell fallback，capability panel 可由 feature flag 关闭 |
