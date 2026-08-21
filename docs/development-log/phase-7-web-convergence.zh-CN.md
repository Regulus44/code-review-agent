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
