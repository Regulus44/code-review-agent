# 阶段状态

本文记录当前开发阶段的实际状态。它不是长期架构决策；阶段完成以对应 Git checkpoint、测试命令和验收证据为准。

## 当前状态

| 阶段 | 状态 | Checkpoint/证据 |
|---|---|---|
| Phase 0：TypeScript 基线与契约 | completed | `codex/phase-0-typescript-foundation`；workspace、strict TS、contracts、依赖图检查通过 |
| Phase 1：Agentic Coding Core | completed（Phase 1A.0–1A.6 已完成） | Tool-calling loop、P0/P1 TypeScript 工具、permission preset、pending approval/terminal 恢复和真实 `read → edit → approve → test → summary` 已通过；本次 checkpoint 完成阶段退出记录 |
| Phase 2：事件、持久化与恢复 | completed | `a7f636f` + `5d5a198`；SQLite reopen/recovery、projection replay、SSE replay、queue、幂等 command 和 model failure 通过 |
| Phase 3：工具运行时与权限 | completed | `e1d3172`（替代 `5003dbd`）；工具禁用、显式覆盖、进程树终止、audit/modelView、权限过期/取消/重启恢复和 Web smoke 通过 |
| Phase 3B：Coding Agent 工具池与工具 Prompt 强化 | completed（2026-08-22） | 3B.0–3B.5、patch/diff、LSP 生命周期/恢复、job spill/恢复和 Web presentation 已闭合；隔离本地长任务与真实 DeepSeek long-task smoke 通过。普通基线测试未重复执行 |
| Phase 4：MCP Client | completed | `5477f16`；官方 SDK stdio/SSE/Streamable HTTP、discovery、ToolRegistry bridge、权限/取消/重连、API/Web MCP 状态和 fixture 验证通过 |
| Phase 5：内部 Subagent / 多 Agent | pending | 等 Phase 4 MCP 和 Task contract 稳定 |
| Phase 6：A2A | pending | 等 Phase 5 parent/child lifecycle 稳定 |
| Phase 7：DSH Web 前端收敛 | in_progress | DSH 三栏 Web 垂直切片 + Workspace Picker + Workspace→Session 树 + Session mode/archive/delete；类型检查、API 测试、浏览器交互和真实 DeepSeek 只读工具 smoke 通过 |
| Phase 8：高级能力与产品化 | pending | 等前置阶段完成 |

## Phase 7 Web Coding 工作模式修复（2026-08-22）

Web 工作台现在支持 Session 级工作模式：新建 Session 可以选择 `read-only`、`ask-on-write`、`workspace-write`、`ask-on-execute` 和 `danger-full-access`，已有 Session 可以从 composer 的 Mode 菜单切换。权限模式已经进入 Session 事件与 projection，ToolRuntime 会按 Session 选择可见工具和执行策略。默认 `ask-on-write` 允许读操作自动执行，写入和命令执行需要确认。

验证：`pnpm typecheck`、`pnpm test` 和 Runtime 工作模式合同测试通过。该修复属于 Phase 7 Web 可用性收敛，同时补齐 Session/Permission contract 的实际入口。

## Phase 1 真实模型增强（2026-08-22）

Phase 1 的 provider-neutral adapter 现在已接入 API CLI 启动路径：通过根目录本地 `.env` 配置 `DEEPSEEK_API_KEY`，`MODEL_PROVIDER=auto` 会选择 DeepSeek；没有 Key 时保留 Echo fallback。默认模型为 `deepseek-v4-flash`，并可在 API/Web 中切换到 `deepseek-v4-pro` 或 `deepseek-v4-flash-vision-exp`。`.env`、`.env.*`（`.env.example` 除外）均被 Git 忽略，API health、事件和 Web 响应只展示不含凭据的 provider/model/configured 信息。fake-fetch API/LLM 测试已证明真实流式路径和 Authorization header 行为，Phase 1A.1–1A.3 的 tool-calling loop 以及 Phase 1A.6 的真实 DeepSeek Coding smoke 均已完成。

## Phase 1 状态校正（2026-08-22）

本次校正不是否定已完成的基础设施 checkpoint，而是把“产品可用”与“基础设施已存在”分开：

- `packages/tools` 已有 9 个内置工具，`ToolRuntime` 已有 schema、workspace、权限、取消、超时、输出预算和审计能力；
- `packages/mcp-client` 已能发现并桥接外部工具；
- 第一批 `packages/contracts`、`packages/llm` 和 `packages/runtime` 已携带工具 schema、解析 `delta.tool_calls` 并执行 model → tool → model 循环；进程重启后的 pending approval/turn continuation 已在 Phase 1A.5 完成；
- 当前 `packages/tools/src/builtin.ts` 的工具池已经是 TypeScript 实现；旧 Python 工具实现已从工作树移除，新 Runtime 只使用 TypeScript 工具；
- 因此当前阶段目标改为 `Phase 1A：Agentic Core + TypeScript Tool Pool`，该目标现已通过工具调用层、Terminal、Plan/Todo、AskUser、权限恢复和真实垂直场景门禁；
- Phase 5 Subagent、Phase 6 A2A 和 Phase 8 高级能力的核心实现必须等待本门禁通过。

执行计划：[phase-1-agentic-coding-core.zh-CN.md](phase-plans/phase-1-agentic-coding-core.zh-CN.md)。

## Phase 1A 实现进展（2026-08-22）

本次 checkpoint 已完成 Phase 1A.1–1A.3 的第一批实现：

- `packages/contracts` 增加 provider-neutral tool call、tool result、tool schema、step event 和 content message 类型；
- `packages/llm` 请求会发送工具 schema，并解析 OpenAI/DeepSeek-compatible `delta.tool_calls`、参数增量和结束事件；
- `packages/runtime` 已能执行多 step model → tool → model 循环，工具结果会作为下一次模型上下文；
- permission ask 会暂停当前 turn，批准/拒绝后继续同一个 turn；
- 多工具上下文、tool-call replay 基础和 API/Web SSE step 事件订阅已补齐；
- 新增 LLM、Runtime、多 step、权限恢复和历史 tool context 测试。

## Phase 1A.4 P1 工具闭包（2026-08-22）

已完成并接入统一 ToolRuntime：

- `terminal_open/send/read/signal/close/list`：TypeScript 持久 terminal manager，按 Session + workspace 隔离 cwd、环境、进程、输出缓冲、增量读取和进程树终止；
- `delete_file`：workspace 内路径校验，默认移动到 `.agent-trash`，永久删除必须显式 `permanent=true` 并经过写权限审批；
- `git_log` / `git_show`：固定 workspace cwd、ref/path 校验、提交结构化解析和输出预算；
- `ask_user`：`interaction/requested` / `interaction/resolved` 事件、API answer endpoint 和 Agent Loop 暂停/恢复；
- `plan` / `todo_write`：`plan/updated` / `todo/updated` 全量 projection 事件，刷新、SSE 和回放不依赖内存镜像；
- Web 已增加 interaction card 和回答控件，P1 事件进入 SSE 订阅。

验证证据：`packages/tools` 20 项测试、`packages/storage` 7 项测试、`apps/api` 11 项测试覆盖 terminal 生命周期、删除审计、Git 读取、interaction resume 和 projection replay。

当时尚未完成的真实 DeepSeek `read → edit → approve → test` smoke 已在 Phase 1A.6 完成；Phase 1A.5 的 permission preset、模型工具过滤、MCP 统一管线和恢复整合均已完成。

## Phase 1A.5 权限与恢复整合（2026-08-22）

已完成：

- `read-only`、`workspace-write`、`ask-on-write`、`ask-on-execute`、`danger-full-access` 五种 permission preset；
- 模型发现阶段过滤 deny 工具，执行阶段再次进行 policy 校验；内置工具和 MCP 工具继续共享 ToolRuntime、审计、取消和输出预算；
- SQLite/InMemory 事件回放后，pending permission 可在新 `AgentHost` 中恢复，并在所有审批解决后继续原 turn；重复批准/拒绝/取消保持幂等；
- `PermissionProjection` 保留 `turnId`，确保 pending approval 能关联到 interrupted turn；
- 新增 `terminal/session` 事件。重启后最近仍为 `running` 的终端只恢复元数据并标记为 `interrupted`，`terminal_list` 可展示该状态，发送输入不会伪造旧进程；
- `waitForTurn` 等待真实 `turn/ended`，避免取消或重启恢复时因中间 `agent/status` 事件提前返回。

验证证据：`packages/tools` 22 项测试、`packages/runtime` 9 项测试覆盖 preset、模型工具过滤、pending approval restart、terminal interrupted replay、取消和幂等恢复。

## Phase 1A.6 真实 Coding 垂直切片（2026-08-22）

已使用真实 DeepSeek 配置完成隔离 workspace smoke：

- API health 确认 provider 为 `deepseek`、模型为 `deepseek-v4-flash`，只返回脱敏配置状态；
- Agent 先调用 `read_file`，通过 `ask_user` 请求用户确认，再生成 `edit_file`；
- 用户批准 `edit_file` 写权限后，Agent 调用 `run_command` 执行 `node fixture.js`，返回修改后的 stdout 和 exit code 0；
- Agent 调用 `git_diff` 并返回单行 diff 总结；
- 通过事件 JSON replay 检查 `tool/*`、`interaction/*`、`permission/*`、`diff/preview`、`step/*` 和 `turn/ended`，未发现 API key 或 Authorization 内容。

该 smoke 证明真实 provider 已能驱动本项目的 model → tool → approval → tool → summary 闭环；自动化测试仍保持 fake/local model，不依赖网络或真实凭据。

## Phase 1A 退出后的 System Prompt 行为强化（2026-08-22）

本次更新没有扩大工具或协议范围，而是把现有 AgentHost 的短字符串 prompt 重构为可测试的 section builder：

- 明确 Coding Agent 的任务目标和 `理解 → 检索 → 计划 → 修改 → 验证 → 总结` 工作循环；
- 每个 turn 注入真实 workspace、经过 ToolRuntime policy 过滤的可见工具及风险/审批/调度元数据；
- 增加 read-before-edit、保留用户修改、搜索后断言、失败诊断、权限不可绕过和完成前验证规则；
- 把仓库内容、命令输出、工具/MCP 结果视为不可信数据，避免 prompt injection 改写运行规则；
- 对重启审批恢复 turn 增加 recovery section；自定义 `systemPrompt` 只能追加低优先级应用指令，不能覆盖安全基线；
- 明确不宣称当前尚未实现的 Subagent、A2A、LSP、Worktree、Web Search、Skills、上下文压缩和图像/Notebook 能力。

实现与设计说明见 [system-prompt-design.zh-CN.md](system-prompt-design.zh-CN.md)。

验证证据：`packages/runtime` 11 项测试覆盖 workspace/tool-use contract、动态工具过滤、自定义指令和 recovery prompt；全 workspace `pnpm typecheck` 与 `pnpm test` 作为本次 checkpoint 门禁。

## Phase 1A.0 迁移边界收尾（2026-08-22）

新增 [工具迁移矩阵](tool-migration-matrix.zh-CN.md)，明确 DSH/Claude Code 行为参考、P0/P1 工具的 source/risk/execution/approval/workspace contract，以及行为 fixture 和安全回归索引。`packages/tools/src/behavior-fixtures.ts` 提供跨平台的 P0 contract fixture，新增 registry 对齐测试。

## Phase 4 验收证据

### 自动化检查

```text
pnpm typecheck   ✓
pnpm test        ✓
git diff --check ✓
```

Phase 4 新增证据：

- `packages/mcp-client`：5 项测试，覆盖真实 stdio 子进程、Streamable HTTP、配置 secret 脱敏、tools/resources/prompts discovery、namespace/schema bridge、MCP error、ToolRuntime approval/cancel、统一事件和断线重连；
- `apps/api`：9 项测试，覆盖 MCP server 配置、列表、disable/delete、`/v1/tools` 来源字段、真实模型适配注入、模型切换和既有 Session/工具回归；
- `apps/web`：MCP server 状态侧栏、Reconnect/Enable/Disable 操作、MCP tool 来源卡片和 `mcp/*` 事件回放；
- 连接失败只影响对应 server，MCP provider 可以全部关闭，内置工具和既有 Session 保持可用。

### Phase 4 退出条件对照

- 至少一个 MCP server 可配置、发现、调用、取消和重连：真实 stdio/HTTP fixture 与 ToolRuntime 测试通过；
- MCP 工具与内置工具共享统一审计和事件：`tool/*`、`permission/*`、`mcp/*` 事件及 API/Web 回放通过；
- 外部工具不能绕过权限、超时、取消和输出预算：MCP approval/error/cancel 测试通过，默认未知 MCP 风险为 `network` 并由本地 policy 拒绝；
- 关闭所有 MCP provider 不影响现有功能：无 MCP 配置的 API/runtime 全量回归通过。

## Phase 2 验收证据

### 自动化检查

```text
pnpm typecheck   ✓
pnpm test        ✓
```

Phase 2 新增证据：

- `packages/storage`：SQLite schema migration、事务追加、projection 重建、跨 reopen 持久化、进程重启 interrupted 标记、命令幂等、并发 sequence 和 fixture replay；
- `packages/runtime`：单 Session queue、重复 send/cancel/resume/fork command、queued turn 恢复和取消；
- `apps/api`：SQLite 默认持久化、`after_sequence`/`Last-Event-ID` SSE、resume/fork、Idempotency-Key、API 进程重启历史恢复；
- 进程级 smoke：关闭并重启 API 后保留 Session、两条消息和完整 event sequence。

### Phase 2 退出条件对照

- 进程重启后 Session 历史完整：通过 SQLite API restart smoke；
- 任意 sequence 断线后可以补发且不重复渲染：SSE historical replay、buffered live events 和 sequence 去重测试/实现；
- 重复 command 不产生重复副作用：storage/runtime/API idempotency tests；
- 中途取消、模型错误和客户端断开都有可解释事件：cancel/turn-ended、agent/error 事件和 SSE close handling；
- SQLite schema migration 和并发追加：SQLite migration 初始化及 concurrent append test；
- 从事件 fixture 重建的 projection 与 API 返回一致：`replayProjection` test 及启动 projection rebuild。

## Phase 1 验收证据

### 自动化检查

```text
pnpm typecheck   ✓
pnpm test        ✓
```

当前 workspace 测试覆盖：

- `packages/contracts`：branded ID；
- `packages/llm`：Echo stream、OpenAI-compatible SSE parser；
- `packages/storage`：monotonic sequence、projection、session isolation；
- `packages/workspace`：workspace path traversal；
- `packages/runtime`：streaming turn、event persistence、cancel；
- `apps/api`：health、Session、message、web shell、SSE replay。

### 人工/运行时 smoke

- Node API：`GET /health` 返回 TypeScript runtime；
- HTTP：创建 Session → 发送消息 → projection 出现 `Echo: ...`；
- SSE：历史事件按 sequence 回放，并在空闲连接发送 `: connected` heartbeat；
- Browser：页面显示 Session sidebar、composer 和 Connected 状态；发送消息后显示 user message、turn event 和 assistant response。

## Phase 1 的明确边界（历史记录）

已完成：

- TypeScript/Node.js monorepo；
- provider-neutral model interface 和 OpenAI-compatible streaming adapter；
- in-memory EventStore；
- AgentHost、Session、Turn、cancel；
- Node HTTP API、SSE 和最小 DSH 风格 Web Shell。

尚未实现且属于后续阶段：

- SQLite durable EventStore 和进程重启恢复（已在 Phase 2 完成）；
- 文件/终端工具、permission approval 和 diff；
- MCP、Subagent、A2A；
- 完整 DSH UI 组件闭包。
