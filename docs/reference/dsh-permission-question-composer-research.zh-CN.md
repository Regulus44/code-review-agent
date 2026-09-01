# 权限请求与用户问题：DSH Composer Takeover 调研与实施指导

> 状态：调研完成，第一版 Composer takeover 已实现并通过 Web 检查。
>
> 目标：明确本项目如何按照 DeepSeek Harness（DSH）的交互逻辑处理 permission request 和 user question，避免等待型请求继续堆叠在 Conversation 尾部。
>
> 适用阶段：Phase 8 Web 收敛；本切片属于 UI projection、Composer 交互和恢复体验，不改变已有 Event、Tool、Task、Permission contract。

## 1. 结论先行

DSH 的实现原则可以概括为：

```text
Host durable request
        │
        ▼
Session pending snapshot
        │
        ├─ Composer chain selector
        │       ├─ QuestionComposer
        │       └─ ApprovalPanel
        │
        └─ Conversation 只保留已发生的事实和结果
```

权限请求和用户问题都是“等待型 request”，不是普通的 transcript message，也不是 ToolRow 的附属信息。它们出现时接管 Composer 的位置，用户完成操作或取消后，Host 追加 resolved frame，pending membership 消失，默认 InputBar 恢复。

这正是当前项目与 DSH 的主要差距：当前 Web 已经有独立的 permission/interaction 节点和 API，但 `apps/web/index.html` 仍然把它们追加到 Conversation body；Composer 只识别 Send/Stop/Stoppng，没有 pending request takeover。

## 2. 本任务的治理回答

| 问题 | 决定 |
|---|---|
| 所属 Phase | Phase 8 Web 收敛；不提前引入新 Runtime 能力 |
| 问题类别 | UI projection、Composer 交互、恢复和可访问性 |
| 是否改变 contract | 不改变 Event/Tool/Task/Permission contract；只新增 Web 侧 pending projection/selector 适配 |
| DSH 参考入口 | `packages/client/ui-conversation/src/client/apply.ts`、`skeleton/ConversationRoot.tsx`、`skeleton/ApprovalPanel.tsx`、`ui-user-questions/src/client/QuestionComposer.tsx`、`runtime/src/client/sessions/pending.ts` |
| 是否复制上游代码 | 不复制品牌、文案或内部类型；仅参考行为和布局，按本项目类型自行实现 |
| 验收场景 | pending permission/question 接管 Composer；长内容内部滚动；重复点击受控；刷新/SSE 重连恢复；resolved 后恢复普通输入 |
| 回滚方式 | 以独立 Git checkpoint 回滚 Web pending projection 和 takeover renderer；Event/API 保持兼容 |

## 3. DSH 的实现逻辑

### 3.1 PendingWait 是传输载体，不是事实来源

DSH 的 `PendingWait` 由 Host/session manager 从 requested frame 创建，包含：

- `kind`：`approval` 或 `question`；
- 稳定 `key`：由 request/rpc identity 组成，用于渲染和 remount；
- `sessionId`；
- 原始 request payload；
- `respond()`：把领域结果包装为 client response，并回填 request 的 rpc identity；
- `markSettled()`：resolved frame 到达后禁止再次响应。

`PendingWait` 不把“按钮点击成功”当作 settled。HTTP/RPC receipt 只说明命令被接受；真正让 request 从 UI 消失的是 Host 广播的 resolved frame。这样可以避免前端先移除卡片、但后端仍处于 pending 的假状态。

### 3.2 Composer chain 是 takeover 边界

DSH 在 `conversation.composer` 声明一个 selector-routed chain：默认 occupant 是 InputBar，pending request occupant 可以替换它。

- `ApprovalPanel` 通过 `selectApproval()` 匹配 `kind === 'approval'`；
- `QuestionComposer` 通过 `selectQuestion()` 匹配 `kind === 'question'`；
- Question 的注册优先级高于 Approval，因此二者同时 pending 时先处理 Question；Question resolved 后 Approval 自动重新当选；
- `renderSlotChain(..., { fallback: composerBar, overlay: true })` 使 takeover 和默认 Composer 使用同一 seat，不在 Conversation 末尾新增等待卡片；
- sticky seat 包住整个 chain 输出，takeover 变高时仍固定在可操作位置；seat 高度会反馈给滚动视图，避免浮动按钮被卡片遮挡。

DSH 的相关源码明确说明：Chat 不渲染 pending placeholder；QuestionComposer 和 ApprovalPanel 都接管 Composer。

### 3.3 ApprovalPanel 的视觉和交互

ApprovalPanel 的结构是：

```text
Composer seat
└─ approval card
   ├─ waiting strip
   ├─ scrollable body
   │  ├─ reason/headline
   │  └─ paired command
   └─ fixed action row
      ├─ Reject
      └─ Allow once
```

关键行为：

1. reason 和 command 视为无界模型文本，只在 body 内部滚动；
2. action row 位于滚动区之外，长命令不会把按钮推到视口之外；
3. 点击后本地 one-shot latch 立即禁用按钮；
4. receipt 拒绝或传输失败时恢复按钮并显示错误；
5. 只有 resolved frame 到达后，Composer 才恢复 InputBar；
6. 使用 pending key 作为 React key，新的 request 不继承上一个 request 的 answered 状态；
7. ApprovalPanel 不负责重新判断权限，也不绕过 Host policy。

DSH 的 `data-approval-scroll` 还让滚动区域具备 tab stop 和可访问名称，键盘用户可以到达长 command 的末尾。

### 3.4 QuestionComposer 的视觉和交互

QuestionComposer 使用同一个 Composer takeover seat，但领域交互更丰富：

- 一次处理一个 pending request；
- request 可以包含多个问题，使用 `index` 分页；
- 支持单选、多选、自定义答案和跳过；
- 未完成当前问题时不能提交整批答案；
- 最终提交结构化 answer batch，而非把选项拼成普通文本；
- 可以取消整个 request，Host 以 cancelled resolved 结束等待；
- detail/options 使用独立滚动区，操作按钮保持可达；
- `plan-review` 只是同一 question request 的专用呈现，不能丢失 generic flow 无法表达的答案能力；
- 本地 busy 状态防止重复提交，receipt 失败时允许重试。

## 4. 当前项目实现现状

### 4.1 已具备的后端和投影能力

当前项目已经具备后续改造所需的 durable 基础：

- Event：`permission/requested`、`permission/resolved`、`interaction/requested`、`interaction/resolved`；
- Runtime：`resolvePermission()`、`resolveInteraction()`、TTL/expiry、SQLite replay/restart recovery；
- API：
  - `POST /v1/sessions/:sessionId/permissions/:permissionId`
  - `POST /v1/sessions/:sessionId/interactions/:interactionId`
- Web client：`WebApiClient.resolvePermission()`、`resolveInteraction()`；
- Conversation projection：`PermissionNode`、`InteractionNode` 以及 pending/resolved 状态；
- Details：已有 Requests 分组，可继续承担历史、恢复和统计查看。

这些能力说明本任务首先是 Web 信息架构和状态连接问题，不需要修改 Event 或 Runtime contract。

### 4.2 当前 Web 的问题

当前 `apps/web/index.html` 存在以下路径：

1. `appendPermission(parent, payload)` 创建 `.permission-card` 并直接 `parent.append(row)`；
2. `appendInteraction(parent, payload)` 创建 `.interaction-card` 并直接 `parent.append(row)`；
3. `renderConversation()` 遍历 `projection.nodes`，对 `permission` / `interaction` 调用上述 append 函数；
4. 旧事件回放逻辑又会把 permission/interaction map 的内容追加到 Conversation body；
5. `renderComposerState()` 只处理 turn 与 Send/Stop/Stoppng，不读取 pending request；
6. 这些卡片虽然已经不再嵌在 ToolRow 内，但仍属于普通 transcript 内容；
7. 长 reason、command、question 和 options 会增长 Conversation 尾部，真正操作按钮被推向页面下方；
8. 普通 Composer 在等待型请求出现时仍可输入，形成“模型等待用户、用户却在发送新消息”的冲突语义。

因此，单纯增加折叠按钮或调整卡片 CSS 不能解决根因。需要改变挂载位置和状态职责。

## 5. 目标职责边界

### 5.1 Conversation

Conversation 只显示已经发生或已经结束的事实：用户消息、assistant 消息、turn 状态、ToolRow、已完成请求的摘要或审计记录。

pending permission/question 不再作为普通 transcript 行渲染。若产品需要历史可见性，可以在 resolved 后显示紧凑结果摘要，或由 Details Requests 提供完整记录。

### 5.2 Composer

Composer 是当前 session 的决策入口，按优先级只展示一个 takeover：

```text
question pending  → QuestionComposer
approval pending  → ApprovalPanel
none              → normal InputBar
```

在 takeover 期间：

- 普通文本输入、发送、附件和与当前决策冲突的控制应隐藏或置为不可用；
- takeover 自己拥有操作按钮、错误提示和长内容滚动区；
- 发送/停止按钮状态不应覆盖 permission/question 的决策按钮语义；
- Composer dock 的 usage/stats 可以保留为只读信息，但不应把请求操作放到 dock 中。

### 5.3 Details

Details 的 Requests 分组只承担：

- pending/resolved/expired 的恢复信息；
- 历史记录和调试信息；
- 连接恢复后的“仍待处理请求”提示；
- 计数、审计和错误诊断。

Details 不能成为主要批准/回答入口，否则用户必须离开对话主操作区才能解除 Agent 阻塞。

### 5.4 ToolRow

ToolRow 只表示 tool lifecycle：queued/running/completed/failed/denied 等。它可以显示“waiting for permission”或“waiting for user input”的紧凑状态，但不承载主要批准/回答按钮，也不负责决定 request 顺序。

## 6. 本项目建议的状态模型

Web 侧新增一个从 SessionStore snapshot 派生的只读视图，不在组件内部自行维护事实：

```ts
type PendingRequestView =
  | {
      kind: 'permission'
      key: string
      permissionId: string
      status: 'pending'
      reason: string
      toolName: string
      input?: unknown
      expiresAt?: string
    }
  | {
      kind: 'interaction'
      key: string
      interactionId: string
      status: 'pending'
      question: string
      options: readonly { label: string; value: string }[]
      allowFreeform: boolean
      expiresAt?: string
    }

type ComposerTakeoverView =
  | { mode: 'question'; request: PendingRequestView }
  | { mode: 'approval'; request: PendingRequestView }
  | { mode: 'normal' }
```

派生规则：

1. 只从最新 SessionStore projection 读取 status 为 pending 的请求；
2. key 必须由 durable request identity 组成，不能用数组索引；
3. 同时存在多个请求时只选一个；
4. 建议与 DSH 对齐：question 优先于 approval；同类型按 request sequence / creation sequence 选择最早者；
5. resolved/expired/cancelled 不再进入 takeover；
6. HTTP receipt 成功只记录“提交中”本地状态，不删除 pending view；
7. resolved event 到达后，projection 自然移除 pending membership，Composer 恢复；
8. refresh、SSE reconnect 和 history replay 重新派生同一结果。

## 7. 推荐实现分层

### 第一步：建立 pending request presenter

在 `apps/web/src/presentation/request-presenter.ts` 或独立 presenter 中增加：

- `presentPendingRequests(snapshot)`；
- stable key 生成；
- priority/oldest selection；
- expiry、connection、recovery 文案；
- 不改变 `ConversationProjection` 的事件语义。

Presenter 输出只读 view，组件不直接解析原始 Event。

### 第二步：从 Conversation 移除 pending 操作卡

调整 `renderConversation()`：

- pending permission/interaction 不调用 `appendPermission` / `appendInteraction`；
- resolved request 可以保留一条紧凑只读结果行，或统一放入 Details Requests；
- ToolRow 使用状态摘要指向“Composer waiting surface”，不重复渲染操作表单；
- 保留旧历史数据的回放兼容，不能因为隐藏 pending 操作卡而丢失事件或审计记录。

### 第三步：在 Composer 中增加 takeover 分支

将 `renderComposerState()` 从“只判断 turn”扩展为：

```text
pending question → render question takeover
else pending approval → render approval takeover
else normal turn state → Send/Stop/Stoppng
```

takeover 组件与普通 InputBar 使用同一 composer seat，避免在页面尾部另开容器。若当前 HTML 仍是单文件，应先拆出最小的 DOM renderer/state adapter，再逐步迁移到独立 TypeScript component；不要继续增加更多 append-to-transcript helper。

### 第四步：实现 one-shot command gate

每个 request 使用 `Map<requestKey, 'idle' | 'submitting' | 'error'>` 或等价结构：

- 点击后立即禁用同一 request 的所有冲突按钮；
- 成功 receipt 进入 submitting，但 pending view 仍在；
- durable resolved 到达后删除 gate；
- receipt rejected/网络失败回到 error，可重试；
- request key 变化时重置 gate，避免上一个 request 的 disabled 状态泄漏。

### 第五步：实现内部滚动和可达操作区

Approval 与 Question takeover 都应遵守：

- 卡片外层与普通 Composer 同宽；
- body 设置明确 `max-height` 和 `overflow-y: auto`；
- action/footer 固定在 body 外；
- 键盘可聚焦滚动区；
- 长文本、长选项和错误提示不能把主要按钮推出可视区域；
- takeover 高度变化必须被滚动容器感知，避免底部浮动控件遮挡。

## 8. 错误、过期、恢复和并发语义

### 8.1 Receipt 与 durable resolved 的区别

```text
用户点击
  → API receipt accepted/rejected
      → accepted: 本地按钮禁用，继续等待事件
      → rejected: 显示错误，允许重试
  → permission/resolved 或 interaction/resolved
      → projection 更新
      → takeover 消失，InputBar 恢复
```

禁止在 `await commandApi()` 成功后直接从 DOM 删除卡片或把 Composer 切回普通输入。

### 8.2 过期

Runtime 已有 expiry/resolved 事件。前端只把 expired request 呈现为不可操作的结果或恢复提示；不能继续提交 approved/answered。若 expired 事件尚未到达，前端可以显示倒计时/即将过期提示，但不能自行制造 resolved 事实。

### 8.3 刷新和 SSE 重连

重连后从 SessionStore 的 durable baseline + replay 重建 pending view。若请求仍未 resolved，Composer 继续 takeover；若 resolved 已存在，不应闪回旧卡片。

### 8.4 多个请求

请求集合可以保留在 snapshot/Details 中，但 Composer 只显示一个。推荐优先级：

1. question；
2. approval；
3. 同类型按 sequence 最早者。

前一请求 resolved 后，下一请求自动进入 Composer；不要一次性渲染多个操作卡。

## 9. 验收矩阵

| 场景 | 预期 |
|---|---|
| permission/requested | Conversation 不新增操作卡；Composer 显示 Approval takeover |
| interaction/requested | Conversation 不新增操作卡；Composer 显示 Question takeover |
| 两种请求同时 pending | 只显示一个，Question 优先；前一个 resolved 后再显示下一个 |
| 长 reason/command | body 内滚动；Reject/Allow 始终可见 |
| 长 question/options | body 内滚动；回答、跳过、取消按钮始终可见 |
| 快速双击按钮 | 只发送一次 command；按钮进入 disabled |
| receipt rejected | takeover 保留；显示错误；按钮可重试 |
| resolved event | pending membership 消失；Composer 恢复普通 InputBar |
| 页面刷新 | 仍 pending 则恢复 takeover；已 resolved 不回闪 |
| SSE 断线重连 | 按 durable projection 恢复，不依赖旧 DOM |
| expired | 不可继续操作，显示过期结果或恢复提示 |
| Details Requests | 可查看历史/恢复信息，但不承担主要操作入口 |
| ToolRow | 只显示生命周期摘要，不重复渲染批准/回答表单 |
| 普通发送状态 | 无 takeover 时继续使用 Send/Stop/Stoppng；takeover 时不冲突 |

## 10. 不包含在本轮实现中的内容

- 不恢复 Reasoning/Effort 切换；
- 不修改 Planning 侧栏；
- 不重新设计三栏 Shell；
- 不改变 ToolRuntime 的权限策略、TTL 或事件 contract；
- 不接入新的外部协议或插件；
- 不复制 DSH 的品牌、产品文案、内部类型或未登记代码。

## 11. 第一版实现状态

本项目已完成本指导方案的第一版 Web 实现：

- `apps/web/src/presentation/request-presenter.ts` 增加 pending request presenter，按 question 优先、同类型按 durable sequence 选择 Composer active request，并过滤过期请求；
- `apps/web/src/presentation/request-action-gate.ts` 增加 one-shot action gate，重复点击被拒绝，回执失败可重试，resolved/移除后的 request key 会清理；
- `apps/web/index.html` 增加同一 Composer seat 上的 approval/question takeover。长 reason、command、question 和 options 在内部滚动区展示，操作区固定在底部；
- pending permission/interaction 不再作为操作卡追加到 Conversation 尾部。resolved/expired 请求仍保留紧凑事实行，Details Requests 继续承担历史和恢复查看；
- HTTP/RPC receipt 成功只显示等待 Host 确认，只有 durable resolved projection 到达后才恢复普通 Composer；
- `apps/web/src/browser.ts` 暴露 presenter 和 gate，未改变 Event、Tool、Task、Permission contract。

已通过：`pnpm typecheck`、Web 122 tests、`pnpm build:web`、`pnpm test:phase8:web` 和 `git diff --check`。浏览器已重启并检查 `http://127.0.0.1:3210/` 的普通 Composer、默认 takeover 隐藏和 Conversation 无 pending 操作卡。当前没有安全可复用的真实 pending session，因此 approval/question 的真实点击闭环仍需后续 fixture 或手工安全场景补充。

## 12. 后续开发顺序和 checkpoint

建议拆成三个可回滚 checkpoint：

1. `feat(phase-8): add pending request projection`：presenter、priority、replay/reconnect 单测；
2. `feat(phase-8): add composer permission takeover`：Approval surface、one-shot、内部滚动、API receipt；
3. `feat(phase-8): add composer question takeover`：Question surface、批量答案、取消、分页和恢复。

每个 checkpoint 都应运行与改动范围匹配的 Web/API/Runtime 测试和 `git diff --check`。本调研文档本身先作为后续实现的入口，不将未实现能力标记为完成。

## 13. 参考源码和本项目映射

### DSH

- `D:\Develop\deepseek-harness-fork\packages\client\runtime\src\client\sessions\pending.ts`
- `D:\Develop\deepseek-harness-fork\packages\client\runtime\src\client\sessions\manager.ts`
- `D:\Develop\deepseek-harness-fork\packages\client\ui-conversation\src\client\apply.ts`
- `D:\Develop\deepseek-harness-fork\packages\client\ui-conversation\src\client\skeleton\ConversationRoot.tsx`
- `D:\Develop\deepseek-harness-fork\packages\client\ui-conversation\src\client\skeleton\ApprovalPanel.tsx`
- `D:\Develop\deepseek-harness-fork\packages\client\ui-conversation\src\client\skeleton\ApprovalPanel.module.css`
- `D:\Develop\deepseek-harness-fork\packages\client\ui-user-questions\src\client\index.ts`
- `D:\Develop\deepseek-harness-fork\packages\client\ui-user-questions\src\client\QuestionComposer.tsx`
- `D:\Develop\deepseek-harness-fork\packages\client\ui-user-questions\src\client\contract\slots.ts`

### 本项目

- `D:\Develop\code-review-agent\apps\web\index.html`
- `D:\Develop\code-review-agent\apps\web\src\presentation\request-presenter.ts`
- `D:\Develop\code-review-agent\apps\web\src\projection\conversation.ts`
- `D:\Develop\code-review-agent\apps\web\src\client\store.ts`
- `D:\Develop\code-review-agent\apps\web\src\client\api.ts`
- `D:\Develop\code-review-agent\apps\api\src\server.ts`
- `D:\Develop\code-review-agent\packages\runtime\src\index.ts`
- `D:\Develop\code-review-agent\packages\tools\src\runtime.ts`
