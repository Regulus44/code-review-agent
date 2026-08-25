# DeepSeek Harness 前端实现对照记录

> 目的：记录本机 `D:\Develop\deepseek-harness-fork` 的 Web 前端实现逻辑，作为本项目后续 UI 收敛的长期对照基线。
>
> 范围：只记录组件边界、状态来源、交互语义和视觉行为。后续实现应复用这些行为模式，并映射到本项目自己的 Event/Projection/API contract；不直接复制品牌资源、产品文案或未经登记的实现代码。

## 1. 总体架构

DSH 的 Web 入口非常薄：`apps/web/src/main.ts` 只找到 `#root`，然后创建 `AppWebEntry`。真正的页面由插件组合完成，前端不是一个巨大的页面组件，而是由 Host projection、Client store、slot 和 keyed renderer 组合出的 Web 工作台。

主要分层如下：

| 层 | DSH 位置 | 责任 |
|---|---|---|
| Web 启动 | `apps/web/src/main.ts` | 挂载 Web Shell，不承载业务状态 |
| Shell / 三栏布局 | `packages/client/ui-layout` | Sidebar、Conversation、Details 三列，断点、拖拽、折叠和 overlay 层 |
| 会话骨架 | `packages/client/ui-conversation/src/client/skeleton` | Session header、视图标签、滚动容器、Composer、Stats、Queue、Todo dock |
| 对话流 | `packages/client/ui-conversation/src/client/chat` | 按稳定 Conversation Node key 渲染 user、assistant、think、turn、command、tool 等行 |
| 工具展示 | `packages/client/ui-tool` | Tool call tree、单行工具摘要、展开详情、工具类型卡片和 fallback |
| 模型选择 | `packages/client/ui-model-selection` | 一个 per-session model directory，供 `/model` 命令和 Composer model seat 共用 |
| 权限 / 问题 | `packages/client/ui-user-questions`、`ui-conversation` 的 ApprovalPanel | 将等待型请求接管 Composer，不把等待卡伪装成普通消息 |
| 计划 / Goal / Todo | `packages/client/ui-plan`、`ui-goal`、`ui-conversation` 的 TodoDock | 读取 Host projection，按 slot 放入 Composer dock 或 Details |

核心约束是：Host 产生事实和 projection，Client store 只保存页面交互状态，组件只渲染 props。页面刷新、重连和分页不能依赖局部 React state 重建事实。

## 2. 三栏 Shell 与可调宽度

`ui-layout/src/client/AppFrame.tsx` 和 `columns.ts` 组成三栏框架：

```text
sidebar | center conversation | details
```

关键行为：

1. Sidebar、Conversation、Details 始终位于固定树位置；Details 关闭时宽度变为 0，子树保持挂载，避免切换面板导致状态和 DOM identity 丢失。
2. Sidebar 与 Details 都有 pointer capture 拖拽句柄，拖拽过程中使用 `requestAnimationFrame` 节流，避免每个 pointermove 都触发完整布局。
3. 宽度通过纯函数 `computeColumns(viewport, sidebarPreference, detailsPreference)` 求解，不在拖拽中直接修改布局事实。
4. 让步顺序固定：先保持 Center 不小于 `CENTER_MIN`；空间不足时先缩小 Details；仍不足时自动关闭 Details；Sidebar 不自动让步，Center 承担最后的压缩。
5. 窄屏由 `SIDEBAR_AUTO_COLLAPSE` 控制。自动折叠不会覆盖用户保存的宽度偏好，重新放大窗口后可以恢复。

这比“直接给中间区域一个固定百分比”可靠：拖拽是持久偏好，最终显示宽度是 viewport 与偏好的投影结果。

## 3. Conversation 的事实和渲染模型

`ui-conversation` 不直接遍历原始 Event，而是消费 Host 生成的 Conversation timeline / node projection：

- 每个业务行拥有稳定 node key 和 anchor key；
- user、assistant、reasoning、turn-tail、tool-call、command、retry、question 等由独立 node definition 注册；
- renderer 通过 `conversation.chat.node` 的 keyed slot 分发；
- 分页 prepend 时用 anchor key 和相对位置恢复阅读位置；
- stream 更新只替换对应 node，不重建整个 transcript；
- 工具 root/subcall 拓扑由 runtime projection 提供，UI 不自己拼 parent-child map；
- 对话滚动容器和 Composer dock 分离，Composer sticky 在底部，滚动和输入不会互相抢位置。

聊天流中的非用户消息通常默认折叠，摘要必须足够说明“来源/类型/状态”，而不是直接把原始 JSON 倾倒在消息末尾。

## 4. 工具调用：DSH 的关键模式

### 4.1 单调用、递归树、统一 renderer

`ui-tool/src/client/tool/ToolCallTree.tsx` 接收已投影的 root `ToolCallBlock`，递归渲染 `subCalls`。Root 和 child 都经过同一条 keyed slot：

```text
conversation node
  └─ ToolCallTree(root)
      ├─ ToolRow(root)
      └─ ToolRow(child ...)
```

UI 不负责判断哪个 call 属于哪个 parent，也不在浏览器内重新配对 `tool/call` 与 `tool/result`。

### 4.2 折叠优先的 ToolRow

`ui-tool/src/client/tool/components/ToolRow.tsx` 是 DSH 工具体验的核心：

- 每个调用都是一条紧凑单行摘要，而不是大卡片；
- 默认关闭；只有有 body、output 或专用 card 时才允许展开；
- 整行点击、Enter、Space 都可以切换展开；
- collapsed row 显示：图标、工具标题、短摘要、状态/尾缀和 hover chevron；
- 展开后才显示 IN/OUT、终端、Diff、Read、Search、Web 等内容；
- 长输入/输出在自己的内容区滚动，不能把整条对话撑到屏幕外；
- 文件路径是独立的 link，点击路径不会触发行展开；
- `Inspect` 是 hover/focus 才出现的辅助入口，不占用摘要主视觉；
- 运行中的 row 使用轻量 sweep/shimmer 和无障碍隐藏文字表达 running，不插入持续增长的 toast 或系统等待光标；
- error 使用错误色和错误首行，stopped/interrupted 使用 warning state；状态来自 runtime call/result slice。

因此 DSH 不把每次工具 progress 都渲染成新一条“工具执行提醒”。同一个 call 只更新同一个 keyed row；新调用才增加新 row，详情仍由用户主动展开。

### 4.3 工具摘要文案

`GenericToolCard` 先通过 `toolRowModel` 分类工具：search、read、bash、write/edit、code、others，再决定摘要和卡片类型。未知工具使用 generic fallback。

摘要优先显示人能理解的目标，例如文件路径、搜索词或终端命令；原始参数 JSON 只进入展开后的 IN 区。状态使用 `running / failed / stopped` 等短标签，不重复拼接“Tool · pending · Tool · pending”。

### 4.4 对本项目的直接映射

当前项目原先的 `Agent activity` 大组可以保留为可选的跨工具汇总，但不应成为唯一展示面。更接近 DSH 的实现是：

1. Conversation projection 保持工具的原始位置；
2. 每个 `tool-call` 映射到一个稳定 `.tool-row`；
3. progress 只更新该 row 的 summary/status/detail；
4. 每个 row 默认折叠，详情按调用展开；
5. 权限请求和用户问题脱离 ToolRow，单独进入 Composer/主对话的决策 surface；
6. 不使用 `cursor: wait` 作为运行状态表达。

## 5. Turn 状态和发送/停止按钮

### 5.1 DSH 的主按钮规则

`ui-conversation/src/client/skeleton/InputBar.tsx` 的逻辑可以概括为：

```text
ordinary session + running = primary button Stop
ordinary session + idle    = primary button Send
continuable child + running = Send remains primary, separate Stop is optional
```

普通会话只有一个主按钮，不把 `Steer`、`...`、Stop 混在一起。发送按钮是 34px 圆形按钮：

- idle：蓝色，上箭头，`aria-label="Send"`；
- running：同一位置变为方形 stop icon，`aria-label="Stop"`；
- disabled：降低 opacity，使用 `cursor: default/not-allowed`，不显示系统加载光标；
- stop 的可用性完全来自 `useSession(s => s.running)` 和 Host 提供的 `stop` 回调；
- stop 请求完成并收到 Host 的终态 projection 后，按钮自然恢复 Send；
- 不因为一次本地 click 就永久保留 Stop，也不以请求 promise 是否 pending 作为最终事实。

### 5.2 Queue 与 Steer 的语义

DSH 将 Queue/Steer 作为消息投递策略，不把它们当成第二个主发送按钮：

- 空闲时 Enter/Cmd+Enter 都是普通 queue send；
- running 时，Enter 的 Queue/Steer 行为由 Host-backed preference 决定；
- Cmd/Ctrl+Enter 可以执行另一种策略；
- Shift+Enter 永远换行；
- 空草稿 + Cmd/Ctrl+Enter 可以把已有 queued messages 批量 steer 到运行 turn；
- queued message 在 QueueDock 中以单行预览显示，可编辑、删除或严格 steer；
- 普通会话的主 Composer 不额外摆一个含义不清的 “Steer” 按钮。

### 5.3 本项目发送/停止 bug 的修复原则

当前项目必须遵循以下状态源规则：

```text
current snapshot.session.turns 中存在 queued/running turn -> Stop
current snapshot.session.turns 没有 queued/running turn -> Send
cancel receipt=false 或终态已到达 -> 立即回到 Send
cancel receipt=true -> 暂时 Stopping，直到 durable terminal event/replay 清除
```

不能在 `snapshot.session` 已经为空或已终态时回退到过期的 `state.session.turns`。否则会出现“顶部提示已结束，Composer 仍显示 Stop”的分裂状态。

## 6. 权限请求和用户问题

DSH 的等待型请求不作为普通 transcript 行堆在尾部：

- ApprovalPanel 通过 `conversation.composer` slot 接管 Composer；
- QuestionComposer 也在 Composer surface 内展示；
- 未决请求显示理由、调用命令/参数和一次性 Allow/Reject/Answer；
- resolved 后由 `approval/resolved` 或对应 interaction frame 驱动 Composer 恢复；
- 页面刷新时从 `pendingInteraction` projection 恢复，不依赖前端临时状态；
- PermissionSelect 是 Composer 底部的独立权限模式控件，不能与 reasoning 或 model 语义混用；
- 审批风险确认使用页面内 Modal，不靠浏览器原生 confirm。

这解释了为什么“权限请求伴随工具行”会显得杂乱：工具行负责观察，Composer/决策 surface 负责操作。

## 7. Model 与 Reasoning effort

DSH 的模型选择由 `ui-model-selection` 管理一个 per-session `ModelDirectory`：

1. `/model` 命令和 Composer 的 model seat 读取同一个 directory；
2. Host 返回 provider 分组、模型目录、当前选择、失败状态和 provider-owned reasoning metadata；
3. 选择成功后先以 Host receipt 更新 directory，再由两个 UI 入口回读同一事实；
4. 加载失败保留上一次有效目录，不把 UI 变成空白 loading；
5. ModelSelect 根菜单是 `Model` / `Effort` 两行，进入子菜单后才选择具体值；
6. reasoning 选项完全来自当前模型的 capability，不在前端硬编码一套适用于所有 provider 的等级；
7. 选择只影响后续 step/turn，不静默修改正在运行的 turn；
8. provider 没有 reasoning capability 时显示明确的 unavailable 文案，不让用户点击一个假控件。

本项目当前已明确暂时取消 Composer 中的 reasoning/effort UI，因此只保留这段作为未来恢复时的参考；现阶段不能继续在主输入栏显示 `Effort · Default` 或 `Model · custom · N/A` 这种相互冲突的组合。

## 8. Planning、Todo、Goal、Details

- TodoDock 位于 Composer dock，默认折叠，表头只显示标题和状态计数；
- QueueDock 为空时隐藏，单条队列直接显示，多条队列默认收起为 `n 条排队消息`，展开区域有最大高度和滚动；
- Plan/Goal/Details 读取 Host projection，不由 UI 猜测完成度；
- Details 是独立列，关闭时不销毁内容；
- 详情 panel 更适合放 trajectory、tool inspector、workspace、MCP、jobs 等低频诊断内容；
- 主对话只保留摘要和需要用户决策的内容，不把整份 planning JSON 持续插入消息尾部。

对当前项目的优先级：Planning 侧先保持“可折叠、摘要优先”；不要为了模仿 DSH 再扩展一套复杂面板。

## 9. 视觉和交互基线

DSH 的共同视觉规律：

- 一个 Composer card，左侧是低权重工具入口，右侧是 model/context/primary action；
- 主操作只有一个明确的圆形按钮；
- 工具 row 是轻量单行，展开后才出现边框卡片；
- 状态用颜色、短标签、StateDot 或轻量 sweep 表达；不用系统 spinner cursor；
- 文字摘要优先，技术细节后置；
- 默认关闭的 DisclosureRow 统一键盘、ARIA 和 hover 行为；
- 失败和等待状态不通过不断新增的 DOM 节点制造“刷屏感”；
- hover 才显示低频动作，例如 Inspect、chevron、copy；
- 浮层使用 slot/overlay 统一管理，不在组件内部各造一套 outside-click 逻辑。

## 10. 测试入口与验收场景

可对照的 DSH 测试位置：

- Composer 状态和键盘：`packages/client/ui-conversation/tests/input-bar.client.spec.tsx`、`input-machine.client.spec.ts`、`input-matrix.client.spec.tsx`；
- Queue：`packages/client/ui-conversation/tests/queue-dock.client.spec.tsx`；
- Tool row/tree：`packages/client/ui-tool/tests/tool-row.client.spec.tsx`、`tool-row-styles.client.spec.ts`、`tool-call-tree.client.spec.tsx`；
- Model：`packages/client/ui-model-selection/tests/model-select.client.spec.tsx`；
- Layout：`packages/client/ui-layout/tests/app-frame.client.spec.tsx`、`columns.client.spec.ts`；
- Conversation replay：`packages/client/ui-conversation/tests/chat-store.client.spec.ts`、`chat-view.client.spec.tsx`；
- Browser e2e：`apps/web/tests/steering.e2e.ts`、`turn-tail-actions.e2e.ts`、`subagent-interrupt-ui.e2e.ts`。

本项目后续每次 UI 改造至少应覆盖：

1. idle → send；
2. send → running → stop；
3. stop request → stopping → terminal → send；
4. 已结束 turn 不残留 Stop；
5. 多个工具调用只更新对应 row，不重复追加提醒；
6. 工具 row 默认折叠，展开/收起可用键盘完成；
7. permission/interaction 不埋在工具详情内；
8. 刷新或 SSE replay 后按钮和工具状态与 Host projection 一致。

## 11. 对当前项目的实施顺序

按用户当前要求，先做两个切片：

### P0：Composer Send/Stop

- 移除容易误解的 Steer 和 reasoning/effort 主栏控件；
- 只保留 Send / Stop / Stopping 三态；
- active turn 只能来自当前 snapshot，不回退到过期 session projection；
- cancel 返回未接受时立即恢复 Send；
- 终态事件、重连和回放都能清理 stopping 状态；
- 禁用按钮不使用 `cursor: wait`。

### P0：ToolRow

- 一个 tool call 对应一个稳定 row；
- 默认折叠，详情在 row 内展开；
- progress/result 更新同一 row；
- 摘要显示工具名、短目标和状态，原始 JSON 只在详情区；
- 工具运行提示不以不断新增的尾部通知呈现；
- permission/question 独立进入主对话决策 surface。

### 暂缓

- 不继续扩展 Planning 侧栏；
- 不恢复 reasoning/effort 入口；
- 不投入完整 Trajectory 诊断系统；
- 不把 DSH 的 React/slot 实现直接移植到当前单页 HTML，先保持本项目 Event/Projection contract。

## 12. 来源与许可证记录

本对照文档参考：

- `D:\Develop\deepseek-harness-fork\LICENSE`；
- `packages/client/ui-conversation/README.zh.md`；
- `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx`；
- `packages/client/ui-conversation/src/client/chat/ChatView.tsx`；
- `packages/client/ui-conversation/src/client/chat/ReasoningRow.tsx`；
- `packages/client/ui-tool/README.zh.md`；
- `packages/client/ui-tool/src/client/tool/ToolCallTree.tsx`；
- `packages/client/ui-tool/src/client/tool/components/ToolRow.tsx`；
- `packages/client/ui-layout/src/client/AppFrame.tsx`；
- `packages/client/ui-layout/src/client/columns.ts`；
- `packages/client/ui-model-selection/src/client/ModelSelect.tsx`。

当前项目只登记“行为和结构参考”。如果未来直接复制或大量改编 DSH 代码，必须按根目录 `AGENTS.md` 的要求补充 `docs/source-reuse-register.md`、许可证和独立提交说明。
