# Phase 8 开发日志

## 2026-08-25：实现 DSH 风格三栏 Shell、Details 可调宽度与响应式让步

本次工作属于 Phase 8.0 Web 对齐，按照 [DSH 三栏 Shell 与可调宽度实现指导方案](../dsh-three-column-resizable-shell-implementation-guide.zh-CN.md) 将 Web Shell 从 Sidebar + Center + overlay Details 收敛为真实的 `sidebar | center | details` 三列。实现只改变 Web layout state、纯布局 presenter 和 DOM 交互，不改变 Event、Tool、Task、Permission 或 Workspace contract。

### 任务七问

1. **Phase**：Phase 8.0 Web Shell 对齐。
2. **问题类型**：三栏几何、Details/Sidebar 宽度、响应式让步、拖拽和无障碍。
3. **契约影响**：不改变 Event、Tool、Task、Permission 或 Workspace contract；新增 `detailsWidthPx`、窄屏状态和列计算仅属于 Web layout state。
4. **DSH 参考**：`packages/client/ui-layout/src/client/columns.ts`、`AppFrame.tsx`、`AppFrame.module.css`、`stores.ts`、`service.ts` 和 `ui-layout/tests/*`。
5. **上游来源**：本轮只做行为参考，没有复制 DSH 代码、品牌资源或产品文案；既有 `DSH-003` 来源登记覆盖本范围。
6. **验收场景**：桌面三列同时存在；Details 关闭保持第三列 0px 且子树挂载；Sidebar/Details 可通过鼠标和键盘独立调整；空间不足遵循 Center 保底 → Details 缩小 → Details 关闭 → Center 承压；1024px 以下 Sidebar 自动 rail；600px 以下进入移动侧栏 overlay。
7. **回滚**：回退本次代码 checkpoint 即可恢复旧 Sidebar-only resizer 与 Details overlay；Runtime、API、EventStore 和会话历史不受影响。

### 实现内容

- 新增 `apps/web/src/shell/columns.ts`，集中定义 DSH 几何常量与 `computeShellColumns()` 纯求解器；偏好宽度和实际渲染宽度分离。
- `ShellLayoutState` 增加 `detailsWidthPx`、`narrow`、`narrowExpanded`，并由 presenter 输出实际列宽、grid template、关闭态和移动态语义。
- `#app` 改为真实三列 grid；Details 关闭时使用 `0px` track，保留 Details DOM 子树；Sidebar/Details 分隔条统一使用 pointer capture、rAF 合帧和实际渲染宽度作为拖拽起点。
- 增加鼠标事件兼容路径，保证内嵌 CUA/合成鼠标事件仍能完成拖拽，同时保留 PointerEvent 作为主路径。
- 窄屏布局在 1024px 进入 Sidebar rail，600px 以下使用移动 Sidebar overlay；移动态由 typed frame intent 写入专用 grid，避免 inline grid 覆盖 CSS 断点行为。
- 移除 Sidebar 宽度 localStorage 持久化，避免浏览器缓存成为布局事实来源。

### 验证证据

```text
git diff --check                                  ✓
pnpm typecheck                                   ✓
pnpm --filter @code-review-agent/web test         ✓ 118 tests
pnpm build:web                                   ✓
http://127.0.0.1:3210/ 重启并浏览器复验             ✓
  - 初始关闭态：280px | center | 0px，Details 无边框/不可交互
  - 打开 Details：280px | 640px | 360px
  - Sidebar CUA 拖拽：280px → 330px，Details 按让步链收缩到 310px
  - Details CUA 向左拖拽：在有剩余空间时 360px → 376px
  - 键盘 Arrow/Home/End 调整与 ARIA separator 状态可用
```

本次实现待提交为独立 Phase 8.0 Web Shell checkpoint；Phase 8 仍保持 `in_progress`。

## 2026-08-25：记录 DSH 三栏 Shell 与可调宽度实现指导

本次工作属于 Phase 8.0 Web 对齐，先研究 D:\Develop\deepseek-harness-fork\packages\client\ui-layout 的三栏 AppFrame、纯列宽求解器、窄屏 auto-collapse 和双向 DragHandle，形成 [DSH 三栏 Shell 与可调宽度实现指导方案](../dsh-three-column-resizable-shell-implementation-guide.zh-CN.md)。本轮只新增指导文档，没有修改布局代码。

### 任务七问

1. **Phase**：Phase 8.0，Web Shell 三栏布局与可调宽度调研。
2. **问题类型**：Shell 几何、Transient layout state、响应式让步、拖拽和无障碍。
3. **契约影响**：不改变 Event、Tool、Task、Permission 或 Workspace contract。
4. **DSH 参考**：ui-layout/src/client/columns.ts、AppFrame.tsx、AppFrame.module.css、stores.ts、service.ts 及 ui-layout/tests/*。
5. **上游来源**：只做行为参考，没有复制 DSH 代码或资产；既有 DSH-003 登记覆盖本范围。
6. **验收场景**：指导文档明确三栏 DOM、偏好/实际宽度分离、固定让步链、1024px auto-collapse、双向拖拽、滚动责任、测试矩阵和 3210 端口浏览器验证要求。
7. **回滚**：本轮无运行时代码变更；后续实现保留当前 Shell fallback，可单独回滚布局 checkpoint，不影响 Runtime 和 EventStore。

### 调研结论

- DSH 使用 sidebar | center | details 固定树位置；Details 关闭是 0px track，子树继续挂载；当前项目的 Details 仍是 fixed overlay，需要在后续实现阶段迁移。
- DSH 用 computeColumns() 固化 Center >= 640 → Details 缩小 → Details 派生关闭 → Center 最后承压的让步链；Sidebar/Details 偏好宽度和 frame 实际宽度分离。
- DSH 的 Sidebar/Details DragHandle 使用 pointer capture、rAF 合帧、实际渲染宽度作为拖拽基准，并在拖拽期间暂停 grid transition；当前项目仅有 Sidebar 的逐 pointermove 写入。
- 指导文档明确了当前项目的模块映射、阶段化实施、验收矩阵、回滚边界，以及不改 Event/Tool/Task/Permission/Workspace contract 的约束。

### 验证

    DSH columns/AppFrame/stores/service 源码核对       ✓
    当前 apps/web Shell CSS/DOM/typed layout 核对       ✓
    git diff --check                                   ✓（文档提交前）

文档 checkpoint：本次 docs(phase8): add dsh three-column shell guide 提交。

## 2026-08-25：修复 ToolRow 集中堆叠到对话尾部

本次工作属于 Phase 8.0 Web 对齐，目标是修复上一轮 ToolRow 改造后仍存在的 Conversation 时间线错误。问题记录见 [ToolRow 对话顺序问题记录](../ui-issue-tool-row-order.zh-CN.md)。实现继续依据 [DSH Web 前端对照文档](../dsh-frontend-reference.zh-CN.md) 的 stable node、keyed slot 和 tool-row timeline 规则。

### 任务七问

1. **Phase**：Phase 8.0，Conversation/ToolRow 时间线修复。
2. **问题类型**：事件投影、消息分段、工具行排序和 turn tail。
3. **契约影响**：不改变 Event、Tool、Task、Permission 或 Workspace contract；只修正 Web ConversationProjection 的节点边界。
4. **DSH 参考**：`ui-conversation` 的 keyed conversation node、`ui-tool` 的 `ToolCallTree`/`ToolRow`；工具更新保持在原 row 内。
5. **上游来源**：参考 DSH 行为与结构，没有复制代码或内部类型；无需新增许可证登记。
6. **验收场景**：同一 turn 含多个 step、每个 step 含 assistant 文本和 tool call 时，ToolRow 必须出现在对应 assistant segment 后；turn 终态出现在 tail；tool-only assistant 不显示空行。
7. **回滚**：回退代码 checkpoint `1935dc5`；事件历史和公共运行时不受影响。

### 根因与实现

- 旧 projection 使用 `assistant:${turnId}` 合并整轮 assistant 内容，导致工具前说明、工具后说明和最终总结变成一个节点，所有 ToolRow 被排序到该节点之后；
- `step/started` 现在为当前 turn 建立稳定 step key，assistant chunk/message 按 step 分段，兼容无 step 事件的旧流；
- `turn:*` 节点的 sequence 跟随最新状态事件，终态自然成为 turn tail；
- 空的 tool-only assistant message 不再创建空 avatar 行；
- ToolRow 仍由 durable `toolCallId` keyed projection 驱动，progress/result 只更新原行。

### 验证

```text
pnpm typecheck                         ✓
pnpm --filter @code-review-agent/web test  ✓ 115 tests
pnpm build:web                         ✓
git diff --check                       ✓
GET http://127.0.0.1:3210/health       ✓ 200
真实浏览器 ToolRow 时间线顺序          ✓
浏览器 console warning/error           ✓ 0
```

代码 checkpoint：`1935dc5 fix(phase8): preserve conversation tool order`。

## 2026-08-25：ToolRow 按 DSH 折叠优先模型收敛

本次工作属于 Phase 8.0 Web 对齐，目标是把现有“Agent activity 大组 + 原始 JSON 工具卡”改造成 DSH 风格的单调用 ToolRow。实现依据 [DSH Web 前端对照文档](../dsh-frontend-reference.zh-CN.md) 第 4 节；不复制 DSH React 组件或内部类型，继续使用本项目的 ConversationProjection、ToolCallTree 和安全 presenter。

### 任务七问

1. **Phase**：Phase 8.0，DSH Web ToolRow 对齐。
2. **问题类型**：工具状态投影、Conversation UI 和详情展开交互。
3. **契约影响**：不改变 Event、Tool、Task、Permission 或 Workspace contract；只扩展 Web `ToolRenderIntent`。
4. **DSH 参考**：`ui-tool/src/client/tool/components/ToolRow.tsx`、`tool-call-model.ts`、`ToolCallTree.tsx`。
5. **上游来源**：参考 DSH 的行为与布局，未复制代码；无需新增许可证登记。
6. **验收场景**：一个 tool call 对应一个稳定行；默认折叠；摘要显示可理解目标；展开后显示 IN/OUT；running/error/stopped 状态可区分；权限请求仍独立于 ToolRow。
7. **回滚**：回退代码 checkpoint `5e55084`，即可恢复此前工具行渲染；公共运行时和事件历史不受影响。

### 已完成

- 移除 Conversation 中旧的 `tool-activity` 外层聚合卡，工具调用直接以独立 `.tool-row` 按事件位置呈现；
- Tool presenter 新增 DSH 对齐的 `variant`、`state`、`statusLabel`、摘要目标、输入/输出、错误首行和文件路径元数据；
- `read/write/edit` 优先显示路径，`search` 显示 query/pattern，`bash` 显示 command，未知调用使用 `Tool call · tool_name` fallback；
- 每行使用统一的图标、标题、分隔点、目标摘要、短状态和 hover chevron；默认折叠，Enter/Space 和整行点击都可展开；
- 展开详情拆成 `IN` / `OUT` 两个 bounded 内部滚动区，长 payload 不再撑开整个对话；
- running 使用轻量 sweep，error/stopped 使用状态色；没有继续追加尾部工具提醒；
- 权限请求和用户问题仍由 Conversation 的独立决策 surface 渲染；当前没有 host-backed 文件打开 action，因此没有伪造点击打开行为。

### 验证与证据

每轮浏览器验证前重启 `http://127.0.0.1:3210/`：

```text
pnpm --filter @code-review-agent/web test                         ✓ 113 tests
pnpm build:web                                                     ✓
git diff --check                                                    ✓
GET http://127.0.0.1:3210/health                                   ✓
浏览器独立 .tool-row                                                ✓ 8 rows
旧 .tool-activity 外层                                               ✓ 0
默认 aria-expanded=false                                             ✓
点击展开 aria-expanded=true                                         ✓
IN/OUT 内部滚动区                                                    ✓
浏览器 console warn/error                                           ✓ 0
```

代码 checkpoint：`5e55084 feat(phase8): align dsh tool rows`。

### 遗留事项

ToolRow 的专用 Terminal/Diff/Read/Search/Web card primitives、Trajectory Inspect 快捷入口和 host-backed 文件打开 action 仍属于后续增强；本次先完成 DSH 的通用单行、折叠、摘要、状态和 bounded IN/OUT 基础，不扩展 Planning、Reasoning 或 Effort。

## 2026-08-25：Trajectory 滚动责任按 DSH 收敛

本次工作属于 Phase 8.0 Web 对齐的滚动边界修复，目标是解决 Trajectory 内容区域无法直接使用鼠标滚轮上下滚动的问题。实现依据 [DSH Conversation / Trajectory 前端实现指导方案](../dsh-conversation-trajectory-implementation-guide.zh-CN.md) 和 [问题记录](../ui-issue-conversation-trajectory-scroll.zh-CN.md)。本次只涉及 Web 布局与可丢弃的滚动位置状态，没有改变 Event、Tool、Task、Permission 或 Workspace contract。

### 任务七问

1. **Phase**：Phase 8.0，DSH Web 对齐与滚动边界维护。
2. **问题类型**：UI 布局、滚动容器和视图恢复。
3. **契约影响**：不改变公共事件、工具、任务、权限或 workspace contract。
4. **DSH 参考**：`ui-conversation` 的稳定 conversation scrollport、`ui-trajectory` 的内部 table scrollport、Composer overlay/bottom clearance。
5. **上游来源**：只参考 DSH 的结构和行为，没有复制代码或内部类型；无需新增许可证登记。
6. **验收场景**：Trajectory 红框区域滚轮滚动、外层不抢滚动、Conversation/Trajectory 往返切换、按视图恢复位置、Composer 不遮挡末尾。
7. **回滚**：回退本 checkpoint `b6a1cf7`；保留第一轮外层几何修复 `14d836d`。

### 实现内容

- Trajectory 模式下将外层 `#conversation` 设为 `overflow: hidden`，把纵向滚动责任交给 `.main-trajectory-scroll`；
- 为 Trajectory active view 补齐 `flex: 1 1 0`、`min-height: 0`、`height: 100%`，防止 Flex 子项按内容扩张；
- 为内部 scrollport 设置 `overflow-y: auto`、`overflow-x: hidden`、`scrollbar-gutter: stable`，并移除会阻断滚轮链路的 `overscroll-behavior: contain`；
- 新增 Conversation/Trajectory 独立 `scrollTop` 状态，统一 tail-follow、Load older、scroll restoration 和历史 prepend 补偿；
- 使用 `ResizeObserver` 动态计算 Composer clearance，写入 `--trajectory-bottom-clearance`；
- 删除重复的全局 Tab click 处理，避免双重 render 造成滚动位置重置。

### 验证与 checkpoint

```text
pnpm build:web                                      ✓
git diff --check                                     ✓
GET http://127.0.0.1:3210/health                    ✓
Trajectory inner scrollport wheel scroll             ✓
Conversation ↔ Trajectory × 10                      ✓
Per-view scrollTop restoration                       ✓
Browser console warning/error                        0
```

代码 checkpoint：`b6a1cf7 feat(phase8): align trajectory scroll ownership`。

### 遗留事项

Planning 侧栏、Reasoning 和 Effort 按用户要求不在本次范围内；后续若修改 Conversation/Trajectory 布局，必须继续在 `3210` 重启后验证滚轮、Tab 可达性、Composer clearance 和视图恢复，并追加本日志与问题文档记录。

## 2026-08-25：8.0 Web parity browser matrix 收口

本次继续属于 Phase 8.0 Web 对齐，依据 DSH `ui-goal/GoalBar.tsx`、`ui-conversation/skeleton/InputBar.tsx`、`ui-user-questions/QuestionComposer.tsx`、`ui-jobs/JobListAction.tsx`、`ui-trajectory/TrajectoryView.tsx` 和 `ui-layout` 的行为边界补齐最后一组真实浏览器证据；没有复制 DSH 代码或内部类型，Web 仍只消费本项目 projection、REST/SSE 和 typed bridge。

### 已完成

- 扩展 `scripts/phase8-web-fixture-server.mjs` 的可选 live-control fixture，使用受范围约束的 `PHASE8_WEB_LIVE_DELAY_MS=2000` 暴露真实 running turn；普通 fixture 默认行为保持兼容。
- 在真实 Codex In-app Browser 中验证 Steer 按钮在 running turn 中启用，Steer guidance 与 queued follow-up 形成 durable event/receipt，reload 后恢复 `Agent is working`、Steer 文本和 queue 事件。
- 将 8.0.7 的 9 组行为场景写入 `docs/phase8-browser-evidence.json`，并由 `scripts/phase8-browser-evidence-gate.mjs` 逐项审计；证据同时保留 visual/accessibility、Settings failure/retry/selection 和 reconnect/replay/API restart 边界。

### 验证

```text
pnpm typecheck                         ✓
pnpm test                              ✓
pnpm build:web                         ✓
pnpm test:phase7:browser               ✓
pnpm test:phase8:web                   ✓
pnpm test:phase8:settings              ✓
pnpm test:phase8:visual                ✓
pnpm test:phase8:parity                ✓
pnpm test:phase8:browser:evidence      ✓（9 个 Web parity 场景）
git diff --check                       ✓
真实 in-app browser: running → steer + queue → reload replay ✓
```

### 阶段边界

Phase 8.0 已完成并建立独立 Git checkpoint；Phase 8 整体仍为 `in_progress`。8.3/8.5 的 OS/container、外部 IdP/secret manager 和 upgrade/deployment smoke 依赖目标部署环境，继续保持 partial/deferred，不影响 8.0 关闭。

## 2026-08-24：8.5 external secret manager adapter 与 upgrade/deployment policy

本次继续属于 Phase 8.5，补齐 credential metadata/reference 与生产 secret/deployment 边界；DSH 仅作为 host-owned configuration/deployment 行为参考，没有复制 DSH 代码或把 fake provider 宣称为云端服务。

### 已完成

- `CredentialVault` 从固定进程 Map 抽象为 `SecretProvider`，提供 host-only 与 external adapter；material 按 tenant/credential/version 存取，rotation、revoke、remove 和 stale reference 均遵循版本边界。
- API 支持注入 `secretProvider`，external provider 的 capability 显示 `credentials.secretStore=external`；provider 取值或写入失败返回明确错误并 fail closed，公开 metadata、route、MCP config、EventStore、SSE 和 diagnostics 不含 secret material。
- `packages/storage` 新增 `SQLITE_UPGRADE_POLICY` / `assessSqliteUpgrade`，schema v5–v7 migration range 与 backup、lock、readiness、rollback 要求可执行审计。
- 新增 `docs/phase8-deployment-policy.json` 和 `scripts/phase8-upgrade-policy-gate.mjs`；升级能力明确保持 `deferred-until-deployment-smoke`，避免将 SQLite migration/rollback 误报为 rolling upgrade 已完成。

### 验证

```text
pnpm typecheck                         ✓
pnpm --filter @code-review-agent/api test -- --run src/credentials.test.ts  ✓（3 tests）
pnpm test:phase8:operations             ✓（schema v7 / upgrade policy）
pnpm test:phase8:upgrade-policy         ✓
pnpm test:phase8:productization         ✓
git diff --check                        ✓
```

### 边界与剩余工作

external provider 是 host 注入边界，当前 fixture 不连接具体 KMS/Vault/Secrets Manager；真实部署仍需 provider integration、rotation/revoke smoke，以及 IdP/Docker deployment evidence。公开 upgrade capability 继续 deferred。

## 2026-08-24：8.5 外部 IdP/JWT 与 durable principal catalog

本次继续属于 Phase 8.5，依据计划中的 DSH connection identity boundary 与 host-owned guard policy 行为参考，补齐静态 bearer fixture 与外部身份接入之间的缺口；没有复制 DSH 代码、内部类型或品牌资产。

### 已完成

- `packages/contracts` 新增 `PrincipalRecord` / `PrincipalBackend`；SQLite schema 从 v6 迁移到 v7，支持 principal metadata 的持久化、reopen、subject lookup、tenant filter 和 backup/restore migration。
- 新增 `apps/api/src/auth.ts` JWT verifier，支持 HS256/RS256、`kid`、issuer、audience、signature、`exp`、`nbf`、tenant claim，以及由 host 显式提供的 JWKS refresh hook；不接受 `none` 或未验签降级。
- verified subject 必须命中 active principal catalog；unknown、disabled、tenant mismatch、缺少 catalog 和无效 key 均 fail closed。静态 bearer 保留为 local/test adapter。
- API 新增 tenant-scoped `GET /v1/principals` 和 detail route，只投影 principal metadata；capability 在 JWT 模式下报告 `auth.mode=jwt` 与 external principal catalog。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/storage test       ✓（17 tests）
pnpm --filter @code-review-agent/api test -- --run src/auth.test.ts src/jwt-server.test.ts  ✓（4 tests）
pnpm test:phase8:operations                         ✓（schema v7 / legacy v5 → v7）
git diff --check                                    ✓
```

### 边界与剩余工作

JWT verifier 和 principal catalog 是 host-backed identity capability，不等于已经连接某个具体外部 IdP；真实部署仍需注入 JWKS provider、运行 key rotation smoke 并保留 IdP/Docker 证据。external secret manager、upgrade/deployment policy 继续保留。

## 2026-08-24：8.3 OS/container isolation 与 deployment evidence

本次继续属于 Phase 8.3，依据计划中的 DSH `packages/guard` host-owned boundary 与 `packages/lsp` lifecycle 行为参考，补齐 Code Mode 进程级策略和 OS/container 隔离之间的缺口；没有复制 DSH 代码、内部类型或品牌资产。

### 已完成

- 新增 `CodeModeIsolationAdapter` contract，以及 Linux `unshare` network namespace 和 Docker `--network none` 两个显式 adapter；adapter availability、reason、evidence 和 launch flags 均由 host capability 提供。
- `CodeModeSandbox` 在 `networkEnforcement: "os-required"` 下要求可用 adapter，缺失时 fail closed；Code Mode progress/result 记录实际 isolation kind，不把 `shell: false`、Node permission flags 或普通 child process 误报为 OS isolation。
- Docker Compose 增加 read-only rootfs、non-root runtime、no-new-privileges、capability drop 和受限 tmpfs；workspace bind 保持显式且受范围约束。
- 新增部署审计 `scripts/phase8-deployment-audit.mjs` 和 `pnpm test:phase8:deployment`；现有 8.3 exit gate 增加 adapter/deployment evidence 检查。

### 验证

```text
pnpm typecheck                    ✓
pnpm --filter @code-review-agent/tools test  ✓（61 tests）
pnpm test:phase8:deployment       ✓
pnpm test:phase8:lsp:exit         ✓（status: partial，宿主能力依赖）
git diff --check                  ✓
```

### 边界与剩余工作

本切片证明了仓库级 adapter 和部署策略边界，但不把当前 Windows 开发机或未运行的 Docker daemon 视为 OS isolation 已启用；真实部署仍需在 Linux/Docker 环境运行 adapter smoke 并保留结果。外部 IdP/JWT、principal catalog、external secret manager、upgrade/deployment policy 继续保留为 Phase 8 缺口。

## 2026-08-24：8.0 visual/accessibility browser matrix 与 Settings recovery 收口

本次继续属于 Phase 8.0 Web 对齐，依据 DSH `ui-layout/AppFrame.tsx`、`ui-sidebar/SidebarRoot.tsx`、`ui-settings-general`、`ui-settings-models` 和 `ui-primitives` 的布局、抽屉、Settings 与 focus 行为完成真实浏览器证据收口；没有复制 DSH 代码、内部类型或品牌资产，Web 仍只消费本项目 API projection、SSE 和 typed browser bridge。

### 已完成

- 使用真实 Codex In-app Browser 打开 `scripts/phase8-web-fixture-server.mjs` 的 SQLite/API/AgentHost fixture，验证 600/900/1024 × 800 无横向溢出；600/900 的移动侧栏可打开/收起，1024 的 Details 可关闭/重新打开。
- 三个视口均验证 Settings dialog 的 `aria-modal="true"`、`aria-labelledby="settings-title"`、Escape 关闭、opener focus restore 和 dialog 内 focus trap；可见交互控件的 accessible name 检查通过。
- 使用 `PHASE8_MODEL_FAILURES=1` 真实验证 Settings 的 provider/model catalog error → `Retry model catalog` → ready；补齐标准 failure fixture 的 `modelSelector` 后，真实点击 `fixture-model` 返回并显示 `Selected fixture-model` selection receipt。
- 新增 `docs/phase8-browser-evidence.json` 和 `scripts/phase8-browser-evidence-gate.mjs`，把真实浏览器观察结果固定成可审计 artifact；视觉 manifest 继续校验六个 Shell/Settings JPEG 基线，Web shell marker 只作为一致性辅助检查。

### 验证

```text
pnpm typecheck                         ✓
pnpm build:web                         ✓
pnpm test:phase8:settings              ✓
pnpm test:phase8:visual                ✓
pnpm test:phase8:parity                ✓
pnpm test:phase8:browser:evidence      ✓
真实 in-app browser: 600/900/1024、drawer/details、Settings focus/ARIA/recovery ✓
```

### 边界与剩余工作

本次只关闭 8.0.6 的真实 visual/accessibility 与 Settings recovery 证据，不宣告 Phase 8 完成；8.0 其余 DSH 行为场景的完整真实 browser matrix、8.3 OS-level isolation/deployment evidence，以及 8.5 外部 IdP/JWT、principal catalog、secret manager 和 upgrade/deployment policy 仍保持未完成。

## 2026-08-24：8.4 Reliability 退出审计与 graphical recovery matrix 收口

本次继续属于 Phase 8.4，依据 Phase 8 计划并对照 DSH 的 generation/reconnect、history-baseline + live-frame stitching 和 Job action/replay 边界，完成最后一批可靠性证据收口；没有复制 DSH 代码、内部类型或品牌资产，A2A 保持 `deferred`。

### 已完成

- 真实 in-app browser fixture 使用 `PHASE8_JOB_RECOVERY_LIVE_ITEMS=200` 和受范围约束的长任务延迟，确认三个并发 Job 的 running projection、交错 output、Job 详情和 `Cancel job` action。
- 图形矩阵覆盖 600/900/1024 viewport；页面无横向溢出，移动布局保持 Connected 状态和可用的 sidebar/details 入口。
- 取消一个 Job 后，Web projection 保留一个 cancelled、两个 running；SSE tail reconnect 和公开 `/jobs`/EventStore replay 继续由自动化 matrix 校验，reload 后状态由事件回放恢复。
- 8.4 退出审计闭合 retry、cancel、deadline、model fallback、graceful shutdown、API/SQLite restart、SSE replay、tail cursor、fork/export、diagnostics、metrics、幂等和 credential redaction 相关证据。

### DSH 对照与边界

- connection generation/reconnect 对应本项目 REST + SSE reconnect；history baseline + live frames 对应 sequence replay 和 projection reducer；Job action/replay 对应现有 `/jobs/:id/cancel`、`/retry` 与 durable command claim。
- 不新增 Event、Tool、Task、Permission 或 HTTP contract；fixture 时序参数只接受有限整数，Web 仍不成为事实来源。
- 8.4 完成后，剩余 Phase 8 缺口转入 8.0 完整 visual/accessibility matrix、8.3 OS-level isolation/deployment evidence 和 8.5 的外部 IdP/JWT、principal catalog、secret manager、upgrade/deployment policy。

### 验证

```text
pnpm test                                      ✓
pnpm test:phase8:jobs                          ✓
pnpm test:phase8:reliability                   ✓
pnpm test:phase8:job-recovery:matrix           ✓
git diff --check                                ✓
graphical browser: 600/900/1024 viewport      ✓
```

## 2026-08-24：8.4 graphical browser recovery evidence

本次继续属于 Phase 8.4，补齐长任务并发/重启/SSE 自动化 matrix 与真实图形 Web recovery 之间的证据缺口。DSH 参考 `packages/client/connection/src/client/connection.ts` 的 generation/reconnect、`packages/client/runtime/src/client/sessions/session.ts` 的 history-baseline + live-frame stitching，以及 `packages/client/ui-jobs/src/client/JobListAction.tsx` 的 Job action/replay 边界；没有复制 DSH 代码、内部类型或品牌资产，A2A 保持 `deferred`。

### 已完成

- `scripts/phase8-job-recovery-fixture-server.mjs` 增加受范围约束的 `PHASE8_JOB_RECOVERY_LIVE_ITEMS`（1–200）和 `PHASE8_JOB_RECOVERY_LIVE_DELAY_MS`（0–5000），避免图形浏览器测试因任务结束过快而丢失 running/action 状态；默认值保持自动化 matrix 兼容。
- 使用 in-app browser 打开真实本地 SQLite/API/AgentHost fixture：页面加载后显示 3 个 running jobs；展开一个 Job 详情后显示 `Cancel job`；执行取消后显示 1 个 cancelled、2 个 running；刷新后仍显示 cancelled/2 running，连接状态为 `Connected`。
- 该场景与 DSH 的 reconnect generation、历史 baseline/live frame stitching 和 Job action 边界一致，Web 仍只消费既有 EventStore/API projection。

### 契约与回滚边界

- 不新增 Event、Tool、Task、Permission 或 HTTP contract；仅增强测试 fixture 的时序控制，并对环境参数做有限整数校验。
- 回滚时移除 bounded timing 参数和本节图形证据即可，既有 `pnpm test:phase8:job-recovery:matrix`、Job Center action gate 和运行时恢复语义保持不变。

### 验证

```text
node --check scripts/phase8-job-recovery-fixture-server.mjs ✓
pnpm test:phase8:job-recovery:matrix ✓
graphical browser recovery: 3 running → cancel 1 → 1 cancelled + 2 running → reload replay ✓
```

### 尚未关闭

该切片只关闭 graphical recovery 的第一批真实场景；多 viewport、浏览器主动断线期间的交错 output、更多 Cancel/Retry 组合和完整 8.4 退出审计仍待扩展。

## 2026-08-24：8.5 SQLite backup/restore 与 migration rollback

本次工作继续属于 Phase 8.5，补齐当前 Host 可以独立验收的运维能力切片。DSH 只作为 deployment-axis 配置和 Host-owned 安全边界参考：`docs/config-catalog.zh.md` 与 `packages/host/webserver/README.md`；没有复制 DSH 代码或内部类型，A2A 保持 `deferred`。

### 已完成

- `packages/storage` 新增 SQLite schema inspection、consistent backup、restore migration 和 rollback operation；backup 使用 SQLite 快照，restore 先写临时库并运行现有 migration/projection rebuild/integrity check。
- legacy schema v5 可恢复到 schema v6；覆盖已有数据库时保留 rollback artifact，rollback 后原活动数据库的 Session/event projection 可继续读取。
- `AgentHost.productizationSettings().operations` 与 SQLite-backed API capability 报告 backup/migration available，upgrade 保持 deferred。
- 新增 `scripts/phase8-operations-gate.mjs` 与 `pnpm test:phase8:operations`，覆盖 backup metadata、event preservation、v5 → v6 migration、overwrite rollback、integrity 和 secret redaction。

### 契约与回滚边界

- 不新增 Event、Tool、Task、Permission 或公开 restore endpoint；运维操作只由受控 Host owner/deployment command 触发，EventStore 仍是唯一事实来源。
- 不支持的 future schema、损坏数据库、URI/in-memory path 和缺少 migration ledger 均 fail closed；覆盖恢复必须显式声明 `overwrite`，原目标保留为可回滚 artifact。
- secret material 不进入 SQLite credential metadata、backup inspection、capability projection 或 gate output。
- upgrade/deployment policy、外部 secret manager、IdP/JWT、principal catalog 和 OS-level isolation 仍延期。

### 验证

```text
pnpm test:phase8:operations ✓
pnpm test:phase8:productization ✓
pnpm typecheck ✓
git diff --check ✓
```

## 2026-08-24：8.4 长任务与并发 Web recovery matrix

本次工作继续属于 Phase 8.4，补齐已有 Job Center restart/replay slice 与更完整 Web recovery matrix 之间的证据缺口。DSH 参考 `packages/client/connection/src/client/connection.ts` 的 generation/reconnect、`packages/client/runtime/src/client/sessions/session.ts` 的 history-baseline + live-frame stitching，以及 `packages/client/ui-jobs/src/client/JobListAction.tsx` 的 job action 边界；本项目没有复制 DSH 代码、内部类型或品牌资产，A2A 保持 `deferred`。

### 已完成

- `scripts/phase8-job-recovery-fixture-server.mjs` 增加 `live` 模式，使用真实 AgentHost/JobManager/SQLite 路径启动三个并发长任务，并向 gate 暴露稳定的 job IDs。
- `scripts/phase8-job-recovery-matrix-gate.mjs` 保留 seed → reopen → reopen-again 基线，同时增加 live concurrency、交错 job output、单 job cancel、其余 job completion 和 SSE tail reconnect 场景。
- 首次 SSE 连接以实际 sequence 断开，重连后只消费 `after_sequence` 之后的 terminal events；gate 验证重复 sequence、跨 job 状态泄露和最终 `/jobs` projection 均不存在。
- Web shell 与 typed browser bundle 继续从真实 fixture 校验 Job Center recovery surface；没有为“浏览器成功”伪造未落盘的 UI 状态。

### 契约与回滚边界

- 本次没有新增 Event、Tool、Task、Permission 或 HTTP contract；只增加使用现有公开 contract 的真实 recovery fixture 与 gate。
- Job output 继续经过现有 bounded event/spill/redaction 管线；SSE 断线只按 sequence replay，不重新执行 job。
- 回滚时删除 `live` fixture 分支和 matrix 扩展即可，既有 API restart、orphaned recovery 和 Job Center action gate 保持有效。

### 验证

```text
pnpm test:phase8:job-recovery             ✓
pnpm test:phase8:jobs                     ✓
pnpm test:phase8:job-recovery:matrix      ✓
pnpm test:phase8:reliability               ✓
pnpm test:phase8:parity                    ✓
pnpm test:phase8:productization            ✓
pnpm test                                  ✓ (all workspace tests)
git diff --check                           ✓
```

### 尚未关闭

8.4 仍需更广泛的真实 graphical browser matrix；8.3 OS-level isolation/deployment evidence、外部 IdP/JWT、完整 principal catalog、外部 secret manager、backup/restore、migration rollback 和 upgrade/deployment policy 继续延期。

## 2026-08-24：8.5 tenant-scoped credential reference lifecycle

本次工作继续属于 Phase 8.5，承接 provider/model routing，补齐 credential reference 的 host-owned 生命周期。DSH 只作为职责和行为参考：`packages/client/ui-model-selection` 的 Host-owned model selection、selection failure 语义，以及 `packages/sdk/client` 的 provider/model handshake/retry 边界；没有复制 DSH 代码、内部类型或品牌资产。A2A 保持 `deferred`。

### 已完成

- `packages/contracts` 新增 `CredentialRecord` / `CredentialBackend`；`McpCredentialReference.version` 固化轮换后的 stale reference 检查。Credential metadata 只包含 tenant、kind、状态、版本和时间，不包含 secret material。
- `packages/storage` 升级 SQLite schema v6，新增 tenant-scoped `credentials` metadata table；旧数据库迁移、reopen、InMemory fixture、跨租户查询和无 secret material 持久化测试已覆盖。
- `apps/api/src/credentials.ts` 新增 host-owned `CredentialVault`，支持 create、rotate、revoke、delete、reference validation 和 resolver。material 只保留在进程内；未配置 backend、跨租户、revoked 或 stale reference 均 fail closed。
- API 增加 `GET/POST /v1/credentials`、`POST /v1/credentials/:id/rotate`、`POST /v1/credentials/:id/revoke` 和 `DELETE /v1/credentials/:id`。公开响应只返回 metadata，route/MCP 引用存在时删除返回冲突。
- model route 在 rotate 后重绑新 credential version，在 revoke 后清除 tenant route 并回退 host-local；MCP resolver 按 tenant 解析，live connection 在 rotate/revoke 时停止，缺少或失效 reference 映射为 `needs_auth`。
- Web typed client 增加 credential catalog/mutation 和带 `credentialRef` 的 model selection；productization gate 增加 credential create、rotation、revoke、in-use deletion、route invalidation 和 redaction 检查。

### 契约与安全边界

- Credential metadata 是 control-plane 配置事实，不新增 Session event type；实际使用的 model route 仍只在所属 Session 的 `turn/started` 或恢复 `agent/status` 中记录 bounded route metadata。
- secret material 不进入 EventStore、SQLite、route、MCP config、SSE、diagnostics、Web projection 或错误消息。当前 host-only material 在进程重启后不可恢复，active reference 缺少 resolver material 时 fail closed；外部 secret manager 适配继续延期。
- 生命周期以 `(tenantId, credentialId)` 隔离；删除前检查 model route/MCP config 引用，吊销优先于删除，rotation 通过 version 使旧引用失效。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/storage test       ✓ (15 tests)
pnpm --filter @code-review-agent/mcp-client test   ✓ (11 tests)
pnpm --filter @code-review-agent/api test             ✓ (37 tests)
pnpm --filter @code-review-agent/web test -- --run src/client/api.test.ts ✓ (12 tests)
pnpm test:phase8:productization                       ✓
pnpm test:phase8:parity                              ✓
pnpm test                                             ✓ (all workspace tests)
git diff --check                                      ✓
```

### 尚未关闭

本切片不实现外部 secret manager、外部 IdP/JWT、完整 principal catalog、8.3 OS-level isolation/deployment evidence、8.4 更完整的跨场景 browser recovery matrix、backup/restore、migration rollback 或 upgrade/deployment policy；Phase 8.5 与 Phase 8 仍保持 `in_progress`。

本切片已建立独立 Phase 8 Git checkpoint；后续工作从该 checkpoint 继续推进，不能据此将 Phase 8.5 或 Phase 8 标记为完成。

## 2026-08-24：8.5 tenant-scoped provider/model routing

本次恢复工作继续属于 Phase 8.5，完成 provider/model routing 的第一可用切片。DSH 参考 `packages/client/ui-model-selection`、`packages/client/runtime` 的 `modelSelection` 和 `packages/sdk/client` 的 provider/model handshake；本项目没有复制 DSH 代码、内部类型或品牌资产。A2A 保持 `deferred`。

### 已完成

- `packages/contracts` 新增 `ModelRouteRecord` / `ModelRouteBackend`；route 只保留 provider、model、baseUrl 和 opaque credential reference，credential material 不进入 route、事件、SQLite 或公开 API；
- `packages/storage` 建立 SQLite schema v5 `model_routes`，支持 tenant route 的 upsert/list/delete、旧数据库迁移和 reopen；非法非 HTTP(S) baseUrl fail closed；
- `packages/runtime` 按 Session ownership 选择 tenant model；实际 route metadata 写入 `turn/started` 和重启恢复的 `agent/status`，未配置 route 的 Session 保持 host-local model；`productizationSettings(tenantId)` 按调用者 scope 报告 routing readiness；
- `apps/api` 的 `/v1/models` 支持认证 tenant 的 route catalog、selection receipt 和 durable update；route mutation 先写 backend，再更新 runtime memory；持久 route 在缺少 selector 时恢复失败，缺少 durable backend 时 tenant mutation 返回配置错误；
- typed Web client 保留 route projection；productization fixture 增加 tenant model selection、cross-tenant denial 和 route receipt；
- productization gate 已覆盖 tenant selection、tenant route isolation、turn route event metadata、credential redaction 和 SQLite-backed API recovery。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/runtime test       ✓ (32 tests)
pnpm --filter @code-review-agent/storage test       ✓ (14 tests)
pnpm --filter @code-review-agent/api test           ✓ (34 tests)
pnpm test:phase8:productization                     ✓
git diff --check                                     ✓
```

### 尚未关闭

该切片不实现 credential reference 生命周期、外部 IdP/JWT、完整 principal catalog、8.3 OS-level isolation/deployment evidence、8.4 更完整的跨场景 browser recovery matrix、backup/restore、migration rollback 或 upgrade/deployment policy；Phase 8.5 与 Phase 8 仍保持 `in_progress`。

## 2026-08-24：8.5 opt-in bearer auth、tenant ownership 与 quota slice

本次 checkpoint 继续 Phase 8.5，落实上一 checkpoint 已接受的产品化边界。默认本地 Host 行为保持兼容；认证与 quota 只有显式配置时才启用。A2A 保持 `deferred`。

### 已完成

- `SessionOwnership` contract 进入 SessionProjection/Summary；`session/created` 事件携带 principal/tenant identity，SQLite replay、fork 和 child Subagent 创建会保留或继承 ownership；
- `AgentHost` 支持按 tenant 的 bounded `maxSessionsPerTenant` 与 `maxTurnsPerTenant` hard quota，并使用租户锁避免同一 Host 的并发创建/发送绕过计量；未归属的本地 Session 保持旧行为；
- API 增加显式静态 bearer token adapter：认证请求按 tenant 过滤 Session catalog，跨租户 Session 返回 404，缺少/错误 token 返回 401；全局 diagnostics、MCP config 和 Workspace mutation 在缺少 tenant-scoped adapter 时 fail closed；
- Productization capability 在配置认证和 quota 时报告 `configured`/`hard`，未配置时继续显示 `deferred`/`disabled`，不把受控静态 token adapter 宣称为外部 IdP；
- 新增真实 Web/SQLite fixture 的认证、tenant catalog、cross-tenant denial、turn quota 和 credential redaction gate。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/storage test       ✓ (13 tests)
pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts ✓ (29 tests)
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓ (29 tests)
pnpm test:phase8:productization                     ✓
git diff --check                                     ✓
```

### 尚未关闭

该切片不实现外部 IdP/JWT、完整 principal catalog、tenant-scoped Workspace mutation、MCP config 隔离、tenant-scoped provider routing 或 backup/migration/upgrade policy；8.5 与 Phase 8 仍保持 `in_progress`。

## 2026-08-24：8.5 产品化边界与 capability 第一切片

本次 checkpoint 属于 Phase 8.5 产品化，先建立可回滚的契约边界和默认禁用态。A2A 保持 `deferred`，未引入认证或租户推断。

### 已完成

- 新增 `docs/adr/phase-8-5-productization-boundary.zh-CN.md`，明确 remote auth、multi-user/tenant、quota、provider/model routing、credentials 和 deployment/backup/migration/upgrade 的状态语义与后续实现门槛；
- `packages/contracts` 新增 `ProductizationCapability`；Runtime、API `/v1/capabilities`、Web Settings 和 typed browser bundle 均消费同一 host-backed 状态；
- 默认本地 Host 明确返回 auth/tenant/quota/运维能力的 `deferred` 或 `disabled`，routing 保持 host-local，credentials 只保留 host-owned/redaction-required 语义；
- 新增 `scripts/phase8-productization-gate.mjs` 与 `pnpm test:phase8:productization`，验证 capability 版本、fail-closed 状态和 Web bundle 传播；

### 验证

```text
pnpm typecheck                                      ✓
pnpm test                                            ✓
pnpm test:phase8:productization                     ✓
pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts ✓
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓
pnpm --filter @code-review-agent/web test -- --run src/presentation/settings-presenter.test.ts ✓
git diff --check                                     ✓
```

### 尚未关闭

该切片不实现 bearer auth、durable Session ownership、tenant isolation、quota enforcement、tenant-scoped provider routing 或 backup/migration/upgrade policy；8.5 与 Phase 8 仍保持 `in_progress`。

## 2026-08-24：8.4 Job recovery 重复重启矩阵

本次 checkpoint 属于 Phase 8.4 可靠性，扩展 API/SQLite recovery slice 的重复重启与 Web Job Center 回放证据。A2A 保持 `deferred`。

### 已完成

- 新增 `scripts/phase8-job-recovery-matrix-gate.mjs` 与 `pnpm test:phase8:job-recovery:matrix`；
- 真实 fixture 执行 seed → reopen → reopen-again，验证 interrupted Session、orphaned/completed jobs、SSE job/terminal replay、terminal `after_sequence` tail cursor、export/diagnostics 和无重复 orphaned projection；
- 同一矩阵检查 Web shell 的 Job Center surface 与 typed browser bundle 的 recovery statuses，确保恢复事实仍来自 host/API replay。

### 验证

```text
pnpm test:phase8:job-recovery:matrix ✓
  job-recovery-restart-matrix: passed
  scenarios: seed, reopen, reopen-again, sse-replay, tail-cursor, export-diagnostics
```

### 尚未关闭

8.4 仍需更长任务、并发 action、真实浏览器交互和跨场景恢复矩阵；8.3 OS 隔离证据与 8.5 产品化也未完成。

## 2026-08-24：8.3 LSP/Code Mode 有界退出审计

本次 checkpoint 属于 Phase 8.3 安全退出审计，固化当前可证明的边界和残余风险。A2A 保持 `deferred`。

### 已完成

- 新增 `scripts/phase8-lsp-codemode-exit-gate.mjs`，审计 workspace/process boundary、网络 deny-by-default、OS-required fail-closed、代码/运行时/输出预算、LSP restart/timeout/cancel 和 Web host-backed surface；
- gate 读取实现源码、单元 fixture、现有 LSP/Code Mode gate、Settings presenter 和构建后的 browser bundle，避免仅凭文案判定安全能力；
- 审计结果显式输出 `status: partial`，保留 OS-level network isolation adapter 和部署级证据两项 residual risk，不把 process-policy 宣称为 OS 隔离。

### 验证

```text
pnpm test:phase8:lsp:exit ✓
  lsp-codemode-bounded-exit-audit: passed, status=partial
```

### 尚未关闭

8.3 仍需 host-specific OS isolation assessment 与部署级安全证据；8.4 跨场景 browser recovery matrix 和 8.5 产品化也未完成。

## 2026-08-24：8.0 响应式视觉基线与 Plugins 状态收口

本次 checkpoint 属于 Phase 8.0 Web 对齐，完成真实 Web fixture 的响应式视觉基线门禁，并补齐 Settings 的 Plugins 分区状态。A2A 保持 `deferred`，不进入本次实现。

### 已完成

- 使用真实 SQLite/API/AgentHost Web fixture 生成 Shell 与 Settings 的 600×800、900×800、1024×800 截图；文件统一为可校验的 JPEG，manifest 记录页面 surface、尺寸和 fixture 来源；
- 新增 `scripts/phase8-visual-gate.mjs` 与 `pnpm test:phase8:visual`，检查六个基线文件存在、PNG/JPEG 格式、真实像素尺寸、Shell/Settings 分离，以及 Settings 中 Plugins 的 `deferred` 说明；
- Runtime/API 新增 host-backed `pluginsSettings()` / `/v1/capabilities` 的 `plugins` 字段，当前明确返回 `deferred`，说明插件运行时等待 Phase 8.5 产品化需求；
- Settings presenter、Web Settings modal、API server test、presenter test 和 aggregate parity gate 均覆盖 Plugins，不把未实现插件能力显示为可用。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test -- --run src/presentation/settings-presenter.test.ts ✓ (3 tests)
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓ (28 tests)
pnpm build:web                                      ✓
pnpm test:phase8:visual                             ✓
pnpm test:phase8:parity                             ✓
git diff --check                                     ✓
```

### 尚未关闭

8.0 的完整响应式/可访问性 browser 矩阵和更多真实交互场景仍需继续扩展；8.3 完整退出审计、8.4 跨场景 browser recovery matrix 与 8.5 产品化也未完成。

## 2026-08-24：8.3 Code Mode 网络边界元数据与 fail-closed

本次 checkpoint 继续 Phase 8.3 的安全退出审计，明确 Code Mode 当前可证明的网络边界。A2A 保持 deferred。

### 已完成

- `CodeModePolicySnapshot` 和 `/v1/capabilities` 暴露 `networkEnforcement`、`network` 和 `osNetworkIsolation` 元数据；默认策略是进程级 deny-by-default，当前 host 明确报告没有 OS 级网络隔离；
- `os-required` 策略在执行前返回 `CODE_MODE_OS_ISOLATION_UNAVAILABLE`，在没有 OS 隔离适配器时 fail closed；
- Settings、LSP/Code Mode gate 和 Web replay gate 均检查该边界，避免把进程内入口拦截描述成 OS 级隔离；
- Settings fixture 补齐 network metadata，保持旧 host 数据缺失时显示 `Network enforcement metadata is unavailable`。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/tools test -- --run src/code-mode.test.ts ✓ (5 tests)
pnpm --filter @code-review-agent/web test -- --run src/presentation/settings-presenter.test.ts ✓ (3 tests)
pnpm test:phase8:lsp                                ✓
pnpm test:phase8:lsp:web                            ✓
pnpm test:phase8:parity                             ✓
pnpm build:web                                      ✓
git diff --check                                     ✓
```

### 尚未关闭

当前 host 仍未提供 OS-level network isolation；8.3 还需要完成退出审计和必要的更强隔离评估。8.0 visual baseline、8.4 跨场景 browser recovery matrix 与 8.5 产品化仍未完成。

## 2026-08-24：8.4 Job Center 真实 fixture 与重启恢复

8.4 的真实 Job Center action slice 和 API restart/recovery slice 已分别通过 `pnpm test:phase8:jobs` 与 `pnpm test:phase8:job-recovery`。前者覆盖 running/failed job、Cancel/Retry、spill metadata、lifecycle replay、diagnostics、session export 和重复 action 幂等；后者覆盖 seed 后关闭 API/SQLite、fresh AgentHost/API reopen、orphaned/completed job、interrupted session、terminal recovery、SSE replay、`after_sequence` tail cursor、diagnostics 和 export。

### 尚未关闭

更广泛的跨场景长任务 browser recovery matrix 仍需继续扩展，不能由这两个 slice 代替完整 8.4 退出条件。

## 2026-08-24：8.0 Aggregate Web parity contract gate

本次 checkpoint 收口 Phase 8.0 的静态 Web parity 合同门禁，继续从现有实现和事件投影验证 DSH 对齐能力；A2A 保持 `deferred`，不进入本次实现。

### 已完成

- 新增 `scripts/phase8-parity-gate.mjs`，检查 Goal/Plan/Question、Workspace Tree/Flat 与排序、Job Cancel/Retry、LSP details、Settings provider failure/retry、Produced Files、Tasks/child agents 以及 typed browser presenters；
- 门禁同时检查 600/900 响应式断点、`aria-live`、browser bundle focus trap 和既有 presenter symbol，避免只检查旧 HTML 文案；
- `package.json` 新增 `pnpm test:phase8:parity`，作为 8.0 aggregate contract 的可重复入口。

### 验证

```text
pnpm test:phase8:parity  ✓
  aggregate-web-parity-contract: passed
git diff --check         ✓
```

### 尚未关闭

该门禁不替代视觉截图基线和真实交互证据。8.0 仍需 600/900/1024 视觉矩阵和完整 Settings section（含 Plugins 的明确状态）；真实 Job action/replay fixture 与 provider failure/retry fixture 已由后续 checkpoint 关闭。8.3 完整审计、8.4 browser recovery matrix 与 8.5 产品化也未完成。

## 2026-08-24：8.0 Workspace Browser 导航 parity 收口

本次工作属于 Phase 8.0 Web 对齐，目标是补齐 Workspace Browser 的视图与排序入口，并验证其与现有 Session 回放、搜索和归档状态保持一致。A2A 保持 `deferred`，不进入本次实现。

### 已完成

- `navigation-presenter.ts` 增加 Tree/Flat 视图模型；Flat 模式展平父子 Session，保留 workspace 和 lineage 元数据；
- 增加 Recent/Name/Path 确定性排序，避免不同刷新顺序造成导航漂移；
- `apps/web/index.html` 暴露 Workspace view/sort 控件并接入 typed navigation model；
- 增加 presenter 单元测试，覆盖 Flat 展平和三种排序；
- 真实页面回归覆盖 Tree/Flat、Recent/Name/Path、搜索、Archived 切换和状态恢复。

### 验证

```text
pnpm typecheck                              ✓
pnpm --filter @code-review-agent/web test   ✓ (101 tests)
pnpm build:web                               ✓
pnpm test:phase8:web                         ✓
pnpm test:phase8:reliability                 ✓
git diff --check                             ✓
```

### 尚未关闭

8.0 的真实 provider failure fixture、visual baseline 和总 parity gate 仍待补齐；8.3 完整退出审计、8.4 browser recovery matrix 与 8.5 产品化也未完成。

## 2026-08-24：8.0 Settings provider/model failure surface

本次工作继续 Phase 8.0 Web 对齐，目标是让 provider/model catalog 的加载、失败、重试和选择结果在 Settings 中保持可解释且可恢复。

### 已完成

- `presentSettings` 增加 model loading/ready/error 状态、错误详情和 selection receipt；
- Web boot 将 model catalog 失败从全局 boot failure 中隔离，Settings 显示 `Catalog status`、provider failure 文案和 `Retry model catalog`；
- 模型切换成功后展示 host-backed `Selected <model>` receipt，失败后保留错误状态并允许再次重试；
- Phase 8 Web gate 增加 Workspace view/sort 与 Settings retry surface 静态门禁。

### 验证

```text
pnpm typecheck                              ✓
pnpm --filter @code-review-agent/web test   ✓ (102 tests)
pnpm test:phase8:web                         ✓
pnpm build:web                               ✓
git diff --check                             ✓
```

### 尚未关闭

仍需 visual baseline 和总 Web parity gate；8.3 完整退出审计、8.4 browser recovery matrix 与 8.5 产品化也未完成。

## 2026-08-24：8.0 provider failure fixture 与真实页面回归

### 已完成

- API 增加受控 `modelCatalogFailures` fixture hook，只用于测试/部署 smoke，不改变默认 provider 行为；
- `scripts/phase8-settings-gate.mjs` 覆盖首次 503、Retry 后 200、Session 数据仍可加载；
- 真实 Web 页面验证 Settings 显示 `Catalog status: error`、provider failure 文案和 `Retry model catalog`，点击后恢复 `ready` 与 `fixture-model`。

### 尚未关闭

8.0 仍需 visual baseline、总 Web parity gate 和更完整的响应式/section 矩阵。

## 2026-08-24：8.4 Reliability 第一阶段收口

本次工作属于 Phase 8.4，目标是让后台 Job、Session export/replay、诊断和 Web Job center 具备可恢复的可靠性边界。A2A 保持 `deferred`，不进入本次实现。

### 已完成

- `JobManager` 持久化 executable/args、attempt/deadline 元数据，支持显式 bounded retry、deadline 失败原因、调用方取消原因和 graceful shutdown；retry 创建新的 durable attempt，原失败保留在事件审计中；
- `AgentHost` 增加 job list/retry/kill、session export/replay、structured diagnostics 和 shutdown；
- API 增加 `/v1/sessions/:id/jobs`、`/retry`、`/cancel`、`/export` 与 `/v1/diagnostics`；Web API client 与 Job center 增加 Cancel/Retry 操作；
- 新增 `scripts/phase8-reliability-gate.mjs`，覆盖 retry、deadline、shutdown、session export 和 diagnostics 的真实运行路径。
- Reliability gate 增加 Web Job Center recovery surface 检查，确认 Cancel/Retry/diagnostics 文案和 typed browser action symbols 随构建产物存在；真实 Job action/replay fixture 已由后续 `pnpm test:phase8:jobs` checkpoint 关闭。
- 修复 API restart recovery race：shutdown 只取消普通 active turn，保留等待 durable user interaction 的 turn，让下一次 AgentHost 从 pending interaction 恢复；同时避免 SQLite close 后异步 `finishTurnAfterError` 写入失败。

### 验证

```text
pnpm typecheck                              ✓
pnpm --filter @code-review-agent/tools test  ✓ (58 tests)
pnpm --filter @code-review-agent/api test    ✓ (31 tests)
pnpm --filter @code-review-agent/web test    ✓ (100 tests)
pnpm build:web                               ✓
pnpm test:phase8:reliability                 ✓
git diff --check                             ✓
```

### 尚未关闭

8.4 的 model fallback、基础 metrics 和 turn trace propagation 已补齐；仍需更完整的 browser recovery matrix。8.0 parity gaps、8.3 完整退出审计和 8.5 产品化也仍未完成。

## 2026-08-24：8.3 LSP/Code Mode 第一阶段收口

本次工作属于 Phase 8.3，补齐受控 Code Mode、LSP Web source-location surface 和 capability metadata。A2A 保持 deferred。

### 已完成

- 新增 `CodeModeSandbox`：独立子进程、无 shell、Node permission 文件范围、最小环境、`node` 命令 allowlist、网络禁用、代码/运行时/输出预算和 AbortSignal 取消；
- `createBuiltinTools` 和 `AgentHost` 支持通过显式 `codeMode` 配置暴露 `code_mode`，默认不启用；
- 新增 Code Mode prompt contract、disabled/路径穿越/网络模块/恶意 executable/超时/输出上限/取消测试；
- 新增 `presentLspTool`，把 diagnostics、definition、references、source location、server restart/crash 和失败原因投影为 bounded Web render intent；
- Web Details 增加 LSP diagnostics & source locations surface；Settings capabilities 公开 Code Mode 与 LSP 的真实 host 状态；
- 新增 `scripts/phase8-lsp-codemode-gate.mjs`，覆盖 Code Mode 成功、网络越权、输出预算、LSP diagnostics/definition、server crash restart 和 cancellation。
- LSP/Code Mode gate 增加 Web LSP details/source-location 静态 surface 检查；Code Mode 网络拒绝模式补充 `globalThis.fetch`、`globalThis.WebSocket` 与 `process.getBuiltinModule` 入口测试。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/tools test         ✓ (56 tests)
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓ (27 tests)
pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts ✓ (25 tests)
pnpm --filter @code-review-agent/web test           ✓ (100 tests)
pnpm build:web                                      ✓
pnpm test:phase8:lsp                                ✓
git diff --check                                     ✓
```

### 尚未关闭

8.3 仍需完成完整退出审计和更强 OS 级隔离评估；当前 host 只有 process-policy，`os-required` 会 fail closed。真实 LSP/Code Mode Web replay 已由 `pnpm test:phase8:lsp:web` 覆盖，但这不替代完整 browser/安全审计矩阵。

## 2026-08-24：8.2 Worktree 收口

本次工作属于 Phase 8.2，解决 Workspace/Worktree runtime、事件回放、安全和 Web 诊断问题。A2A 保持 deferred，不在本次范围内。

### 已完成

- `GitWorktreeManager` 支持主仓库和 linked worktree 识别；所有 Git 调用使用无 shell 的 `execFile`；
- Worktree create、attach、switch、cleanup 通过 `worktree/*` 事件进入 EventStore，并投影到 Session；
- active worktree 的路径进入工具执行、权限请求和 system prompt；主 Session `workspaceRoot` 不被覆盖；
- 增加每个 Session 的 Worktree operation lock，避免并发创建相同路径或分支；
- pending create 在 Git side effect 已发生但事件尚未追加时可以恢复并补写事件；
- dirty/conflicted cleanup 默认拒绝，主仓库永远不能 cleanup，重复路径返回 `WORKTREE_EXISTS`；
- Web API、SSE、SessionStore、Worktree presenter 和 Details panel 已接入；
- 新增 linked worktree、SQLite reopen/replay、并发创建、pending recovery、API client 和 presenter 测试；
- 新增 `scripts/phase8-worktree-gate.mjs` 与 `pnpm test:phase8:worktree`，覆盖真实 API、临时 Git 仓库、SQLite 重启、dirty protection、强制清理和 Web bundle。

### 验证

```text
pnpm typecheck                         ✓
pnpm --filter @code-review-agent/workspace test  ✓ (6 tests)
pnpm --filter @code-review-agent/runtime test    ✓ (24 tests)
pnpm --filter @code-review-agent/storage test    ✓ (12 tests)
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓ (26 tests)
pnpm --filter @code-review-agent/web test        ✓ (98 tests)
pnpm build:web                          ✓
pnpm test:phase7:browser                ✓
pnpm test:phase8:worktree               ✓
git diff --check                        ✓
```

### 尚未关闭

本记录对应的代码已建立独立的 Phase 8.2 Git checkpoint；Phase 8.1 Compaction 已完成，8.0 Web parity、8.3 LSP/Code Mode、8.4 可靠性和 8.5 产品化仍未完成。

## 2026-08-24：8.1 Context Compaction 收口

### 已完成

- API capabilities 返回 host-backed context compaction enabled/configured/budget metadata；Web Settings 和 ContextMeter 显示真实配置，未配置 provider budget 时保持 `unknown`；
- Context projection 保留 summary、dropped message、protected tool 和 truncated tool result 计数；
- 增加 compaction failure continuation 测试，压缩失败时保留原上下文并继续完成 turn；
- 增加真实 API 长上下文 fixture、SQLite restart/replay 和 Web bundle gate。

### 验证

```text
pnpm typecheck
pnpm --filter @code-review-agent/runtime test        ✓ (25 tests)
pnpm --filter @code-review-agent/storage test        ✓ (12 tests)
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓ (27 tests)
pnpm --filter @code-review-agent/web test             ✓ (98 tests)
pnpm test:phase8:compaction                           ✓
git diff --check                                      ✓
```

本记录对应的代码已建立独立 Phase 8.1 Git checkpoint；8.0 Web parity、8.3 LSP/Code Mode、8.4 可靠性和 8.5 产品化仍未完成。

## 2026-08-24：Phase 8 暂存归档

本次动作只负责阶段收尾和可回滚归档，不宣告 Phase 8 完成。当前工作树在 `c1aae6c` checkpoint 后保持干净；最后一轮全量 workspace 测试及本轮 Phase 8 定向门禁均已通过。

### 归档内容

- 8.1 Context Compaction 与 8.2 Worktree 已满足各自退出条件；
- 8.0 aggregate Web parity 已通过，8.3 LSP/Code Mode、8.4 Reliability 和 8.5 Productization 的已实现切片、合同、恢复与安全证据已保留；
- 8.5 当前以显式 bearer/tenant/quota adapter 提供受控部署切片，外部 IdP/JWT、完整 principal catalog、tenant-scoped Workspace/MCP/provider routing、credentials 生命周期、backup/restore 和 upgrade policy 仍待实现。

### 恢复入口

恢复 Phase 8 时从 `c1aae6c` 继续，优先选择 tenant-scoped Workspace catalog/mutation 或 provider/model routing 与 credential reference durable contract，并为新切片建立独立 checkpoint 和对应 gate。

## 2026-08-24：8.5 tenant-scoped Workspace catalog/mutation

本次恢复工作属于 Phase 8.5，完成产品化第一切片中 Workspace 的租户边界。变更影响 Workspace contract、事件回放、API 权限和产品化安全 gate；默认未认证本地 Host 保持兼容。

### 已完成

- `AgentHost.listWorkspaces()`、`reorderWorkspaces()`、`renameWorkspace()`、`archiveWorkspace()` 和 `deleteWorkspace()` 支持可选 `SessionOwnership` scope；同一 Workspace root 下的不同 tenant 可以拥有独立 label、archive/delete 状态和排序事件。
- tenant-scoped `workspace/updated` / `workspace/reordered` 事件携带 `tenantId`、`principalId`，只追加到调用者 tenant 的 Workspace members；回放按 tenant 过滤，未认证 catalog 只消费 legacy unscoped metadata。
- API `/v1/workspaces` 和 Workspace mutation routes 现在使用 bearer identity 进入 host scope；跨租户查询和 mutation 返回 404，tenant 内 rename/archive/restore/delete/reorder 继续使用 durable command idempotency。
- 增加 Runtime InMemory isolation、SQLite reopen/replay、API tenant catalog/mutation 和 productization browser fixture gate。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts ✓ (31 tests)
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓ (29 tests)
pnpm test:phase8:productization                     ✓
git diff --check                                     ✓
```

### 尚未关闭

外部 IdP/JWT、完整 principal catalog、MCP config tenant 隔离、tenant-scoped provider/model routing、credentials 生命周期、backup/restore、migration rollback 和 upgrade/deployment policy 仍未实现；Phase 8.5 与 Phase 8 继续保持 `in_progress`。

## 2026-08-24：8.5 tenant-scoped MCP config 与 ToolRuntime 隔离

本次恢复工作继续属于 Phase 8.5，补齐 MCP 产品化切片的 tenant boundary。变更影响 MCP config contract、SQLite schema、ConnectionManager、ToolRuntime、API 路由和产品化安全 gate；默认未认证本地行为保持兼容。

### 已完成

- `McpConfigRecord` / `McpServerConfig` 支持可选 `tenantId`；SQLite schema 从 v3 迁移到 v4，增加 `mcp_server_configs.tenant_id` 及索引，旧无租户记录保持可读。
- `McpConfigStore` 对 tenant ownership 做 fail-closed 冲突检查；`list/get/setEnabled/remove` 支持 tenant scope，未认证本地 catalog 只读取 legacy unscoped configs。
- `McpConnectionManager` 的 list/get/catalog/resource/prompt/enable/disable/reconnect/delete routes 接受 tenant scope；MCP lifecycle 事件只投影到相同 tenant 的 Session members。
- MCP ToolSource 携带 tenant identity；ToolRuntime 在 model-visible discovery 与 execute 阶段再次验证 tenant，越权调用返回 bounded `MCP_TENANT_SCOPE_DENIED`，并保留统一 tool audit。
- API authenticated MCP create 自动绑定 bearer tenant，不接受客户端伪造 tenant；跨租户 catalog/delete/lifecycle 返回 404；scrubbed config 和 credential reference 继续保持不泄露 secret。
- 产品化 gate 增加 tenant MCP catalog、credential redaction 和 cross-tenant denial 检查。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/mcp-client test -- --run src/index.test.ts ✓ (10 tests)
pnpm --filter @code-review-agent/storage test -- --run src/index.test.ts ✓ (13 tests)
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓ (29 tests)
pnpm test:phase8:productization                     ✓
git diff --check                                     ✓
```

### 尚未关闭

外部 IdP/JWT、完整 principal catalog、tenant-scoped provider/model routing、credentials 生命周期、backup/restore、migration rollback 和 upgrade/deployment policy 仍未实现；在本次收尾前，Phase 8.5 与 Phase 8 保持 `in_progress`。

## 2026-08-24：Phase 8 当前暂停归档

本次动作负责停止当前阶段并保留可回滚 checkpoint，不宣告 Phase 8 或 Phase 8.5 完成。收尾 checkpoint 为 `61cd9ca`（`feat(phase-8.5): add tenant-scoped mcp config`），提交后工作树已确认干净。

### 收尾证据

```text
pnpm typecheck                         ✓
pnpm test:phase8:parity                ✓
pnpm test:phase8:productization        ✓
git diff --check                        ✓
```

产品化 gate 已覆盖 auth、tenant Session/Workspace/MCP catalog、跨租户拒绝、turn quota 和 credential redaction。当前状态写回 `docs/phase-status.zh-CN.md`：Phase 8 为 `paused`，8.5 仍为 partial。

### 恢复入口

从 `61cd9ca` 继续，优先推进 tenant-scoped provider/model routing、credential reference 生命周期、8.3 OS-level isolation/deployment evidence、8.4 跨场景 browser recovery matrix，以及 backup/restore、migration rollback 和 upgrade/deployment policy。外部 IdP/JWT 和完整 principal catalog 仍未实现。

## 2026-08-25：权限请求与用户问题 Composer takeover 调研

本次工作只做调研和文档沉淀，没有修改运行时代码。目标是为后续解决“权限请求伴随工具调用堆在 Conversation 尾部”和“用户问题没有进入对话主操作区”建立 DSH 对照方案。

### 调研结论

- DSH 把 approval/question 视为 Host-owned pending request，不把 pending 操作卡渲染成普通 transcript 行；
- `conversation.composer` 是 selector-routed takeover chain，QuestionComposer 和 ApprovalPanel 替换默认 InputBar，共享同一个 sticky composer seat；
- 同一时刻只显示一个 pending request，Question 优先于 Approval；前一个 request 的 durable resolved frame 到达后，下一个 request 才进入 Composer；
- HTTP/RPC receipt 只代表响应被接受，不能让前端自行删除 pending UI；resolved frame、Session projection 和 replay 才是权威状态；
- Approval 的 reason/command、Question 的 detail/options 在内部滚动区中展示，操作区固定在卡片底部；
- 点击后使用 one-shot disabled，receipt 失败可重试，request key 变化时重置本地 latch；
- 页面刷新、SSE 重连和恢复都从 durable pending projection 重建 Composer takeover；
- 本项目的 Event、Runtime、API、SQLite replay 和 Web Conversation projection 已具备基础，当前主要差距位于 `apps/web/index.html` 的挂载职责和 Composer 状态连接。

### 形成文档

详细的状态模型、职责边界、DSH 源码入口、实现分层、错误/过期/恢复语义和验收矩阵记录在：

`docs/dsh-permission-question-composer-research.zh-CN.md`

### 本轮边界

- 未修改 `apps/web`、`apps/api`、`packages/runtime` 或 `packages/tools` 代码；
- 未修改 Event/Tool/Task/Permission contract；
- 未恢复 Reasoning/Effort，未修改 Planning、三栏 Shell 或 ToolRow；
- 后续实现应拆成 pending projection、Approval takeover、Question takeover 三个独立 checkpoint。
