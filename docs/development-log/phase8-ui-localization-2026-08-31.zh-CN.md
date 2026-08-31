# Phase 8 前端中文化开发日志（2026-08-31）

## 目标

将 Web 工作台中面向用户的英文界面字段尽可能改为简体中文，降低三栏工作台的阅读噪声，同时保持事件、工具、权限和模型契约稳定。

## 边界

- 翻译显示层、状态标签、空态、按钮、标题、提示、ARIA 文案和详情字段。
- 保留工具真实名称、模型名、provider 名、MCP/LSP/A2A 等协议标识、文件路径、命令、用户消息和 Agent 原始输出。
- 不修改根目录 `AGENTS.md`，不引入完整多语言运行时。
- 不改变事件状态内部值、CSS 状态类和 API 字段名；必要时仅在 presenter/DOM 层提供中文显示值。

## 已完成（截至当前批次）

### 静态 Web Shell

- `apps/web/index.html`
  - 页面标题、品牌、侧栏、工作区、会话、归档、搜索、设置、计划、模型、上下文、发送/取消等静态文案已中文化。
  - 主要 ARIA label 和 placeholder 已中文化。
  - 增加 `localizeStatus`、`localizeKind` 和 `localizeVisibleUi`，用于覆盖动态状态、空态、详情字段及 ARIA 属性；只处理已知 UI 文案，不处理用户/Agent 原文。

### Presenter / Sidebar

- `apps/web/src/presentation/composer-presenter.ts`
- `apps/web/src/presentation/connection-presenter.ts`
- `apps/web/src/presentation/context-presenter.ts`
- `apps/web/src/presentation/deliverables-presenter.ts`
- `apps/web/src/presentation/goal-presenter.ts`
- `apps/web/src/presentation/plan-presenter.ts`
- `apps/web/src/presentation/question-presenter.ts`
- `apps/web/src/presentation/queue-presenter.ts`
- `apps/web/src/presentation/request-presenter.ts`
- `apps/web/src/presentation/settings-presenter.ts`
- `apps/web/src/presentation/task-presenter.ts`
- `apps/web/src/presentation/todo-presenter.ts`
- `apps/web/src/presentation/tool-presenter.ts`
- `apps/web/src/presentation/trajectory-presenter.ts`
- `apps/web/src/presentation/lsp-presenter.ts`
- `apps/web/src/presentation/mcp-presenter.ts`
- `apps/web/src/presentation/job-presenter.ts`
- `apps/web/src/presentation/worktree-presenter.ts`
- `apps/web/src/sidebar/sidebar-attention.ts`
- `apps/web/src/sidebar/sidebar-presenter.ts`
- `apps/web/src/sidebar/session-row.ts`
- `apps/web/src/sidebar/workspace-row.ts`
- `apps/web/src/shell/boot.ts`

已处理的类别包括：回合/步骤/工具状态、连接状态、上下文压缩、权限与交互请求、目标/计划/待办、任务/工作树、LSP/MCP、终端与作业诊断、轨迹概览/时间线/详情、工作区和会话相对时间。

## 测试同步

已同步受显示文案影响的 Web 单元测试，包括 presenter、sidebar、shell 测试。测试输入中的真实工具名、模型名、路径和用户内容保持原样。

## 当前验证状态

- 术语修订：品牌展示统一为 `Coding Agent`；对话头像保留 `AI`；`Bash`、`Diff / Patch`、`Terminal / Job` 和 `Generation` 保留英文；`Lineage warnings` 调整为“调用链告警”；审批和问题计数调整为“待审批”“已恢复审批”“已过期审批”“待回答问题”等更紧凑的中文。
- 第二批已完成：
  - `apps/web/index.html` 的动态权限/交互卡片、轨迹、任务/产物、MCP/LSP、工作树、模型/模式菜单、侧栏状态、重命名/删除确认和连接状态已中文化。
  - `apps/web/src/shell/app-frame.ts` 的移动侧栏 ARIA 标签已中文化，并同步 `app-frame.test.ts`。
  - `localizeStatus` 现在按大小写不敏感方式处理状态值；动态本地化扫描跳过用户/Agent 消息、代码块、工具名、工具目标、工具输入输出、产物预览和路径。
  - 继续保留工具真实名称、模型/provider、协议、路径、命令、用户输入和 Agent 原始输出。
- 当前待验证：运行 Web 测试并同步显示文案期望；随后运行 `pnpm typecheck`、Web build、`git diff --check`，再检查动态 HTML 是否仍有未覆盖英文。

## 回滚

本次变更可通过回滚本开发日志对应的本地化文件和独立 checkpoint 恢复；不涉及 Event/Tool/Task/Permission/Workspace contract。
