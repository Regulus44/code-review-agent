# Phase 7：DSH Web 前端收敛与可观测工作台

状态：`in_progress`（7.2 连接与回放基础、7.4 typed Conversation renderer、7.5 Tool projection 基础、7.7 Task/Subagent details 切片，以及 7.8 Trajectory ledger 的 query/lane/inspector 切片已完成；7.1 Shell 拆分、7.3 导航收敛、7.6–7.10 继续推进）

## 当前执行 checkpoint：typed Web client 与 Session replay foundation

本 checkpoint 对照 DSH 的 `client/connection`、Session snapshot 和 Conversation assembler，已落地以下基础：

- `apps/web/src/client/api.ts`：统一 JSON/HTTP error、idempotency header、Session/Event/Permission/Interaction/Task/Model/MCP/Subagent 命令与查询；
- `apps/web/src/client/store.ts`：Session baseline、事件 sequence 去重、higher-sequence-wins、projection fold、连接状态和订阅；
- `apps/web/src/client/connection.ts`：generation、history baseline → SSE、after-sequence、backoff、旧连接隔离、断线恢复；
- `apps/web/src/projection/conversation.ts`：user/assistant/reasoning/turn/tool/permission/interaction/task 与 generic event node，assistant chunk 合并和 ToolCallView；permission/interaction projection 保留 caller、workspace、expiresAt、allowFreeform 和终态字段；
- `apps/web/src/projection/tool-call-tree.ts` 与 `apps/web/src/presentation/tool-presenter.ts`：bounded recursive lineage、orphan/cycle/depth guard、builtin/MCP/subagent/diff/terminal/generic presenter、modelView 优先、敏感字段脱敏和 untrusted render intent；
- `apps/web/src/projection/trajectory.ts`：从共享 event window 建立 turn/step/assistant/tool/task/permission/interaction/error ledger，保留 sourceSeq、lastSeq、timing、status 和 running duration 约束；
- `apps/web/src/presentation/safe-value.ts`、`trajectory-presenter.ts`：统一 bounded/redacted/untrusted detail、query/kind/runningOnly/limit、lane grouping 和 Overview/Timing/Source/Rendered detail inspector；
- `apps/web/index.html`：details panel 已消费 typed trajectory presenter，提供搜索、running-only、lane/record 选择和安全 inspector；搜索与选择不建立第二套事实状态；
- `apps/web/src/presentation/task-presenter.ts`、`apps/web/index.html`：details panel 已消费 Session task projection 与 Subagent catalog，展示 task status、mode/provider、parent/child lineage、report/artifact、bounded diagnostics，child session 和 live cancel 使用既有 API；
- `apps/web/src/client/store.ts`：`SessionStoreSnapshot` 同时发布 Conversation、ToolCallTree 和 Trajectory，避免 UI 维护第二套事实窗口；
- `apps/web/src/browser.ts` 与 API `/web/*` 静态资源：typed runtime 作为现有静态 Shell 的可回滚 bridge，主 Session 流已切换到 `SessionConnectionController`；旧 inline EventSource 仅作为 bundle 缺失时的 fallback；
- Web 包已进入 TypeScript project reference，并有 API、Store、Connection、Conversation 定向测试。

验证证据：`pnpm typecheck`、`pnpm --filter @code-review-agent/web test`（28 tests）、`pnpm -F @code-review-agent/web run build:browser` 和 `git diff --check` 通过；真实 API/browser smoke 已验证 Trajectory 搜索、lane、record inspector、敏感字段脱敏、running-only 空态、Task/Subagent 空态、刷新回放和 console 无 warning/error。当前 renderer 已优先消费统一 `SessionStoreSnapshot`，无 bundle 时仍回退旧 event renderer。

## 1. 目标与边界

在 Phase 5 内部 Subagent、Phase 4B MCP、事件持久化、工具运行时和权限 contract 稳定后，把 `apps/web` 收敛为一个可恢复、可检查、接近 DSH 信息架构的 Coding Agent 工作台。重点是吸收 DSH 的前端分层、接口消费方式、工具展示和运行轨迹，不复制 DSH 的 Cordis runtime、品牌或无关产品能力。

本计划采用已接受的 A2A 暂缓决策：Phase 7 以本项目内部 AgentHost/Task/Subagent 为数据源，不把 A2A 作为 Web 或内部 Multi-Agent 的 transport。未来恢复 Phase 6 时，A2A 仍应映射到已有 Task/Session/Permission/Workspace，不反向改变本计划的 UI contract。

### 1.1 交付结果

- typed Web boot、API client、SSE connection、baseline/replay 和 reconnect 状态；
- Workspace/Session 导航、Session snapshot、Conversation node projection；
- Tool render intent、递归 ToolCallTree、专用 presenter、Diff/Terminal/Job 展示；
- Permission、AskUser、queue/steer、attachment 和错误/过期状态；
- Model/provider/reasoning、mode、Plan/Todo、Goal、Job、Subagent、MCP 和 Settings 面板；
- Trajectory ledger、timeline、搜索/折叠/虚拟化和 inspector；
- produced files/deliverables、可访问性、窄屏和品牌收敛；
- browser e2e、事件回放、断线恢复、视觉回归和性能证据。

### 1.2 不包含

- 完整 DSH Cordis/plugin runtime、桌面端、CLI、账户、遥测和发布系统；
- A2A Server/Client、Agent Card 或远程 Agent transport；
- 没有后端事件或 contract 支持的前端假状态；
- 重写 Agent Loop、ToolRuntime、EventStore 或 PermissionPolicy 的核心语义；
- 以 CSS 像素复制 DSH 品牌、图标、文案或产品标识。

## 2. 参考入口与复用规则

### 2.1 DSH 参考入口

| 领域 | 入口 |
|---|---|
| Web boot | `D:/Develop/deepseek-harness-fork/apps/web/src/main.ts`、`packages/client/web/src/boot.tsx`、`AppRoot.tsx` |
| Shell/layout | `packages/client/ui-layout`、`ui-sidebar`、`ui-workspace` |
| Connection | `packages/client/connection/src/client/api.ts`、`connection.ts`、`web-api-client.ts` |
| Runtime snapshot | `packages/client/runtime/src/client/sessions/*`、`contract/conversation.ts` |
| Session/host API | `packages/host/apiproxy/src/api/sessions.ts`、`events.ts`、`subagents.ts`、`goals.ts`、`jobs.ts`、`workspace.ts` |
| Conversation | `packages/client/ui-conversation/src/client/conversation-nodes`、`chat`、`skeleton` |
| Tool | `packages/core/tools/src/presentation.ts`、`packages/client/ui-tool/src/client/tool` |
| Subagent | `packages/client/ui-subagent`、`packages/host/apiproxy/src/api/subagents.ts` |
| Plan/Goal/Job/Model/Question/Permission | `packages/client/ui-plan`、`ui-goal`、`ui-jobs`、`ui-model-selection`、`ui-user-questions`、`ui-permission-presets` |
| Trajectory | `packages/client/ui-trajectory/src/client/*` |

### 2.2 Claude Code 参考入口

只做行为参考，不复制代码：

- `D:/Develop/claude-code/src/query.ts`：流式 turn 和消息边界；
- `D:/Develop/claude-code/src/services/tools/StreamingToolExecutor.ts`：工具流式状态和错误合成；
- `D:/Develop/claude-code/src/tools.ts`、`packages/builtin-tools/src/tools`：工具摘要与用户体验；
- `D:/Develop/claude-code/src/coordinator`：Task/Team/Coordinator 的用户可见状态；
- `D:/Develop/claude-code/packages/remote-control-server`：远程 Session 的连接、取消和所有权边界。

### 2.3 复用与许可证

- 仅阅读或复刻行为：登记在 [phase-7-dsh-web-research.zh-CN.md](../phase-7-dsh-web-research.zh-CN.md)，无需建立代码依赖；
- 直接复制/大量改编 DSH 文件：保留 MIT notice，并在 [source-reuse-register.md](../source-reuse-register.md) 增加来源路径、本项目路径和测试；
- Claude Code 快照没有根许可证证据，默认只参考结构、状态机和行为；
- 不把 DSH/Claude Code 内部类型暴露为 `packages/contracts` 公共 API。

## 3. 公共契约原则

1. EventStore 是唯一事实来源；Web store、Conversation、Tool 和 Trajectory 都是可重建 projection。
2. 历史 baseline 和 live SSE frame 使用统一 sequence；higher-seq-wins，重复事件不重复渲染。
3. approval/question 是 server request，必须有 receipt、过期、取消和恢复语义；不能伪造成普通消息。
4. Tool view 只能消费 host/API 计算的 render intent；generic fallback 永远可用。
5. Trajectory 不创建第二套事实日志；它消费共享 event window，并保留 `sourceSeq`/`callId`/`turnId` 关联。
6. 新增字段优先增加 query/projection DTO；若必须改变 Event/Tool/Task/Permission/Workspace contract，先更新对应文档、fixture、replay 和迁移说明。
7. Web 只能发送本项目 API command，不能直接读写 Agent、ToolRegistry、MCP manager 或 EventStore。

## 4. 分步执行计划

每一步都创建独立 checkpoint。前一步的退出条件满足后，才允许合并下一步的核心实现；调研、fixture 和契约草案可以提前进行。

### Phase 7.0：研究、A2A 边界与契约冻结

**目标**：把 DSH 调研、当前差距和 A2A 暂缓决策固化为可审查文档。

**工作内容**：

- 完成 [DSH Web 调研](../phase-7-dsh-web-research.zh-CN.md)；
- 接受“Phase 7 不依赖 A2A”的 ADR，标明恢复 A2A 的触发条件；
- 确认当前事件可投影范围、敏感字段、redaction、sequence/generation 规则；
- 定义 Web client、Session snapshot、Conversation node、Tool view、Trajectory record 的草案类型；
- 列出 DSH 能力的 adopt/adapt/defer 矩阵。

**契约影响**：文档和 DTO 草案；不得添加未经后端支持的 UI 事件。

**验收**：研究文档引用真实源码入口；ADR、阶段状态、Phase 7 计划互相一致；`git diff --check` 通过。

**回滚**：只回滚文档 checkpoint，不影响运行时。

### Phase 7.1：Web boot 与 TypeScript UI shell

**目标**：把单文件入口拆成可测试的 boot、layout、store 和 shell 边界。

**工作内容**：

- 建立 `apps/web/src/boot`、`client`、`stores`、`shell` 的最小目录；
- 实现 `booting/ready/failed` 状态和错误边界；
- 抽出三栏 AppFrame：sidebar、conversation、details、overlay；
- 保留当前静态 shell 作为 fallback；
- 通过本项目 tokens 完成本项目品牌、颜色、图标、文案；
- 实现窄屏 sidebar rail、details close 和键盘 focus 基础。

**参考**：DSH `ui-layout/AppFrame.tsx`、`ui-sidebar/SidebarRoot.tsx`、`client/web/AppRoot.tsx`。

**契约影响**：仅 UI 内部类型；API/Event contract 不变。

**测试**：shell unit、layout concession、boot failure、Chromium mount、1024px/窄屏 smoke、键盘展开/关闭。

**退出条件**：刷新时不会出现旧 DOM 残留；boot 失败可解释；fallback 可切换；`pnpm typecheck` 通过。

**回滚**：feature flag 使用旧 `apps/web/index.html`，API/Runtime 不受影响。

### Phase 7.2：Connection client、SSE baseline 与重连

**目标**：让前端的历史、实时事件和重连共享同一套连接语义。

**工作内容**：

- 实现 typed `ApiClient`，统一 unary command、HTTP error 和 response schema；
- 实现 `ConnectionController` 或等价 service：generation、connected/reconnecting、backoff、abort；
- 首次打开先拉取 Session snapshot/history，再建立 SSE live stream；
- 支持 `after_sequence`、`Last-Event-ID` 和事件去重；
- 重连只 replay 缺失事件，不重复 prompt/tool execution；
- sink 异常只进入 UI error，不关闭 transport。

**参考**：DSH `client/connection` 的双流握手、generation 和 sink isolation；本项目现有 SSE API。

**契约影响**：若增加 `baselineAsOfSequence`、connection status 或 replay DTO，同步 `packages/contracts` 和 API contract；不改变事件事实。

**测试**：API client schema、断线/重连、sequence gap、重复 frame、服务重启、pending approval/question 恢复、取消期间断线。

**退出条件**：Read-only 场景断线后状态与连续连接相同；工具不会因重连重复执行；浏览器显示明确 Reconnecting/Connected。

**回滚**：关闭新 connection client，保留当前 `EventSource` 路径。

### Phase 7.3：Workspace/Session navigation 与 snapshot store

**目标**：建立 DSH 风格的 Workspace → Session 导航和 session-aware store。

**工作内容**：

- 抽出 Workspace tree、Session summary、archived filter、search；
- 支持 workspace create/rename/reorder/archive/delete 的真实 API 生命周期；
- 建立 `SessionStore`：current id、summaries、baseline、last seq、open/loading/error；
- Session 切换通过 key remount 或等价 identity boundary 清理旧 queue/interaction/detail；
- parent/child Session 在导航树中保持 lineage；
- session open 不激活 Agent，只读取历史和 projection。

**参考**：DSH `ui-workspace`、`ui-sidebar`、`api/sessions.ts`、`api/workspace.ts`。

**契约影响**：优先消费已有 `SessionSummary`/Workspace DTO；若补充 `parentSessionId`、`archived`、`projectionBaseline`，同步 API schema。

**测试**：多 workspace、搜索、归档/恢复、删除后历史保留、切换时旧 SSE 关闭、刷新后选中 Session 恢复、parent/child tree。

**退出条件**：导航不依赖 DOM 临时状态；重启后 tree 和当前 Session 可恢复；权限/queue 不串 Session。

**回滚**：保留现有 Session list renderer，关闭 workspace lifecycle actions。

### Phase 7.4：Conversation snapshot 与 typed node projection

**目标**：从“按事件追加 DOM”升级为可分页、可回放、可复用的 Conversation snapshot。

**工作内容**：

- 定义 user、assistant、reasoning、tool-call/result、command、context、compaction、retry、turn-error、turn-tail node；
- 建立 Definition/Reducer registry，按 event type 生成 keyed node；
- 支持 tail partial assistant、older page、loadingOlder、hasMore、promptError、lastAgentError；
- 实现 assistant Markdown、reasoning 折叠、turn summary、steering/queue 标记；
- conversation 与 details/trajectory 共用 event window，不复制事实 fold；
- 处理未知事件为安全 generic node，保留 source sequence。

**参考**：DSH `ui-conversation` 和 `client/runtime` conversation assembler。

**契约影响**：新增 Web projection 类型；若当前 `assistant/chunk`、`turn/*` 字段不足，先补 contract fixture。

**测试**：node reducer、分页消息边界、partial assistant、未知事件、重复 sequence、compaction/turn error、Markdown 安全、重连 replay。

**退出条件**：刷新、重连、从历史加载得到同一 Conversation snapshot；不再由 renderer 直接维护业务事实。

**回滚**：Conversation tab 可退回现有 event card renderer，保留新 reducer 只读运行。

### Phase 7.5：Tool render intent、ToolRow、Diff、Terminal 与 Job

**目标**：建立统一工具卡片和可展开的嵌套调用树。

**工作内容**：

- 定义 `ToolCallView`/`ToolResultView`，包含 source、risk、permission、call lineage、summary、bounded input/output、timing、redaction；
- 用 `callId/rootCallId/parentCallId` 构造递归 ToolCallTree；
- 实现 generic JSON presenter 和 read/grep/glob/edit/patch/diff/bash/terminal/MCP/subagent 专用 presenter；
- 工具行默认折叠、可键盘展开、显示 running/error/stopped/cancelled；
- Diff 支持 preview/applied/rejected/rolled_back、路径操作和 bounded hunks；
- Terminal/Job 显示 session、cwd、output chunks、exit code、interrupted/recovered 状态；
- 所有工具输出遵循 output budget、redaction 和 untrusted marker。

**参考**：DSH `core/tools/presentation.ts`、`ui-tool`；本项目 `packages/tools`、`packages/mcp-client`、`packages/contracts`。

**契约影响**：增加 Web-facing projection/DTO；不允许 Web 推断风险或审批。需要新字段时补 `tool-contract.md`、事件 schema 和 replay fixture。

**测试**：recursive tree/cycle/depth guard、generic fallback、per-tool presenter、diff state、terminal restart/interrupted、MCP scope、secret redaction、keyboard interaction。

**退出条件**：Read/Edit/Test 场景中每个工具调用都有稳定 summary、结果和 source；没有 presenter 的工具仍可见；工具结果不会因折叠而丢失。

**回滚**：按 tool family feature flag 关闭专用 presenter，保留 generic card。

### Phase 7.6：Permission、AskUser、queue/steer 与附件

**目标**：将所有需要用户回应的 server request 做成可恢复交互。

**工作内容**：

- Permission card 区分 allowed-once、preset、rejected、cancelled、expired；
- 高风险 mode/preset 需要可解释确认和可访问 dialog；
- AskUser 支持一批问题、single/multi select、freeform、plan review、cancel/expiry；
- queue dock 显示 pending messages，支持删除/重排；steer 显示插入点和 receipt；
- attachment 支持文件/图片能力 gate、大小/type error 和 upload receipt；
- pending request 在刷新、断线、API 重启后恢复，不重复提交回答。

**参考**：DSH `api/approvals.ts`、`api/questions.ts`、`ui-user-questions`、`ui-permission-presets`、`ui-conversation/InputBar`。

**契约影响**：必须复用现有 `permission/*`、`interaction/*`、`turn/queued` 和 command idempotency；若扩大 question batch contract，更新 `event-contract.md`。

**测试**：重复 approve/answer、过期、取消、重启恢复、权限绕过、queue ordering、steer 与 attachment rejection、键盘/屏幕阅读器 smoke。

**退出条件**：用户可以从 Web 完成 Edit 场景的批准、回答和继续；所有状态有明确 pending/resolved/failed 展示。

**回滚**：关闭 queue/attachment/preset 高级面板，保留基础 permission/interaction 卡片。

### Phase 7.7：Model、mode、Plan、Goal、Jobs、Subagent 与 MCP surface

**目标**：将已有后端能力纳入 session header、composer 和 details 的可见工作台。

**工作内容**：

- Model/provider/reasoning effort 两级选择菜单、catalog failure/retry、selection receipt；
- Session permission mode selector 和当前 mode badge；
- Plan mode control、Todo panel、GoalBar（revision CAS、pause/resume/edit/complete/clear）；
- Job list action、后台任务状态和 output detail；
- Subagent parent/child tree、child status、provider/mode、report/artifact、child history、prompt/interrupt/cancel；
- MCP server/tool/resource/prompt status、scope、generation、retry 和 disabled reason；
- details panel 根据 capability flags 显示/隐藏功能，不展示未实现能力。

**参考**：DSH `ui-model-selection`、`ui-plan`、`ui-goal`、`ui-jobs`、`ui-subagent`、`ui-deliverables` 和 MCP roster。

**契约影响**：主要消费已有 Phase 4/5 projection；任何新增 goal/job/task/artifact 字段必须保持 CAS、parent authority、scope 和 EventStore 事实边界。

**测试**：model selection failure/retry、mode policy、goal revision conflict、job restart、subagent authority/depth/scope、MCP generation stale frame、child history cold read。

**退出条件**：Delegation 场景可从 parent 创建、观察、进入 child、读取 report、打断并恢复；MCP 和 Subagent 不越权。

**回滚**：每个 capability panel 独立 feature flag；关闭后核心 Conversation/Tool/Permission 仍可用。

### Phase 7.8：Trajectory ledger、timeline 与 inspector

**目标**：把 Agent 运行过程变成可排序、可搜索、可检查和可按时间分析的第一等视图。

**工作内容**：

- 建立 `TrajectoryProjection`，从共享 event window 关联 turn/step/request/assistant/tool/subtool/compaction/error；
- 记录稳定 identity、sourceSeq、turnId、callId、root/parent call、startedAt、endedAt、duration、status；
- 显示 provider/model、prompt header、tool catalog、token usage、TTFT、throughput（字段不存在时显示 unknown，不猜测）；
- ledger 支持 sequence、turn 分隔、assistant/tool collapse、search、load older、虚拟化和 tail-follow/pause-follow；
- timeline 支持 system/context、message/compaction、tool/subtool lanes、actual/recorded time 和 bounded interval selection；
- inspector 支持 Overview、Options、Usage、Timing、Diff、System prompt、Tool catalog、Rendered、Raw、Source、Input、Output、Schema；
- 对 raw/input/output 做 redaction、截断和 trust marker；running record 不显示虚构 duration。

**参考**：DSH `ui-trajectory`、`runtime/request-inspection.ts`、`timeline.ts`、`Trajectory*` components。

**契约影响**：第一版只增加 Web query/projection DTO；request-header/token/raw 字段若缺失，先评估事件 contract 和脱敏风险，再单独提交。

**测试**：record association、nested calls、out-of-window settlement、cancel/error freeze、virtualized prepend、search/fold/tail-follow、timeline selection/zoom、inspector redaction、replay equivalence。

**退出条件**：Inspection 场景能从一次真实 Read/Edit/Test turn 打开完整轨迹；刷新/重连后 identity、顺序和已结束 timing 稳定；trajectory 不影响 Agent 执行。

**回滚**：trajectory 作为独立 tab/feature flag 关闭，Conversation 和 ToolRow 保持可用。

### Phase 7.9：Settings、Deliverables、MCP 详情、可访问性与品牌收敛

**目标**：将功能面板收敛为可交付的产品化 Web surface。

**工作内容**：

- 独立 settings/general/model/permission/capability 页面；
- Produced Files/Artifacts 列表、路径/下载/打开操作和 scope 提示；
- MCP server detail、tool catalog、resource/prompt trust marker；
- 统一 loading/empty/error/reconnect/toast/dialog/menu；
- 完成 keyboard navigation、focus restore、aria、窄屏、主题 token 和本项目品牌；
- 清理单文件 global state、重复 API 调用和未使用的 DSH 风格文案。

**参考**：DSH `ui-settings*`、`ui-deliverables`、`ui-mcp`、`ui-primitives` 的行为，不复制品牌资产。

**契约影响**：原则上只消费既有 projection；artifact/path 展示必须遵守 workspace scope 和脱敏规则。

**测试**：axe/键盘 smoke、窄屏、错误/空态、artifact path traversal、MCP trust/redaction、品牌 token snapshot。

**退出条件**：主要能力均有稳定入口；未实现 capability 不会被 UI 宣称可用；视觉和文案完成本项目化。

**回滚**：保留基础 details panel 和旧静态 MCP/permission cards。

### Phase 7.10：Browser e2e、replay、visual regression 与性能

**目标**：用真实 Coding Agent 场景证明 Web 收敛没有破坏事件、恢复、安全和交互。

**工作内容**：

- 建立 Read-only、Edit、Test/Recovery、Delegation、Inspection fixtures；
- 浏览器验证 workspace/session navigation、composer、tool row、permission、trajectory、subagent 和 MCP；
- 注入断线、重复 SSE、API restart、pending approval/question、长输出和慢模型；
- 从 EventStore fixture 重建 Session/Conversation/Tool/Trajectory，与 API snapshot 比较；
- Chromium 常规/窄屏视觉快照，避免锁定无关像素；
- 测量首次可交互、tail append、1000+ trajectory rows、长工具输出和重连抖动。

**契约影响**：只补测试 fixture 和必要 DTO；任何为了通过 e2e 而修改事件语义必须回到对应 Phase contract。

**退出条件**：五个核心场景全部通过；重连不重复执行工具；没有敏感输出；trajectory 和 conversation replay 等价；性能基线有记录。

**回滚**：保留最小 shell 和各 capability flag；失败的专用视图可退回 generic fallback。

### Phase 7.final：阶段验收与 checkpoint

**阶段门禁**：

- 交付物和“不包含”列表逐项关闭；
- `pnpm typecheck`、`pnpm test` 和改动范围对应的 browser/replay/security tests 通过；
- `git diff --check` 通过；
- Event/Tool/Task/Permission/Workspace contract、source reuse、ADR 和阶段状态同步；
- 有独立可回滚 checkpoint；
- Web 刷新、断线、重连、回放和 API 重启得到一致状态；
- Read-only、Edit、Test/Recovery、Delegation、Inspection 五个场景有命令、fixture 或浏览器结果证明。

**完成后开放**：Phase 8 的 Worktree、LSP 深度体验、上下文压缩、后台/定时任务、session fork/replay/export、多用户和产品化能力；Phase 6 A2A 仅在出现明确外部互操作需求后重新立项。

## 5. Phase 7 统一验收场景

| 场景 | 必须看到的结果 |
|---|---|
| Read-only | Session history、assistant/reasoning、工具调用/结果、model metadata、trajectory 可搜索；断线恢复不丢事件 |
| Edit | read → permission → diff → approve → patch → terminal/test → summary 全链路可见、可回放 |
| Test/Recovery | 长任务输出、job/terminal 状态、重连、刷新和 API 重启不重复执行，interrupted 状态可解释 |
| Delegation | parent/child tree、child history、report/artifact、prompt/interrupt/cancel、权限与 MCP scope 可见且不越界 |
| Inspection | 选中 turn/tool 后能查看 timing/usage/input/output/schema/raw/source，敏感字段脱敏，未加载部分不伪造数据 |

## 6. 阶段决策七问

1. **属于哪个 Phase？** Phase 7；本计划以 Phase 5 内部 Subagent 为前置，A2A 暂缓。
2. **解决什么问题？** 主要解决 Web UI、客户端 projection、连接恢复和 Agent 可观测性，不重写 Runtime。
3. **是否改变 Event/Tool/Task/Permission/Workspace contract？** 默认只增加 Web projection/query DTO；任何事实 contract 变化必须单独同步文档和回放测试。
4. **参考哪些入口？** DSH Web boot、client/connection、host API、ui-conversation、ui-tool、ui-subagent、ui-trajectory；Claude Code 仅参考流式 turn、工具状态和任务协调。
5. **是否需要 source reuse/license 登记？** 行为参考写入研究文档；直接复制/大量改编 DSH 时登记 MIT 来源；Claude Code 默认不复制代码。
6. **验收场景是什么？** Read-only、Edit、Test/Recovery、Delegation、Inspection 五场景，加上断线、恢复、权限和安全测试。
7. **如何回滚或禁用？** 每个切片独立 checkpoint；保留旧 shell/generic tool fallback；capability panel、Trajectory 和新 connection client 都可 feature flag 关闭。
