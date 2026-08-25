# Conversation / Trajectory 视图切换后的滚动边界异常

状态：`open`

记录日期：2026-08-25

范围：Phase 8 Web 收敛，UI 布局与滚动容器问题

本记录只描述问题、证据和 DSH 对照实现。本轮不修改运行代码。

## 1. 用户观察到的现象

### 1.1 打开 Trajectory

复现路径：

1. 进入一个已有对话的 Session；
2. 点击顶部 `Trajectory` 标签；
3. 尝试查看轨迹内容或返回 `Conversation`。

现象：

- Trajectory 内容直接顶到页面顶部；
- 视图标签不再保持稳定的顶部位置；
- `Conversation` 标签可能被内容覆盖、挤出可点击区域，或无法正常返回。

### 1.2 返回 Conversation

复现路径：

1. 在 Trajectory 状态下点击 `Conversation`，或刷新后回到 Conversation；
2. 尝试滚动对话并再次打开 Trajectory。

现象：

- 对话内容顶到页面顶部并出现溢出；
- 页面整体滚动边界与中间内容滚动边界混在一起；
- `Trajectory` 标签可能被内容遮挡，无法再次点击；
- Conversation 与 Trajectory 不能稳定地来回切换。

用户截图：

- `codex-clipboard-63bc767b-1e81-4a39-ad64-67fb51665d60.png`：打开 Trajectory 后的布局异常；
- `codex-clipboard-21a006ee-31ef-4871-b991-8642c53ff161.png`：返回 Conversation 后的布局异常。

## 2. 当前项目的结构证据

实现入口：[`apps/web/index.html`](../apps/web/index.html)

当前 `workspace` 直接包含以下多个兄弟节点：

```text
workspace
├─ workspace-header
├─ session-view-tabs
├─ connection-banner
├─ queue-dock
├─ goal-bar
├─ conversation
└─ composer-shell
```

当前 CSS 的核心定义是：

```css
.workspace {
  display: grid;
  grid-template-rows: 60px minmax(0, 1fr) auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.conversation {
  min-height: 0;
  overflow: auto;
}
```

初步判断，最可疑的结构问题是：`workspace` 只声明了 3 个 grid row，但实际直接子元素超过 3 个。`connection-banner`、`queue-dock`、`goal-bar`、`conversation` 和 `composer-shell` 会进入隐式 grid row，导致“顶部固定区、内容滚动区、Composer”没有形成一个明确的中心列布局。不同内容高度和视图切换时，浏览器会重新计算隐式行，可能把标签、内容和 Composer 推到互相覆盖或溢出的位置。

这只是当前问题的初步根因，后续修复前仍需要在 `http://127.0.0.1:3210/` 通过浏览器检查实际 computed layout、scrollHeight/clientHeight、滚动元素和切换后的 DOM 层级。

## 3. 现有 DSH 对照文档的覆盖情况

现有文档：[`docs/dsh-frontend-reference.zh-CN.md`](dsh-frontend-reference.zh-CN.md)

已有相关内容：

| 文档位置 | 已有结论 | 对本问题的帮助 |
|---|---|---|
| 第 2 节 | Conversation 是固定中心列，Details 是独立列；布局通过稳定的列树和拖拽偏好求解 | 说明视图切换不能改变中心列的外层几何 |
| 第 3 节 | 对话滚动容器与 Composer dock 分离；流式更新不重建整个 transcript；用 anchor 恢复阅读位置 | 说明滚动状态不能依赖整个页面重排 |
| 第 8 节 | Trajectory 更适合作为低频诊断内容；主对话保留摘要 | 说明 Trajectory 是视图内容，不应破坏主对话壳 |
| 第 9 节 | Composer、Disclosure、浮层和滚动区域采用统一布局边界 | 提供交互层面的约束 |

不足之处：现有文档没有明确写出以下“视图切换滚动契约”：

1. Session header 和 view tabs 必须位于 transcript scrollport 外部；
2. Conversation / Trajectory 只能挂载在同一个稳定的 active-body scrollport 内；
3. Trajectory 的长列表可以拥有自己的内部纵向滚动区，但不能让整个页面或标签栏成为滚动内容；
4. Composer 必须在 active-body 内通过 sticky/overlay seat 布局，并为内容预留实时高度；
5. 视图切换应保持 DOM/布局身份稳定，并按视图保存或恢复阅读位置。

## 4. DSH 源码中的具体对照实现

DSH 仓库：`D:\Develop\deepseek-harness-fork`

### 4.1 外层结构：Header 在滚动区外

主要文件：

- `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx`
- `packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx`
- `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css`

DSH 的结构可以抽象为：

```text
ConversationRoot
├─ ConversationSessionHeader
│  ├─ session title / breadcrumbs
│  └─ Conversation / Trajectory tabs
└─ scrollBody[data-conversation-scroll]
   ├─ ConversationSession
   │  └─ viewArea
   │     └─ active view (Conversation 或 Trajectory)
   └─ composerSeat
      └─ sticky Composer / pending interaction takeover
```

关键实现约束：

- `.root` 使用纵向 flex，并占满中心列高度；
- `.header` 使用 `flex: none`，不参与内容滚动；
- `.scrollBody` 使用 `flex: 1`、`min-height: 0`、`overflow-y: auto` 和 `overflow-x: hidden`；
- active view 只通过 `conversation.view` slot 在 `viewArea` 中切换；
- Composer 作为 `composerSeat` 留在同一个 active-body scrollport 中，并在 active 状态下 `position: sticky; bottom: 0`。

因此切换视图时，标签栏没有被替换到内容列表内部，也不会随着 Conversation 或 Trajectory 的内容滚动到页面顶端。

### 4.2 Conversation 的滚动目标是稳定的 scrollport

主要文件：

- `packages/client/ui-conversation/src/client/chat/ChatView.tsx`
- `packages/client/ui-conversation/src/client/contract/slots.ts`

DSH 使用：

```ts
from.closest('[data-conversation-scroll]')
```

来解析真正的滚动容器。ChatView 的滚动、回到底部、向前分页和 anchor 恢复都针对这个容器，而不是针对任意父节点或整个页面。

DSH 还为每个 Session 保存：

- 稳定的 `anchorKey`；
- anchor 相对于 scrollport 顶部的 `anchorTop`；
- `scrollTop` 兜底值。

视图切换重新挂载 Conversation 时，会从该记录恢复阅读位置；若用户原本在底部，则继续执行尾部跟随。

### 4.3 Trajectory 的滚动是“视图内部滚动”

主要文件：

- `packages/client/ui-trajectory/src/client/TrajectoryView.tsx`
- `packages/client/ui-trajectory/src/client/views.module.css`
- `packages/client/ui-trajectory/src/client/TrajectoryTable.module.css`

Trajectory 根节点带有：

```html
data-conversation-composer-overlay
```

这会让 ConversationRoot 对 Trajectory 采用专门的 overlay 布局：

- `viewArea` 保持全高但 `min-height: 0`；
- Trajectory 根节点占满可用高度并 `overflow: hidden`；
- Trajectory table 自己设置 `overflow-y: auto`；
- Composer overlay 固定在 active-body 底部；
- Trajectory 通过 `--dsh-composer-height` 和 bottom clearance 为最后几行保留可达空间。

DSH 的 Trajectory README 也明确说明：Composer 浮在全高 ledger 上方，响应式纵向滚动容器必须预留 Composer 的实时高度，保证用户仍能滚到最后几行。

这与当前项目“把 Trajectory 内容直接塞进 `#conversation`，再让 `#conversation` 统一 `overflow: auto`”的做法不同。当前项目没有独立的 active-body、viewArea 和 Trajectory 内部 scrollport，因此更容易发生标签被内容推走或整个页面滚动的情况。

### 4.4 视图选择只改变 active view，不改变外层壳

主要文件：

- `packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx`
- `packages/client/ui-conversation/src/client/contract/views.ts`
- `packages/client/ui-trajectory/src/client/index.ts`

DSH 通过 per-session view store 保存当前 view id；Header 从 view ring 投影标签，Session body 只渲染当前 active view。未注册或过期的 view id 会回退到 Chat，而不会让整个 Session shell 进入空白或异常布局。

## 5. 与当前问题的对应结论

可以确认，DSH 有与本问题直接相关的具体实现参考，但它不是一个单独的“切换按钮修复”，而是一套布局契约：

```text
固定 Header / Tabs
        ↓
唯一 active-body scrollport
        ├─ active Conversation 或 Trajectory
        └─ sticky/overlay Composer seat
```

当前项目应优先围绕这条契约排查：

1. 消除 `workspace` 多个隐式 grid row；
2. 为 tabs、可选 banner/dock、内容区和 Composer 建立明确的 center-column/body 结构；
3. 确定唯一的 active-body scrollport；
4. 让 Conversation 与 Trajectory 都挂载到该 scrollport 的 active view 区域；
5. 若 Trajectory 需要大列表，再让 Trajectory 自己拥有内部 scrollport；
6. 将 Composer 的 sticky/overlay 和内容底部 clearance 纳入同一套布局；
7. 后续再补充按 Session / view 保存阅读位置的恢复策略。

本轮不直接修改以上代码，避免在没有浏览器 computed-layout 和滚动数据证据时盲目调整 CSS。

## 6. 后续修复验收标准

- Conversation 和 Trajectory 标签始终位于固定可见区域，并可重复点击；
- 切换视图不会把内容顶到页面顶部覆盖标签；
- 页面只有一个明确的中心 active-body scrollport；
- Conversation 内容不会溢出到整个页面，Trajectory 内容不会改变标签栏位置；
- Trajectory 长列表滚动不会吞掉 Header/Tabs 的点击区域；
- Composer 不遮挡内容末尾，且不会把标签栏推出可视区；
- Conversation → Trajectory → Conversation 可以连续往返至少 10 次；
- Session 切换、页面刷新、SSE replay 和 API 重启恢复后布局仍正确；
- 浏览器检查不存在非预期的 body/document 滚动条或横向溢出；
- 后续实现需在 `http://127.0.0.1:3210/` 重启服务后验证，并保留截图或浏览器证据。

## 7. 暂不包含

- 本轮不修改 `apps/web/index.html` 或其他运行代码；
- 不继续改造 Planning 侧栏；
- 不恢复 Reasoning / Effort 控件；
- 不在本问题中扩展完整 Trajectory 诊断功能；
- 不改变 Event、Tool、Task、Permission 或 Workspace contract。

