# DSH 三栏 Shell 与可调宽度实现指导方案

状态：guidance

记录日期：2026-08-25

用途：作为本项目后续实现三栏 Shell、Sidebar/Details 可调宽度和窄屏让步行为的唯一 UI 指导文档。本轮只完成调研和方案记录，不修改布局代码。

本方案以 D:\Develop\deepseek-harness-fork 为行为参考，将 DSH 的职责边界映射到本项目的 Web Shell。实现时继续使用本项目的 API、SSE、EventStore、Session projection 和 typed browser bridge，不暴露 DSH 内部类型，不复制 DSH 品牌资源或产品文案。

关联文档：

- [DSH Web 前端对照文档](dsh-frontend-reference.zh-CN.md)
- [DSH Conversation / Trajectory 实现指导方案](dsh-conversation-trajectory-implementation-guide.zh-CN.md)
- [Phase 8 开发日志](../archive/development-log/phase-8-productization.zh-CN.md)
- [阶段状态](../archive/phases/phase-status.zh-CN.md)

## 1. 治理七问

1. **Phase**：Phase 8.0 Web 对齐，三栏 Shell 与可调宽度。
2. **问题类型**：Web Shell 几何、临时 UI 状态、响应式布局、鼠标/键盘拖拽和滚动边界。
3. **契约影响**：不改变 Event、Tool、Task、Permission 或 Workspace contract；新增内容只属于 Web layout state、纯布局 presenter 和 DOM 交互。
4. **DSH 参考入口**：packages/client/ui-layout/src/client/columns.ts、AppFrame.tsx、AppFrame.module.css、stores.ts、service.ts 及 ui-layout/tests/*。
5. **上游来源**：本轮是 behavior-reference，不复制 DSH 代码；已有 docs/../source-reuse-register.md 的 DSH-003 覆盖 ui-layout 行为参考，无需新增代码来源登记。
6. **验收场景**：桌面三栏同时存在、Sidebar/Details 独立拖拽、空间不足时按固定让步链收缩、窄屏自动折叠 Sidebar、Session 切换不产生错位、拖拽和键盘操作不抖动、刷新/重连不改变事件事实。
7. **回滚**：实现阶段保留当前 inline Shell fallback；若新 computeColumns 或新 frame mount 失败，移除 typed layout bridge 和新 CSS，即可恢复当前 Sidebar-only resizer 与 Details overlay，不影响 Runtime、API、EventStore 和已有会话历史。

## 2. DSH 的实际布局模型

### 2.1 固定树位置

DSH 的 AppFrame 只有一个根 frame，三列顺序固定为：

    ┌──────────────┬──────────────────────────────┬──────────────┐
    │ Sidebar      │ Center / Conversation        │ Details      │
    │              │                              │              │
    └──────────────┴──────────────────────────────┴──────────────┘

AppFrame 直接写入：

    grid-template-columns: <sidebar px> minmax(0, 1fr) <details px>

三个 occupant 从首次渲染开始就处在自己的列中：

- Sidebar slot 位于第一列；
- Conversation slot 位于第二列；
- Details slot 位于第三列；
- shell.overlay 位于 frame 内的绝对定位 overlay layer，不参与列宽计算。

Details 关闭时第三轨为 0px，Details 子树仍然挂载。这样做可以保持 DOM identity、折叠状态、选中记录和局部滚动状态；关闭/打开不会把 Details 当作新的页面重新创建。

### 2.2 当前项目的结构差距

当前 apps/web/index.html 的 #app 虽然声明了 grid，但实际列只有：

    sidebar | 4px resizer | center

#details-panel 使用 position: fixed、transform: translateX(...) 和 --details-width，因此它是覆盖在 Center 上方的抽屉，不是真正的第三列。details-open 与 details-collapsed 目前没有把 Details 纳入 grid track，Details 的开关只改变 transform。

| 区域 | 当前实现 | DSH 目标 | 后续处理 |
|---|---|---|---|
| Sidebar | ShellLayoutState.sidebarWidthPx + 单一 resizer | 宽度偏好与渲染宽度分离 | 保留 typed state，迁移到统一列求解器 |
| Center | minmax(0, 1fr) | 让步链最后承压 | 由 computeColumns() 输出剩余宽度 |
| Details | fixed overlay，只有开/关 | 第三 grid track，0 宽关闭 | 改为 frame 的第三列，保留子树挂载 |
| 拖拽 | 每次 pointermove 直接写状态 | pointer capture + rAF 合帧 | 统一 Sidebar/Details DragHandle |
| 拖拽基准 | 使用存储的 Sidebar 偏好宽度 | 使用拖拽开始时的实际渲染宽度 | 防止让步压缩时第一次拖拽跳变 |
| 响应式 | desktop > 900、tablet/mobile 两档 | DSH 1024px Sidebar auto-collapse + mobile overlay | 保留 600px mobile 体验，补齐 1024 让步语义 |
| 偏好持久化 | inline 代码写入 localStorage | root-level transient store，不写 localStorage | 默认按 DSH 移除浏览器事实缓存 |

## 3. DSH 的宽度状态和纯求解器

### 3.1 几何常量

DSH 在 columns.ts 中集中定义几何契约：

    CENTER_MIN            = 640
    SIDEBAR_MIN           = 264
    SIDEBAR_MAX           = 420
    SIDEBAR_DEFAULT       = 280
    SIDEBAR_COLLAPSED     = 56
    SIDEBAR_AUTO_COLLAPSE = 1024
    DETAILS_MIN           = 300
    DETAILS_MAX           = 520
    DETAILS_DEFAULT       = 360

这些数值不是 CSS 中各自散落的 magic number。拖拽 clamp、grid 计算、separator ARIA 和单元测试都必须引用同一组常量。

### 3.2 偏好宽度和实际宽度分离

DSH 的 layout store 保存的是用户偏好：

    sidebar: number       // 0 表示宽屏状态下关闭；非 0 是 Sidebar 偏好宽度
    details: number       // 0 表示关闭；非 0 是 Details 偏好宽度
    narrow: boolean       // 当前 frame 是否低于 auto-collapse 断点
    narrowExpanded: boolean // 窄屏下用户是否手动重新展开 Sidebar

computeColumns() 的输出才是当前 frame 的实际渲染宽度。窄屏自动折叠、Details 因空间不足派生为 0 宽，都不能偷偷覆盖用户的原始偏好；窗口重新变宽时，纯函数会恢复到偏好宽度。

### 3.3 固定让步链

computeColumns(viewport, sidebarPreference, detailsPreference) 是无副作用纯函数，顺序必须保持不变：

    1. 先按 Sidebar 偏好、Details 偏好计算；Center 保持至少 640px。
    2. 如果空间不足，先把 Details 压到至少 300px。
    3. Details 最小值仍无法保住 Center 时，派生关闭 Details（渲染 0px）。
    4. Sidebar 不自动让步；最后由 Center 吸收剩余空间，即使低于 640px。

等价伪代码：

    const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clamp(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
    const d0 = details === 0 ? 0 : clamp(details, DETAILS_MIN, DETAILS_MAX)

    if (s + d0 + CENTER_MIN <= viewport) {
      return { sidebar: s, center: viewport - s - d0, details: d0 }
    }

    const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - CENTER_MIN)
    if (s + d1 + CENTER_MIN <= viewport) {
      return { sidebar: s, center: CENTER_MIN, details: d1 }
    }

    return { sidebar: s, center: Math.max(0, viewport - s), details: 0 }

重要边界：CENTER_MIN 是正常让步阶段的保护线，不是所有 viewport 下的硬约束。极窄窗口最终允许 Center 低于该值，避免让 Sidebar 或 Details 不受控地缩小。

### 3.4 典型数值

| frame 宽度 | Sidebar 偏好 | Details 偏好 | 实际 Sidebar | 实际 Center | 实际 Details | 说明 |
|---:|---:|---:|---:|---:|---:|---|
| 1920 | 280 | 360 | 280 | 1280 | 360 | 全部偏好宽度可容纳 |
| 1250 | 280 | 360 | 280 | 640 | 330 | Details 先让步，Center 保持下限 |
| 1210 | 280 | 360 | 280 | 930 | 0 | Details 最小值仍挤压 Center，派生关闭 |
| 700 | 280 | 0 | 280 | 420 | 0 | Details 已关闭，Center 最后承压 |
| 1920 → 1100 → 1920 | 280 | 360 | 280 | 820 / 920 | 0 / 360 | 变窄不覆盖偏好，变宽自动恢复 |

上表是纯求解器输入为 sidebar=280 的结果。实际 AppFrame 在低于 SIDEBAR_AUTO_COLLAPSE 时还会先把 Sidebar 的有效输入改为 rail 或手动重展开状态，见下一节。

## 4. 窄屏和面板状态机

### 4.1 Sidebar auto-collapse

DSH 的断点由 AppFrame 读取，而不是塞进纯求解器：

- viewport < 1024：Sidebar 默认渲染为 56px rail；
- narrowExpanded=false：Sidebar slot 收到 collapsed=true，不显示 Sidebar 拖拽手柄；
- 窄屏点击 Sidebar toggle：只翻转 narrowExpanded，不修改原有 Sidebar 宽度偏好；
- narrowExpanded=true：Sidebar 使用原偏好宽度（若宽屏偏好为关闭，则使用 SIDEBAR_DEFAULT），Center 吸收挤压；
- 回到 viewport >= 1024：清除窄屏 override，恢复宽屏偏好；
- 跨过断点时必须清除 narrowExpanded，避免下次进入窄屏继承上一次的临时展开。

这与“窄屏永远把 Sidebar 偏好写成 56px”不同。56px 是当前渲染结果，不是用户偏好。

### 4.2 Details 生命周期

DSH 通过当前 Session projection 判断 Details 是否有意义：

- 无当前有效 Session：传给求解器的 Details 输入为 0；Details 子树仍挂载；
- 当前 Session 从 A 切换到 B：useLayoutEffect 关闭 Details，避免把 A 的 inspector 留在 B 上；
- 首次从空 Session 变成有效 Session：不自动打开 Details；
- Details 的打开使用 DETAILS_DEFAULT，已经打开时保留当前宽度；
- 关闭后宽度状态写为 0，下一次打开回到默认宽度；
- Details 派生为 0 宽只是当前 frame 的空间结果，不能误写为永久关闭事件。

Planning 侧栏在本阶段只保留现有可折叠行为，不借布局重构扩展其信息架构；Reasoning/Effort 不属于本次 Shell 改造。

## 5. DSH 的拖拽实现

### 5.1 通用 DragHandle 规则

DSH 的 AppFrame.tsx 只有一个拖拽组件，side 决定方向和 CSS：

1. pointerdown：preventDefault()，调用 setPointerCapture(pointerId)，记录 clientX，记录拖拽开始时的实际渲染宽度。
2. pointermove：只有仍持有 pointer capture 才处理；更新 latest X；同一帧只安排一个 requestAnimationFrame。
3. rAF：用 latestX - originX 计算 delta，调用 Sidebar/Details action。
4. pointerup：释放 capture；取消尚未执行的 rAF；同步提交最后位置；结束 dragging 状态。
5. pointercancel/卸载：清理 pending frame 和 dragging 状态。

拖拽基准使用实际渲染宽度非常关键。比如 Details 偏好为 360，但当前 viewport 让它只渲染 330；用户从 330px 边缘向右拖 10px，结果应是偏好 320px，而不是从 360px 再减 10px 造成跳变。

### 5.2 方向和句柄显示

    Sidebar handle：拖动向右 => Sidebar 变宽
    Details handle：拖动向左 => Details 变宽

- Sidebar 折叠成 rail 时不显示 Sidebar handle；
- Details 实际宽度为 0 时不显示 Details handle；
- Details handle 是跨越边界的 8px hit strip，视觉 pill 默认透明，hover/focus/drag 时显现；
- handle 必须位于 frame 上层，不能被 sidebar 或 details 的 overflow:hidden 裁掉；
- 拖拽期间 frame 和 handle 取消 grid/left transition，否则鼠标已经移动而列边界还在缓动，造成“抓不住”的感觉。

### 5.3 本项目当前拖拽代码的风险

当前 apps/web/index.html 的 Sidebar resizer 有以下差异：

- 每个 pointermove 都直接调用 setSidebarWidth()，没有 rAF 合帧；
- 虽然调用了 setPointerCapture，但 move/up 路径没有按 capture 状态做严格门控；
- 拖拽起点使用 state.layout.sidebarWidthPx，不是当前让步后的实际宽度；
- 没有 Details resizer；
- setSidebarWidth() 每次拖动都写入 localStorage，导致拖拽事件与浏览器持久化耦合；
- #details-panel 是 fixed overlay，所以拖拽它无法参与 Center/Details 的空间让步。

实现新 Shell 时应先拆出统一的 DragHandle 和纯列求解器，再删除旧的 inline listener，避免两套拖拽逻辑同时写布局状态。

## 6. CSS、DOM 与滚动责任

### 6.1 目标 DOM

后续实现应收敛成以下树形关系：

    #app.app-shell / .frame
    ├─ .sidebar-col
    │  └─ #sidebar-panel
    ├─ .center-col
    │  └─ main.workspace
    │     └─ ConversationRoot（Header/Tabs/scrollBody/Composer seat）
    ├─ .details-col
    │  └─ #details-panel
    ├─ .shell-overlay-layer
    │  └─ Modal / permission / menu overlay
    ├─ SidebarDragHandle
    └─ DetailsDragHandle

Details 不应继续使用 position: fixed 作为桌面主布局。Modal、permission dialog、session menu 等真正的 overlay 才放在 overlay layer；普通 Details 内容必须受第三列的 min-width: 0; overflow: hidden 约束。

### 6.2 Header、Conversation、Trajectory 的滚动边界

三栏 Shell 只负责列宽和列级裁剪，不重新发明 Conversation/Trajectory 的滚动模型。必须继续遵守 Conversation / Trajectory 指导方案：

- Header 与 Conversation/Trajectory tabs 位于 transcript scrollport 外；
- Center column min-width: 0; min-height: 0; overflow: hidden；
- active view 使用自己的内部滚动区；
- Composer 通过已有 seat/sticky/overlay 规则占据底部空间；
- Details 内容只在 Details column 内滚动；
- 不允许把滚轮责任交给 body 或整个 #app。

这样做可以同时解决“Trajectory 顶到页面顶端”和“红框内滚轮不生效”两类问题：Shell 提供稳定高度，active view 再在自己的 scrollport 中消费滚轮。

### 6.3 transition 和无障碍

- frame 的列变化可以有短 transition；prefers-reduced-motion: reduce 时关闭；
- 拖拽期间必须关闭 frame 和 handle transition；
- separator 使用 role=separator、aria-orientation=vertical、aria-valuemin/max/now、tabindex=0；
- 保留当前 Sidebar 的 Arrow/Home/End 键盘调整；Details separator 使用相同模式；
- 面板开关同步 aria-expanded 和 aria-controls；
- 关闭 Details 后，不应让 0 宽的子树遮挡焦点；可在关闭时把焦点返回触发按钮；
- 不用 cursor: wait 或持续 spinner 表达布局拖拽/Agent running 状态。

## 7. 面向本项目的实现映射

### 7.1 建议新增或调整的模块

| 模块 | 目标职责 | 备注 |
|---|---|---|
| apps/web/src/shell/columns.ts | CENTER_MIN、clamp、computeColumns() | 纯函数，无 DOM、无 EventStore、无 breakpoint 副作用 |
| apps/web/src/shell/layout.ts | width preference、open/close、narrow override、render intent | 保持 layout state 为 Web transient state |
| apps/web/src/shell/app-frame.ts | 找到 frame/slots、写入 grid tracks、同步 ARIA | 不负责 Conversation/Details 内容事实 |
| apps/web/src/shell/drag-handle.ts（或等价 inline adapter） | pointer capture、rAF、pointerup/cancel 清理 | Sidebar/Details 共享相同实现 |
| apps/web/index.html | 只保留 frame markup 和最小 fallback | 删除旧 Details fixed overlay 和重复 pointer listener |

### 7.2 目标状态和 action 语义

目标 Web layout state 可以采用以下等价模型；名称可以根据当前 typed bridge 调整，但语义不能改变：

    interface ShellLayoutState {
      sidebarWidthPx: number   // 0 表示宽屏关闭；偏好宽度不等于当前渲染宽度
      detailsWidthPx: number   // 0 表示关闭
      narrow: boolean
      narrowExpanded: boolean
      mobileSidebarOpen: boolean
    }

最小 action 集合：

    set-sidebar-width(width)
    set-details-width(width)
    toggle-sidebar()
    set-narrow(narrow)
    toggle-details()
    open-details()
    close-details()
    open-mobile-sidebar()
    close-mobile-sidebar()
    set-viewport(viewport)

这些 action 只更新浏览器中的 layout state。不要把面板宽度、拖拽中间态或折叠状态追加到 EventStore，也不要让 Web 自己生成 Session/Turn/Tool 事实。

### 7.3 应用顺序

1. 读取 frame 自身 ResizeObserver 宽度，而不是只读取 window.innerWidth；嵌入式窗口、Details/侧栏状态和浏览器缩放都可能改变 frame box。
2. 根据 viewport 和 layout state 派生有效 Sidebar preference。
3. 使用 computeColumns() 得到 { sidebar, center, details }。
4. 一次性写入 grid-template-columns、collapsed data attributes 和 separator 位置。
5. 根据 session projection 决定 Details 输入是否为 0；不在渲染函数里重新拼 Event。
6. 只有用户拖拽/键盘操作才调用 layout action；窗口 resize 只重新计算 projection，不覆盖偏好。

## 8. 分阶段实施计划

### 阶段 A：纯模型和测试

- 新增 columns.ts 及 computeColumns() 单元测试；
- 将 DSH 的 1/2/3 步让步链、边界、恢复、极窄 viewport 固化为 fixture；
- 扩展 layout state 测试，覆盖 narrow override、Details 0 宽和 Session 切换；
- 此阶段不改变 DOM 和视觉。

### 阶段 B：三栏 frame

- 把 Details 从 fixed overlay 改为第三 grid track；
- 保留 Details 子树挂载，关闭时输出 0px；
- 将 Modal、Permission、Session menu 放到 overlay layer；
- 删除 details-open 对 fixed transform 的依赖；
- 先保持现有 Conversation/Trajectory 内部滚动实现不变。

### 阶段 C：双向拖拽

- 引入共享 DragHandle；
- Sidebar 和 Details 都用 pointer capture + rAF；
- 用实际渲染宽度作为 drag base；
- 增加 pointercancel、unmount 清理和 transition pause；
- 将旧 inline pointermove/localStorage 写入逻辑删除，防止双写。

### 阶段 D：响应式与无障碍

- 接入 1024px Sidebar auto-collapse、56px rail 和 narrowExpanded；
- 保留 600px mobile overlay；
- 为两个 separator 加 ARIA 和键盘操作；
- 在 600/900/1024/1250/1920 viewport 做截图和 console smoke。

### 阶段 E：收口和 checkpoint

- 删除旧 CSS 重复选择器、fixed Details fallback 和旧 resizer listener；
- 运行 pnpm typecheck、Web tests、build、git diff --check；
- 重启并使用 http://127.0.0.1:3210/ 做真实浏览器验证；
- 更新 Phase 8 开发日志，创建独立提交；未完成前不把本项标记为完成。

## 9. 验收矩阵

### 9.1 纯函数/状态

| 场景 | 预期 |
|---|---|
| 1920px，280/360 偏好 | 280 / 1280 / 360 |
| 1250px，280/360 偏好 | 280 / 640 / 330 |
| 1210px，280/360 偏好 | 280 / 930 / 0 |
| Details 关闭 | Details 输出 0，子树仍挂载 |
| Sidebar 宽屏关闭 | 输出 56px rail，不显示 Sidebar handle |
| 980px 首次进入 | 自动 rail，原 Sidebar 偏好不丢失 |
| 980px 手动展开 | 使用原偏好，Center 吸收空间 |
| 980 → 1920 | 清除 narrow override，恢复原偏好 |
| Session A → B | 关闭 Details，避免 A inspector 留在 B |
| 无 Session → 首次 Session | Details 仍关闭，不自动弹出 |

### 9.2 交互/视觉

- Sidebar 向右拖动增加宽度，Details 向左拖动增加宽度；
- 两个 handle 的拖拽边界与鼠标同步，无明显滞后或跳变；
- release/cancel 后没有残留 resizing、全局 col-resize 或 pending rAF；
- Details 关闭时 Center 占据剩余空间，页面无横向溢出；
- Header、Conversation/Trajectory tabs、Composer 在三栏变化后仍可点击；
- Trajectory 的滚轮只在其内部 scrollport 滚动，Details 不抢滚轮；
- 面板状态变化不会新增 Event、Tool、Task、Permission 或 Workspace 事件；
- 浏览器 Console 没有 error/warning；
- 页面刷新、SSE 重连和 Session 回放后，布局只是 transient UI 状态，事件历史不变。

### 9.3 必跑命令和运行环境

    pnpm typecheck
    pnpm --filter @coding-agent/web test
    pnpm build:web
    git diff --check

真实页面验证必须：

1. 重启 http://127.0.0.1:3210/ 对应的 Web 服务；
2. 在该地址覆盖 600、900、1024、1250、1920 viewport；
3. 检查 Sidebar/Details 拖拽、键盘 separator、Session 切换、Conversation/Trajectory 切换和浏览器 Console；
4. 记录截图或可复现操作，写入本项开发日志。

## 10. 不包含的内容

- 不在本项恢复 Reasoning/Effort 控件；
- 不扩展 Planning 侧栏的信息架构；
- 不改 Event/Tool/Task/Permission/Workspace contract；
- 不把 DSH 的 React/Cordis 内部类型引入本项目；
- 不复制 DSH 品牌、图标、产品文案或完整插件平台；
- 不将 localStorage 当作 Runtime 事实来源；
- 不借 Shell 重构顺便修改 ToolRow、Composer Send/Stop 或权限请求投影。

## 11. 完成定义与回滚

本指导项在以下条件全部满足后才可标记为完成：

- computeColumns() 和 layout reducer 有覆盖让步链、窄屏和恢复的测试；
- Details 已经是真正第三列，关闭为 0px 且子树保持挂载；
- Sidebar/Details 双向拖拽具备 pointer capture、rAF、cancel 和 transition pause；
- 旧 fixed Details、重复 listener 和 localStorage 双写路径已删除或明确保留为不可达 fallback；
- 600/900/1024/1250/1920 浏览器矩阵通过，Trajectory/Conversation 的滚动责任没有回归；
- 开发日志、测试证据和独立 Git checkpoint 已建立。

若实现引入回归，优先回滚本项独立 checkpoint，恢复现有 layout.ts、app-frame.ts 和 inline Shell fallback。回滚只影响 Web layout projection，不回滚 Runtime 事件、Session 数据或工具执行结果。

