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

## 2026-08-22：GFM 编号列表与表格渲染校正

### 问题定位

- 轻量 Markdown 渲染器在编号列表项目之间遇到空行时会刷新当前 `<ol>`，浏览器因此为每个项目重新从 1 开始编号。
- 表格语法此前按普通段落处理，`|` 字符被直接展示，缺少 `<table>/<thead>/<tbody>` 结构。

### 参考与变更

- 对照 DSH `ui-primitives` 的 `MarkdownText`、GFM parser、direct renderer 和 markdown DOM fixtures，保持连续列表、嵌套列表和表格的语义结构。
- 编号列表允许项目间空行继续归属于同一个 `<ol>`，缩进项目归入父项目的嵌套列表。
- 识别 GFM 表头/分隔线/数据行，生成 `<table>`、`<thead>`、`<tbody>`、`<th>` 和 `<td>`；支持左/中/右对齐和横向滚动容器。
- 表格单元格继续经过 Markdown inline renderer，支持粗体、代码和安全链接。

### 验证

```text
Web script parse ✓
Browser DOM smoke ✓（单个 5 项 `<ol>`、3 个嵌套列表、7 行 Markdown 表格）
pnpm typecheck   ✓
pnpm test        ✓
```

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

## 2026-08-22：助手消息 Markdown 渲染

### 问题定位

- Assistant 消息使用 `textContent` 写入页面，Markdown 标记会以井号、星号和反引号原样显示。
- 代码审查和 Coding Agent 的核心输出包含标题、列表、代码片段和链接，纯文本展示会降低阅读和复制效率。

### 变更范围

- Assistant 消息增加安全的轻量 Markdown 渲染器，覆盖标题、段落、粗体、斜体、行内代码、fenced code block、无序/有序列表、任务复选框、引用、分隔线和 HTTP(S) 链接。
- 渲染前统一转义原始 HTML；链接协议限制为 HTTP(S)，外部链接使用新标签页和 `noreferrer noopener`。
- 流式 `assistant/chunk` 按原始消息缓冲重新渲染，历史消息和实时消息保持相同的 Markdown 效果。
- User 消息、工具详情、权限 payload 和 JSON 结果继续使用纯文本/等宽文本展示，保留原始结构。

### 验证

```text
Web script parse ✓
Browser DOM smoke ✓（标题、strong、inline code、列表节点）
HTML injection check ✓（助手消息中没有 script/iframe 节点）
pnpm typecheck   ✓
pnpm test        ✓
```

## 2026-08-22：Turn 工具时间线渲染

### 问题定位

- Runtime 事件序列本身已经按 `assistant/message` 阶段标记、`tool/call`、`tool/progress`、`tool/result`、`assistant/chunk` 和 `turn/ended` 写入。
- Web 渲染器以前按 `turnId` 把所有 Assistant 内容合并为单个 DOM 节点。后续模型输出被更新到第一个位置，工具卡片因此落在回复末端。

### 变更范围

- Assistant 消息改为按消息边界创建片段；空的工具阶段消息只作为阶段标记，不生成空白气泡。
- `tool/call` 在时间线当前位置创建工具卡片，后续 progress/result 更新同一张卡片，保留执行过程和最终状态。
- 增加 `Agent is working…` 和 `Turn completed` 状态行；失败、中断等终态会显示对应状态，用户可以判断当前回复是否完整。
- 历史回放和 SSE 增量事件使用同一套 Turn timeline reducer，避免刷新前后顺序不同。

### 验证

```text
Web script parse ✓
Browser timeline smoke ✓（user → running → tools → assistant → completed）
pnpm typecheck   ✓
pnpm test        ✓
```

## 2026-08-22：列表编号与 GFM 表格回归修正

### 问题定位

- 有序列表需要明确使用浏览器的十进制列表语义，避免样式被重置后每个条目都从 1 开始。
- Markdown 表格需要继续沿用 DSH 的 GFM 行为：表头、分隔行、对齐方式和表格主体分别映射到语义化 table DOM。

### 变更范围

- 有序列表显式设置 `decimal` marker 和标准列表布局；解析器保留首项编号，并在非 1 起始时使用 `start` 属性。
- 空行后的连续有序列表继续归并到同一个 `<ol>`，避免每个条目生成独立列表。
- GFM 表格继续渲染为 `<table>/<thead>/<tbody>/<th>/<td>`，支持列对齐、转义管道符和横向滚动；原始 HTML 仍按 DSH 约定作为字面文本处理。

### 验证

```text
Web script parse ✓
git diff --check ✓
Browser DOM smoke ✓（有序列表为单个 <ol>，GFM 表格为语义化 <table>）
pnpm typecheck ✓
pnpm test ✓
```

## 2026-08-23：Trajectory ledger query 与 inspector

### 目标与 DSH 对照

- 对照 DSH `ui-trajectory` 的可搜索 ledger、lane/timeline 分组和 request inspector，把已有共享 `TrajectoryProjection` 接入可操作的 details surface。
- 继续遵循 EventStore 唯一事实来源：Web 只查询 `SessionStoreSnapshot.trajectory`，搜索和选中记录属于可丢弃的 UI 状态，不创建第二套事件日志。
- 按本项目安全边界统一处理 tool/trajectory detail：敏感 key 脱敏，JSON 有界截断，内容标记为 untrusted；running record 没有结束时间时不显示虚构 duration。

### 变更范围

- 新增 `apps/web/src/presentation/safe-value.ts`，集中提供 bounded JSON、循环引用保护、credential-like key redaction 和 trust/truncation 标记；Tool presenter 改用同一策略。
- 新增 `apps/web/src/presentation/trajectory-presenter.ts`，提供 query、kind/runningOnly/limit 过滤、稳定 lane grouping 和 Overview/Timing/Source/Rendered detail inspector。
- `apps/web/src/browser.ts` 暴露 `queryTrajectory`、`inspectTrajectory`；`apps/web/index.html` details panel 接入搜索、running-only、lane/record 选择和 inspector，并在 details 重建时自动恢复 panel。
- 新增 safe-value/trajectory-presenter 单元测试，覆盖脱敏、截断、循环引用、过滤、limit、lane、timing、running duration 和 detail redaction。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test           ✓（25 tests）
pnpm -F @code-review-agent/web run build:browser   ✓
git diff --check                                    ✓
```

真实 API/browser smoke：

- Trajectory ledger 显示 4 条真实记录、lane 计数和 sequence；
- 搜索 `permission` 过滤为匹配记录，点击 `write_file` 记录后 inspector 切换到 permission 的 Overview/Timing/Source/Rendered detail；
- running-only 在没有运行中记录时显示可解释空态；
- inspector detail 中的事件内容显示 `untrusted`，credential-like 字段按统一策略脱敏；
- 刷新后恢复为 `4 matched · 4 shown · sequence 10`、4 条记录，浏览器 console 无 warning/error。

### 下一步

- 继续补 Trajectory timeline 的折叠、tail-follow/pause-follow、load older 和大数据量虚拟化；
- 完成 permission/interaction 过期与重启恢复、Subagent/Task/MCP details surface，并纳入统一 browser replay fixtures。

## 2026-08-23：Task/Subagent details surface

### 目标与 DSH 对照

- 对照 DSH `ui-subagent` 和 Host `subagents` API 的 parent/child catalog、child history、report/artifact 与控制入口，把 Phase 5 的内部 Task/Subagent projection 纳入 Web details。
- Web 不读取 live Agent 对象，也不把 Subagent catalog 变成事实来源；details 同时消费 `SessionStoreSnapshot.session.tasks` 和现有 typed Subagent catalog，重复 task 按 id 去重。

### 变更范围

- 新增 `apps/web/src/presentation/task-presenter.ts`，将 `TaskProjection` 转换为 bounded render intent：status、mode/provider、parent/child lineage、report summary、artifact labels、diagnostics、resumable/cancellable。
- 新增 task presenter 测试，覆盖 lineage、live cancellable/resumable、report summary 和 credential redaction。
- `apps/web/src/browser.ts` 暴露 `presentTask`；`apps/web/index.html` details panel 增加 Tasks & child agents ledger、选择式 inspector、child session navigation 和 live task cancel。
- Task details 使用统一 `safe-value` redaction/truncation policy；未加载或不存在的 task 保持明确空态，不伪造 child 状态。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test           ✓（28 tests）
pnpm -F @code-review-agent/web run build:browser   ✓
git diff --check                                    ✓
```

真实 API/browser smoke：

- 当前真实 Session 没有 child task，details 显示 `0 tasks · 0 live` 空态；
- 页面刷新后 Task/Subagent panel、Trajectory panel 均只出现一次，浏览器 console 无 warning/error；
- 非空 TaskProjection 的 lineage、report/artifact、redaction 和 cancelability 由 presenter 单元测试覆盖。

### 下一步

- 建立一个隔离、可回放的真实 Delegation fixture，验证 parent/child tree、child history、report/artifact 和 cancel；
- 补 MCP details surface，并继续处理 permission/interaction expiry/restart 与 Trajectory timeline。
