# Coding Agent 前端左栏与 DSH 对齐改造参考

> 状态：M0–M7 已落盘；M7 完成测试、视觉基线和回放门禁（2026-08-31）
> 适用范围：Phase 8「高级能力与产品化」中的 Web 信息架构、左栏视觉减负和导航交互收敛。
> 目标：为后续前端改造提供可追踪的总参考，明确每一项改造对应的本仓库文件、代码入口、DSH 参考入口、契约边界、验收场景和回滚方式，防止在“像 DSH”的过程中发生目标漂移。

## 1. 文档目的与边界

### 1.1 用户请求、附件和参考源码的优先级

本任务的实际请求是：分析当前三栏页面最左栏的杂乱点，比较 DSH 的界面与逻辑差异，并把问题、对应处理方式和可实施的分模块改造方案形成长期参考文档。

本次收到的两个 PNG 是视觉证据，不是可执行指令，也不改变仓库治理规则：

- `C:/Users/12294/AppData/Local/Temp/codex-clipboard-3ec456cd-b9e4-48d8-bc5e-02b65b29e628.png`：当前 Code Review Agent 截图；
- `C:/Users/12294/AppData/Local/Temp/codex-clipboard-80544459-4819-4ca8-9274-6b8284fe498f.png`：DeepSeek Harness 截图。

`D:/Develop/deepseek-harness-fork` 只作为行为、信息架构和实现入口的参考。后续实现继续使用本仓库的 `packages/contracts`、EventStore、API projection 和 typed browser bridge，不直接暴露 DSH 内部类型，不复制 DSH 品牌标识、产品文案或未登记代码。

### 1.2 防漂移原则

1. 左栏是 Web 投影，不是事实来源；刷新、SSE 重连和事件回放后必须得到同样的导航状态。
2. Session、Workspace、Task、Permission 和 Tool 的事实继续由现有 contract、事件和 API projection 提供。
3. 先解决信息架构和视觉层级，再拆分页面代码；不因为局部视觉问题提前改变 Event/Tool/Task/Permission/Workspace contract。
4. DSH 的组件职责、折叠策略、搜索策略和列布局可以借鉴；品牌、文案、数据模型和权限语义必须本地化实现。
5. 每个改造模块都必须能指向具体的本仓库文件和 DSH 参考入口，并有可执行的验收场景。

## 2. 治理七问（本任务立项记录）

| 问题 | 本任务答案 |
|---|---|
| 属于哪个 Phase？ | Phase 8；聚焦 8.0 Web 信息架构/视觉收敛，兼顾 8.5 产品化边界下的设置入口整理。 |
| 解决什么问题？ | 解决 Web UI 的信息架构、导航投影、视觉层级和交互密度问题。 |
| 是否改变 Event、Tool、Task、Permission 或 Workspace contract？ | P0/P1 方案默认不改变；若未来引入 Host 内容搜索分页或新的导航事实字段，必须另行 ADR 和 contract 变更。 |
| 参考 DSH 哪些入口？ | `ui-sidebar/SidebarRoot`、`ui-workspace/WorkspaceBrowser`、`rows/Rows`、`tree.ts`、`stores.ts`、`ui-layout/AppFrame` 与 `columns.ts`。 |
| 是否需要登记上游代码来源或许可证？ | 当前只做行为/结构参考，不直接复制代码；若后续复制或大量改编 DSH 代码，必须同步 `docs/../source-reuse-register.md`，保留 MIT 版权声明。 |
| 验收场景是什么？ | 左栏在 600/900/1024 宽度下层级清晰；搜索、视图、排序、展开、归档、Workspace 生命周期和 Session 打开可用；刷新、重连、回放后导航一致；键盘和屏幕阅读器可操作。 |
| 如何回滚或禁用？ | P0/P1 以独立 Web feature flag 或独立提交启用；回滚仅涉及 Web projection、DOM/CSS、导航 UI 状态和测试，不回滚 EventStore 或公共 contract。 |

## 3. 调研对象与当前状态

### 3.1 当前仓库的左栏结构

当前实现仍以单一页面文件承载大部分左栏 HTML、CSS 和事件编排：

- `apps/web/index.html` 约 2939 行，包含 Shell、左栏、主区、详情区、CSS 和绝大部分 DOM 事件。
- 左栏 DOM 位于 `apps/web/index.html:711-733`：品牌与折叠、New session、Sessions 标题、Archived、Workspace 工具栏、Session 列表、Integrations、Tasks、Settings。
- `.sidebar-content` 在 `apps/web/index.html:59` 作为整体滚动容器；顶部操作、导航列表和低频面板共享同一个滚动上下文。
- Workspace 工具栏在 `apps/web/index.html:719-721` 同时显示 Tree/Flat、Recent/Name/Path 两个原生 `select` 和常驻 Search 输入框。
- Workspace 分组、Session 行和子树样式主要在 `apps/web/index.html:94-136`；Workspace 名称、完整路径、count、菜单和上下箭头同时进入常态布局。
- `state` 在 `apps/web/index.html:832` 集中保存页面临时状态；其中 `showArchived`、`expandedWorkspaces`、`sessionSearch`、`sessionView` 等导航状态尚未形成独立的持久化浏览 Store。
- `workspaceViewMode` 与 `workspaceSort` 没有在 `state` 初始对象中声明，而是在 `apps/web/index.html:2806-2807` 首次变更时动态挂载；首次渲染依赖 presenter 默认值，说明导航偏好缺少明确的状态契约。
- Shell 拖拽在 `apps/web/index.html:982-1108` 已使用 `requestAnimationFrame`、pointer capture 和实际渲染宽度基准；这部分基础不应被误判为“完全没有 rAF”，首批重点是左栏内部信息架构。
- `showSessionsTree()` 在 `apps/web/index.html:2506` 左右通过清空列表并重新写入 HTML 生成导航；这会增加刷新时的 DOM identity、焦点和过渡稳定性风险。
- `showSessionsTree()` 同时维护 typed `navigation` 分支（约 `:2508-2550`）和 fallback 分支（约 `:2552-2600`），两套 renderer 的字段、状态和交互容易逐步漂移。

### 3.2 用户截图中的直接观察

第一张截图显示：左栏在约 500px 的可见高度内同时承载了十余个 Workspace/Session、完整 Windows 路径、Session 数字计数、常驻上下排序箭头、树形缩进、Integrations/Tasks 低频区和 Settings；主区顶部也重复展示 Workspace 路径，导致路径信息在多个层级出现。

第二张 DSH 截图显示：左栏只保留品牌、New Session、Workspace 标题和三个图标操作、少量 Workspace/Session 行以及固定 Settings；Workspace 名称是主视觉，Session 只显示标题和相对时间，完整路径和更多操作被收起到 hover/menu/详情。

| 视觉维度 | 当前 Code Review Agent | DSH | 差距结论 |
|---|---|---|---|
| 首屏密度 | 同时出现多个路径、count、排序箭头、树线、状态元数据和低频分组 | 只显示必要的 Workspace/Session 行和少量图标 | 当前左栏把“导航”和“管理面板”混在一起，扫描成本更高 |
| 工具栏 | Tree、Recent、Search 等多个原生控件常驻 | Search、View options、Add workspace 以图标/菜单呈现 | 当前控件长期占据标题行，DSH 把低频选择延后 |
| Workspace 行 | 名称 + 完整 Windows 路径 + count + menu + 上下箭头 | 文件夹/名称为主，详细信息和操作按需出现 | 当前技术元数据的视觉权重过高 |
| Session 行 | 标题 + 相对时间/permission/child mode，且可递归嵌套 | 标题 + 状态点/相对时间，复杂状态进入 hover card | 当前一行承担过多解释，且多级嵌套放大纵向高度 |
| 当前项 | Session active 高亮较明确，Workspace active 依赖展开而非稳定 tint | Workspace/Session 都有明确 selected/containsCurrent 语义 | 需要把 active Workspace 从“推断”提升为显式投影 |
| 滚动 | 左栏内容整体滚动，顶部控制和 footer 可能离开视口 | 浏览列表独立滚动，顶部/底部固定 | 当前缺少稳定的操作锚点 |
| 低频入口 | Integrations、Tasks 与导航同层级常驻 | Settings 固定，其他能力通过 slot/详情承载 | 应按使用频率重新分层 |

### 3.3 本仓库与 DSH 的源码证据

| 主题 | 本仓库 | DSH 参考 |
|---|---|---|
| 左栏壳层 | `apps/web/index.html:711-733` | `packages/client/ui-sidebar/src/client/SidebarRoot.tsx:44-174` |
| 左栏滚动边界 | `apps/web/index.html:59` 的 `.sidebar-content` 整体滚动 | `packages/client/ui-sidebar/src/client/SidebarRoot.module.css:227` 的 `regionArea`；顶部与 footer 固定，列表区独立滚动 |
| Workspace 浏览 | `apps/web/index.html:719-721` + `showSessionsTree()` | `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx:741`、`:977-1154` |
| Workspace/Session 行 | `apps/web/index.html:102-136` | `packages/client/ui-workspace/src/client/rows/Rows.tsx:110` 的 `ProjectRowItem`、`:353` 的 `SessionNodeItem` |
| Tree/Flat/搜索投影 | `apps/web/src/presentation/navigation-presenter.ts:47-132` | `packages/client/ui-workspace/src/client/tree.ts:118-372`、`WorkspaceBrowser.tsx:249/546/672` |
| 浏览状态 | `apps/web/index.html:832` 页面临时 state | `packages/client/ui-workspace/src/client/stores.ts:20-83` 独立 store，`persist: 'dsh.workspace.view.v5'` |
| 三栏列求解 | `apps/web/src/shell/columns.ts`、`layout.ts`、`app-frame.ts` | `packages/client/ui-layout/src/client/columns.ts:62`、`AppFrame.tsx:40-198` |
| 本地数据契约 | `packages/contracts/src/index.ts:288-325` 的 `SessionSummary`、`WorkspaceSummary` | DSH 内部 `SessionSummary`/workspace projection；只借鉴投影职责，不直接复用类型 |

## 4. 当前左栏的杂乱点与优先级

下表将视觉问题、逻辑原因、用户影响和建议处理方式放在同一处，后续实施必须逐项关闭或明确延期。

| 优先级 | 问题 | 证据/根因 | 用户影响 | 建议处理 |
|---|---|---|---|---|
| P0 | Sidebar 职责过载 | 左栏常驻导航、Workspace 管理、排序、Integrations、Tasks、Settings；DOM 集中在 `index.html:716-732` | 主任务“找到并切换 Session”被低频功能打断 | 左栏只保留品牌、新建、Workspace/Session 浏览和 Settings；Integrations/Tasks 迁移到 Details 或低频面板 |
| P0 | 技术元数据过早显示 | Workspace 行同时显示名称、完整路径、count、菜单、上下箭头；Session 行显示标题和路径；CSS `:108-118`、`:81-84` | 视觉噪声高，窄栏中标题被截断，用户难以扫描 | 默认只显示名称/标题、状态点、相对时间；路径、permission、child mode、序列等进入 tooltip/hover card/details |
| P0 | 常驻上下移动按钮制造“编辑态” | `.workspace-order-controls` 和 `.workspace-order-button` 常驻于每个分组 `:116-119` | 每行都像可编辑表格，注意力从导航内容移向控制器 | 改为 Workspace hover menu；长期可选拖拽排序，插入标记只在拖拽中出现 |
| P0 | 搜索与视图控件占据常态空间 | Tree/Flat、Recent/Name/Path 原生 select 与 Search 输入框同排 `:719-721` | 控件风格不一致，Workspace 标题被挤压 | 默认只显示搜索图标和 View options 图标；点击后展开 Search 或 popover |
| P0 | 当前 Workspace 的 active 语义不稳定 | presenter 会输出 `activeWorkspaceKey`，但页面未始终给 Workspace header 添加稳定 active class | Session 已打开但所属 Workspace 不够明显 | presenter 明确输出 active workspace，渲染层稳定添加 active class/淡色 folder tint，并保留 aria-current |
| P0 | 滚动边界混杂 | `.sidebar-content` 整体 `overflow:auto` `:59`，顶部操作和低频区与列表共享滚动 | 列表滚动时 New session/区段边界失去锚点 | 壳层固定 header、New session、Workspace toolbar 和 footer；只让 Session list/Workspace list 滚动 |
| P1 | parent/child 递归树增加缩进与线条噪声 | presenter `:69-83` 构造递归 children；CSS `:120-125` 使用多级 padding 和 branch line | 多 Agent/fork 场景下左栏纵向膨胀、层级难读 | 普通 fork 默认作为同级 Session；`origin: subagent` 默认不进入普通侧栏；需要时在 Task/Details 查看关系 |
| P1 | 列表整体重建破坏稳定性 | `showSessionsTree()` 清空 `innerHTML` 后重建 | 可能出现闪烁、焦点丢失、行状态/hover 过渡重置 | 抽出稳定的 WorkspaceBrowser/Row 渲染器，以稳定 key/节点复用为目标；短期至少按 group/row 局部更新 |
| P1 | typed 与 fallback 两套 renderer 容易分叉 | `showSessionsTree()` 在 `:2508-2550` 与 `:2552-2600` 各维护一套 Workspace/Session HTML | 某一运行路径修复后，另一条路径仍可能显示旧字段或旧交互 | 统一为一个 presenter + 一个 row renderer；fallback 只负责能力缺失时提供相同语义的降级数据 |
| P1 | 搜索能力局限于本地元数据 | `matchesSession()` 只匹配标题、ID、workspaceRoot `navigation-presenter.ts:169-171` | 用户无法按对话内容找回历史 Session | 第一阶段保留本地搜索；第二阶段仿 DSH 增加防抖 Host 内容搜索，并把结果投影为扁平结果，需另行评估 API 契约 |
| P1 | 导航状态未独立持久化 | `state` 集中在 `index.html:832`，未见类似 DSH view store | 刷新后 Tree/Flat、排序、展开和搜索体验不稳定 | 新增 Web-only `SidebarNavigationState`，本地持久化，不进入 EventStore |
| P1 | 状态点直接暴露粗粒度 SessionStatus | `SessionSummary.status` 直接拼入 `.session-status-dot` class `:2523-2526` | pending interaction、子 Agent running 等重要状态无法形成明确优先级 | 在 presenter 中派生 running/pending/completed/failed 等展示状态，保留原始 status 供详情使用 |
| P2 | 低频管理入口与高频导航同层级 | Integrations/Tasks 使用 `details` 常驻区 `:723-730` | 左栏信息层级不符合使用频率 | 迁移到 Details/Settings；当存在待处理任务或 MCP 交互时，仅显示 badge/attention indicator |

## 5. DSH 对应处理方式与可借鉴逻辑

### 5.1 SidebarRoot：壳层只负责区域，不承载业务列表

DSH 的 `SidebarRoot` 负责宽栏/rail、折叠动画、固定 footer 和 slot 注入；Workspace 浏览由 `sidebar.workspaces` slot 提供。该职责切分使左栏壳层、Workspace 浏览器、行渲染和外部入口彼此独立。

对本仓库的启示：`apps/web/index.html` 可以保留单页入口，但应逐步把左栏拆成壳层、WorkspaceBrowser 和低频入口三个模块；`app-frame.ts` 只负责布局意图落 DOM，不应继续吸收导航业务。

### 5.2 WorkspaceBrowser：默认收敛，按需展开

DSH 的 `WorkspaceBrowser` 具备以下策略：

- 默认折叠搜索，搜索展开时压缩右侧操作区（`WorkspaceBrowser.tsx:977-1044`）；
- View options 进入菜单（`ViewOptionsMenu`，`:147-168`），不把多个原生 select 固定在标题行；
- Workspace 分组和 Session 列表分离，默认每组只显示 `COLLAPSED_SESSION_LIMIT = 5`（`:39`、`:482-533`）；
- Tree、Flat、Search 三种模式使用同一套投影和行组件（`:249`、`:546`、`:672`、`:1122-1154`）；
- 列表有自己的 scroll 区域，组间留白和“展开其余 N 条”提供稳定节奏（`WorkspaceBrowser.module.css:336-377`、`:429-446`）。

对本仓库的启示：把 `showSessionsTree()` 的过滤、排序、分组和 DOM 生成拆为纯 presenter + browser renderer；先实现默认 5 条、折叠搜索和 popover，再考虑 Host 内容搜索。

### 5.3 Rows：单行优先，详细信息延后

DSH 的 `ProjectRowItem` 和 `SessionNodeItem` 默认以轻量单行呈现：Workspace 名称、Session 标题、状态点和相对时间是首屏信息；完整路径、状态解释和复杂操作通过 hover card、tooltip 或行菜单提供。加号、菜单和拖拽插入标记只在 hover/focus/drag 时出现（`Rows.tsx:110/353`、`Rows.module.css:97-116/221-285`）。

对本仓库的启示：将 `workspaceRoot`、`permissionPreset`、`childMode`、`activeWorktreeId` 等字段继续保留在本地 projection，但从默认行移出，避免为了视觉减负而删除可恢复所需的数据。

### 5.4 tree.ts：导航是派生投影，隐藏非用户主任务节点

DSH 在 `tree.ts` 中把 Workspace/Session 列表、归档过滤、空白 New Session 和搜索结果派生为 Web 投影。`origin: subagent` 默认隐藏，普通 fork 作为同级 Session；内容搜索在派生树之外执行，最后合并为扁平结果。

对本仓库的启示：继续以 `navigation-presenter.ts` 为本地事实映射边界；可以调整默认可见性和展示层级，但不能让 DOM 自己成为第二套 Session 事实模型。

### 5.5 stores.ts：浏览状态独立于 Host 事实并持久化

DSH 的 `stores.ts` 独立保存 `groupBy`、`orderBy`、Workspace 展开状态和 Session order，并通过 `persist: 'dsh.workspace.view.v5'` 保存。这样刷新后，用户的浏览偏好恢复，而 Session 事实仍由 Host projection 提供。

对本仓库的启示：新增本地 `SidebarNavigationState`，只持久化 view mode、sort、search、archive 和 expanded workspaces；不要把这些纯 UI 偏好写入 EventStore。

### 5.6 AppFrame/columns：拖拽体验与三栏让步链

DSH 的 `AppFrame` 使用 pointer capture、rAF 和实际渲染宽度基准完成拖拽；`computeColumns()` 规定 Details 先让步、再关闭 Details，Sidebar 不让步。当前仓库的 `columns.ts`、`layout.ts` 和 `app-frame.ts` 已具备相近基础，因此建议先保持列求解器，只在后续统一拖拽手柄、rail 动画和左栏内部滚动边界。

## 6. 当前项目与 DSH 的逻辑差异

视觉差距背后存在实现逻辑差异。后续改造应优先收敛这些边界，否则只改 CSS 会很快回到当前的杂乱状态。

| 逻辑主题 | 当前项目 | DSH | 改造判断 |
|---|---|---|---|
| 事实来源 | API 返回 `SessionSummary[]` 与 `WorkspaceSummary[]`；页面 state 再进行分组、展开和 DOM 生成。 | Host-backed session/workspace store 提供稳定快照；浏览器 store 只保存浏览偏好。 | 保留本仓库的 API/Event projection 事实来源，新增 Web-only navigation store。 |
| Workspace 分组 | `buildNavigationModel()` 以规范化 `workspaceRoot` 分组，支持 workspace catalog 生命周期；保留 parent/child 递归。 | `tree.ts` 以 Host Workspace 的 `sessionIds` 顺序分组，未归属 Session 进入 Ungrouped；subagent child 不作为普通导航节点。 | 继续使用本地 catalog 和路径规范化；默认隐藏 subagent，普通 fork 扁平化。 |
| active 语义 | presenter 输出 `activeWorkspaceKey`，渲染时只负责展开相关分组；Workspace header active 样式没有形成单一稳定入口。 | `containsCurrent` 在 tree projection 中派生，`ProjectRowItem` 直接依据 projection 决定 active。 | active、expanded、selected 都由 presenter/state 明确输出，renderer 不再扫描 DOM 推断。 |
| 搜索 | `matchesSession()` 只匹配标题、ID、路径；输入事件立即触发整棵树重建。 | 本地元数据匹配 + 250ms 防抖 Host 内容搜索，合并去重为扁平 SearchResult；查询有长度/NUL 边界。 | P0 先折叠搜索并保留本地搜索；P1 再接入 bounded Host search，单独变更 API/契约。 |
| 排序与顺序 | `recent/name/path` 是页面 state；Workspace reorder 通过常驻上下箭头写入 API。 | `manual/updated` 与 Workspace/Session order account 在 store 中持久化；拖拽通过 insertion marker 写入顺序。 | 将视图选择与排序偏好移入持久化 store；按钮降级为 hover menu，拖拽作为可选增强。 |
| 展开策略 | active group 会自动加入 `expandedWorkspaces`；没有 per-group 5 条折叠上限。 | active group 自动展开；每组默认展示 5 条，剩余通过“展开其余 N 条”。 | 引入 `expandedWorkspaces` 与 `expandedSessionGroups` 两层状态，默认 5 条。 |
| 渲染稳定性 | `showSessionsTree()` 使用 `list.innerHTML = ''`，随后重新创建 section、row 和 button。 | React 组件使用稳定 key；row action、hover card 和状态更新局部重渲染。 | 先抽出稳定 row renderer，再逐步消除整棵树重建；不得把 DOM 作为第二事实源。 |
| 状态语义 | `SessionSummary.status` 直接映射 CSS class，只有 idle/queued/running/stopped/failed/interrupted 等粗粒度值。 | `Rows.tsx` 由 pending interaction、当前 Session、子 Agent activity 和 completed 派生主状态点及屏幕阅读器文案。 | 增加本地 `NavigationSessionPresentation` 派生状态，不改变原始 SessionStatus contract。 |
| 低频功能位置 | Integrations、Tasks 在同一 `.sidebar-content` 中常驻可展开。 | Sidebar 壳层通过 footer/slot 注入，Workspace browser 与低频入口职责分离。 | 将 MCP/Task 移到 Details/Settings；左栏只显示需要注意的 badge 或入口。 |
| 三栏布局 | 已有 typed layout state、columns solver、rAF resize，HTML 是 render site。 | AppFrame 直接组合 sidebar/center/details slots，并以实际渲染宽度驱动拖拽。 | 不重写 solver；把 `app-frame.ts` 的职责继续收窄为 slot/frame adapter。 |

## 7. 目标信息架构与视觉基线

### 7.1 左栏层级

目标结构固定为四层，任何新入口都必须先判断属于哪一层：

1. **Shell header**：品牌、折叠/展开；不放业务状态。
2. **Primary action**：New session；保持可见，但降低大面积高饱和蓝色的占比，使用轻量 elevated/outline 视觉。
3. **Workspace browser**：Workspace/Session 标题、搜索图标、View options、Add workspace、可滚动列表。
4. **Footer**：Settings；Integrations、Tasks 等低频入口迁移到 Details/Settings，必要时在 Workspace browser 仅显示 attention badge。

顶部控制区和 footer 必须固定；只有 Workspace/Session 列表滚动。滚动区域中不再混入工具栏和低频面板。

### 7.2 默认行信息密度

| 行 | 默认显示 | 延后显示 |
|---|---|---|
| Workspace | 文件夹图标、Workspace label、展开箭头、必要时 active tint；可选轻量 session count | 完整路径、rename/archive/delete、reorder、生命周期细节 |
| Session | 状态点、标题、相对时间；当前项使用稳定 selected fill | permission preset、child mode/provider、完整 workspace path、sequence、worktree 等 |
| Search result | 标题、Workspace label、状态点、内容摘要（若有） | 原始事件位置、完整 ID、内部 provider 信息 |

建议尺寸基线：Workspace 行约 34px、Session 行约 32–36px、组间留白 6–10px、左右内边距 8–12px。具体 token 应沿用本仓库现有 CSS 变量，并通过 600/900/1024 宽度矩阵验证，不直接复制 DSH token 名称。

### 7.3 默认行为

- Search 默认折叠；打开后聚焦输入框，Escape 清空并收起。
- View options 进入 popover，至少包含 Tree/Flat 与 Recent/Name/Path；控件关闭后只保留图标。
- 每个 Workspace 默认显示最多 5 条 Session，超过后显示“展开其余 N 条”。
- 当前 Workspace 自动展开并有淡色 active tint；当前 Session 有 selected fill 和 `aria-current`/`aria-selected`。
- 行菜单、加号、排序和删除等操作只在 hover/focus/menu-open 时出现；键盘聚焦时必须保持可见。
- `origin: subagent` 或等价 child projection 默认不进入普通侧栏；Task/Details 提供可追溯入口。
- 普通 fork 在 Flat 模式作为同级 Session；Tree 模式也不默认增加多级 branch line。
- 窄屏继续使用已有 rail/移动侧栏策略；点击 rail 的 Search 应先展开侧栏再聚焦输入框。

## 8. 模块化实施方案

以下方案按“先降噪、再收敛状态、最后拆分文件”的顺序编排。模块名称是本仓库自己的命名，DSH 仅作为职责参考。

### M0：事实与契约冻结（实施前置）

**本仓库入口**

- `packages/contracts/src/index.ts:288-325`：`SessionSummary`、`WorkspaceSummary`；
- `apps/web/src/client/api.ts`：Session/Workspace HTTP client；
- `apps/web/src/browser.ts:20-36, 66-155`：typed browser bridge，把 presenter、layout 和 API 能力注入 `index.html`；
- EventStore/API projection 相关实现保持不变。

**DSH 参考**

- `packages/client/ui-workspace/src/client/contract/slots.ts`：Workspace browser 所需的 slot/回调职责；
- `packages/client/ui-sidebar/src/client/contract/slots.ts`：SidebarRoot 与 workspace/footer/settings 的组合边界。

**实施内容**

- 不新增事实字段；明确 `SidebarNavigationState` 是 Web-only 状态；
- 对 `activeWorkspaceKey`、`selectedSessionId`、`expandedWorkspaces`、`showArchived` 的来源写入 presenter contract；
- 如需 Host 内容搜索，先新增独立 ADR、API request/response 类型和 bounded limit，不在 M0 顺手扩展。

**验收/回滚**：类型检查和现有导航测试通过；M0 无生产运行时变更，可直接撤销新增类型。

#### M0 已冻结的来源边界（2026-08-31）

本轮以最小契约注释和 presenter contract 测试完成冻结，没有引入 M4 的 reducer、localStorage 持久化或新的 API。字段的唯一来源和禁止越权如下：

| 字段 | 所有者/来源 | presenter 责任 | 明确禁止 |
|---|---|---|---|
| `selectedSessionId` | Web `SessionStoreSnapshot.sessionId`；迁移期间 `index.html` 的 `state.session?.id` 通过 bridge 传入，新的调用应使用 `NavigationOptions.selectedSessionId` | 在 `NavigationRenderIntent.selectedSessionId` 原样回显，并据此派生 `activeWorkspaceKey` | 不从 `WorkspaceSummary`、DOM 当前 class 或 EventStore 另造一份 selection；不作为 Sidebar 偏好持久化 |
| `activeWorkspaceKey` | 由 `buildNavigationModel()` 根据 selected Session、可见 Session/Workspace projection 派生 | 只输出可见分组中 selected Session 所属的规范化 Workspace key；selected Session 不可见时保持 `undefined` | 不在 API、EventStore、`WorkspaceSummary` 或本地存储中独立写入/恢复 |
| `expandedWorkspaces` | Web-only 浏览器/渲染状态；当前仍由 `index.html` 的 `state.expandedWorkspaces` 临时持有 | M0 仅在 `SidebarNavigationState` 类型中冻结其 UI 语义；M4 再接 reducer/持久化 | 不进入 `packages/contracts`、Session/Workspace 事件、EventStore 或 API mutation |
| `showArchived` | Web-only 列表过滤器；同时作为 `WebApiClient.listSessions/listWorkspaces(includeArchived)` 的 query 参数和 presenter option | 只决定返回 active/archived projection 的可见性，原始 `SessionSummary.archived`/`WorkspaceSummary.archived` 保持 host 事实 | 不因切换筛选器而修改归档事实；不把筛选状态追加为事件 |

本轮 contract 约束落在 `apps/web/src/presentation/navigation-presenter.ts`：新增 Web-only `SidebarNavigationState` 类型、`NavigationOptions.selectedSessionId`（保留 `activeSessionId` 兼容别名）和 `NavigationRenderIntent.selectedSessionId`。`apps/web/src/client/store.ts` 与 `apps/web/src/client/api.ts` 只补充来源边界注释，`apps/web/src/browser.ts` 明确 typed bridge 只暴露纯 projection。这样后续 M4 可以移动类型和接入 reducer，而无需改变事实来源或公共 contract。

**M0 改动文件**

- `apps/web/src/presentation/navigation-presenter.ts`：冻结 Web-only state 类型、selection 命名和 active Workspace 派生注释；不改变过滤/分组结果；
- `apps/web/src/presentation/navigation-presenter.test.ts`：覆盖 preferred `selectedSessionId`、兼容 `activeSessionId`、不可见 selected Session 和 Web-only state 类型契约；
- `apps/web/src/client/store.ts`：标注 `SessionStoreSnapshot.sessionId` 是当前 Web selection 来源；
- `apps/web/src/client/api.ts`：标注 `includeArchived` 仅为只读 query filter；
- `apps/web/src/browser.ts`：标注 bridge 暴露纯 navigation projection，不成为第二事实源；
- 本文档：记录 M0 的来源矩阵、实施边界、验证和回滚。

**验收命令与结果**

```powershell
pnpm typecheck
pnpm --filter @code-review-agent/web test
git diff --check
```

2026-08-31 验收结果：`pnpm typecheck` 通过；Web 36 个测试文件、151 个测试通过；`git diff --check` 通过。M0 未改动 `packages/contracts`、EventStore、API route 或生产 DOM/CSS 行为。

**M0 回滚边界**：删除上述 presenter 类型/字段回显、注释和新增测试即可回滚；保留现有 `activeSessionId` 调用路径不会影响旧 bridge。不得以 M0 回滚为由修改或回滚 EventStore、Session/Workspace 公共 contract、归档事实或 API 路由。

### M1：Sidebar shell 与滚动边界

**本仓库需要修改**

- `apps/web/index.html:715-741`：将现有 `<aside>` 重新组织为 header、primary action、browser slot、footer 四块；
- `apps/web/index.html:61, 720-740`：把 `.sidebar-content` 的整体滚动拆为固定控制区 + `.sidebar-list-scroll`；
- `apps/web/index.html:52-77, 150-153`：收敛 header、secondary、footer 的样式；
- `apps/web/src/shell/app-frame.ts:1-40`：继续只应用 layout intent，必要时补充 sidebar slot/数据属性，不承载 Session 业务；
- `apps/web/src/shell/layout.ts`、`columns.ts`：仅补充测试或可访问性属性，不改现有让步链。

**模仿 DSH 的入口**

- `packages/client/ui-sidebar/src/client/SidebarRoot.tsx:44-189`：固定 logo/new-session/region/footer，Workspace 通过 `renderSlot('sidebar.workspaces', ...)` 注入；
- `packages/client/ui-sidebar/src/client/SidebarRoot.module.css:227-238`：`regionArea` 填充中间空间，rail/宽栏由壳层控制；
- `packages/client/ui-layout/src/client/AppFrame.tsx:164-198`：三列 occupant 固定挂载，slot 负责组合。

**实现要点**

- 保持当前三栏宽度、断点和 rAF 拖拽行为；
- New session 和 Settings 固定在可见区；
- Workspace/Session list 承担唯一纵向滚动；
- 低频 Integrations/Tasks 不再和列表共享滚动上下文。

**验收/回滚**：600/900/1024 宽度截图和键盘滚动通过；回滚只恢复旧 DOM/CSS 结构。

#### M1 实施记录（2026-08-31）

本轮完成了最小可验证的 Sidebar shell 与滚动边界切片，未提前实现 M2 的 WorkspaceBrowser 文件拆分或 M4 的浏览状态持久化：

- `apps/web/index.html:61-63`：`.sidebar-content` 改为 `display:flex; flex-direction:column; overflow:hidden`，新增 `.sidebar-primary` 固定顶部控制区；原有三栏 `.app-shell`、rail/mobile 断点和 sidebar footer 结构保持不变。
- `apps/web/index.html:97-100`：`.workspace-browser` 成为可收缩的列式 flex 区域；新增 `.sidebar-list-scroll`（`min-height:0; flex:1; overflow:auto`），将 `#session-list` 放入带 `role="region"`、`aria-label` 和键盘 `tabindex` 的唯一主滚动容器。Workspace toolbar、New session 和 Archived 控件不再随列表滚动。
- `apps/web/index.html:69`：Integrations/Tasks `details.sidebar-secondary` 作为固定 shell 的低频折叠区保留在 list scrollport 之外；M6 再迁移其承载位置，本轮不改变 `renderMcp()`/`renderSubagents()` 行为。
- `apps/web/index.html:715-741`：保留 `sidebar-header`、`new-session`、`session-list`、`mcp-list`、`subagent-list`、`settings-button` 等既有 id，新增的 wrapper 仅用于布局分区，不改变 `showSessionsTree()`、REST/SSE 或 typed bridge 入口。
- `apps/web/src/shell/sidebar-shell.test.ts:1-32`：新增静态 shell 契约测试，锁定固定区域、滚动容器和 footer 的 DOM 顺序及 CSS 非滚动/滚动边界。

**M1 验收结果**

```powershell
pnpm typecheck
pnpm --filter @code-review-agent/web test
git diff --check
```

2026-08-31：`pnpm typecheck` 通过；Web 37 个测试文件、153 个测试通过（含新增 sidebar shell 2 个测试）；`git diff --check` 通过。`apps/web/src/shell/app-frame.ts`、`layout.ts`、`columns.ts` 未修改，现有三栏计算、pointer capture/rAF resize 和移动 rail 语义保持不变。

**M1 回滚边界**：删除 `sidebar-primary`/`sidebar-list-scroll` wrapper、恢复 `.sidebar-content { overflow:auto }` 和 `.workspace-browser` 原有 grid 声明即可回退；不得回滚 EventStore、Session/Workspace contract、API/SSE 或导航 presenter。M1 不需要 feature flag，若后续启用 `WEB_SIDEBAR_DENSITY_V2`，可将本切片作为其 shell 子开关。

### M2：WorkspaceBrowser（浏览器控制层）

**建议新增文件**

```text
apps/web/src/sidebar/workspace-browser.ts
apps/web/src/sidebar/sidebar-presenter.ts
```

**本仓库接入点**

- `apps/web/index.html:2506-2600` 的 `showSessionsTree()`：迁移过滤、分组、展开、空态和行装配；
- `apps/web/index.html:2804-2807` 的 archive/search/view/sort 事件：改为调用 browser controller；
- `apps/web/src/presentation/navigation-presenter.ts:47-132`：继续提供纯投影，不直接操作 DOM。

**模仿 DSH 的入口**

- `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx:147-180`：View options popover；
- `:249-543`：SessionTree、active group、5 条折叠和 overflow；
- `:546-740`：FlatList 与 SearchResults；
- `:741-880, :977-1154`：WorkspaceBrowser 的状态、搜索展开和三种渲染模式。

**实现要点**

- 默认显示 Search icon、View options icon、Add workspace icon；
- `COLLAPSED_SESSION_LIMIT = 5` 作为本地 UI 常量；
- Tree/Flat/Search 共用同一投影和 row renderer；
- 空态区分 search、archived、no active sessions；
- renderer 使用稳定 row key/DOM identity，第一阶段可采用局部 group 更新，第二阶段再完全移除整棵树重建。

#### M2 最小实施记录（2026-08-31）

本轮先交付 M2 的控制层边界切片，暂不搬移整棵 DOM renderer，也不引入 M4 的 reducer/localStorage。这样可以先固定 WorkspaceBrowser 的输入、投影和空态语义，再在后续切片安全替换 `showSessionsTree()` 的 DOM 装配。

**已实施**

- 新增 `apps/web/src/sidebar/sidebar-presenter.ts`，封装 `buildNavigationModel()` 的 Web adapter：
  - 归一化 `query`、`viewMode`、`sort`、`workspaceOrder`、`workspaceCatalog` 输入；
  - 同时接受首选的 `selectedSessionId` 和迁移期兼容的 `activeSessionId`；
  - 输出 `activeGroupKey`（由 `activeWorkspaceKey` 派生）和稳定 `emptyMessage`，使 DOM renderer 不需要自行推断 active/empty 语义；
  - 提供 DSH 对齐的 `COLLAPSED_SESSION_LIMIT = 5` 与 `windowSessionGroup()`；当前 `showSessionsTree()` 的 typed/fallback 两条兼容路径通过同一 `windowSidebarSessions()` adapter 应用五条默认窗口和 overflow；
  - 保持 Session/Workspace/EventStore contract 不变，浏览状态仍是 Web-only。
- `apps/web/src/browser.ts` 新增 `presentSidebarNavigation` typed bridge 入口；原有 `buildNavigationModel` 继续保留，便于已有调用和渐进迁移。
- `apps/web/index.html:2516` 的 typed 分支改为调用 `typedRuntime.presentSidebarNavigation()`，并改用 `selectedSessionId` 命名；typed/fallback 均经过 `windowSidebarSessions()`，在无 typed bridge 时以相同的 limit/overflow 规则降级。
- `apps/web/index.html` 的导航临时 state 增加 `expandedSessionGroups`（仅当前页面内存态），当前 Workspace/Session DOM 仍由原闭包装配；不包含 M4 reducer/localStorage。
- 新增 `apps/web/src/sidebar/sidebar-presenter.test.ts`，覆盖输入归一化、active group、搜索/归档空态、选择与可见性边界及五条折叠窗口。

**M2 最小切片验收**

```powershell
pnpm --filter @code-review-agent/web build
pnpm --filter @code-review-agent/web test
git diff --check
```

2026-08-31：Web build 通过；Web 38 个测试文件、158 个测试通过；`git diff --check` 通过。此次没有修改 `packages/contracts`、EventStore、API route、M1 shell/CSS 或 M4 持久化状态。

**M2 最小切片回滚边界**：删除 `apps/web/src/sidebar/sidebar-presenter.ts` 及其测试，恢复 `index.html` 对 `typedRuntime.buildNavigationModel` 的调用，并移除 `browser.ts` 的新 bridge 字段即可。不得以该切片回滚为由改变 Session/Workspace 事实、归档 API 或事件恢复逻辑。

### M3：Workspace/Session row（信息减负）

**建议新增文件**

```text
apps/web/src/sidebar/workspace-row.ts
apps/web/src/sidebar/session-row.ts
```

**本仓库接入点**

- `apps/web/index.html:102-136`：将 `.workspace-group-header`、`.session`、`.tree-session` 样式拆出或至少按模块标记；
- `apps/web/index.html:2520-2548`：替换 `appendNavigationNode()`、Workspace header 和常驻 order controls；
- `apps/web/index.html:2580-2598`：替换 fallback renderer，确保 typed presenter 与 fallback 行为一致。

**模仿 DSH 的入口**

- `packages/client/ui-workspace/src/client/rows/Rows.tsx:110-151`：`ProjectRowItem` 的 active、menu、drag 和 onCreate 组合；
- `Rows.tsx:274-290`：Session hover card；
- `Rows.tsx:303-335`：SearchResultItem；
- `Rows.tsx:339-430`：`SessionNodeItem` 的状态点、相对时间、菜单和选中态；
- `packages/client/ui-workspace/src/client/rows/Rows.module.css:6-25, 96-126, 219-287`：轻量行、hover-only actions、drag insertion marker。

**实现要点**

- Workspace 默认只显示 label；完整 root 通过 `title`/tooltip/hover card 提供；
- Session 默认只显示状态点 + 标题 + 相对时间；permission/childMode/provider 进入 hover/details；
- 状态点不直接把 `SessionSummary.status` 当作全部用户语义；由 presenter 计算 pending interaction、running、completed、failed/stopped 的显示优先级，并为屏幕阅读器提供稳定文案；
- 上下箭头从常态 DOM 移除；Workspace menu 中保留 rename/archive/delete，拖拽排序作为增强；
- 菜单打开时固定 hover fill，键盘 focus-visible 时操作可见；
- active Workspace 由 presenter 输出，不由 row renderer 自己查找当前 Session。

### M4：导航状态与本地持久化

**建议新增文件**

```text
apps/web/src/sidebar/sidebar-navigation-state.ts
```

建议类型：

```ts
export interface SidebarNavigationState {
  viewMode: 'tree' | 'flat'
  sort: 'recent' | 'name' | 'path'
  searchQuery: string
  showArchived: boolean
  expandedWorkspaces: Record<string, boolean>
  expandedSessionGroups: Record<string, boolean>
}
```

**本仓库接入点**

- `apps/web/index.html:832`：从大 state 中移出导航字段，保留兼容 adapter；
- `apps/web/index.html:2506-2548`：使用 state reducer 读取/更新展开状态；
- `apps/web/index.html:2804-2807`：事件改为 dispatch action；
- `apps/web/src/client/store.ts`：若仓库已有 Web store 约定，可在此承载持久化 adapter；否则使用命名空间明确的 `localStorage` 封装，禁止写入 EventStore。

**模仿 DSH 的入口**

- `packages/client/ui-workspace/src/client/stores.ts:18-87`：浏览状态、Workspace expansion、session order account 与 `persist`；
- `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx:258-329`：active group 自动展开和 view state 驱动投影。

**实现要点**

- 只保存 UI 偏好和展开状态；Workspace 删除/归档后清理失效 key；
- 当前 Session 所属 Workspace 在刷新后自动展开；
- `searchQuery` 可以选择不持久化，默认建议仅在当前页面生命周期保留，避免打开页面就进入搜索态；
- 任何持久化失败都 fail-soft，不能阻断 Session 浏览。

### M5：搜索（分阶段）

**P0 本地搜索**

- 修改 `apps/web/src/presentation/navigation-presenter.ts:161-171`，把匹配字段收敛为标题、Workspace label/path；ID 作为可选低优先级字段；
- 修改 `apps/web/index.html:97-101` 和工具栏 DOM，使输入框默认隐藏；
- 参考 DSH `WorkspaceBrowser.tsx:984-1037` 的展开、Escape、clear、focus 行为。

**P1 Host 内容搜索**

- 新增本仓库独立的 `apps/web/src/sidebar/session-search.ts`，负责 debounce、AbortController、结果合并和 stale response 丢弃；
- 对应 API client/contract 需要先通过 ADR 明确 query 上限、result limit、snippet 脱敏和权限边界；
- 模仿 DSH `tree.ts:309-390` 的 local + content 合并、去重、bounded result 和 `WorkspaceBrowser.tsx:672-740` 的 pending/unavailable/hasMore 状态。

### M6：Integrations/Tasks/Details 收敛

**本仓库接入点**

- `apps/web/index.html:723-730`：移除或降级常驻 Integrations/Tasks 区；
- `apps/web/index.html:2601-2602`：保留 `renderSubagents()`/`renderMcp()` 数据刷新，但改变承载位置；
- Details 相关 DOM/renderer（现有 `renderDetails()` 入口）承载完整状态、操作和错误。

**DSH 参考**

- `SidebarRoot.tsx:181-189` 的 footer action/settings slots；
- `WorkspaceBrowser.tsx` 只负责 Workspace/Session 浏览，不把 MCP、Task 状态混入 row。

**实现要点**

- 无待处理事项时左栏不显示 MCP/Task 详情；
- 有 pending interaction、running child 或 MCP failure 时，只显示一个带 aria-label 的 badge/attention indicator；
- 点击 badge 打开 Details 对应分组，详情仍从本地 projection 读取。

### M7：测试、视觉基线和回放

**本仓库新增/扩展**

- `apps/web/src/presentation/navigation-presenter.test.ts`：active Workspace、隐藏 subagent、flat/tree、5 条折叠投影、归档/删除 Workspace、稳定排序；
- 新增 `apps/web/src/sidebar/*.test.ts`：导航 state reducer、持久化失效 key、搜索 debounce/stale response、row action 可见性；
- `apps/web/src/shell/app-frame.test.ts`、`layout.test.ts`：只补充 M1 的滚动/rail/resize 可访问性断言；
- `apps/web/tests/*.e2e.mjs`：扩展真实 API/SSE fixture，覆盖 reload/replay 后导航一致性；
- `scripts/phase8-visual-gate.mjs` 或现有 Phase 8 visual gate：补充左栏 600/900/1024 三个宽度及长列表/搜索/菜单状态。

**DSH 参考**

- `D:/Develop/deepseek-harness-fork/packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx`、`sidebar-styles.client.spec.ts`、`pointer-scrollbars.client.spec.tsx`；
- `D:/Develop/deepseek-harness-fork/packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx`、`tree.client.spec.ts`、`rows.client.spec.tsx`、`browser-styles.client.spec.ts`；
- `D:/Develop/deepseek-harness-fork/packages/client/ui-layout/tests/app-frame.client.spec.tsx`、`columns.client.spec.ts`；
- `D:/Develop/deepseek-harness-fork/apps/web/tests` 中的浏览器导航/搜索/布局场景，作为行为参考，不直接复制 fixture。

## 9. 文件与代码入口映射总表

该表是后续拆任务、写 PR 描述和做代码审查时的最小映射要求。新增改动如果无法落到表中的模块，应先更新本节和对应 ADR。

| 本仓库模块 | 当前文件/入口 | 计划修改内容 | DSH 模仿文件/入口 | 契约影响 |
|---|---|---|---|---|
| Shell/三栏 | `apps/web/index.html:42-60, 710-735`；`apps/web/src/shell/app-frame.ts`；`layout.ts`；`columns.ts` | 固定左栏 header/action/footer，列表独立滚动；保持现有列求解和断点 | `ui-layout/AppFrame.tsx:40-198`；`ui-layout/columns.ts:62-76`；`ui-sidebar/SidebarRoot.tsx:116-189` | 无 |
| Sidebar 壳层 | `apps/web/index.html:711-733` | 拆出 SidebarRoot 职责，减少壳层内业务 DOM | `ui-sidebar/SidebarRoot.tsx:44-189`、`SidebarRoot.module.css:227-238` | 无 |
| Workspace 浏览 | `apps/web/index.html:719-721, 2506-2600` | 新增 `apps/web/src/sidebar/workspace-browser.ts`，统一 Tree/Flat/Search/空态 | `ui-workspace/WorkspaceBrowser.tsx:147-180, 249-740, 741-1154` | 无；Host search 另行评估 |
| Workspace 行 | `apps/web/index.html:102-119, 2533-2548` | 新增 `workspace-row.ts`；路径/count/order 控件延后到 tooltip/menu | `ui-workspace/rows/Rows.tsx:110-151`；`Rows.module.css:6-25, 96-116, 219-245` | 无 |
| Session 行 | `apps/web/index.html:75-92, 120-136, 2520-2532, 2589-2598` | 新增 `session-row.ts`；状态点/标题/相对时间默认展示，复杂状态进 hover/details | `ui-workspace/rows/Rows.tsx:274-290, 339-430`；`Rows.module.css:107-126, 219-287` | 无 |
| 导航投影 | `apps/web/src/presentation/navigation-presenter.ts:47-132, 161-189` | 明确 active Workspace、默认可见性、扁平 fork 和稳定排序 | `ui-workspace/tree.ts:118-199, 244-390` | 仅 Web projection |
| 状态展示投影 | `apps/web/index.html:2523-2526` 直接消费 `SessionSummary.status` | 在 `ui-workspace/rows/Rows.tsx:262-290, 339-375` 派生主状态和 SR 文案 | 新增 Web presentation 字段；不改原始 contract |
| 导航状态 | `apps/web/index.html:832, 2518-2547, 2804-2807` | 新增 `sidebar-navigation-state.ts`；本地持久化 view/sort/expand/archive | `ui-workspace/stores.ts:18-87` | Web-only，不进 EventStore |
| 本地搜索 | `apps/web/index.html:97-101, 2805`；`navigation-presenter.ts:169-171` | 折叠搜索、Escape/focus/clear、query sanitize | `WorkspaceBrowser.tsx:984-1037` | 无 |
| Host 内容搜索（可选） | 新增 `apps/web/src/sidebar/session-search.ts`；`apps/web/src/client/api.ts` | debounce、abort、去重、bounded result、snippet 脱敏 | `tree.ts:309-390`；`WorkspaceBrowser.tsx:672-740` | 需要独立 ADR/API contract |
| Integrations/Tasks | `apps/web/index.html:723-730, 2601-2602`；`renderDetails()` | 移至 Details/Settings，左栏只保留 badge/attention | `SidebarRoot.tsx:181-189`；WorkspaceBrowser 不承载低频功能 | 无 |
| 浏览器测试 | `apps/web/src/presentation/navigation-presenter.test.ts`；`apps/web/src/shell/*.test.ts`；`apps/web/tests/*.e2e.mjs` | 增加 row/state/scroll/replay/keyboard/视觉矩阵 | DSH `ui-sidebar/tests/*`、`ui-workspace/tests/*`、`ui-layout/tests/*` | 无 |

## 10. 分阶段实施顺序、依赖和不包含项

### P0：纯视觉减负（可独立回滚）

**范围**：M1 的 DOM/CSS 重排、M3 的行信息减负、M2 的 Search/View options 外观收敛；不改变 API、EventStore 或 `SessionSummary`/`WorkspaceSummary`。

**交付**

- New session 降低蓝色面积；
- Workspace toolbar 只保留标题 + Search/View/Add 图标；
- 完整路径、permission、child mode、count 和上下箭头移出默认行；
- 顶部/底部固定，`.sidebar-list-scroll` 独立滚动；
- Workspace 每组默认最多 5 条，提供展开/收起；
- 当前 Workspace 和 Session 的 active/selected 视觉明确。

**依赖**：无；但必须先保留旧 DOM fallback 或 feature flag。
**不包含**：Host 内容搜索、Subagent contract、MCP API、A2A、Worktree/LSP。

### P1：导航状态和投影收敛

**范围**：M0、M2、M4、`navigation-presenter.ts` 的行为调整、稳定 row renderer。

**交付**

- `SidebarNavigationState` reducer + 本地持久化；
- active Workspace、expanded Workspace、selected Session 由 presenter/state 显式提供；
- subagent 默认隐藏，普通 fork 同级展示；
- Tree/Flat/Recent/Name/Path 的状态在刷新后恢复；
- 列表从整棵树 innerHTML 重建逐步改为 group/row 局部更新。

**依赖**：P0 的 DOM 分区和 row 语义稳定。
**不包含**：改变 Session/Task/Event 事实模型；不把浏览偏好写入 EventStore。

### P2：页面结构拆分和交互增强

**范围**：M1–M7 的文件拆分、键盘/ARIA、菜单/拖拽、可选 Host 内容搜索。

**交付**

- `apps/web/src/sidebar/` 形成可独立测试的模块；
- `index.html` 只保留 render site、typed bridge 和少量装配；
- Workspace/Session menu、drag insertion marker、tooltip/hover card 可访问；
- 若业务确实需要按内容找 Session，再按独立 ADR 接入 Host search。

**依赖**：P1 的 presenter/state 和回放行为稳定；Host search 还依赖 API/存储边界评审。
**不包含**：复制 DSH React runtime/slot 类型、插件平台、账户/遥测、A2A 互操作。

### 推荐提交拆分

每一阶段建立独立 checkpoint，建议提交边界如下：

1. `feat(phase8): sidebar visual density baseline`：P0 DOM/CSS 与视觉测试；
2. `feat(phase8): persist sidebar navigation state`：P1 state/presenter/单测；
3. `refactor(phase8): split sidebar browser modules`：P2 文件拆分、e2e 和无行为回归；
4. `feat(phase8): add bounded session content search`：仅在 API/ADR 接受后提交。

## 11. 验收场景

| 场景 | 操作 | 必须观察到的结果 |
|---|---|---|
| A. 三栏宽度矩阵 | 在 600、900、1024px 及桌面宽度打开页面 | 左栏层级稳定；窄屏按既有 rail/mobile 策略；主区不会被新增控件挤压。 |
| B. 长列表减负 | 构造 3 个 Workspace、每组 8–20 个 Session | 顶部 New session、Workspace toolbar、Settings 固定；只有列表滚动；每组默认 5 条并显示剩余数量。 |
| C. 搜索交互 | 点击 Search icon、输入、Escape、清空、快速连续输入 | 输入框按需展开并自动聚焦；Escape 收起；不会因旧响应覆盖新结果；空态文案准确。 |
| D. View options | 在 Tree/Flat 与 Recent/Name/Path 间切换 | popover 可用，切换后投影确定；关闭/刷新后偏好按设计恢复。 |
| E. Active/selected | 打开不同 Workspace 下的 Session，刷新和 SSE 重连 | 当前 Session selected，所属 Workspace active 且自动展开；回放后相同。 |
| F. 行操作 | hover/focus Workspace/Session，打开 menu，rename/archive/delete，拖拽排序 | 操作默认隐藏、hover/focus 可见；菜单不改变行布局；排序结果可回放。 |
| G. 层级噪声 | 创建普通 fork 和 child/subagent | 普通 fork 作为同级 Session；subagent 不污染普通侧栏，Task/Details 仍可追踪。 |
| H. 可访问性 | 仅使用键盘 Tab/Enter/Escape/方向键，检查 aria treeitem/current/selected | 搜索、popover、展开、菜单、Session 打开和关闭都可完成；焦点不丢失。 |
| I. 事实一致性 | 修改 Workspace label、archive/delete、Session title，重载 API/SQLite | 左栏只显示最新 projection；删除 Workspace 后历史 Session 不被误展示为 active 导航项。 |

### 建议门禁命令

```powershell
pnpm typecheck
pnpm test
pnpm build:web
pnpm test:phase8:visual
pnpm test:phase8:browser:evidence
git diff --check
```

若只提交 P0 视觉切片，至少运行 `pnpm typecheck`、Web 定向测试、视觉 gate 和 `git diff --check`；涉及搜索 API、回放或 Workspace 生命周期时必须增加对应合同/恢复/e2e 测试。

## 12. 回滚、禁用和故障边界

### 12.1 Feature flag 建议

建议在 Web-only 配置中使用以下开关，默认按阶段逐步启用：

```text
WEB_SIDEBAR_DENSITY_V2       // P0：行信息减负、固定滚动边界
WEB_SIDEBAR_NAV_STATE_V2     // P1：独立浏览状态与持久化
WEB_SIDEBAR_MODULES_V2       // P2：sidebar/row/browser 文件拆分
WEB_SESSION_CONTENT_SEARCH   // 可选：Host 内容搜索，默认关闭
```

开关只改变 Web projection/rendering；任何 API/EventStore 行为必须有独立版本和回滚说明。

### 12.2 回滚策略

- P0 回滚：关闭 `WEB_SIDEBAR_DENSITY_V2` 或回滚视觉提交，恢复旧 DOM/CSS；不影响 Session、Workspace、Task 和事件。
- P1 回滚：关闭 `WEB_SIDEBAR_NAV_STATE_V2`，忽略本地浏览偏好并使用 presenter 默认值；清理失效 localStorage key 不得删除服务器数据。
- P2 回滚：保留旧 `index.html` render site adapter，逐模块恢复；不允许以回滚名义修改 EventStore 或删除历史 Session。
- Host content search 回滚：关闭 `WEB_SESSION_CONTENT_SEARCH`，继续使用本地元数据搜索；API 新字段保持向后兼容或由独立版本撤回。

### 12.3 故障处理

- 本地持久化解析失败：丢弃损坏的 UI state，回退默认 Tree/Recent，不阻塞页面启动；
- 搜索请求超时/失败：显示可理解的 unavailable 状态，保留本地匹配，不展示伪造的成功结果；
- Workspace catalog 暂时不可用：沿用现有 projection 的 fail-closed 规则，不能因为浏览器缓存把已删除 Workspace 重新显示为可导航；
- SSE 重连期间：保持当前 selected/expanded UI，待新 projection 到达后按 sequence 更新，不创建第二套临时事实模型。

## 13. 上游参考与许可证边界

- DSH 根仓库按 MIT 处理；本次只记录结构和行为入口，不复制实现代码。
- 本仓库已有 `docs/../source-reuse-register.md` 的 `DSH-004` 登记，覆盖 `WorkspaceBrowser.tsx`、`tree.ts`、`SidebarRoot.tsx` 的行为参考与未来适配；本文件是该登记的左栏专项实施细化，不新增一条未经代码复用的登记。
- 若后续直接复制或大量改编 DSH 文件，必须在 `docs/../source-reuse-register.md` 登记原文件、改编范围、版权声明和本地替代关系，并把许可证文件保留在适当位置。
- Claude Code 只作为 Agent 行为、权限和上下文体验参考；本任务没有复制其账户、遥测或 CLI 体系。
- 本仓库 Web 只消费 `packages/contracts` 和 API projection；不能直接把 DSH 的 `WorkspaceBrowserProps`、`SessionListState` 或 slot 类型暴露成公共 API。

## 14. 调研变更记录

| 时间 | 本轮已完成 | 文档落点 | 下一步 |
|---|---|---|---|
| 2026-08-31 | 核对两张用户截图，确认当前左栏的路径、count、常驻排序、树线、低频面板和滚动边界问题；核对 `apps/web/index.html`、`navigation-presenter.ts`、`columns.ts`、`layout.ts`、`app-frame.ts`、contracts。 | 第 1–4 节 | 补齐 DSH 处理方式与本仓库入口映射。 |
| 2026-08-31 | 核对 DSH `SidebarRoot`、`WorkspaceBrowser`、`Rows`、`tree.ts`、`stores.ts`、`AppFrame`、`columns.ts` 及对应测试入口。 | 第 5–9 节 | 进入 P0/P1/P2 实施拆分和验收门禁。 |
| 2026-08-31 | 将改造分为 M0–M7 模块、P0–P2 阶段，写入 feature flag、回滚和许可证边界。 | 第 10–13 节 | 后续若发现新入口或 contract 需求，先更新本节与 ADR，再编码。 |
| 2026-08-31 | 完成 M0 事实与契约冻结：在 `navigation-presenter.ts` 明确 Web-only `SidebarNavigationState`、`selectedSessionId` 输入/回显和 `activeWorkspaceKey` 派生边界；补充 API、SessionStore、typed bridge 注释与 3 组 presenter contract 测试。 | 第 8 节 M0；第 15 节 | 进入 M1/M2 前端结构实施；M4 只能在本冻结之上接 reducer/持久化。 |
| 2026-08-31 | 完成 M1 Sidebar shell 最小切片：`index.html` 新增 `sidebar-primary` 与 `sidebar-list-scroll` 分区，固定 header/New session/toolbar/footer，独立 Workspace/Session scrollport；新增 `sidebar-shell.test.ts` 并通过 typecheck、Web 全量测试和 diff 检查。 | 第 8 节 M1；第 11–12 节 | 由主 agent 复核后建立 Phase 8 M1 checkpoint；后续进入 M2 浏览器控制层。 |
| 2026-08-31 | 完成 M2 最小控制层切片：新增 `sidebar-presenter.ts` 统一导航输入归一化、active group 和空态输出；`browser.ts` 暴露 typed bridge；`index.html` typed 分支改用 `presentSidebarNavigation`，fallback DOM 暂保持兼容；新增 4 个 presenter 测试。 | 第 8 节 M2；第 12–13 节 | 由主 agent 复核后建立 M2 checkpoint；下一步再拆 WorkspaceBrowser DOM renderer 和 Tree/Flat/Search 共用行装配。 |
| 2026-08-31 | 完成 M3 最小 row 信息减负切片：新增 `sidebar/workspace-row.ts`、`sidebar/session-row.ts`，由 `sidebar-presenter.ts` 派生稳定 Session 状态和 aria 文案；typed/fallback 两条 `showSessionsTree()` 路径通过同一 row adapter 接入。Workspace 默认只显示 label，root/count 进入 title/aria/menu；Session 默认只显示状态点、标题和相对时间，permission/childMode/provider 进入 title 与 assistive details；Workspace 上下移动能力移入菜单。 | 第 8 节 M3；第 11 节 F/H；第 12 节 P0/P2 | 主 agent 复核后建立 M3 checkpoint；后续 M4 再处理导航 state reducer/localStorage，M5 再处理搜索输入收敛。 |
| 2026-08-31 | 完成 M4 导航状态与本地持久化切片：新增纯 reducer 和 fail-soft localStorage adapter，统一 Tree/Flat、排序、搜索生命周期、归档与展开 action；刷新恢复偏好，active Workspace 自动展开，Workspace 生命周期清理 stale key。 | 第 8 节 M4；第 11 节 D/E/I；第 12 节 P1；M4 实施记录 | 主 agent 复核后建立 M4 checkpoint；下一步进入 M5 折叠搜索和键盘生命周期。 |
| 2026-08-31 | 完成 M5 P0 本地搜索交互收敛：搜索输入默认折叠为图标，展开后自动聚焦；Escape 与 clear 均清空查询并收起；Tree/Flat 共用标题、Workspace label/basename/path 的同步本地匹配，保留 Session ID 兼容匹配；未引入 Host 内容搜索、debounce、AbortController 或 API contract。 | 第 8 节 M5 P0；第 11 节 E/G；第 12 节本地搜索；M5 实施记录 | 主 agent 复核并建立 M5 checkpoint；后续单独评估 M5 P1 Host 内容搜索与 API/权限边界。 |

#### M3 实施记录（2026-08-31）

本轮交付聚焦“行组件信息减负”，没有引入 React、第三方 UI 依赖，也没有修改 `packages/contracts`、EventStore、API route 或 Session/Workspace 事实模型。实现边界如下：

- `apps/web/src/sidebar/workspace-row.ts`：提供纯 `presentWorkspaceRow()` 和 DOM `createWorkspaceRow()`；Workspace 行只把 label 放在可见 copy 中，完整 root 与聚合 session count 通过 `title`、`aria-label` 和 Workspace menu 继续可发现；active/expanded 由 presenter/浏览器 state 传入，row 不扫描 DOM 推断。
- `apps/web/src/sidebar/session-row.ts`：提供纯 `presentSessionRow()` 和 DOM `createSessionRow()`；可见信息收敛为状态点、标题、相对时间，root、permission preset、child mode/provider 保留在 title 和屏幕阅读器可访问的 details 节点；menu/selection 仍由调用方回调驱动。
- `apps/web/src/sidebar/sidebar-presenter.ts`：新增 `presentSessionStatus()`，将 raw `SessionSummary.status` 及可选 Web-only pending interaction/permission/running child 信号映射为 `pending/running/completed/failed/stopped`，并输出稳定英文 aria 文案。`idle` 仅作为已完成展示态，不改变原始 status。
- `apps/web/src/browser.ts`：typed bridge 暴露 row presenter/DOM factory，供静态 `index.html` 调用；公共 bridge 只暴露本仓库 Web presentation 类型，不暴露 DSH 内部类型。
- `apps/web/index.html`：typed/fallback 共用 `createSidebarSessionRow()` 与 `createSidebarWorkspaceRow()` 适配器；移除 Workspace 行常态路径、count 和上下箭头，菜单中保留 rename/archive/delete 与 move up/down；Session 复杂 metadata 不再进入常态 meta 行；fallback 在 typed bridge 不可用时继续使用相同的低噪声结构和新建 Workspace 行行为。

**M3 验收结果**

```text
pnpm --filter @code-review-agent/web build       通过
pnpm --filter @code-review-agent/web test        40 个测试文件 / 165 个测试通过
pnpm --filter @code-review-agent/web build:browser 通过
```

新增/覆盖测试：

- `sidebar-presenter.test.ts`：pending 优先级、running child、idle→completed、failed/interrupted→稳定展示态；
- `workspace-row.test.ts`：label 与 root/count details 分离、无 label root 回退；
- `session-row.test.ts`：title/time 轻量摘要、丰富 metadata details、pending permission aria 文案。

**M3 未覆盖项**

- 当前 row factory 仍由单页 `index.html` 编排 section、children 和 overflow；完整 `WorkspaceBrowser` 文件拆分、稳定 key/节点复用及 Tree/Flat/Search 共用 renderer 留待后续 M7/P2 切片。
- pending interaction/permission/running child 只在选中 Session 且现有 Web projection 可取得时传入；列表中其他 Session 仍依据 `SessionSummary.status` 派生展示态。引入完整 Host-backed pending 索引前不得修改公共 contract。
- title/aria 是按需详情的第一步，hover card、拖拽插入标记和完整 keyboard treeitem 语义仍需后续可访问性/e2e 门禁验证。

**M3 回滚边界**：恢复 `index.html` 原有 Workspace/Session row DOM 装配、移除 `browser.ts` 的四个 row bridge 字段，以及删除 `sidebar/workspace-row.ts`、`sidebar/session-row.ts` 和对应测试即可回滚。若只需暂时关闭信息减负，可让 `createSidebar*Row()` adapter 回退到旧 renderer；不得以 M3 回滚为由删除 Workspace reorder API、修改 Session/Workspace contract、EventStore 或归档事实。

#### M4 实施记录（2026-08-31）

本轮完成“导航状态与本地持久化”最小可审查切片。实现模仿 DSH `ui-workspace/src/client/stores.ts` 的浏览状态隔离，以及 `WorkspaceBrowser.tsx` 中当前 Session 所属 group 自动展开的行为；没有复制 DSH 类型、代码、品牌或引入第三方依赖。

- `apps/web/src/sidebar/sidebar-navigation-state.ts`：新增纯 `SidebarNavigationState` reducer，覆盖 `tree/flat`、`recent/name/path`、搜索输入、归档过滤、Workspace 展开和五条 Session 窗口展开；展开状态保留用户显式的 `false`，当前 Session 所属 group 只在没有显式选择时自动展开；`retain-workspace-keys`/`remove-workspace-key` 清理生命周期失效 key。reducer 不读写 DOM、API、EventStore。
- 同一文件提供 Web-only `createSidebarNavigationPersistence()` localStorage adapter。默认持久化视图、排序、归档和展开状态，`searchQuery` 仅保留当前页面生命周期；可选 `persistSearchQuery` 只为后续产品决策预留。读取、JSON 解析、写入、清除和 localStorage 能力/配额异常均 fail-soft，损坏值按白名单归一化。
- `apps/web/src/browser.ts`：typed bridge 暴露 reducer、state factory、持久化 adapter 和序列化 helper；公共 bridge 只包含本仓库 Web presentation 类型，不暴露 DSH 内部类型。
- `apps/web/index.html:832, 900-969, 1182-1199, 2636-2725, 2932-2935`：大 `state` 保留兼容字段但唯一来源改为 `sidebarNavigationState`；初始化从 localStorage 恢复控件；Workspace/Session 展开、归档、Tree/Flat、排序和搜索事件统一 dispatch action；刷新时按 Workspace catalog 清理失效 key，当前 Session group 自动展开。
- 测试覆盖 reducer 不变性、视图/排序/归档/搜索、Workspace/Session 展开与 stale key 清理、localStorage 恢复、搜索不持久化、未知值归一化、损坏 JSON 和存储异常 fail-soft；`sidebar-shell.test.ts` 增加 index 接入静态契约。

**M4 验收结果**

```text
pnpm --filter @code-review-agent/web build       通过
pnpm --filter @code-review-agent/web build:browser 通过
pnpm --filter @code-review-agent/web test        41 个测试文件 / 171 个测试通过
git diff --check                                 通过
```

**M4 未覆盖项**

- `WorkspaceBrowser` 完整 DOM 文件拆分、稳定 key/节点复用和 Tree/Flat/Search 共用 renderer 仍留待 M7/P2；本轮只把导航状态边界接入现有 `showSessionsTree()`。
- 搜索仍是本地元数据匹配；Host 内容搜索、防抖/取消、结果分页和 API contract 需要独立 ADR 与后续 M5 切片。
- 当前 Session 所属 Workspace 在列表投影可见时自动展开；若当前 Session 属于已归档/删除 Workspace，遵循 catalog 投影隐藏，不由浏览器缓存重新创建导航项。
- localStorage 只提供单浏览器/单 origin 偏好，不承担跨设备同步、用户账户迁移或 EventStore 回放。

**M4 回滚边界**：关闭 typed bridge 的 `sidebarNavigationPersistence` 或让其返回默认 state，即可忽略本地偏好并继续使用兼容字段；回滚 `index.html` 的 dispatch 接入并移除 `browser.ts` 的 M4 bridge 字段即可恢复 M3 renderer。删除 `sidebar-navigation-state.ts` 及测试不会影响 Session/Workspace API、EventStore、归档事实或服务器数据；不得以 M4 回滚为由清理服务器 Session 或 Workspace。

#### M5 P0 实施记录（2026-08-31）

本轮只实现本地元数据搜索和搜索槽位交互，沿用 DSH `WorkspaceBrowser.tsx:984-1037` 的“按需展开、自动聚焦、Escape/clear 收起”行为，并参考 `tree.ts` 的本地 title/Workspace label 派生边界。没有复制 DSH 代码，没有新增 Host 内容搜索请求，也没有修改 `packages/contracts`、EventStore、Session/Workspace API 或权限边界。

- `apps/web/src/presentation/navigation-presenter.ts`：`buildNavigationModel()` 为每个 Workspace 生成统一搜索文本（自定义 label、basename、规范化前的路径），`matchesTree()` 在 Tree 与 Flat 两种投影中复用同一匹配函数；可见字段以 Session 标题与 Workspace label/path 为主，Session ID 作为兼容性低优先级 token 保留。
- `apps/web/src/presentation/navigation-presenter.test.ts`：新增 label/path 查询在 Tree/Flat 模式下命中同一 Workspace 全部 Session 的测试，确保本地同步投影一致。
- `apps/web/index.html`：Workspace toolbar 新增 `session-search-toggle`、`session-search-slot` 与 `session-search-clear`；输入框默认 `hidden`、`tabindex=-1`，展开时只保留搜索槽位并自动聚焦，clear/Escape 通过 M4 reducer 的 `clear-search` action 清空并收起，typed/fallback 渲染器继续共享同一个 `showSessionsTree()` 查询状态。
- `apps/web/src/shell/sidebar-shell.test.ts`：增加搜索默认折叠、ARIA 展开状态、clear 控件和 Escape 生命周期的静态契约测试。

**M5 P0 验收结果**

```text
pnpm --filter @code-review-agent/web test -- --run src/presentation/navigation-presenter.test.ts src/shell/sidebar-shell.test.ts   18 个测试通过
pnpm typecheck                                                                                                     通过
git diff --check                                                                                                   通过
```

**M5 P0 未覆盖项**

- Host 内容搜索、输入防抖、AbortController/stale response 丢弃、结果去重/分页、snippet 脱敏及 API/权限 contract 均未实现；这些属于 M5 P1，必须先完成 ADR 和 bounded query/result 设计。
- 当前 renderer 仍由 `index.html` 的 `showSessionsTree()` 整体重建列表；稳定 key/节点复用和完整 WorkspaceBrowser renderer 拆分留待 M7/P2。
- 搜索查询默认不写入 localStorage，刷新后从空查询开始；这是 M4 的 Web-only 持久化策略，不改变 Session/Workspace 事实。

**M5 P0 回滚边界**：恢复 `index.html` 原有常驻 input toolbar，并移除 `setSidebarSearchExpanded`、clear/Escape 监听及对应静态测试即可回退交互；恢复 `matchesTree()`/`matchesSession()` 的旧调用签名即可回退字段策略。回滚只影响 Web projection 与 DOM，不删除或修改 EventStore、Session/Workspace API、归档数据或公共 contract。

#### M6 实施记录（2026-08-31）

本轮完成 Integrations/Tasks/Details 收敛的最小可回滚切片，模仿 DSH `SidebarRoot.tsx` 的 footer/slot 分层与 `WorkspaceBrowser` 不承载低频状态的职责边界。没有复制 DSH 代码、类型、品牌或文案，也没有修改 EventStore、公共 contract、MCP/Task API 或权限语义。

- `apps/web/index.html`：移除左栏常驻 Integrations/Tasks `<details>` 和可见 `mcp-list`/`subagent-list`；在固定 footer 前增加单一 `sidebar-attention` indicator。无待处理请求、运行中 child 或 MCP failure 时保持 `hidden`；有事项时只显示带 `aria-label` 的按钮和计数 badge。
- `apps/web/index.html`：新增 `renderSidebarAttention(snapshot)`，从 SessionStore conversation projection、fallback 事件日志、Subagent catalog 和 MCP server 状态派生 attention；请求优先，其次 running child，再其次 MCP failure。点击按钮通过 `openDetailsGroup()` 打开 Details 面板并聚焦对应 `details-group-requests/planning/integrations` 分组。
- `apps/web/src/sidebar/sidebar-attention.ts`：新增纯 Web presentation 投影，统一计数归一化、优先级、可访问标签和 Details target group；`apps/web/src/browser.ts` 暴露 typed bridge，不把 DSH 内部类型泄露到页面。
- `apps/web/src/sidebar/sidebar-attention.test.ts`：覆盖空态、pending interaction/permission、running child、MCP failure、优先级和异常计数；`apps/web/src/shell/sidebar-shell.test.ts` 增加常驻区移除、badge/ARIA/click/Details 分组静态契约。
- `renderTaskPanel()`/`renderMcpDetailsPanel()` 继续在 Details 中承载完整状态、操作和错误；历史 `renderSubagents()`/`renderMcp()` 刷新入口保留为 detached compatibility sink，避免低频数据重新进入左栏。

**M6 验收结果**

```text
pnpm --filter @code-review-agent/web test -- --run src/sidebar/sidebar-attention.test.ts src/shell/sidebar-shell.test.ts   14 个测试通过
pnpm typecheck                                                                                                      通过
pnpm --filter @code-review-agent/web build:browser                                                                  通过
git diff --check                                                                                                    通过
```

**M6 未覆盖项**

- 尚未新增真实 API/SSE browser fixture 来逐状态截图验证 badge；M7 负责真实浏览器、键盘和视觉矩阵。
- 单一 indicator 在同一时刻选择 Requests > Planning > Integrations 的最高优先级目标；多个低频事项的完整数量和切换仍在 Details 分组查看。
- `mcp-list`/`subagent-list` 的 detached compatibility sink 仍保留在渲染代码中，后续完成完整 renderer 拆分时可以删除；它们不再挂载到可见 sidebar DOM。

**M6 回滚边界**：恢复左栏两个 `sidebar-secondary` 区块并移除 `sidebar-attention` DOM/renderer/bridge/test，即可恢复 M5 的左栏可见结构；不需要回滚 Details renderer、SessionStore、MCP/Task 事实或任何 Event/Tool/Task/Permission/Workspace contract。

#### M7 实施记录（2026-08-31）

本轮完成 M6 attention badge 的真实 API/SSE/SQLite 回放门禁、键盘/ARIA/focus 导航矩阵和左栏视觉状态矩阵。测试结构模仿 DSH `ui-sidebar`、`ui-workspace`、`ui-layout` 的行为分层，但没有复制 DSH 类型、品牌或 fixture。

- `apps/web/tests/sidebar-attention-replay.e2e.mjs`：使用现有 `withFixture()` 启动真实 SQLite/API；通过 SSE 追加并接收 pending interaction/permission，重启后确认 pending projection 恢复，再通过 SSE 追加 resolved 事件并重启确认状态稳定；通过真实 `/v1/mcp/servers` 生命周期制造 failed MCP 并验证 API 重启后仍可观察。
- `scripts/phase8-sidebar-gate.mjs`：检查 Web shell/typed bridge，运行 attention replay 场景，并启动现有 `phase7-delegation-fixture-server.mjs` 验证真实 running child catalog、scoped replay 和 browser bundle；输出 M7 的 viewports、状态矩阵、键盘、ARIA、focus 证据。
- `apps/web/src/shell/sidebar-shell.test.ts`：补充 sidebar collapse、New session、Archived、折叠 Search、attention 路由、列表 region、Workspace Enter/Space、Details summary focus、Workspace/Session menu accessible name 和长列表 overflow 的静态契约矩阵。
- `docs/archive/phases/phase8-visual-baselines/manifest.json` 与 `scripts/phase8-visual-gate.mjs`：保留既有六张真实 600/900/1024 JPEG，同时增加 `sidebarMatrix`，对 empty、long-list、search、workspace-menu、attention 五种状态和稳定 DOM/CSS 断言进行可重复审计。
- `package.json`：新增 `pnpm test:phase8:sidebar`，串联 typecheck、Web build、sidebar shell contract 和 M7 API/SSE/delegation gate。

**M7 验收结果**

```text
pnpm typecheck                                      通过
pnpm build:web                                      通过
pnpm --filter @code-review-agent/web test -- --run src/shell/sidebar-shell.test.ts   9 个测试通过
pnpm test:phase8:visual                             通过（6 张 JPEG + 5 状态 sidebar 矩阵）
node scripts/phase8-sidebar-gate.mjs               通过（API/SSE/replay + running child）
git diff --check                                    通过
```

**M7 未覆盖项**

- 当前门禁仍是无 Playwright 依赖的真实 HTTP/SSE/SQLite 边界测试与静态 shell contract；尚未新增图形浏览器截图采集或像素级 diff。
- `running child` 使用已有 delegation fixture 的真实 SubagentRuntime catalog 验证，attention badge 的点击/Details 聚焦由 shell contract 覆盖；下一步若接入图形浏览器，应复用同一 fixture 和断言。
- WorkspaceBrowser 仍由 `index.html` 的兼容 renderer 编排，稳定 key/局部 DOM 复用和完整文件拆分继续留在 P2，不在 M7 扩大范围。

**M7 回滚边界**：移除 `sidebar-attention-replay.e2e.mjs`、`phase8-sidebar-gate.mjs`、`test:phase8:sidebar`、`sidebarMatrix` manifest 字段及新增 shell 断言即可回退测试与视觉门禁；不回滚 M6 运行时代码、EventStore、Session/Workspace/Task/Permission/MCP contract 或现有 JPEG 基线。

## 15. 防漂移检查清单（每个后续 PR 必填）

- [ ] 改动属于 M0–M7 中已登记的模块，或先更新本文件；
- [ ] PR 描述写明本仓库文件/代码入口和 DSH 参考入口；
- [ ] 未把 DSH 内部类型、品牌或文案直接引入公共 API；
- [ ] 未把 UI 偏好写入 EventStore，未让 DOM 成为事实来源；
- [ ] 涉及 Event/Tool/Task/Permission/Workspace contract 时已补 ADR、合同测试、恢复测试和回滚说明；
- [ ] 至少完成一项真实浏览器场景和对应截图/ARIA 证据；
- [ ] `pnpm typecheck`、与改动范围匹配的测试和 `git diff --check` 已记录；
- [ ] 阶段性代码/文档变更已建立独立 Git checkpoint。
