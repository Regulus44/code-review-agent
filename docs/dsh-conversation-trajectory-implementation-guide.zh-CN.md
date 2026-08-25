# DSH Conversation / Trajectory 前端实现指导方案

状态：`guidance`

记录日期：2026-08-25

用途：作为本项目后续修复 Conversation / Trajectory 切换、滚动边界和 Composer 布局的实现基线。

本方案记录 DeepSeek Harness（DSH）的结构与行为逻辑，并将其转换为本项目可执行的实现约束。后续实现必须映射到本项目自己的 Event、Projection、Session 和 Web API contract，不直接暴露 DSH 内部类型，也不复制 DSH 品牌资源或产品文案。

关联问题记录：[`ui-issue-conversation-trajectory-scroll.zh-CN.md`](ui-issue-conversation-trajectory-scroll.zh-CN.md)

关联总对照文档：[`dsh-frontend-reference.zh-CN.md`](dsh-frontend-reference.zh-CN.md)

## 1. DSH 的核心实现结论

DSH 把视图切换问题拆成四个稳定边界：

```text
ConversationRoot（中心列根节点）
├─ Session Header（标题、面包屑、视图标签）
└─ scrollBody[data-conversation-scroll]（唯一外层滚动宿主）
   ├─ ConversationSession
   │  └─ viewArea
   │     └─ 当前 active view：Chat 或 Trajectory
   └─ composerSeat
      └─ Composer / Approval / Question takeover
```

四条必须保持的规则：

1. Session Header 和 Conversation / Trajectory 标签不属于 transcript scrollport，因此不会随内容滚动。
2. View 切换只改变 `viewArea` 中的 active view，不替换外层 Session shell。
3. Chat 和 Trajectory 各自处理自己的内容滚动，但都服从外层 shell 提供的稳定几何边界。
4. Composer 永远由 shell 保留一个 seat；普通 Conversation 使用 sticky seat，Trajectory 使用 overlay seat，并为 Composer 预留实时高度。

## 2. DSH 源码入口与职责

DSH 根仓库：`D:\Develop\deepseek-harness-fork`

| 文件 | DSH 中的职责 | 本项目应参考的行为 |
|---|---|---|
| `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx` | 常驻 Conversation 根节点，组织 Header、scrollBody 和 Composer seat | 外层 shell 常驻，视图切换不破坏布局身份 |
| `packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx` | 渲染 Session Header、view tabs 和 active view | 标签栏在滚动区外，active view 通过 view ring 选择 |
| `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css` | 定义 root、scrollBody、viewArea、composerSeat 的 flex/overflow/sticky 关系 | 用明确的 flex 纵向布局替代隐式 grid 行堆叠 |
| `packages/client/ui-conversation/src/client/chat/ChatView.tsx` | 解析真实 scrollport，处理尾部跟随、分页 anchor 和阅读位置 | Chat 不直接操作 document 或任意父节点滚动 |
| `packages/client/ui-conversation/src/client/contract/slots.ts` | 定义 `conversation.session`、`conversation.session.header`、`conversation.view` 等 slot contract | 将 Header、Session body、active view 和 Composer 作为独立职责 |
| `packages/client/ui-trajectory/src/client/TrajectoryView.tsx` | 注册 Trajectory view，并声明 Composer overlay 需求 | Trajectory 作为 active view，不改变外层标签栏结构 |
| `packages/client/ui-trajectory/src/client/views.module.css` | Trajectory 根节点全高、内部裁剪和 bottom clearance | Trajectory 自己管理内部内容区，不让内容撑开页面 |
| `packages/client/ui-trajectory/src/client/TrajectoryTable.module.css` | Trajectory 表格的内部纵向滚动和虚拟列表边界 | 长轨迹在内部滚动，保留 Header/Tabs 点击区域 |
| `packages/client/ui-trajectory/README.zh.md` | Trajectory 的尾部跟随、Composer clearance 和内部滚动说明 | 作为 Trajectory 行为验收依据 |

## 3. 外层布局逻辑

### 3.1 Root 使用纵向 Flex，而不是多个隐式 Grid Row

DSH 根节点的职责只有三件事：

- 占满中心列高度；
- 让 Header 固定在顶部；
- 让 scrollBody 承担剩余高度。

等价结构：

```css
.conversation-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.session-header {
  flex: none;
}

.scroll-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
```

`min-height: 0` 是必要条件：没有它，Flex 子项可能按内容最小高度扩张，滚动责任会逃逸到更外层。

### 3.2 Header / Tabs 的边界

DSH 的 `ConversationSessionHeader` 位于 `scrollBody` 外部。它负责：

- Session 标题、面包屑和 Header actions；
- 从 view ring 投影 `Conversation` / `Trajectory` 标签；
- 将 `setView(viewId)` 写入 per-session view store。

Header 不负责：

- 渲染大量 transcript 内容；
- 直接改变 Chat 或 Trajectory 的滚动位置；
- 以 absolute 定位覆盖内容区；
- 在切换 view 时销毁整个 Composer 或 Session shell。

### 3.3 Active view 的边界

`ConversationSession` 只完成以下流程：

1. 读取当前 Session 的 view id；
2. 在 view ring 中解析 active view；
3. 无效 view id 回退到默认 Chat；
4. 在稳定的 `viewArea` 中只渲染当前 active view。

因此 View 切换不是两个页面互相覆盖，也不是把两个完整页面插入同一个 document 流；它是同一个 Session body 中的 active child 切换。

## 4. Chat 的滚动逻辑

### 4.1 唯一滚动目标

DSH 的 ChatView 不假设自身就是滚动容器。它通过：

```ts
function scrollerOf(from: HTMLElement): HTMLElement {
  return from.closest('[data-conversation-scroll]') ?? from
}
```

解析宿主：

- 在生产布局中，使用 ConversationRoot 提供的 `[data-conversation-scroll]`；
- 在单元测试或独立挂载时，才退回到 ChatView 自己的本地 scroller。

本项目对应要求：所有 Conversation 的 `scrollTop`、`scrollHeight`、`scrollTo` 和滚动监听必须集中到一个明确的 active-body scrollport，不得直接读写 `document.documentElement`、`body` 或不稳定的父节点。

### 4.2 尾部跟随

DSH 仅在以下情况跟随底部：

- Session 首次打开且没有保存的阅读位置；
- 用户发送新的 user message；
- 用户处于底部附近，且流式内容增长；
- 用户主动点击回到底部。

用户向上滚动后，系统会暂停尾部跟随，避免新工具调用或 assistant chunk 把用户拉回页面底部。

### 4.3 阅读位置恢复

DSH 保存的不是单一 `scrollTop`，而是：

```ts
interface ChatScrollPosition {
  anchorKey: string
  anchorTop: number
  scrollTop: number
}
```

恢复顺序：

1. 先写入保存的 `scrollTop`；
2. 查找同一个 `anchorKey`；
3. 用 anchor 当前相对顶部位置与保存位置的差值修正 scrollTop；
4. 若恢复后接近底部，则清除保存的 anchor，继续尾部跟随。

这可以抵抗窗口宽度变化、Markdown 高度变化和历史 prepend 导致的内容重排。

### 4.4 历史 prepend

加载更早的消息时，DSH 不把用户当前内容推走：

- 在请求前记录可见 anchor；
- prepend 完成后重新测量同一个 anchor；
- 用新旧 anchor 顶部差修正 scrollTop。

这项逻辑属于 ChatView 的 scrollport 层，不应由消息行组件自行实现。

## 5. Trajectory 的滚动逻辑

### 5.1 Trajectory 是 active view，不是第二个页面壳

Trajectory 通过 `conversation.view` 注册一个 view entry：

- view id：`trajectory`；
- Header 从 view ring 投影对应标签；
- Session body 在 `viewArea` 中渲染 Trajectory；
- 外层 root、Header、Tabs 和 Composer contract 不变。

### 5.2 Composer overlay 标记

Trajectory 根节点声明：

```html
<div data-conversation-composer-overlay>
```

ConversationRoot 看到该标记后切换到 overlay 约束：

- `viewArea` 占据剩余高度并 `min-height: 0`；
- `scrollBody` 保持裁剪边界；
- Composer seat 绝对定位在 active-body 底部；
- Trajectory 内容区不被 Composer 覆盖；
- 通过 Composer 实时高度变量增加 bottom clearance。

### 5.3 Trajectory 内部滚动

Trajectory 的根节点负责裁剪，表格负责真正的列表滚动：

```text
scrollBody
└─ viewArea
   └─ trajectoryRoot (height: 100%; overflow: hidden)
      └─ trajectoryTable (flex: 1; min-height: 0; overflow-y: auto)
```

这样可以同时满足：

- Header/Tabs 不滚动；
- Trajectory toolbar 保持在视图内部顶部；
- 长列表只在 table 内滚动；
- Composer overlay 不会把最后一行遮住。

Trajectory 还实现了：

- 初次打开定位到当前尾部；
- 用户上滚后暂停尾部跟随；
- 到达已加载范围顶部时加载更早一页；
- 只挂载可见行和少量 overscan；
- 选中记录时在同一视图内部打开 inspector，不把详情插入 Header 或整个页面流。

## 6. Composer seat 的逻辑

### 6.1 Composer 常驻

DSH 的 Composer 由 ConversationRoot 常驻挂载：

- 普通 Conversation：`composerSeat` 使用 `position: sticky; bottom: 0`；
- Trajectory：`composerSeat` 使用 overlay 定位；
- Approval / Question：通过 composer chain 接管同一个 seat；
- 空 Session：同一个 Composer DOM 保留，只改变 inert/disabled 状态。

这避免了 view 切换时 textarea、草稿和交互状态被销毁重建。

### 6.2 实时高度

DSH 用 ResizeObserver 观察 Composer seat，把高度写入：

```css
--dsh-composer-height
```

Trajectory 根据这个变量计算底部清除空间，确保最后几行可以滚动到 Composer 上方。Composer 高度变化时（多行输入、权限请求、问题卡片展开），不需要重新猜测固定像素值。

### 6.3 Composer 不应承担的职责

- 不把工具 progress 逐条追加到 Composer 下方；
- 不把 permission request 埋在 ToolRow 详情内；
- 不把 view tabs 放进 Composer；
- 不使用浏览器等待光标作为运行状态；
- 不通过本地 click 状态永久显示 Stop，按钮必须由当前 Host snapshot 的 turn 状态驱动。

## 7. View 状态与切换流程

### 7.1 DSH 状态来源

DSH 将当前 view id 保存在 per-session store：

```text
Host Session snapshot
        ↓
ConversationSession store
        ├─ current view id
        ├─ inspect target
        └─ chat scroll position
```

View id 是页面交互状态，不是新的 Event 真相来源；事实仍来自 Host projection。刷新或 Session 切换后，store 可以重新建立，active view 通过合法 view ring 重新解析。

### 7.2 切换流程

```text
用户点击 Trajectory
        ↓
session view store.setView('trajectory')
        ↓
Header 保持挂载，标签 active 状态更新
        ↓
Session body 只替换 viewArea 的 active child
        ↓
Trajectory 初始化自己的内部滚动位置
        ↓
Composer seat 继续由 shell 管理
```

返回 Conversation 时流程相同，只替换 active child，不改变 Header、scrollBody 和 Composer 的身份。

### 7.3 无效 view 的回退

如果持久化的 view id 已经没有对应注册项，DSH 回退到默认 Chat。后续实现不能因为 `trajectory` 数据为空、插件未加载或旧版本残留 view id 而让标签栏消失或整个 Conversation shell 失效。

## 8. 本项目的目标结构

本项目后续应把当前多个隐式 grid sibling 收敛成明确的中心列结构：

```text
workspace
├─ workspace-header
└─ workspace-center
   ├─ session-view-tabs
   ├─ connection-banner / queue-dock / goal-bar（非滚动提示区）
   └─ session-body
      └─ conversation-scrollport[data-conversation-scroll]
         ├─ active-view-pane
         │  ├─ Conversation view
         │  └─ Trajectory view
         └─ composer-seat
            └─ composer-shell
```

目标约束：

- `workspace-center` 使用明确的纵向 flex/grid 行定义；
- `session-view-tabs` 不属于内容滚动区；
- `session-body` 只有一个外层纵向 scrollport；
- Conversation 内容使用该 scrollport；
- Trajectory 长表再建立内部 scrollport，但不得把 scrollport 责任传播到 document；
- Composer seat 与 active view 由同一个 session-body 协调；
- banners、queue、goal 在布局上有明确的占位策略，不能依赖隐式 grid row；
- 所有内容区域设置 `min-height: 0`，防止 Flex/Grid 最小内容尺寸撑破父容器。

这部分是后续实现目标，不代表本轮已修改代码。

## 9. 推荐实现顺序

### P0：先固定外层几何

1. 检查当前 `workspace` 的 computed grid rows 和隐式行；
2. 建立显式 `workspace-center / session-body / conversation-scrollport` 层级；
3. 将 Tabs 移出 scrollport；
4. 确认页面、workspace、session-body、active view 各自的 overflow 责任。

### P1：接入 Conversation / Trajectory active view

1. 将当前 `state.sessionView` 映射到 active view pane；
2. 切换时保留 Header、Tabs、session-body 和 Composer DOM；
3. Conversation 使用稳定 scrollport；
4. Trajectory 根节点裁剪，内部列表滚动；
5. 无效 view id 回退 Conversation。

### P2：接入 Composer seat

1. 普通 Conversation 使用 sticky seat；
2. Trajectory 使用 overlay seat；
3. 用 ResizeObserver 发布 Composer 实时高度；
4. 为 Trajectory 最后内容增加 bottom clearance；
5. 检查权限请求和用户问题是否进入同一个 Composer decision surface。

### P3：补充阅读位置与恢复

1. 为 Conversation 保存按 Session 的 anchor/scrollTop；
2. View 切换前保存当前阅读位置；
3. 返回 Conversation 后恢复 anchor；
4. Trajectory 单独保存内部列表位置；
5. 刷新、SSE replay、Session 切换和 API 重启后验证恢复行为。

## 10. 禁止的实现方式

- 不在一个没有明确父级高度的容器上直接设置 `overflow: auto`；
- 不让 Header/Tabs 与 transcript 使用同一个可滚动 DOM；
- 不用多个隐式 grid row 承载 banner、queue、goal、conversation 和 Composer；
- 不在视图切换时把整个 `workspace` 或 `conversation` 重新替换成另一套页面壳；
- 不让 Conversation 和 Trajectory 同时拥有竞争性的外层滚动条；
- 不用固定 Composer 高度代替 ResizeObserver 发布的实时高度；
- 不通过新增大量工具通知节点来表达进度；
- 不让 UI 自己猜测 Event、Turn 或 Tool 的事实状态。

## 11. 验收场景

后续代码实现至少需要验证：

1. Conversation → Trajectory → Conversation 连续切换 10 次，Tabs 始终可点击；
2. Conversation 长消息滚动时，Header/Tabs 不移动；
3. Trajectory 长列表滚动时，Header/Tabs 不移动；
4. Trajectory 最后一行可以滚到 Composer 上方；
5. Composer 变成多行输入或出现 Approval/Question takeover 时，内容仍可达；
6. 用户在 Conversation 上滚离底部后切换 Trajectory 再返回，阅读位置不被强制跳到底部；
7. 页面刷新和 SSE replay 后 active view、Composer 和滚动边界一致；
8. `document`、`body` 和 workspace 外层不存在非预期的垂直/水平滚动条；
9. 浏览器在 `http://127.0.0.1:3210/` 上完成验证，且每轮验证前重启该端口服务；
10. 相关浏览器证据记录在阶段文档或对应 issue 文档中。

## 12. 来源、许可证与复用边界

本方案参考 DSH MIT 仓库的公开源码和文档，来源包括：

- `D:\Develop\deepseek-harness-fork\LICENSE`；
- `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx`；
- `packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx`；
- `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css`；
- `packages/client/ui-conversation/src/client/chat/ChatView.tsx`；
- `packages/client/ui-conversation/src/client/contract/slots.ts`；
- `packages/client/ui-trajectory/src/client/TrajectoryView.tsx`；
- `packages/client/ui-trajectory/src/client/views.module.css`；
- `packages/client/ui-trajectory/src/client/TrajectoryTable.module.css`；
- `packages/client/ui-trajectory/README.zh.md`。

当前文档只记录结构和行为参考。若后续直接复制或大量改编 DSH 代码，必须同步更新 `docs/source-reuse-register.md`，保留许可证和版权声明，并单独提交。

