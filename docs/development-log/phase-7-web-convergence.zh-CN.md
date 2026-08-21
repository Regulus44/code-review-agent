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
