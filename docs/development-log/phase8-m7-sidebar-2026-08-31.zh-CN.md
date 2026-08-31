# Phase 8.0 M7：Sidebar 测试、视觉基线和回放

日期：2026-08-31
范围：M6 attention badge 的真实 API/SSE/replay、键盘/ARIA/focus、视觉状态矩阵
状态：completed

## 目标与边界

本轮把 M6 的低频状态收敛落实为可重复的浏览器边界证据，覆盖 pending request、running child、MCP failure、reload/replay 和窄屏导航。测试沿用 DSH `ui-sidebar`、`ui-workspace`、`ui-layout` 的职责分层：事实由 API/EventStore 提供，Sidebar 只验证 projection 和交互入口，不新增第二套 UI 事实模型。

本轮没有修改 `packages/contracts`、EventStore、Session/Workspace/Task/Permission/MCP 事实语义，也没有复制 DSH 类型、品牌或测试 fixture。由于仓库没有固定 Playwright 依赖，视觉部分使用既有六张真实 JPEG 加稳定 shell markers/CSS 断言，保留未来接入图形浏览器的状态矩阵。

## 实施内容

### 1. API/SSE/SQLite attention replay

`apps/web/tests/sidebar-attention-replay.e2e.mjs` 使用 `apps/web/tests/fixture.mjs` 的真实 SQLite/API fixture：

1. 建立 Session，连接 `/events?after_sequence=...` SSE；
2. 追加 `interaction/requested` 与 `permission/requested`，验证 SSE 顺序和 Session pending projection；
3. 重启 API/SQLite，确认两个 pending 状态恢复；
4. 追加 `interaction/resolved` 与 `permission/resolved`，验证 SSE 顺序和 pending 清理；
5. 再次重启，确认 resolved 状态不复活；
6. 通过 `/v1/mcp/servers` 注册不存在的 stdio 命令，验证 failed MCP 可见，并在 API 重启后继续为 failed。

### 2. Running child 与 scoped replay

`scripts/phase8-sidebar-gate.mjs` 启动既有 `scripts/phase7-delegation-fixture-server.mjs`，通过真实 `/v1/sessions/:id/subagents?scope=children` 读取 running child，并通过 scoped events endpoint 确认 child descriptor 可回放。这样 running child 的 attention 输入来自 SubagentRuntime catalog，而不是页面伪造数据。

### 3. 键盘、ARIA 和 focus 矩阵

`apps/web/src/shell/sidebar-shell.test.ts` 新增 M7 静态契约矩阵，固定以下入口：

- Sidebar collapse、New session、Archived、Search toggle/input、attention button 的 button/type/ARIA 标记；
- 唯一 Workspace/Session list scrollport 的 `role=region`、`tabindex=0`；
- Workspace header 的 Enter/Space 展开生命周期；
- Search Escape 生命周期、attention → Details 路由、Details summary 聚焦恢复；
- Workspace/Session menu 的可访问名称；
- 五条默认 Session 窗口和 long-list overflow 的稳定入口。

### 4. 视觉矩阵

`docs/phase8-visual-baselines/manifest.json` 新增 `sidebarMatrix`：

| 视口 | 状态 |
|---|---|
| 600 / 900 / 1024 | empty |
| 600 / 900 / 1024 | long-list |
| 600 / 900 / 1024 | search |
| 600 / 900 / 1024 | workspace-menu |
| 600 / 900 / 1024 | attention |

`scripts/phase8-visual-gate.mjs` 校验上述矩阵、独立 list scrollport、折叠 Search、attention indicator、五条窗口和 focus/hover menu marker；既有 Shell/Settings 六张 JPEG 的尺寸与格式校验保持不变。

## 验证

```text
pnpm typecheck                                      ✓
pnpm build:web                                      ✓
pnpm --filter @code-review-agent/web test -- --run src/shell/sidebar-shell.test.ts   ✓（9 tests）
pnpm test:phase8:visual                             ✓
node scripts/phase8-sidebar-gate.mjs               ✓
git diff --check                                    ✓
```

M7 gate 输出包含：

- request SSE sequences `[2, 3]`、resolution SSE sequences `[4, 5]`；
- restart 后 pending 数 `2`，resolution/replay 后 pending 数 `0`；
- MCP status `failed`，API restart 后保持 `failed`；
- delegation fixture 中 running child task 和 scoped replay event 数；
- 600/900/1024、empty/long-list/search/workspace-menu/attention、keyboard/ARIA/focus 矩阵。

## 未覆盖与后续

- 尚未引入 Playwright/Chromium 像素级截图 diff；接入时复用 M7 fixture 和 `sidebarMatrix`，不要改变 EventStore 或 Web projection。
- Sidebar attention 点击和 Details summary focus 目前由 shell contract 与稳定入口断言保护，图形浏览器 click/focus 仍待后续真实浏览器运行环境。
- WorkspaceBrowser 仍由 `apps/web/index.html` 兼容 renderer 编排；稳定 key、局部 DOM 复用和完整文件拆分属于 P2。

## 回滚

删除 `apps/web/tests/sidebar-attention-replay.e2e.mjs`、`scripts/phase8-sidebar-gate.mjs`、`package.json` 的 `test:phase8:sidebar`、M7 shell 断言、`sidebarMatrix` 字段及本日志即可回滚本轮证据。不要回滚 M6 attention 运行时代码、既有 JPEG 基线或任何 Event/Tool/Task/Permission/Workspace contract。
