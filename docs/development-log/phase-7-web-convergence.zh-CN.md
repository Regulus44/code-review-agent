# Phase 7：DSH Web 前端收敛

## 2026-08-22：第一批 DSH 风格 Web 垂直切片

### 变更范围

- 将 `apps/web/index.html` 从旧的两栏静态页改为 DSH 风格的三栏工作台：`sidebar | conversation | details`；
- 左侧加入品牌行、New session、Session 列表、MCP 状态和底部设置入口；支持收起为约 56px 的 rail；
- 中间加入空态 hero、会话 header、滚动 transcript 和悬浮圆角 composer；
- 将模型切换从顶栏原生 `<select>` 改为 composer toolbar 内的 popover，继续调用现有 `GET/POST /v1/models` API；
- 增加右侧 Session details，展示 provider/model、Session、MCP、工具和权限信息，并支持收起；
- 工具调用、工具结果、diff preview、MCP 事件和 permission request 改为 DSH 风格可展开 row/card；
- 保留现有 Session、SSE replay/reconnect、MCP enable/disable/reconnect、权限决策和消息发送 API，不改变事件/工具契约；
- 保留本项目 `Code Review Agent` 品牌与自有颜色、图标和文案，没有复制 DSH 品牌标识。

### 参考与取舍

- 参考 DSH `ui-layout/AppFrame`、`ui-sidebar/SidebarRoot`、`ui-conversation/ConversationRoot`、`InputBar`、`ui-model-selection/ModelSelect` 和 `ui-tool/ToolRow` 的布局、几何和信息分区；
- 本批只适配结构和交互行为，不把 DSH client workspace 作为运行时依赖；
- 继续使用本项目的静态 Web shell，等前端垂直切片稳定后再决定是否拆分为 TypeScript UI package；
- 详情面板的高级设置、完整 diff/terminal/subagent 视图和视觉回归 fixture 尚未纳入本批。

### 验证

```text
pnpm typecheck   ✓
pnpm test        ✓
git diff --check ✓
```

浏览器 smoke：

- 本地 API `/` 正确加载三栏工作台；
- 已有 Session 历史显示为 user/assistant transcript，状态为 Connected；
- composer model popover 展示 `deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`，切换到 `deepseek-v4-pro` 成功；
- Sidebar collapse 和 details close 操作可用；
- API 不可用时展示可解释的连接错误空态。

### 下一步

- 把 Diff、Terminal、Permission、Subagent 和 MCP 详情逐步抽成可复用组件；
- 增加窄屏、SSE 断线重连和关键事件 fixture 的浏览器回归；
- 评估将静态 shell 迁移到 TypeScript UI package，同时保持 API contract 不变。

## 2026-08-22：补齐 Workspace Picker P0

### 问题判断

- 第一批 Web shell 创建新 Session 时把 `workspaceRoot` 写死为 `.`，用户无法在前端指定本地仓库；
- 后端 Session、ToolRuntime 和 WorkspaceResolver 早已按 `workspaceRoot` 工作，因此这是 Web 入口缺失，不是 Phase 8 worktree 生命周期问题；
- 按 Phase 7 交付物中的 workspace picker 要求，本项作为当前阶段的 P0 功能立即补齐。

### 变更范围

- 新增 `POST /v1/workspaces/validate`，在创建 Session 前验证路径存在、可访问且确实是目录，并返回规范化路径和 Git 目录提示；
- New session 打开 DSH 风格 workspace picker modal，支持输入 Windows/Linux 本地路径、最近使用路径和错误提示；
- 当前 Session header 的 workspace path 可点击并打开 picker；选择路径会创建新的 Session，不修改已有 Session 的历史事实；
- 保持 `POST /v1/sessions`、工具执行和事件契约不变。

### 验证

```text
pnpm typecheck                         ✓
pnpm --filter @code-review-agent/api test ✓
git diff --check                       ✓
```

浏览器 smoke：

- New session 打开 Workspace picker；
- 不存在的目录显示 API 返回的可解释错误；
- 选择 `D:/Develop/code-review-agent` 后创建新 Session，header、hero chip 和 details panel 均显示该 workspace；
- 最近 workspace 可再次选用。

## 2026-08-22：Session 操作与真实模型失败诊断收敛

### 问题定位

- 最近一次失败 Session `ses_9854b5f5-a981-4a07-a495-4f50e5e2db30` 的事件顺序是 `turn/started → agent/error → turn/ended`，其中没有 `tool/call`；失败发生在首次模型请求阶段，工具运行时尚未开始执行。
- SQLite 事件中的原始错误为 `fetch failed`。本地 Node Fetch 直接访问 DeepSeek API 可以返回 200，因而该记录更接近瞬时网络失败或旧进程状态，不能归因于某个内置工具。
- 根目录 `restart.ps1` 仍启动旧 Python/FastAPI 进程，导致新 Web API 的 Session mode/archive 路由得到 `not found`，并且可能使用不同的 SQLite 工作目录。

### 修复范围

- `restart.ps1` 统一启动 `apps/api/src/server.ts` 的 TypeScript API，默认监听 `127.0.0.1:3210`；`/health` 返回 `runtime: typescript`。
- SQLite 默认路径固定为 `apps/api/.data/code-review-agent.sqlite`，与启动目录无关，避免重启后 Session 查找漂移。
- DeepSeek 请求失败增加目标 URL、底层 cause 和一次短重试；诊断信息不包含 API key。
- Session 列表的 `Archived` 入口现在只显示归档 Session，默认列表只显示活动 Session；归档按钮增加无障碍名称并在悬停时显示，减少侧栏视觉噪声。
- 对话区增加滚动边界保护和稳定滚动条槽；打开 Session 后按当前活动/归档筛选状态刷新侧栏，避免切换视图后列表混杂。

### 验证

```text
Node script syntax check       ✓
pnpm typecheck                 ✓
pnpm test                      ✓
git diff --check               ✓
```

浏览器与真实 DeepSeek smoke：

- 新建 `read-only` Session、切换到 `workspace-write`、归档和恢复均返回成功；
- 浏览器中的 New session 工作模式选择和对话中 Mode popover 均可用；
- 真实 DeepSeek Session `ses_ef4121aa-b328-4260-95b4-ed3041522b27` 完成 `glob/read_file` 工具调用并返回仓库总结，6 个只读工具调用均为 `completed`，说明当前失败路径没有复现。

## 2026-08-22：历史会话展示收敛

### 问题定位

- 同一个工具调用的 `tool/call` 和 `tool/result` 分别渲染为两张卡片，工具较多时会显著拉长对话；
- `turn/queued`、`step/started`、`step/ended` 等生命周期事件对用户诊断价值较低，却占用了主要对话空间；
- 打开长历史 Session 时逐条事件触发渲染，事件量较大时会造成页面重复布局和交互延迟。

### 修复范围

- Web 对话区按 `toolCallId` 合并工具调用、进度和结果，单个工具只保留一张可展开卡片；
- 保留用户消息、助手消息、计划、待办、MCP、权限、交互和 Agent error，隐藏低价值生命周期事件；
- 历史事件先批量写入内存，再进行一次渲染；SSE 新事件仍按增量方式更新。

### 验证

```text
Web script syntax check       ✓
pnpm typecheck                ✓
pnpm test                     ✓
git diff --check              ✓
```

浏览器回归：

- 真实历史 Session 中 6 个工具调用各显示一张卡片，`call/result` 已合并；
- 长历史加载后对话区保持可滚动，页面可以继续输入下一轮消息；
- `Read only` 切换到 `Workspace write` 成功，并写入新的 Session 更新事件。

## 2026-08-22：退役旧实现并收敛仓库入口

### 清理范围

- 删除旧 Python Runtime、Python 测试、`pyproject.toml` 和旧单页 Web 原型；
- 删除旧 FastAPI Docker 启动方式，改为 Node 22 + pnpm + TypeScript API 镜像；
- `.env.example` 只保留 TypeScript API、DeepSeek、端口和 SQLite 配置；
- 删除仓库中发现的临时凭据文件，当前代码和文档不再提供旧 provider 的启动命令；
- README、架构决策、迁移矩阵和阶段状态同步到 TypeScript-only 工作树；历史阶段记录保留在开发日志中。

### 验证

```text
pnpm typecheck                         ✓
pnpm test                              ✓
API /health runtime=typescript         ✓
legacy src/tests/pyproject             absent
```

Docker CLI 当前机器未安装，因此镜像构建只能通过 Dockerfile 静态检查和 TypeScript 构建门禁验证。

## 2026-08-22：Workspace 树与 Session 生命周期操作

### 需求判断

- 左侧导航需要表达“项目/Workspace → 多个 Session”的长期关系；扁平路径列表无法支撑同一仓库下的多轮开发工作。
- Session 的归档和删除属于侧栏核心操作，操作入口需要靠近行项目并保持可恢复、可审计。
- DSH Workspace Browser 的树派生、分组排序和局部展开状态适合直接适配到本项目的 Session projection。

### 变更范围

- 左侧导航改为 DSH 风格 Workspace Browser：Workspace 父节点展示名称、完整路径和 Session 数量，子节点展示 Session 标题、更新时间、工作模式和运行状态。
- 增加 Workspace 展开/折叠、当前 Workspace 自动展开、Session 搜索、空状态和 Workspace 内新建 Session 入口。
- Session 行加入操作菜单，支持归档、恢复和删除；归档通过 `archive/restore` 事件保持可见历史，删除通过 `session/deleted` 事件隐藏 Session 并保留完整事件流。
- 后端契约增加可选 Session 标题、`deleted` 状态、`session/deleted` 事件和 `DELETE /v1/sessions/:id`；`include_archived=true` 仍不会返回已删除 Session。
- 保留三栏布局、中间 Conversation、右侧 Details、SSE replay 和现有 API client；本批把 DSH Workspace 行为落到当前 Web shell，后续可继续拆成独立 TypeScript UI package。

### 验证

```text
pnpm typecheck   ✓
pnpm test        ✓
git diff --check ✓
Web script parse ✓
Browser DOM smoke ✓（Workspace 分组、搜索、展开/折叠、操作菜单）
API delete smoke ✓（软删除、列表隐藏、事件历史保留）
```
