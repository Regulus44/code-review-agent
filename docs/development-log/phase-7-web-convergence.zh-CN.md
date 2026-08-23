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

## 2026-08-23：MCP details surface

### 目标与 DSH 对照

- 对照 DSH MCP roster、tool catalog、scope/generation 和 retry diagnostics，把 Phase 4B 已稳定的 MCP server view 纳入 Phase 7 details inspector。
- Web 只消费 API 返回的 public server/config/catalog projection；不读取 credential provider、MCP manager 或 ToolRegistry 内部对象，也不把 MCP details 作为执行事实来源。

### 变更范围

- 新增 `apps/web/src/presentation/mcp-presenter.ts`，统一呈现 server status、scope、transport、revision/generation、auth、catalog enabled/disabled reason、retry/error 和 bounded raw detail。
- 新增 MCP presenter 测试，覆盖 catalog policy、retry/error、credential reference 和统一 redaction。
- `apps/web/src/browser.ts` 暴露 `presentMcpServer`；`apps/web/index.html` details panel 增加 server ledger、选择式 inspector 和 catalog policy 详情。
- MCP config、env、headers 和 credential reference 继续经过 API/host 脱敏与 Web `safe-value` 双重边界；面板只读，不新增未经授权的连接或工具命令。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test           ✓（31 tests）
pnpm -F @code-review-agent/web run build:browser   ✓
git diff --check                                    ✓
```

真实 API/browser smoke：

- 空态显示 `0 servers · 0 connected`，刷新后 panel identity 稳定；
- 临时创建 disabled/project/stdio MCP fixture 后，面板展示 status/scope/transport/revision/generation/auth/catalog 计数；
- `AUTH_TOKEN` 和 credential reference 在 inspector 中显示 `[redacted]`，detail 标记为 `untrusted`；
- fixture 已通过 DELETE 清理，API 再次返回空 server 列表，浏览器 console 无 warning/error。

### 下一步

- 建立真实非空 Delegation replay fixture，验证 parent/child Task、report/artifact、child history 和 cancel；
- 继续处理 permission/interaction expiry/restart 与 Trajectory timeline。

## 2026-08-23：Permission/Interaction expiry 与 restart recovery

### 目标与 DSH 对照

- 对照 DSH approvals/questions 的 server-request 语义，把 Permission/Interaction 的 pending、resolved、expired、reconnecting 和恢复提示统一纳入 Web render intent；
- 保持 EventStore 为事实来源：Web 只根据 Conversation projection 和当前 Session/connection 状态计算可丢弃的显示状态，不在浏览器写入 request 状态；
- 修复 API/AgentHost 重启后只恢复 Permission、没有恢复 Interaction 的缺口，确保 question answer 能继续原 turn。

### 变更范围

- 新增 `apps/web/src/presentation/request-presenter.ts`：根据 `expiresAt` 计算 deadline-safe display status；过期请求不暴露 approve/answer action；interrupted/reconnecting session 标记 `Recovered request`；详情统一 bounded JSON、敏感字段脱敏和 untrusted marker；
- `apps/web/index.html`：Permission/Interaction card 显示 expired/recovery 状态，details 增加 pending/recovered/expired 计数；fallback renderer 同样保留终态记录；
- `packages/tools/src/runtime.ts`：`restorePending()` 重建 Interaction waiter，重启后支持 answer/cancel；恢复 answer 追加合成的 bounded `tool/result`，过期恢复请求追加 `interaction/resolved(expired)` 和失败结果；
- `packages/runtime/src/index.ts`：RecoveredTurn 同时跟踪 permission/interaction，等待所有阻塞请求解决后恢复原 turn；reconcile 处理 expiry timer 在无 API command 时产生的终态；
- `packages/tools/src/index.test.ts`、`packages/runtime/src/index.test.ts`、`apps/api/src/server.test.ts`：增加 runtime、AgentHost、API restart recovery fixtures。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test           ✓（34 tests）
pnpm --filter @code-review-agent/tools test -- --run src/index.test.ts   ✓（30 tests）
pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts ✓（13 tests）
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts    ✓（16 tests）
pnpm -F @code-review-agent/web run build:browser   ✓
git diff --check                                    ✓
```

### 下一步

- 建立隔离、可回放的非空 Delegation fixture，验证 parent/child tree、child history、report/artifact 和 cancel；
- 补 browser replay fixture，把恢复请求的显示、回答和终态纳入真实 Web smoke；
- 继续 Trajectory timeline、折叠、tail-follow/pause-follow、load older 和大数据量虚拟化。

## 2026-08-23：非空 Delegation fixture 与 browser replay 收口

### 目标与 DSH 对照

- 对照 DSH `ui-subagent`、`packages/host/apiproxy/src/api/subagents.ts` 和 child Session history，将 Phase 5 的内部 parent/child Task projection 变成可重复的真实 Web fixture；
- 验证 Web 只消费 parent Session projection、Subagent catalog 和 child scoped replay，不读取 live Agent 对象，也不把 A2A 引入内部 Multi-Agent transport；
- 把本轮验证发现的短 TTL expiry timer 竞争修复在 ToolRuntime 中，保持 `expired`、`cancelled` 和重启恢复语义稳定。

### 变更范围

- 新增 `apps/api/src/fixtures/delegation.ts`：`phase-7-fixture` provider，completed child、cancellable child、非空 child transcript、bounded report/artifact，以及显式 workspace、permission、tool/MCP allowlist；
- 新增 `scripts/phase7-delegation-fixture-server.mjs`：启动隔离 in-memory API，seed fixture 并输出可供浏览器 smoke 使用的 parent/child ids；
- `packages/storage/src/index.ts`：`task/report` 的 artifacts 合并到顶层 `TaskProjection.artifacts`，按 artifact id 去重；
- `packages/subagent/src/runtime.ts`：`taskOutput()` 增加 parent/ancestor authority 检查，兄弟 Session 不能读取其他 child transcript；
- `apps/api/src/server.test.ts`：覆盖 catalog、completed/cancellable child、history、report/artifact、workspace/permission/tool/MCP scope、parent/scoped replay、sibling rejection、cancel 和 live-state cleanup；
- `apps/web/index.html`：刷新 Subagent catalog 后重新渲染 typed Task panel，修复打开 child Session 后残留 parent task 的 identity 泄漏；
- `packages/tools/src/runtime.ts`：expiry timer 触发时重新检查绝对截止时间，避免定时器提前唤醒将过期 permission 错记为取消。

### 验证

```text
pnpm typecheck                                      ✓
pnpm test                                            ✓（全 workspace 通过）
pnpm --filter @code-review-agent/web test            ✓（34 tests）
pnpm --filter @code-review-agent/tools test -- --run src/index.test.ts   ✓（30 tests）
pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts ✓（13 tests）
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts    ✓（17 tests）
pnpm -F @code-review-agent/web run build:browser    ✓
git diff --check                                    ✓
```

真实 browser smoke：

- parent 初始显示 completed child 和 cancellable child，details 为 `2 tasks · 1 live`；completed child 的 report/artifact 和 bounded detail 可见；
- 点击 cancel 后 parent 显示 `2 tasks · 0 live`，cancellable child 变为 `cancelled`，child transcript 追加 `subagent/settlement`、`subagent/end` 和 interrupted turn；
- 刷新 parent 后 Task/Trajectory/replay 仍显示 `cancelled`，没有重复记录；
- 打开 child Session 后 Conversation 显示 fixture prompt、assistant summary 与 `subagent/*` events，details 显示 `0 tasks · 0 live`，没有残留 parent task；
- console warn/error 为空，临时 API 进程已关闭。

### 下一步

- 继续 Trajectory timeline 的 record 折叠/展开、tail-follow/pause-follow、load older 和 1000+ records 虚拟化；
- 将 Read-only、Edit、Test/Recovery、Delegation、Inspection browser fixture 汇总为 Phase 7.10 可重复门禁，并补性能基线。

## 2026-08-23：Trajectory timeline、折叠与 tail-follow

### 目标与 DSH 对照

- 对照 DSH `ui-trajectory`、`timeline.ts` 和 request inspector，把已有 query/lane/inspector projection 延伸为有界 timeline；
- 保持 EventStore 唯一事实来源：timeline 只消费 `TrajectoryProjection`，record/lane 折叠和 tail-follow 是当前 Web session 的可丢弃 UI 状态；
- 对真实时间字段保持诚实：只有同时存在合法 started/ended timestamp 才显示 recorded timing，running record 不显示伪造 duration。

### 变更范围

- `apps/web/src/presentation/trajectory-presenter.ts`：新增 `buildTrajectoryTimeline()`，提供 stable source order、recorded span、nested tool depth、offset/width、running/unknown timing 和 1000 行 bounded limit；
- `apps/web/src/presentation/trajectory-presenter.test.ts`：覆盖稳定排序、嵌套深度、bounded width、unknown timing 和 running duration；Web 测试增至 35 项；
- `apps/web/src/browser.ts`：向静态 shell 暴露 `buildTrajectoryTimeline`；
- `apps/web/index.html`：Trajectory details 增加 Timeline record `<details>` 折叠、lane 折叠、`Following tail`/`Paused` 控件；conversation scroll 离开尾部时自动暂停跟随，回到尾部时恢复；Session 切换清理可丢弃的折叠/选择状态。

### 验证

```text
pnpm typecheck                                      ✓
pnpm test                                            ✓（全 workspace 通过）
pnpm --filter @code-review-agent/web test            ✓（35 tests）
pnpm -F @code-review-agent/web run build:browser    ✓
git diff --check                                    ✓
```

真实 browser smoke：

- parent fixture 的 timeline 显示 `1ms span`，completed record 为 `recorded`，cancellable record 为 `running · duration unknown`；
- `Following tail` 切换为 `Paused` 后按钮状态和 `aria-pressed` 正确；
- `task · 2` lane 可折叠，timeline record 可单独折叠，刷新后事实记录仍从 replay projection 重建；
- browser console warn/error 为空，临时 fixture API 进程已关闭。

### 下一步

- 继续收敛 Read-only、Edit、Test/Recovery、Delegation、Inspection 的 Phase 7.10 browser fixtures 和性能基线。

## 2026-08-23：Trajectory history paging、prepend replay 与 1000+ fixture

### 目标与 DSH 对照

- 对照 DSH `ui-conversation`/`ui-trajectory` 的 older page、cursor 和 bounded render window，把已有全量 `/events?format=json` 回放扩展为可恢复的历史分页；
- 保持 EventStore 为唯一事实来源：分页只限制 Web 已加载/渲染的窗口，不能删除或重写事件；prepend 后重新从共享窗口折叠 Conversation、ToolCallTree 和 Trajectory；
- 保持 newest SSE cursor 独立于 oldest history cursor，加载 older 不重新执行工具、不重复消费 live event。

### 变更范围

- `packages/contracts/src/index.ts`：新增可选 `EventStore.listPage()`、`EventListOptions`、`EventPage`，保留旧 `list(sessionId, afterSequence)` 兼容路径；
- `packages/storage/src/index.ts`：InMemory/SQLite 支持 latest page、`before_sequence`、limit、hasMore 和 oldest/newest sequence；
- `packages/runtime/src/index.ts`、`apps/api/src/server.ts`：增加 `AgentHost.eventsPage()` 和分页 JSON DTO；无分页参数时继续返回旧数组响应；
- `apps/web/src/client/api.ts`、`connection.ts`、`store.ts`：初始读取 200-event tail page，`loadOlder()` 以 oldest sequence prepend，去重并 rebuild derived projection；
- `apps/web/index.html`：Trajectory details 增加 `Load older`，加载 older 时保持 scroll anchor；paused tail-follow 仍消费新事件但不强制滚动；
- `apps/api/src/fixtures/trajectory.ts`、`scripts/phase7-trajectory-fixture-server.mjs`：新增 1,250 条 completed read-only tool record fixture；
- `apps/web/src/presentation/trajectory-presenter.test.ts`：新增 1,200 条记录的 searchable/bounded ledger/timeline 测试。

### 验证

```text
pnpm typecheck                                      ✓
pnpm test                                            ✓（全 workspace 通过）
pnpm --filter @code-review-agent/web test            ✓（39 tests）
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓（18 tests）
pnpm --filter @code-review-agent/storage test -- --run src/index.test.ts ✓（10 tests）
pnpm -F @code-review-agent/web run build:browser    ✓
git diff --check                                    ✓
```

真实 browser smoke：

- 1,250-record fixture 初始 bounded page 显示 100 条 tool records；点击 `Load older` 后显示 200 条，oldest cursor prepend 后 newest sequence 仍保持 2501；
- 精确搜索 `trajectory_fixture_call_1250` 显示 `1 matched · 1 shown`；timeline/ledger render 保持有界；
- `Following tail` 切换为 `Paused` 后追加 live turn，sequence 从 2501 前进而按钮仍为 `Paused`；恢复跟随后仍使用同一 SSE connection；
- browser console warn/error 为空，临时 fixture API 和 tab 已关闭。

### 下一步

- 将 Read-only、Edit、Test/Recovery、Delegation、Inspection browser fixture 汇总为 Phase 7.10 门禁；
- 补充 load-older 多页性能测量、真实 Read/Edit/Test trajectory fixture 和 shell 拆分/导航收敛。

## 2026-08-23：Read-only、Edit、Test/Recovery Coding fixture

### 目标与 DSH 对照

- 对照 DSH `ui-conversation`、`ui-tool`、`ui-permission-presets`、`ui-jobs` 和 `ui-trajectory` 的 Coding 工作流，把前面已验证的 projection、permission、diff、job/recovery surface 连接到真实可回放的 Web 场景；
- 使用真实 `AgentHost`、`ToolRuntime` 和 SQLite EventStore，不在 fixture 中伪造 tool/result 或浏览器成功状态；
- 保持 Phase 5 内部 Task/Subagent 和 Phase 6 A2A 的边界：本切片不实现 A2A，也不把 A2A 当作内部 Multi-Agent transport。

### 变更范围

- `apps/api/src/fixtures/coding.ts`：新增 Read-only、Edit、Test/Recovery 三个隔离 workspace/session。Read-only 完成 `read_file`；Edit 在 `ask-on-write` 下等待批准，批准后产生真实文件修改和 `diff/preview`；Test/Recovery 在 `ask-on-execute` 下等待 `run_tests`，通过 SQLite API/AgentHost 重启验证 pending permission 恢复；
- `apps/api/src/fixtures/coding.test.ts`：覆盖 completed read-only projection、edit approval 后的文件内容与 diff，以及 test/recovery pending permission；
- `scripts/phase7-coding-fixture-server.mjs`：提供真实 browser smoke harness，seed 后关闭并重开同一 SQLite 数据库，再通过正常 API/SSE/permission 路径继续任务。

### 根治理七问

1. **Phase**：Phase 7.10 browser/replay fixture 基线。
2. **问题类型**：Web 验收、事件回放、权限交互和恢复证据；不重写 Runtime。
3. **契约影响**：复用已有 Event/Tool/Permission/Workspace contract；没有新增生产事件类型。
4. **参考入口**：DSH `ui-conversation`、`ui-tool`、`ui-permission-presets`、`ui-jobs`、`ui-trajectory`；Claude Code 只作流式 Coding 行为参考。
5. **上游来源**：只做行为对照，没有复制 DSH 或 Claude Code 代码；无需新增许可证登记。
6. **验收场景**：Read-only、Edit、Test/Recovery 的真实浏览器批准、回放和重启恢复。
7. **回滚**：删除 fixture server/fixture 文件或关闭 browser gate，不影响生产 AgentHost、Web fallback、MCP、内部 Subagent 和 A2A deferred 状态。

### 验证

```text
pnpm typecheck                                      ✓
pnpm test                                            ✓
pnpm --filter @code-review-agent/api test -- --run  ✓（19 tests）
pnpm -F @code-review-agent/web run build:browser    ✓
git diff --check                                    ✓
```

真实 browser smoke：

- Read-only Session 的 `read_file` completed，assistant summary 显示 `fixtureValue = 42`，trajectory 收敛为 completed；
- Edit Session 批准 `edit_file` 后真实 workspace 的 `notes.txt` 从 `before` 变为 `after`，页面显示 unified diff 和 `diff/preview`，turn completed；
- Test/Recovery Session 在 API/AgentHost 重启后显示 `Recovered request · response will continue the turn`，批准后 `run_tests` completed，trajectory 从 interrupted 收敛为 completed；
- 三个场景刷新/回放后无重复 tool execution，浏览器 console 无 warning/error。

### 下一步

- 将三个 Coding fixture 与 Delegation、Inspection 汇总为单一可重复的 Phase 7.10 browser gate；
- 补 Test/Recovery 的长任务 terminal/job output、失败诊断，以及 1,000+ Trajectory 多页性能测量；
- 继续 Shell 拆分、Workspace/Session 导航和 Settings/Deliverables/accessibility 收敛。

## 2026-08-23：Settings 与 capability surface

### 目标与 DSH 对照

- 对照 DSH `ui-settings*`、`ui-model-selection`、`ui-permission-presets` 和 MCP roster 的 host-backed details，把已有静态 `Workspace settings` 入口接入真实 projection；
- 让用户可以在一个可访问对话框中检查 workspace、session 状态、permission mode、model、tool risk、MCP health 和 capability availability；
- 保持 EventStore 为事实来源：Settings 只读 Session/Model/Tool/MCP projection，A2A 继续 `deferred`，不把 UI 状态或外部协议字段写入 Runtime。

### 变更范围

- `apps/web/src/presentation/settings-presenter.ts`：新增 bounded `SettingsRenderIntent`，汇总 workspace/status、permission 描述、model catalog、tool source/risk 计数、MCP connected/attention 计数和 Coding tools/MCP/Internal subagents/A2A capability 状态；
- `apps/web/src/presentation/settings-presenter.test.ts`：覆盖完整 host catalog、MCP attention、风险统计和可选数据缺失时的安全默认值；
- `apps/web/src/browser.ts`：暴露 `presentSettings` 给静态 Web bridge；
- `apps/web/index.html`：新增 `Workspace settings` dialog，使用 textContent 渲染 General、Permission、Model、Tool catalog、MCP 和 Capabilities 分区，支持 Close、backdrop 和 Escape；
- 没有新增 API、Event、Tool、Task、Permission 或 Workspace contract；没有复制 DSH/Claude Code 代码或资产。

### 根治理七问

1. **Phase**：Phase 7.9 Settings/capability surface。
2. **问题类型**：Web UI、render intent、可访问交互和能力声明。
3. **契约影响**：只消费已有 Session、Model、Tool、MCP projection；无生产事实 contract 变化。
4. **参考入口**：DSH `ui-settings*`、`ui-model-selection`、`ui-permission-presets`、MCP roster；Claude Code 仅作 model/permission 行为参考。
5. **上游来源**：行为参考，不复制代码；无需新增许可证登记。
6. **验收场景**：Test/Recovery 页面打开 Settings，检查 interrupted/recovered 状态、Ask on execute、tool/MCP 统计、A2A deferred，并用 Close/Escape 关闭。
7. **回滚**：移除 dialog 和 presenter，保留原 details panel；不影响 Runtime、EventStore、MCP、内部 Subagent 或 A2A deferred 状态。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test -- --run  ✓（41 tests）
pnpm -F @code-review-agent/web run build:browser    ✓
git diff --check                                    ✓
```

真实 browser smoke：

- Settings dialog 显示 workspace、`interrupted` session、`Ask on execute`、model/configuration、34 个 host-approved tools、MCP 统计和内部 Subagent `available`；
- A2A capability 显示 `deferred`，文案说明需要明确外部 Agent 互操作需求后再启用；
- 对话框级 Escape 和 Close 按钮都能关闭设置层，Test/Recovery 的 `Recovered request`、pending approval 和 Trajectory 状态没有被 UI 操作改写。

### 下一步

- 实现 workspace-scoped artifact API 和受控 path/open/download action；
- 为 Settings 增加 loading/error/empty、窄屏和 keyboard focus restore smoke；
- 将 Read-only、Edit、Test/Recovery、Delegation、Inspection 与 Settings/Deliverables 汇总为统一 Phase 7.10 browser gate。

## 2026-08-23：Deliverables/Produced Files render surface

### 目标与 DSH 对照

- 对照 DSH `ui-deliverables` 的产物清单、详情和 bounded preview 行为，把 Phase 5 `TaskProjection.artifacts` 接入当前 Session details；
- 让 Web 能区分 workspace artifact、external reference、workspace 外路径和无路径 artifact，同时把打开/下载动作保持在 host policy 与 workspace-scoped API 之后；
- 保持 EventStore 为事实来源：Deliverables 只消费 Session task projection，不在浏览器保存 artifact 事实，也不把 A2A 引入内部 Multi-Agent transport。

### 变更范围

- `apps/web/src/presentation/deliverables-presenter.ts`：新增 bounded artifact dedupe/classification/preview render intent；使用 workspace 根目录进行路径边界判断，external URL、unsafe path 和 pathless artifact 提供明确原因；
- `apps/web/src/presentation/deliverables-presenter.test.ts`：覆盖 workspace、relative/absolute unsafe、external、去重、empty 和 bounded manifest；
- `apps/web/src/browser.ts`：暴露 typed `presentDeliverables`；
- `apps/web/index.html`：新增 `Produced files & artifacts` details section，展示 label、kind、source task、path、scope、mediaType、size、preview 和 disabled action reason；所有不可信值使用 DOM textContent；
- `apps/api/src/fixtures/delegation.ts`：completed child fixture 增加 workspace JSON、external URL、workspace 外文件三类 artifact；
- `apps/api/src/server.test.ts`：同步验证三类 artifact 仍通过 parent catalog/report/output projection；

### 根治理七问

1. **Phase**：Phase 7.10 Deliverables/Produced Files render surface。
2. **问题类型**：Web projection、产物可观测性、workspace 安全边界和浏览器验收 fixture。
3. **契约影响**：复用现有 `TaskProjection.artifacts` 和 Session workspace；没有新增生产 Event、Tool、Task、Permission 或 Workspace contract，fixture 仅扩展测试数据。
4. **参考入口**：DSH `ui-deliverables`；Claude Code 只作 Coding 结果呈现行为参考。
5. **上游来源**：只做行为对照，没有复制 DSH 或 Claude Code 代码；无需新增许可证登记。
6. **验收场景**：parent completed child 显示 workspace/external/blocked 三类 artifact；action 全部 disabled 并说明原因；child Session 不显示 parent artifact；空 Session 显示空态。
7. **回滚**：移除 presenter、panel 和 fixture boundary artifacts；保留既有 Task projection、Web fallback、内部 Subagent 和 A2A deferred 状态。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓（18 tests）
pnpm --filter @code-review-agent/web test -- --run  ✓（43 tests）
pnpm -F @code-review-agent/web run build:browser    ✓
git diff --check                                    ✓
```

真实 browser smoke：

- Delegation parent 的 completed child 显示 3 个 artifact：workspace JSON 显示 `workspace`，URL 显示 `external`，越界绝对路径显示 `blocked`；
- 在该 render-surface 初始 checkpoint 中，三个 `Open unavailable` 按钮均 disabled，workspace preview、external host policy、workspace boundary 原因分别可见；没有根据 event path 执行打开或下载。后续 workspace-scoped artifact API checkpoint 已将 workspace artifact 升级为 host-backed Open/Download，external/blocked 仍保持 disabled；
- 打开 completed child Session 后显示 `0 artifacts`，不会残留 parent artifact；新建空 Session 显示 `No produced files or artifacts.`；
- 浏览器 console warn/error 为空。

### 下一步

- 已在后续 `Workspace-scoped artifact API` checkpoint 完成受控读取；当前转入统一 Phase 7.10 browser gate、loading/error、键盘/窄屏和性能证据收敛。

## 2026-08-23：Workspace-scoped artifact API

### 目标与 DSH 对照

- 对照 DSH `ui-deliverables` 的 host-backed artifact 读取边界，让 workspace artifact 在 Web 中具备可验证的 inline preview 与 download 能力；
- 将 artifact 内容请求重新绑定到当前 Session 的 workspace 和 artifact manifest，避免把事件中的 path 当作浏览器可直接访问的权限凭证；
- 保持 Phase 5 Task/Artifact projection、EventStore 事实来源和 Phase 6 A2A `deferred` 边界不变。

### 变更范围

- `apps/api/src/artifacts.ts`：新增 artifact lookup/inspection，按 Session workspace 与 artifact id 解析状态，区分 workspace、external、blocked、missing、not_file、too_large、unavailable/pathless；
- `apps/api/src/server.ts`：新增 metadata 与 content 路由，支持 `inline`/`attachment`，设置 `nosniff`、`no-store`、安全 MIME fallback 和 Content-Disposition；每次读取重新执行 lexical、绝对路径、regular-file 与 symlink 越界检查；
- `apps/web/src/client/api.ts`、`apps/web/index.html`、`apps/web/src/presentation/deliverables-presenter.ts`：workspace artifact 生成 host API Open/Download URL，其他 scope 继续显示 disabled reason；Web 不直接读取本地路径；
- `apps/api/src/fixtures/delegation.ts`、`scripts/phase7-delegation-fixture-server.mjs`：写入真实 `delegation-report.json`，使用临时 workspace 并在退出时清理；
- `apps/api/src/server.test.ts`、`apps/web/src/client/api.test.ts`、presenter tests：覆盖 inline、download、external 409、absolute outside 403、child scope 404、symlink escape 403、artifact replay/projection 和 URL 编码。

### 根治理七问

1. **Phase**：Phase 7.10 Deliverables/Produced Files host-backed access。
2. **问题类型**：Web 产物访问、API 安全、workspace 边界和恢复/回放验证。
3. **契约影响**：新增 API 路由与 DTO，不改变 Event、Tool、Task、Permission 或 Workspace 公共事件 contract；artifact 事实仍来自 TaskProjection/EventStore。
4. **参考入口**：DSH `ui-deliverables` 与 host-backed artifact boundary；Claude Code 仅作结果呈现行为参考。
5. **上游来源**：只做行为对照，没有复制 DSH 或 Claude Code 代码或资产，无需新增许可证登记。
6. **验收场景**：workspace artifact inline 读取和 download 成功；external、越界、missing child scope、symlink escape 被明确拒绝；刷新/回放后列表与 action 保持一致。
7. **回滚**：移除 artifact API 路由与 workspace action，恢复 Deliverables disabled 状态；不影响 Task projection、内部 Subagent、MCP 或 A2A deferred 状态。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓（18 tests）
pnpm --filter @code-review-agent/web test -- --run  ✓（43 tests）
pnpm -F @code-review-agent/web run build:browser    ✓
git diff --check                                    ✓
```

真实 smoke：

- workspace artifact metadata/content API 返回 200；inline 使用 `application/json` 与 `Content-Disposition: inline`，download 使用 `Content-Disposition: attachment`；
- external artifact 返回 409，workspace 外绝对路径和 symlink escape 返回 403，child Session 不能读取 parent artifact；
- Deliverables workspace artifact 显示 Open/Download，external/blocked 仍 disabled；Node fetch 与浏览器页面均无 console warning/error；直接在浏览器 tab 打开本地内容 URL 的 `ERR_BLOCKED_BY_CLIENT` 被记录为客户端限制，未改变 API fetch 与 UI href 验收结论。

### 下一步

- 将 Read-only、Edit、Test/Recovery、Delegation、Inspection、Settings、Deliverables 和 artifact access 汇总为统一 Phase 7.10 browser gate；
- 补齐 loading/error、键盘焦点恢复、窄屏布局、长任务 terminal/job 输出与失败诊断；
- 推进 Shell 拆分、Workspace/Session 导航和 1,000+ trajectory 多页性能基线。

## 2026-08-23：Typed boot error boundary

### 目标与 DSH 对照

- 对照 DSH Web boot 与 error boundary 的职责，把静态 Shell 的启动过程显式建模为 `booting / ready / failed`；
- 启动失败需要可解释、可重试，并且不能把失败 UI 当成新的事件事实。

### 变更范围

- `apps/web/src/shell/boot.ts`：新增 `ShellBootState`、`ShellBootAction`、reducer、错误归一化和 bounded `ShellBootRenderIntent`；
- `apps/web/src/shell/boot.test.ts`：覆盖 loading、ready、未知异常、retryable failure 和 bounded error；
- `apps/web/src/browser.ts`：将 boot presenter/state 作为 typed browser bridge 暴露；
- `apps/web/index.html`：启动时设置 `aria-busy` 并禁用 composer，loading/failed 使用 typed hero，失败状态提供 Retry；Retry 重新执行既有 boot/API/SSE 流程，成功后恢复正常 Conversation renderer。

### 根治理七问

1. **Phase**：Phase 7.1 Web Shell boot boundary。
2. **问题类型**：UI state boundary、错误呈现和恢复入口。
3. **契约影响**：只增加 Web 内部 boot state/render intent；不改变 Event、Tool、Task、Permission 或 Workspace contract。
4. **参考入口**：DSH Web boot、`client/connection` 和 `ui-primitives` error boundary 行为；实现继续使用本项目 API/SessionConnectionController。
5. **上游来源**：只做行为参考，没有复制代码或资产。
6. **验收场景**：初始 loading、成功 ready、API 启动失败 hero、Retry 后恢复、composer 在 boot 期间不可提交、browser console 无 warning/error。
7. **回滚**：移除 boot bridge 与 typed hero，保留原静态 Shell 和既有 connection banner；不影响 EventStore、SessionStore 或 API。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test -- --run  ✓（60 tests）
pnpm --filter @code-review-agent/web run build:browser ✓
git diff --check                                    ✓
```

下一切片：继续物理拆分 Conversation、Details 和 Overlay，随后补 Workspace/Session rename/reorder 等真实生命周期 API、queue/steer/attachment、长任务 terminal/job 失败诊断和窄屏视觉基线。

## 2026-08-23：Typed overlay state

### 目标与 DSH 对照

- 对照 DSH `ui-primitives`、Settings/Workspace modal 和 popover 的生命周期行为，把 Shell 的 overlay 打开/关闭路径收敛为单一 typed state；
- modal、session menu、model/mode popover 互斥，outside click、Escape 和 `aria-expanded` 由同一 reducer 驱动。

### 变更范围

- `apps/web/src/shell/overlay.ts`：新增 `ShellOverlayState`、action reducer 和 `ShellOverlayRenderIntent`；
- `apps/web/src/shell/overlay.test.ts`：覆盖 modal/popover 互斥、toggle、指定关闭和 Escape；
- `apps/web/src/browser.ts`：暴露 overlay bridge；
- `apps/web/index.html`：Workspace/Settings/Session menu/Model/Mode 的打开、关闭、outside click、Escape 和 aria-expanded 全部消费 typed overlay presenter；focus trap 继续只负责 dialog 内焦点。

### 根治理七问

1. **Phase**：Phase 7.1 Web Shell overlay boundary。
2. **问题类型**：UI state boundary、modal/popover lifecycle 和可访问性交互。
3. **契约影响**：只增加 Web 内部 state/render intent；不改变 Event、Tool、Task、Permission 或 Workspace contract。
4. **参考入口**：DSH `ui-primitives`、`ui-settings*`、Workspace picker；实现继续使用本项目 typed bridge 和现有 focus trap。
5. **上游来源**：只做行为参考，没有复制代码或资产。
6. **验收场景**：Workspace/Settings/modal 互斥、popover outside click、Escape 关闭、aria-expanded 与 hidden 同步、browser/replay gate 无回归。
7. **回滚**：移除 overlay bridge，恢复各 DOM 节点直接 `hidden` 切换；不影响 API、SessionStore、EventStore 或连接恢复。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test -- --run  ✓（62 tests）
pnpm --filter @code-review-agent/web run build:browser ✓
pnpm test:phase7:browser                            ✓（五场景；trajectory full replay 18.53ms）
git diff --check                                    ✓
```

## 2026-08-23：Queue dock 与 durable turn projection

### 目标与 DSH 对照

- 对照 DSH `InputBar`/queued-turn surface，把 AgentHost 已有的 queued turn 事实呈现在 Web composer 附近；
- 只暴露后端已经支持的 cancel，明确标记 reorder 尚未进入 host contract。

### 变更范围

- `apps/web/src/presentation/queue-presenter.ts`：新增 bounded queue render intent，按 durable `TurnProjection.lastSequence` 稳定排序，区分 running/queued 和 pending count；
- `apps/web/src/presentation/queue-presenter.test.ts`：覆盖排序、running/queued、bounded message 和 empty state；
- `apps/web/src/client/store.ts`：增量 fold `user/message`、`turn/queued`、`turn/started`、`assistant/message`、`turn/ended` 时同步 upsert turns，保证 queue dock 不依赖 refetch；
- `apps/web/src/client/store.test.ts`：增加新 queued turn 在本地事件窗口中立即可见的回归测试；
- `apps/web/src/browser.ts`、`apps/web/index.html`：暴露 typed presenter，增加 Queue dock、host-backed Cancel、pending count 和 reorder limitation hint。

### 根治理七问

1. **Phase**：Phase 7.6 Permission/AskUser/queue surface。
2. **问题类型**：Web queue projection、可恢复交互和取消入口。
3. **契约影响**：复用既有 `turn/queued`、`turn/started`、`turn/ended` 和 `cancelTurn` command；只增强 Web SessionProjection fold，不改变事件 schema。
4. **参考入口**：DSH `InputBar`、queued turn indicator；实现继续使用本项目 `SessionStore` 和 AgentHost queue。
5. **上游来源**：只做行为参考，没有复制代码或资产。
6. **验收场景**：连续发送后 running/queued row、刷新/重连后 queue replay、Cancel 后状态收敛、长消息 bounded、host 不支持 reorder 时显示明确提示。
7. **回滚**：移除 Queue dock 和 presenter，保留 `SessionStore` turn upsert 兼容逻辑；不影响 Runtime、EventStore 或权限恢复。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test -- --run  ✓（65 tests）
pnpm --filter @code-review-agent/web run build:browser ✓
pnpm test:phase7:browser                            ✓（五场景；trajectory full replay 18.91ms）
git diff --check                                    ✓
```

下一切片：继续物理拆分 Conversation/Details，或在 host contract 允许后补 queue reorder/steer；附件能力先补 capability gate、大小/type rejection 和 receipt contract，再接入 UI。

## 2026-08-23：Session rename 生命周期

### 目标与 DSH 对照

- 对照 DSH `ui-workspace` 的 Session lifecycle，补齐可回放的 Session rename；
- 标题变更必须经过 AgentHost/EventStore，刷新、重连和导航列表都读取同一 projection。

### 变更范围

- `packages/runtime/src/index.ts`：新增 `renameSession()`，非空/120 字符校验、command claim、`session/updated` 事件和重复命令幂等；
- `packages/storage/src/index.ts`：持久化显式 title，Session summary 显式标题优先，缺失时回退首条用户消息；
- `apps/api/src/server.ts`：新增 `POST /v1/sessions/:id/title`；
- `apps/web/src/client/api.ts`：新增 typed `renameSession()`；
- `apps/web/index.html`：Session menu 增加 Rename action，使用可访问 dialog、focus trap、Escape/outside click、错误状态和成功后的导航刷新。

### 根治理七问

1. **Phase**：Phase 7.3 Workspace/Session navigation lifecycle。
2. **问题类型**：Session lifecycle API、projection replay 和 Web navigation UX。
3. **契约影响**：复用 `session/updated` 与 command idempotency；SessionProjection 增加对已有 title 字段的持久化优先级，不新增事件类型。
4. **参考入口**：DSH `ui-workspace`、Session action menu；实现继续使用本项目 AgentHost、EventStore 和 typed API client。
5. **上游来源**：只做行为参考，没有复制代码或资产。
6. **验收场景**：Rename dialog 键盘/焦点、成功后列表和当前 header 更新、刷新/重连保留标题、重复命令不追加事件、非法标题有错误提示。
7. **回滚**：隐藏 Rename action 和 endpoint，保留原有自动标题；不影响 Session history、工具、权限或 workspace 安全。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/runtime test -- --run ✓（14 tests）
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓（20 tests）
pnpm --filter @code-review-agent/web test -- --run  ✓（66 tests）
pnpm --filter @code-review-agent/web run build:browser ✓
pnpm test:phase7:browser                            ✓（五场景；trajectory full replay 20.42ms）
pnpm test                                           ✓
git diff --check                                    ✓
```

## 2026-08-23：统一 Phase 7.10 browser/replay gate

### 目标

把 Read-only、Edit、Test/Recovery、Delegation、Inspection 五个验收场景收敛为一个可重复命令，验证浏览器实际消费的 API、静态 bundle、Session projection 和 EventStore replay。

### 变更范围

- `scripts/phase7-browser-gate.mjs`：编排三个隔离 fixture server，读取启动 JSON，统一执行五场景断言并在失败时清理子进程；
- Read-only：验证静态 Web shell/typed browser bundle、assistant summary、completed `read_file`、tool call/result replay；
- Edit：通过真实 permission API 批准 `edit_file`，验证 completed tool、diff summary 和 permission/tool settlement replay；
- Test/Recovery：使用 SQLite fixture 的真实 API/AgentHost 重启状态，验证 `run_tests` pending permission、批准后的 completed tool、recovery status event 和重复批准不重复执行；
- Delegation：验证 parent/child catalog、非空 child transcript/report、scoped replay、workspace artifact inline/download、external/blocked artifact 和 cancellable child cleanup；
- Inspection：验证 1,250 条 trajectory records、2,501 条事件的 monotonic replay、latest/older bounded pages、100 条 page limit 和 prepend cursor；
- 性能记录：输出 HTTP 最大单请求耗时、trajectory latest/older/full replay 和 gate 总耗时，作为后续浏览器渲染基线输入。

### 根治理七问

1. **Phase**：Phase 7.10 browser/replay gate。
2. **问题类型**：Web 验收、事件回放、权限恢复、workspace 安全和 trajectory 性能证据。
3. **契约影响**：新增测试编排脚本和 package command；不改变 Event、Tool、Task、Permission 或 Workspace contract。
4. **参考入口**：DSH `client/connection`、`ui-conversation`、`ui-subagent`、`ui-deliverables`、`ui-trajectory`；实现只调用本项目 host/API。
5. **上游来源**：只做行为对照，没有复制上游代码或资产。
6. **验收场景**：五场景全部通过，重复批准不重复工具执行，artifact 越界被阻断，trajectory replay 序列无重复。
7. **回滚**：删除 gate 脚本和 package command，不影响生产 AgentHost、Web bridge、EventStore 或 fixture 之外的运行路径。

### 验证

```text
pnpm test:phase7:browser                         ✓
五场景通过；总耗时 2.66s；trajectory latest/older/full replay 2.59/1.41/8.60ms
pnpm typecheck                                   ✓
pnpm test                                        ✓
pnpm --filter @code-review-agent/web test -- --run ✓（50 tests）
pnpm -F @code-review-agent/web run build:browser  ✓
git diff --check                                  ✓
```

### 下一步

- 补齐各面板 loading/error/empty/reconnect 细节和长任务 terminal/job 失败诊断；
- 推进 Shell 拆分、Workspace/Session 导航和窄屏视觉基线；
- 保持 gate 作为每个后续 Phase 7 Web 切片的回归入口。

## 2026-08-23：Typed Workspace→Session navigation projection

### 目标

对照 DSH `ui-workspace`、`ui-sidebar` 和 Session identity boundary，把现有静态导航中的分组、搜索、归档过滤和 parent/child lineage 从 inline DOM 逻辑抽出为可测试的 typed render intent。

### 变更范围

- `apps/web/src/presentation/navigation-presenter.ts`：新增 Workspace→Session projection，统一 Windows/Unix workspace key、workspace label、session label、relative time、archived/deleted filter、search、recent roots、active workspace 和 explicit empty state；
- `apps/web/src/presentation/navigation-presenter.test.ts`：覆盖路径大小写/尾斜杠归一化、稳定排序、parent/child tree、child search ancestor 保留、archived/deleted 和 empty state；
- `apps/web/src/browser.ts`：typed browser bridge 暴露 navigation presenter；
- `apps/web/index.html`：typed bridge 可用时消费导航 projection，渲染嵌套 child Session、active workspace 展开和 600px 窄屏 sidebar fallback；旧 DOM renderer 继续保留为 bundle 缺失时的回滚路径。

### 根治理七问

1. **Phase**：Phase 7.1/7.3 Web Shell 与 Workspace/Session navigation。
2. **问题类型**：UI projection、导航 identity、可测试 Shell 边界和窄屏呈现。
3. **契约影响**：只消费现有 `SessionSummary`；不改变 Event、Tool、Task、Permission 或 Workspace contract。
4. **参考入口**：DSH `ui-workspace`、`ui-sidebar`、Session identity boundary；实现继续使用本项目 API/SessionStore。
5. **上游来源**：只做行为参考，没有复制上游代码或资产。
6. **验收场景**：多 workspace 分组、搜索、归档过滤、父子 Session 展开、刷新/切换后 active identity、窄屏 sidebar 入口和 console 无错误。
7. **回滚**：typed navigation bridge 缺失时自动使用旧 inline renderer；删除 presenter 不影响 AgentHost/EventStore。

### 验证

```text
pnpm typecheck                                   ✓
pnpm --filter @code-review-agent/web test -- --run ✓（54 tests）
pnpm --filter @code-review-agent/web run build:browser ✓
pnpm test:phase7:browser                         ✓（五场景，总耗时 2.40s）
pnpm test                                        ✓
git diff --check                                  ✓
```

真实浏览器 smoke：

- 默认 viewport 显示 Workspace 分组、Session summary、MCP/Child agents 区域；
- Search 输入 `coding-agent-test` 后只保留匹配 workspace；
- 600×800 viewport 显示 `Open sidebar`，details/sidebar 按窄屏规则隐藏；
- browser console warn/error 为空。

### 下一步

- 继续把物理 Shell 拆成 boot/layout/overlay 边界；
- 补 Workspace/Session rename/reorder 等真实生命周期 API 与错误/空态；
- 扩展 queue/steer/attachment、长任务 terminal/job 失败诊断和窄屏视觉基线。

## 2026-08-23：Typed Shell layout state 与 mobile sidebar

### 目标

对照 DSH `ui-layout/AppFrame` 与 responsive sidebar 行为，把三栏 Shell 的布局事实从 inline boolean 切到可测试的 typed state/reducer，并让窄屏侧栏真正可打开和收起。

### 变更范围

- `apps/web/src/shell/layout.ts`：新增 `ShellLayoutState`、`ShellLayoutAction`、viewport breakpoint、reducer 和 `ShellLayoutRenderIntent`；sidebar、details、mobile sidebar 是 UI session state，不进入 EventStore；
- `apps/web/src/shell/layout.test.ts`：覆盖 desktop sidebar/details 独立切换、mobile overlay 打开/关闭和 600/900 breakpoint；
- `apps/web/src/browser.ts`：暴露 `createShellLayoutState`、`reduceShellLayout`、`presentShellLayout` 和 `shellViewport`；
- `apps/web/index.html`：typed bridge 驱动 class/aria/expanded 状态，resize 时同步 viewport；`mobile-sidebar-open` 在 600/900 breakpoint 展开真实 sidebar，点击 Session 后自动收起；旧 class toggle 保留为 fallback。

### 根治理七问

1. **Phase**：Phase 7.1 Web Shell/layout。
2. **问题类型**：UI state boundary、responsive layout、keyboard/aria 交互。
3. **契约影响**：只增加 Web 内部 state/render intent；不改变 Event、Tool、Task、Permission 或 Workspace contract。
4. **参考入口**：DSH `ui-layout/AppFrame`、`ui-sidebar` responsive behavior；实现继续使用本项目静态 shell 和 typed bridge。
5. **上游来源**：只做行为参考，没有复制上游代码或资产。
6. **验收场景**：desktop sidebar/details toggle、600px Open/Close sidebar、Session 切换关闭 mobile sidebar、resize 状态稳定、控制台无错误。
7. **回滚**：移除 layout bridge 后恢复现有 class toggle；不影响 API、SessionStore、AgentHost 或 EventStore。

### 验证

```text
pnpm typecheck                                   ✓
pnpm --filter @code-review-agent/web test -- --run ✓（57 tests）
pnpm --filter @code-review-agent/web run build:browser ✓
pnpm test:phase7:browser                         ✓
pnpm test                                        ✓
git diff --check                                  ✓
```

真实浏览器 smoke：

- 600×800 viewport 初始显示 `Open sidebar`；点击后显示完整 Workspace/Session sidebar；再次点击 `Collapse sidebar` 后恢复主内容；
- 默认 viewport 的 Workspace search、Session tree 保持正常；
- browser console warn/error 为空。

### 下一步

- 抽出 booting/ready/failed boot state 和错误边界；
- 继续把 Conversation、Details、Overlay 从单文件 inline script 拆为可测试 Shell 区域；
- 补 Workspace/Session 生命周期 API、长任务 terminal/job 失败诊断和窄屏视觉基线。

## 2026-08-23：Modal keyboard/focus semantics

### 目标与 DSH 对照

- 对照 DSH `ui-primitives`、`ui-settings*` 和 Workspace picker 的 keyboard/focus 行为，完成 Phase 7.9 两个 modal 的可访问交互闭环；
- 保持页面事实和 API/Session projection 不变，交互状态只存在于当前 Web session。

### 变更范围

- `apps/web/src/presentation/focus-trap.ts`：新增 bounded focusable selector、Tab/Shift+Tab 回环和 opener focus restore；
- `apps/web/src/presentation/focus-trap.test.ts`：覆盖边界索引和空 dialog 安全行为；
- `apps/web/src/browser.ts`：将 focus trap 暴露给静态 Shell；
- `apps/web/index.html`：Workspace picker 增加 dialog 语义，Settings/Workspace 支持 Escape、Tab 回环和关闭后焦点恢复，连接状态声明 `role=status`/`aria-live`。

### 根治理七问

1. **Phase**：Phase 7.9 modal accessibility surface。
2. **问题类型**：Web UI 交互、可访问性和窄屏/键盘验收。
3. **契约影响**：无 Event、Tool、Task、Permission 或 Workspace contract 变化；新增状态不进入 EventStore。
4. **参考入口**：DSH `ui-primitives`、`ui-settings*`、Workspace picker behavior；Claude Code 不作为实现依赖。
5. **上游来源**：只做行为参考，没有复制上游代码或资产，无需许可证登记。
6. **验收场景**：Workspace/Settings 打开后焦点进入 dialog，Tab/Shift+Tab 不逃逸，Escape 关闭并恢复 opener focus；浏览器无 console warning/error。
7. **回滚**：移除 `focus-trap` bridge 和 modal 属性，保留原有 click/Escape fallback，不影响 Session/EventStore。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test -- --run  ✓（46 tests）
pnpm -F @code-review-agent/web run build:browser    ✓
git diff --check                                    ✓
```

真实 browser smoke：

- Workspace picker 打开后 active element 为 `workspace-input`；从首个关闭按钮 Shift+Tab 到 `workspace-create`，从末尾正向 Tab 回到 `workspace-close`；
- Workspace picker Escape 后 `hidden=true` 且焦点恢复到 `new-session`；Settings Escape 后焦点恢复到 `settings-button`；
- browser console warn/error 为空。

### 下一步

- 将 Read-only、Edit、Test/Recovery、Delegation、Inspection、Settings、Deliverables 和 artifact access 汇总为统一 Phase 7.10 browser gate；
- 补齐 loading/error/empty/reconnect 状态、窄屏布局、长任务 terminal/job 输出与失败诊断；
- 推进 Shell 拆分、Workspace/Session 导航和 1,000+ trajectory 多页性能基线。

## 2026-08-23：Loading/error/reconnect shell state

### 目标与 DSH 对照

- 对照 DSH `client/connection`、`ui-primitives` 的连接状态和断线重连反馈，让 Web 能区分 loading、reconnecting、failed 与 healthy 状态；
- 失败状态提供 host-backed Retry，恢复成功后移除 stale error；正常连接不展示空 banner。

### 变更范围

- `apps/web/src/presentation/connection-presenter.ts`：新增 bounded `ConnectionRenderIntent`，统一 visibility、tone、message 和 retryable；
- `apps/web/src/presentation/connection-presenter.test.ts`：覆盖 idle/connected、connecting、reconnecting、failed 和错误长度限制；
- `apps/web/src/client/store.ts`、`apps/web/src/client/store.test.ts`：修复 `setConnection()` 在恢复后清理 transport error，新增回归测试；
- `apps/web/src/browser.ts`、`apps/web/index.html`：新增 connection banner、Retry、`role=status`/`aria-live`，并从统一 `SessionStoreSnapshot` 渲染，不另建连接事实状态。

### 根治理七问

1. **Phase**：Phase 7.9 loading/error/reconnect shell state。
2. **问题类型**：Web 状态呈现、断线恢复 UX 和错误可观测性。
3. **契约影响**：不改变 Event、Tool、Task、Permission 或 Workspace contract；只修正 Web Store error 生命周期并增加 render intent。
4. **参考入口**：DSH `client/connection`、`ui-primitives`；实现继续使用本项目 SessionConnectionController/EventStore projection。
5. **上游来源**：只做行为参考，无代码复制或许可证新增。
6. **验收场景**：连接中显示 loading；SSE 断线显示 reconnecting；达到重试上限显示 failed/Retry；恢复后 banner 隐藏且 stale error 清除；浏览器 console 无 warning/error。
7. **回滚**：移除 connection presenter/banner，恢复 header status 文案；不影响 SSE、SessionStore 事件回放或 API。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test -- --run  ✓（50 tests）
pnpm -F @code-review-agent/web run build:browser    ✓
git diff --check                                    ✓
```

真实 browser smoke：

- 正常 API 页面 header 显示 `Connected`，connection banner 为 hidden 且无残留文案；
- presenter/store 回归覆盖 failed retry、reconnecting warning、bounded error 和 recovery clear；
- browser console warn/error 为空。

### 下一步

- 将 Read-only、Edit、Test/Recovery、Delegation、Inspection、Settings、Deliverables 和 artifact access 汇总为统一 Phase 7.10 browser gate；
- 补齐 loading/error/empty/reconnect 的各面板空态、窄屏布局、长任务 terminal/job 输出与失败诊断；
- 推进 Shell 拆分、Workspace/Session 导航和 1,000+ trajectory 多页性能基线。
