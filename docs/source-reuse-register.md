# 上游参考与复用登记

每次直接复制、改编或大量依赖上游代码时，在本文件登记一条记录。只读参考、不产生代码来源关系的阅读不需要登记。

## 登记格式

```text
ID:
来源仓库:
来源路径:
复用方式: copy | adapt | behavior-reference
许可证/来源证据:
本项目路径:
删除或改写的部分:
新增测试:
```

## 当前登记

### DSH-001

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/client`、`apps/web`

复用方式：`adapt`

许可证/来源证据：根仓库和 Web package 声明 MIT。

本项目路径：未来的 `apps/web`。

范围：复用 Shell、Session sidebar、Conversation、Tool row、Diff、Permission、Terminal 和 Settings 的信息架构；先剥离 Cordis、DSH 专有 API 和无关插件依赖。

要求：保留 MIT notice；所有 API/event 类型改为本项目 `packages/contracts`；补充本项目的 SSE 重连和权限测试。

### DSH-002

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/core/agent-loop/src/agent.ts`、`packages/core/agent-loop/src/tool-calls.ts`

复用方式：`behavior-reference`，必要时在确认具体 package license 后再局部 `adapt`。

许可证/来源证据：根仓库 MIT；具体复制前检查目标 package 的 notice。

本项目路径：未来的 `packages/runtime`、`packages/tools`。

范围：turn/step、parallel/exclusive、取消、兄弟工具失败、结果顺序和 progress 语义。

### DSH-003

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/client/ui-layout`、`packages/client/ui-sidebar`、`packages/client/ui-conversation`、`packages/client/ui-model-selection`、`packages/client/ui-tool`

复用方式：`behavior-reference` + `adapt`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本批没有复制 DSH 品牌资产或运行时代码。

本项目路径：`apps/web/index.html`

范围：三栏 AppFrame 几何、sidebar rail、New session、workspace picker、hero/composer 空态、composer model popover、details panel、tool row 和 permission card 的信息分区与交互顺序。

改写部分：所有 DOM、CSS、事件渲染和 API 调用均适配本项目静态 Web shell、`/v1/*` API 和 SSE event contract；品牌、颜色、图标、文案和模型列表使用本项目内容。

新增测试：浏览器 smoke 验证 Session transcript、Connected 状态、模型 popover/切换、sidebar collapse、details close 和 API error 空态。

### DSH-004

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx`、`packages/client/ui-workspace/src/client/tree.ts`、`packages/client/ui-sidebar/src/client/SidebarRoot.tsx`。

复用方式：`behavior-reference` + `adapt`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本批没有复制 DSH 运行时类型或品牌资产。

本项目路径：`apps/web/index.html`。

范围：Workspace 父级分组、Session 子项、展开/折叠、搜索、活动/归档视图、行级操作菜单、滚动侧栏和当前 Workspace 自动展开。

改写部分：树数据直接由本项目 `/v1/sessions` projection 按 `workspaceRoot` 派生；Session 操作使用本项目 archive/restore/delete API；Workspace 和 Session 文案、颜色、图标保持本项目风格。

新增测试：浏览器 DOM smoke 验证多 Workspace 分组、搜索过滤、展开/折叠和 Session 操作菜单；API 合同测试覆盖软删除与事件历史保留。

### DSH-005

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/client/ui-primitives/src/markdown/MarkdownText.tsx`、`packages/client/ui-primitives/src/markdown/parse.ts`、`packages/client/ui-primitives/src/markdown/render.tsx`、`packages/client/ui-primitives/tests/fixtures/markdown-dom`。

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本批没有复制 DSH Markdown parser 或 React renderer 实现。

本项目路径：`apps/web/index.html`。

范围：GFM 有序/无序列表的连续编号、嵌套列表、表格 header/body、列对齐、横向滚动、流式 Markdown 的稳定 DOM 行为和原始 HTML 安全策略。

适配方式：当前静态 Web shell 保持无构建依赖，按 DSH 的 GFM DOM 语义适配轻量渲染器；表格和列表样式使用本项目 CSS token，HTTP(S) 链接和 HTML 转义继续由本项目安全规则控制。

### CC-001

来源仓库：`D:/Develop/claude-code`

来源路径：`src/query.ts`、`src/services/tools/StreamingToolExecutor.ts`、`src/tools.ts`。

复用方式：`behavior-reference`；只有具体文件或 package 的许可证明确兼容时才 `adapt`。

许可证/来源证据：本地快照未发现根 `LICENSE`；仓库描述为 reverse-engineered/decompiled。

本项目路径：未来的 `packages/runtime`、`packages/tools`、`packages/llm`。

范围：流式 turn、工具调度、工具目录、权限前置检查、错误合成和恢复路径。不得默认整段复制实现。

### CC-002

来源仓库：`D:/Develop/claude-code`

来源路径：`packages/builtin-tools/src/tools`、`src/services/contextCollapse`、`src/coordinator`。

复用方式：`behavior-reference`。

许可证/来源证据：按目录逐文件核实；无明确许可时只复刻接口和行为。

本项目路径：未来的 `packages/tools`、`packages/context`、`packages/agents`。

范围：Read/Edit/Write/Glob/Grep/Bash/Task 的用户体验，上下文压缩、父子任务和报告模型。
