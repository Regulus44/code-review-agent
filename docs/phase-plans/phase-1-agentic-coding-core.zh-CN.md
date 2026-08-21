# Phase 1：Agentic Coding Core（工具调用与真实 Coding Agent）

状态：`in_progress`（重新打开 Phase 1 的产品门禁）

## 1. 为什么重新校正 Phase 1

此前的 Phase 1 Web Shell checkpoint 已经证明 TypeScript/Node.js、Session、SSE、workspace picker 和 DeepSeek-compatible streaming 可以运行，但这不等于 Coding Agent 核心已经完成。

当前实现的真实边界是：

```text
用户消息 → 模型文本流 → assistant 消息
```

而本阶段必须达到：

```text
用户消息
  → 模型请求（包含工具 schema）
  → 模型 tool call
  → ToolRuntime schema/policy/approval/execute
  → tool result 回到模型上下文
  → 模型继续推理
  → 最终回答
```

旧 Python 原型中的工具位于 `src/code_review_agent/tools/`，只保留为行为和回归参考；当前 `packages/tools/src/builtin.ts` 已经是 TypeScript 初版。Phase 1A 不会把 Python 模块接回新 Runtime，也不会逐行翻译旧 Python，而是以现有 TypeScript `ToolDefinition`/`ToolRuntime` 为基线，按 DSH/Claude Code 的核心工具行为重新审计、补齐和测试。

本阶段同时解决两件事：先恢复正常的 model → tool → model 调用流程，再把文件、搜索、Shell、持久终端、计划、任务和用户交互等 Coding Agent 核心工具补齐到可用的 TypeScript 工具池。

## 2. 对照 DSH 和 Claude Code 的能力结论

| 能力层 | 当前项目 | DSH / Claude Code 的做法 | 本阶段结论 |
|---|---|---|---|
| 模型工具调用 | `ModelRequest` 只有 messages；只解析 text delta | 每一步都把工具 schema 发给模型，解析多 tool call，再把结果作为下一轮上下文 | P0，必须先完成 |
| 文件基础工具 | TypeScript 已有 9 个工具，但主要可由 API 直接调用；旧 Python 工具只作参考 | Read/Write/Edit/Glob/Grep 是模型第一层工具 | 接入 Loop，并按模型 UX 重新审计 |
| 命令执行 | 一次性 `run_command` / `run_tests` | Bash/Pwsh + 持久 Terminal session | P0 保留一次性命令；P1 增加 terminal session |
| 权限 | risk、auto/ask/deny、workspace、取消、审计已有 | permission mode、deny rule、工具过滤、审批暂停/恢复统一进入 Loop | P0 增加 preset、模型可见过滤、暂停恢复 |
| 计划与任务 | projection 有 Task 基础，但无模型工具闭环 | Plan/Todo/AskUser 是独立状态，可暂停 Agent | Phase 1A 增加 `plan`、`todo_write`、`ask_user` |
| 外部工具 | MCP discovery/bridge 已有 | MCP 工具与内置工具进入同一工具池 | P0 让 MCP 工具也能被模型调用，不能只停留在 discovery |
| 子 Agent | 尚未进入核心 Loop | Task/Subagent 有独立生命周期和权限边界 | P2，等待核心 Loop 稳定 |
| 高级能力 | 尚无 LSP、worktree、web、image/notebook | 作为扩展工具或产品化能力按需启用 | P2，不阻塞本阶段 |

DSH 作为运行时和 Web 信息架构主参考；Claude Code 作为工具 UX、权限模式和 Agent 行为参考。只重建本项目需要的行为，不复制第三方账户、CLI、遥测或商业服务。

## 3. 交付物

### 3.1 Tool-calling Contract

扩展 `packages/contracts`：

- `ToolDefinition`、`ToolCall`、`ToolResultMessage` 和内容 block 类型；
- `ModelRequest.tools`、`toolChoice`、最大调用数和最大 step 配置；
- `text_delta`、`tool_call_start`、`tool_call_delta`、`tool_call_end`、`done`、`error` 流事件；
- 多工具调用、参数增量、JSON 参数解析失败和未知工具错误的稳定表示；
- assistant/tool-call/tool-result 事件可以持久化、回放并重新构建模型上下文。

### 3.2 OpenAI-compatible / DeepSeek Adapter

- 请求中发送工具 schema、tool choice 和完整 message content blocks；
- 解析兼容 OpenAI/DeepSeek 的 `delta.tool_calls`、index、id、function name 和 arguments 增量；
- 支持文本与工具调用混合流；
- API 错误、截断参数、未知 tool call 和 malformed JSON 都转换为可恢复的 model error；
- 使用 fake fetch 做合同测试，使用真实 DeepSeek key 做一次受控 smoke，不把 key 写入事件、日志或响应。

### 3.3 Agent Loop

在 `packages/runtime` 实现明确的 turn/step 循环：

```text
turn/started
  → step/started
  → model request
  → text/tool call stream
  → tool execution（可能等待 permission）
  → tool result
  → step/ended
  → 下一步 model request 或 assistant/message
  → turn/ended
```

必须覆盖：

- 多 step 和最大 step 限制；
- 同一步内 parallel/exclusive 工具调度，结果按模型调用顺序回传；
- 用户批准、拒绝、取消后暂停的 turn 可继续或结束；
- tool timeout、model error、malformed tool call、unknown tool、用户 stop；
- SSE 实时展示文本、tool call、progress、permission、result 和最终消息；
- 事件重放后能够恢复正在等待权限或需要继续模型请求的 turn。

### 3.4 Coding Agent 核心工具集

工具池分为“必须由本项目 TypeScript 维护的安全基元”和“以后可通过 MCP 扩展的外部能力”。文件、workspace、进程、终端、审批、diff 和审计不能依赖 MCP server；GitHub、Issue、数据库、Slack、云平台等外部系统优先走 MCP。

#### P0：必须进入模型工具池

```text
read_file
glob
grep
edit_file
write_file
git_status
git_diff
run_command
run_tests
```

P0 必须全部由 TypeScript 实现并进入模型工具池。输入格式可以采用本项目自己的稳定 contract，但必须满足 DSH/Claude Code 的核心行为：schema 清晰、结果可被模型消费、写入返回 diff、命令返回结构化 stdout/stderr/exit code、所有调用经过统一权限和事件管线。

#### P1：核心 Coding Agent 体验补齐

```text
terminal_open
terminal_send
terminal_read
terminal_signal
terminal_close
terminal_list
delete_file
git_log
git_show
ask_user
plan
todo_write
```

其中持久 Terminal 优先于 Subagent，因为真实 Coding Agent 需要跨多次命令保持 cwd、环境和输出状态。

#### P2：扩展能力

```text
read_image
notebook_edit
lsp
web_fetch
web_search
skill
worktree
subagent
```

P2 只有在 P0/P1 稳定后按独立阶段实施，不得为了工具数量提前稀释 Agent Loop 的验收。

### 3.5 Permission Preset

保留现有 `read/write/execute/network` 风险级别和 `auto/ask/deny` 策略，同时增加面向 Coding Agent 的 preset：

```text
read-only
workspace-write
ask-on-write
ask-on-execute
danger-full-access
```

策略必须同时作用于内置工具、MCP 工具、terminal 和未来 Subagent，并把工具名、风险、workspace、caller、turn、输入摘要、审批原因和结果写入审计事件。模型看到的工具列表必须经过 deny/permission 过滤，不能只在执行时才拒绝。

## 4. Phase 1A 执行计划：Agentic Core + TypeScript Tool Pool

Phase 1A 是当前优先级最高的执行单元，必须同时交付 Agent Loop 和一组足以完成基础 Coding 的内置 TypeScript 工具。工具数量扩展不能脱离 Loop 单独堆积；每个新工具必须能被模型发现、调用、审批、执行、回传和回放。

### 1A.0：迁移边界和工具清点

- [x] 将 `src/code_review_agent/tools/` 标记为 legacy/reference，不被新 Runtime import；
- [x] 为当前 TypeScript 9 个工具建立行为 fixture、输入/输出快照和安全回归清单；
- [x] 对照 DSH `packages/fs`、`packages/shell`、`packages/terminal`、`packages/plan`、`packages/todo`、`packages/interaction` 与 Claude Code `packages/builtin-tools/src/tools` 建立工具映射；
- [x] 明确每个工具的 source、risk、executionMode、approvalMode、workspace 规则和模型可见结果；
- [x] 禁止直接复制无许可或与本项目边界不兼容的上游实现；只复用已登记、可追溯的行为模式或兼容代码。

详细矩阵、行为 fixture 索引和安全回归要求见 [tool-migration-matrix.zh-CN.md](../tool-migration-matrix.zh-CN.md)。

### 1A.1：Tool-calling Contract

- [x] 增加 tool call/content block 类型和事件 payload；
- [x] 增加 LLM stream part 和 `ModelRequest.tools`；
- [x] 增加单工具、多工具、混合文本、参数增量、错误和 tool result continuation 合同测试。

### 1A.2：DeepSeek/OpenAI-compatible Adapter

- [x] 请求中发送当前启用的 TypeScript 工具 schema 和 tool choice；
- [x] 解析 `delta.tool_calls` 的 index、id、function name 和 arguments 增量；
- [x] fake fetch 覆盖文本、单工具、多工具、混合流和 malformed JSON；
- [x] 真实 API 只做最小 smoke，不在自动测试中依赖网络或真实凭据。

### 1A.3：Agent Loop

- [x] 把 `AgentHost.runTurn` 从单次文本流改为 model → tools → model；
- [x] tool result 作为 `role=tool` 或等价 content block 回到下一次 request；
- [x] 增加 step lifecycle、max steps、unknown tool、duplicate call 和 malformed call 处理；
- [x] 同一步内按 `parallel`/`exclusive` 调度，结果按模型调用顺序回传；
- [x] permission pending 不能结束 turn，批准后必须恢复同一个 turn。

### 1A.4：内置 TypeScript 工具池

#### P0：先完成并接入 Loop

- [x] `read_file`、`glob`、`grep`：窗口、编码、忽略规则、输出预算和 workspace 边界；
- [x] `edit_file`、`write_file`：读取前置、旧内容校验、diff、覆盖策略和幂等；
- [x] `git_status`、`git_diff`：固定 workspace cwd、结构化结果和输出限制；
- [x] `run_command`、`run_tests`：argv 优先、超时、进程树终止、stdout/stderr/exit code 审计；
- [x] 每个工具都提供模型描述、JSON Schema、modelView、presentation 和错误 remedy。

#### P1：完成基础 Coding Agent 工具闭包

- [x] `terminal_open`、`terminal_send`、`terminal_read`、`terminal_signal`、`terminal_close`、`terminal_list`：维护独立 session、cwd、环境、输出缓冲和取消；
- [x] `delete_file`：workspace 内删除、默认 ask、可恢复/明确审计；
- [x] `git_log`、`git_show`：只读、结构化、输出预算；
- [x] `ask_user`：暂停当前 turn，等待用户回答后恢复；
- [x] `plan`、`todo_write`：写入事件和 projection，不能伪造已完成状态。

### 1A.5：权限、MCP 和恢复整合

- [x] 增加 `read-only`、`workspace-write`、`ask-on-write`、`ask-on-execute`、`danger-full-access` preset；
- [x] 模型看到的工具列表先经过 deny/permission 过滤，执行时再做最终校验；
- [x] 内置工具和 MCP 工具共享同一 Agent Loop、ToolRuntime、审计、取消和输出预算；
- [x] 补齐 tool-call replay、pending approval replay、terminal session replay 和 interrupted recovery；
- [x] 重复批准、拒绝、取消保持幂等。

实现边界：终端 session 只回放 `terminalId`、workspace、cwd、命令、状态和缓冲字节等元数据；Node 进程重启后将旧的 `running` session 标记为 `interrupted`，不会尝试恢复或伪造旧子进程。

### 1A.6：真实 Coding 垂直切片

状态：已完成（2026-08-22）。

使用真实 DeepSeek API（默认 `deepseek-v4-flash`）验收：

1. 创建并选择 workspace；
2. 用户要求修改一个真实文件；
3. Agent 自动调用 `read_file` / `grep`；
4. Agent 生成 `edit_file`，Web 显示 diff；
5. 用户批准写入；
6. Agent 调用 `git_diff` 和 `run_tests`；
7. Agent 返回总结；
8. 刷新/断线后仍能看到完整 tool trajectory。

验收记录：使用本地 `.env` 的 DeepSeek 配置和隔离 workspace 完成真实 smoke。模型实际调用 `read_file`、`ask_user`、`edit_file`、`run_command`、`git_diff`，用户分别批准交互和写入/执行权限；`node fixture.js` 返回修改后的字符串，事件 replay 保留 tool、interaction、permission、diff、step 和最终 summary，事件内容未包含 API key。

## 5. 测试和退出门禁

必须通过：

- `pnpm typecheck`；
- `pnpm test`；
- LLM 合同测试：tool schema、SSE tool call、tool result continuation；
- Runtime 测试：至少两步、并行工具、权限暂停/恢复、取消、超时、模型错误；
- 安全测试：workspace 越界、命令注入、工具 deny、MCP 权限绕过、输出预算；
- API/SSE 测试：tool call、permission、result、resume 的事件顺序和 replay；
- 真实 DeepSeek smoke：完成一次 `read → edit → approve → test → summary`。

在以上门禁全部通过前：

- 不得声称“Coding Agent 核心已完成”；
- 不进入 Subagent/A2A/复杂 Worktree 的核心实现；
- Web UI 只能展示后端真实事件，不能用静态假数据模拟工具成功。

## 6. 不包含

- 不修改根目录 `AGENTS.md`；
- 不恢复旧 Python Runtime 作为后端底座；
- 不复制 DSH/Claude Code 的完整仓库、CLI、账户、遥测或商业 provider；
- 不在本阶段实现 Subagent、A2A、LSP、Worktree、复杂 Web Search 或完整 Plan UI；
- 不因为已有 MCP discovery 就把 MCP 误判为“模型已经能调用 MCP 工具”。

## 7. 回滚点和后续入口

每个 1A.0–1A.6 子步骤使用独立提交，任何步骤失败都能回滚到当前已通过的 Web Shell/ToolRuntime checkpoint。Phase 1A 退出后，Phase 2–4 的基础设施可以保留，但后续 Phase 5 Subagent、Phase 6 A2A 和 Phase 8 高级能力必须以本计划的真实 Coding 垂直场景通过为前置条件。
