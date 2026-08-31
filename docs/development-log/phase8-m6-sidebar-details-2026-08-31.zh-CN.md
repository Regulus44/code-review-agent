# Phase 8.0 M6：Integrations/Tasks/Details 收敛

日期：2026-08-31

本切片解决左栏高频 Workspace/Session 浏览与低频 Integrations/Tasks 状态混排的问题。实现采用 DSH `ui-sidebar/SidebarRoot` 的 footer/slot 分层思路，并保持 `ui-workspace/WorkspaceBrowser` 只负责 Workspace/Session 浏览；本仓库的 MCP、Task、Permission 和 Session 事实仍来自现有 projection、SessionStore 与 API。

## 交付物

- `apps/web/index.html`
  - 删除可见的常驻 Integrations/Tasks `<details>` 区域。
  - 在固定 footer 前增加单一 `sidebar-attention` indicator；空态隐藏，有事项时显示 badge、稳定 `aria-label` 和 target group。
  - `renderTaskPanel()` 与 `renderMcpDetailsPanel()` 继续把完整状态、操作和错误挂载到 Details 的 Planning/Integrations 分组。
  - `renderSidebarAttention()` 从 pending request、running child 和 MCP failure 派生低频 attention；点击后打开 Details 对应分组并聚焦 summary。
- `apps/web/src/sidebar/sidebar-attention.ts`
  - 纯 Web presentation：计数归一化、Requests > Planning > Integrations 优先级、ARIA 文案和 Details target group。
- `apps/web/src/browser.ts`
  - 暴露 `presentSidebarAttention` typed bridge；未引入 DSH 类型。
- 测试
  - `apps/web/src/sidebar/sidebar-attention.test.ts`
  - `apps/web/src/shell/sidebar-shell.test.ts`

## 验收证据

```text
pnpm --filter @code-review-agent/web test -- --run src/sidebar/sidebar-attention.test.ts src/shell/sidebar-shell.test.ts
  14 tests passed
pnpm typecheck
  passed
pnpm --filter @code-review-agent/web build:browser
  passed
git diff --check
  passed
```

## 边界与后续

单一 badge 同时存在多个事项时按 Requests、Planning、Integrations 顺序选择打开目标；完整状态仍可在 Details 分组查看。当前没有新增真实 browser fixture，M7 负责 badge 的 SSE/replay、键盘和视觉矩阵验证。旧 `renderSubagents()`/`renderMcp()` 仅写入 detached compatibility sink，后续完整 WorkspaceBrowser 拆分后可移除。

## 回滚

仅回滚本切片的 `index.html`、sidebar attention presenter/bridge 和测试即可恢复 M5 左栏结构；不涉及 SessionStore、EventStore、MCP/Task API 或公共 contract。
