# Phase 1：AgentHost 与 Web Shell 开发日志

状态：`completed`（Web Shell 与 Phase 1A Agentic Coding Core 均已完成，2026-08-22）

阶段计划：[phase-1-agenthost-web.zh-CN.md](../phase-plans/phase-1-agenthost-web.zh-CN.md)

## 2026-08-21：阶段完成记录

### 主要交付

- 建立 TypeScript/Node.js monorepo：`packages/contracts`、`llm`、`storage`、`runtime`、`workspace`；
- 建立 `AgentHost`、Session、Turn、in-memory EventStore 和 Echo/OpenAI-compatible model adapter；
- 建立 Node HTTP API、SSE、取消和最小 DSH 风格 Web Shell；
- Web 完成 Session sidebar、Conversation、composer、Connected 状态和 assistant 增量展示。

### 验证证据

- 主要实现提交：`87401da feat: add phase one typescript agent host`；
- `pnpm typecheck`、`pnpm test` 通过；
- HTTP/SSE smoke 通过；
- 浏览器 Read-only smoke：页面连接 SSE、发送消息、显示 assistant 增量；
- 修复了 SSE JSON/流式读取、空流 heartbeat 和 Session 列表 payload 问题。

### 后续移交

Phase 1 保留 in-memory store 作为测试实现，SQLite durable EventStore、projection 重建、重启恢复和幂等 command 移交 Phase 2。

## 2026-08-22：重新打开 Phase 1 的 Coding Agent 门禁

### 诊断

- 当前 Web 页面已经可以创建 Session、选择 workspace、选择模型并显示流式文本；
- 当前 `packages/tools/src/builtin.ts` 的 9 个内置工具已经是 TypeScript 初版，ToolRuntime 已能通过 API 直接执行，并具备 workspace、schema、权限、取消、超时、输出预算和审计能力；旧 `src/code_review_agent/tools/` 只保留为 Python legacy/reference；
- 但模型请求只包含 `messages`，adapter 只解析文本增量，AgentHost 没有把模型 tool call 转换为 ToolRuntime 执行，也没有把 tool result 作为下一次模型上下文；
- 所以已有实现是 Coding Agent Runtime 基础设施，不是完整的 DSH/Claude Code 风格 Coding Agent。

### 决策

Phase 1 不再以 Web Shell 完成为退出条件，改以 [Agentic Coding Core 计划](../phase-plans/phase-1-agentic-coding-core.zh-CN.md) 的 Phase 1A.0–1A.6 门禁为准。下一步先做 contracts → DeepSeek tool-call adapter → Agent Loop → P0 TypeScript 工具池 → permission resume，再完成真实 `read → edit → approve → test` smoke；Terminal、Plan/Todo、AskUser 已提升为 Phase 1A 的 P1，Subagent/A2A 暂不进入核心实现。

### 2026-08-22：Phase 1A.1–1A.3 首批实现

- `packages/contracts` 增加 tool call、tool result、model tool schema、content message 和 step event contract；
- `packages/llm` 支持发送工具 schema并解析 OpenAI/DeepSeek-compatible `delta.tool_calls` 参数增量；
- `packages/runtime` 支持多 step model → tool → model、并行工具调用、tool result continuation、max steps 和 malformed tool call；
- permission ask 会等待用户批准/拒绝后继续同一个 turn；
- 多轮上下文会从事件重建 assistant tool call 和 tool result；
- Web SSE 订阅 `step/started` / `step/ended`，并保留既有 tool/permission 展示。

### 当前未完成

- 真实 DeepSeek API 下的 `read → edit → approve → test` 垂直验收；
- 进程重启后的 pending turn continuation；
- Phase 1A.4 的持久 Terminal、AskUser、Plan/Todo、delete/git read 工具扩展；
- P1 工具的完整行为 fixture 和 DSH/Claude Code 对照回归。

## 2026-08-22：真实模型配置接入

### 变更

- API CLI 启动入口新增本地 `.env` 加载；根目录 `.env` 已加入 Git 忽略，仓库只保留不含密钥的 `.env.example`；
- `MODEL_PROVIDER=auto` 在存在 `DEEPSEEK_API_KEY` 时选择 DeepSeek，否则保持 Echo，避免测试和无密钥开发被真实网络调用阻塞；
- DeepSeek 默认模型改为 `deepseek-v4-flash`，并登记 `deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp` 三个可选模型；
- API 新增 `GET /v1/models` 和 `POST /v1/models`，Web 顶栏提供模型下拉切换；切换只影响后续 turn，重启后回到 `.env` 中的 `DEEPSEEK_MODEL`；
- `MODEL_PROVIDER=deepseek` 在缺少 Key 时快速失败，错误不会回显 Key；
- API `/health` 仅返回 provider、model、base URL 和 `configured` 状态，不返回 API Key；
- API 测试使用 fake fetch 验证 Authorization header 和真实流式消息路径，未使用真实凭据。

### 验证

- `pnpm typecheck` 通过；
- `pnpm test` 通过；
- DeepSeek-compatible SSE adapter、无 Key fallback、显式缺 Key 错误、Key 不进入请求体/health/events 均有测试。
- 模型目录、合法切换、后续 turn 使用新模型和非法模型拒绝均有 API 测试。

### 使用方式

在仓库根目录执行 `Copy-Item .env.example .env`，只在本机 `.env` 中填写 `DEEPSEEK_API_KEY`，然后运行 `pnpm dev:api`。真实 Key 不需要也不应该发送到 Web API。

## 2026-08-22：Phase 1A.4 P1 工具闭包

### 主要交付

- 重构 `packages/tools/src/builtin.ts`，保留 P0 文件、搜索、Git 状态/差异和 argv 命令工具，并补齐 TypeScript P1 工具池；
- 新增 `TerminalManager`，支持独立 terminal session、固定 workspace/cwd、环境、增量输出读取、信号、关闭和列表；
- 新增 `delete_file`、`git_log`、`git_show`，删除默认进入 `.agent-trash`，Git 工具限制 ref/path 和输出预算；
- `ToolContext` 增加受 Runtime 控制的 `appendEvent` 与 `requestUserInput`，`ask_user` 通过 interaction 事件暂停并在 API/Web 回答后恢复同一个 turn；
- 新增 `plan/updated`、`todo/updated`、`interaction/requested`、`interaction/resolved` 事件和 projection；Web SSE 增加 interaction card；
- API 新增 `POST /v1/sessions/{sessionId}/interactions/{interactionId}`，支持 answer/cancel 和幂等 command。

### 验证

- `pnpm typecheck` 通过；
- `packages/tools` 20 项测试通过；
- `packages/storage` 7 项测试通过；
- `apps/api` 11 项测试通过，包含 ask_user → interaction answer → model continuation；
- 尚未进行真实 DeepSeek `read → edit → approve → test` smoke，待 Phase 1A.5 的权限 preset、MCP/恢复整合稳定后执行。

## 2026-08-22：Phase 1A.5 权限与恢复整合

### 主要交付

- 增加 `read-only`、`workspace-write`、`ask-on-write`、`ask-on-execute`、`danger-full-access` permission preset；工具列表在模型发现阶段进行 deny 过滤，执行时仍做最终 policy 校验；
- AgentHost 重启时从事件恢复 pending permission，并把同一 turn 的审批关联起来；最后一个审批解决后继续原 turn，恢复上下文包含原 user message、assistant tool call 和 tool result；
- 修复 `waitForTurn` 在取消/重启中间状态提前返回的问题，重复审批、拒绝和取消不重复启动恢复流程；
- 新增 `terminal/session` 生命周期事件。重启时旧的 running terminal 只恢复 cwd、命令、workspace、状态和缓冲字节元数据，并追加 `interrupted`；不恢复不存在的 Node child process；
- `PermissionProjection` 增加 `turnId`，使 pending approval 能从 projection 关联 interrupted turn；API workspace 对 `@code-review-agent/tools` 的类型依赖和 project reference 已补齐。

### 验证

- `pnpm typecheck` 通过；
- `@code-review-agent/tools` 22 项测试通过；
- `@code-review-agent/runtime` 9 项测试通过；
- 覆盖 permission preset/模型可见过滤、重启后的 pending approval continuation、取消收尾、terminal interrupted replay 和无伪造进程；
- 尚未进行真实 DeepSeek `read → edit → approve → test` smoke，该项移交 Phase 1A.6。

## 2026-08-22：Phase 1A.6 真实 Coding 垂直切片

### 验收场景

在隔离 workspace 中使用本地 `.env` 的真实 DeepSeek 配置（`deepseek-v4-flash`）完成：

1. 创建 Session 并绑定 workspace；
2. Agent 调用 `read_file` 读取 `fixture.js`；
3. Agent 通过 `ask_user` 请求变更确认；
4. 用户批准后，Agent 生成 `edit_file`，再经 permission approval 写入并产生 `diff/preview`；
5. Agent 调用 `run_command` 执行 `node fixture.js`，stdout 为修改后的字符串，exit code 为 0；
6. Agent 调用 `git_diff` 并返回最终 summary；
7. 拉取事件 JSON replay，确认完整 tool/interaction/permission/diff/step trajectory 且没有 API key。

### 结果

- 真实 provider、工具 schema、Agent Loop、用户交互、权限审批和工具结果 continuation 全部连通；
- `read → edit → approve → test → summary` smoke 通过；
- 本次 smoke 不改变仓库源码，自动化测试继续使用 fake/local model，避免测试依赖网络和真实凭据。

## 2026-08-22：Phase 1A.0 迁移边界与工具矩阵收尾

- 明确 `src/code_review_agent/tools/` 仅为 Python legacy/reference，新 Runtime 只依赖 TypeScript `packages/tools`；
- 新增 [tool-migration-matrix.zh-CN.md](../tool-migration-matrix.zh-CN.md)，登记 P0/P1 工具与 DSH/Claude Code 行为参考、权限/工作区/模型视图和安全边界；
- 新增 `packages/tools/src/behavior-fixtures.ts` 及 registry 对齐测试，确保 9 个 P0 工具的风险、调度、审批和输出契约持续可验证。

## 2026-08-22：Phase 1A 退出记录

### 退出结论

- Phase 1A.0–1A.6 的交付物、测试门禁和真实 Coding 垂直场景均已完成；
- 真实 DeepSeek `read → edit → approve → test → summary` smoke 已在隔离 workspace 通过；
- pending approval、terminal interrupted metadata、tool/permission/interaction/diff/step 事件均可从事件日志回放；
- 新 Runtime 继续以 TypeScript/Node.js 为唯一后端基座，旧 Python 工具只保留为 legacy/reference；
- Phase 1A 之后不得直接把 Subagent、A2A、LSP 或复杂 Worktree 作为未计划的核心实现引入，后续工作按阶段计划进入。

### 验证证据

```text
pnpm typecheck   ✓
pnpm test        ✓
git diff --check ✓
```

本次阶段状态收口对应一个独立 Git checkpoint；后续阶段性更新仍必须遵守根目录 `AGENTS.md` 的“更新后立即 commit”规则。

## 2026-08-22：Phase 1A 通过后的可用性修复

### 用户验收反馈

- 选择 workspace 后，模型仍可能用“无法直接查看仓库”的话术要求用户自行执行命令并粘贴结果；
- 长输出期间 Web 会话滚动区域与 composer 的布局不稳定，可能导致输入框离开可视区域，无法继续下一轮对话。

### 修复

- AgentHost 默认 system prompt 明确声明当前 workspace、可用工具和主动调用规则；模型被要求在可用工具能够完成任务时先调用工具，不得要求用户代为执行命令；每个 turn 还会注入实际 workspace 根路径；
- `runSteps` 在模型收到取消后返回空流时检查 AbortSignal，避免已取消 turn 被错误标记为 completed；
- Web app/workspace 增加 `min-height: 0` 和溢出约束，使 conversation 独立滚动、composer 保持在固定网格行；
- 渲染时只在用户原本接近底部时自动跟随新事件，用户向上查看长输出时不再被每个 SSE 事件强制拉回底部。

### 验证

```text
pnpm typecheck   ✓
pnpm test        ✓
git diff --check ✓
```

新增 Runtime 合同测试确认模型收到 workspace 和工具使用约束；本地 API Web smoke 确认返回页面包含独立滚动布局和 near-bottom 自动滚动逻辑。

## 2026-08-22：System Prompt 分层与动态上下文强化

### 背景

上一轮可用性修复已经阻止模型在有工具时声称“无法查看 workspace”，但默认 prompt 仍是单段短文本，没有清晰表达成熟 Coding Agent 所需的任务循环、权限、安全、验证和恢复规则，也没有把当前经过 policy 过滤的工具集合告诉模型。

### 变更

- 新增 `packages/runtime/src/system-prompt.ts`，按 identity、task execution、tool use、workspace、permission、safety、verification、communication、recovery 和 application instructions 分 section 组装；
- 每个 turn 动态注入真实 workspace、可见工具名及 risk/approval/execution 元数据；工具描述继续由模型工具 schema 传递，避免把外部 MCP 描述直接当可信系统指令；
- 增加搜索后断言、read-before-edit、保留用户改动、失败诊断、权限不可绕过、工具结果不可信和完成前验证规则；
- 重启审批恢复明确带 recovery section；自定义 `AgentHostOptions.systemPrompt` 改为低优先级附加指令，不能覆盖安全基线；
- 新增 [system-prompt-design.zh-CN.md](../system-prompt-design.zh-CN.md) 和 ADR-009，记录与 Claude Code section pipeline、DSH lifecycle/tool pipeline 的对应关系及当前明确不宣称的高级能力。

### 验证

```text
pnpm typecheck   ✓
pnpm test        ✓
git diff --check ✓
```

`packages/runtime` 测试覆盖默认 prompt 的 workspace/tool-use contract、permission-filtered tool inventory、自定义应用指令和 recovery prompt。该更新仍属于 Phase 1A 退出后的行为强化，不新增 Subagent、A2A、LSP、Worktree 或其他未计划核心能力。
