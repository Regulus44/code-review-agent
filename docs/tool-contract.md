# 工具契约

内置工具、MCP 工具和未来的 Subagent 工具都进入同一个 ToolRegistry。Agent Loop 不区分工具来源，只依赖统一的定义、权限和结果类型。

模型侧的工具描述由 `ToolDefinition` 映射为 provider-neutral 的 `ModelToolDefinition`：

```ts
type ModelToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
};
```

每次模型请求都可以携带当前经过权限过滤的工具列表。模型返回的 tool call 先在模型适配层解析为稳定的 `id`、`name` 和 JSON `arguments`，再交给 `ToolRuntime`；执行后的 `ToolResult.modelView` 以 `role=tool` 或等价 content block 进入下一次模型请求。模型适配器不得直接执行工具，也不得绕过 `ToolRegistry`。

## ToolDefinition

```ts
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  executionMode: "parallel" | "exclusive";
  riskLevel: "read" | "write" | "execute" | "network";
  approvalMode: "auto" | "ask" | "deny";
  interruptBehavior: "cancel" | "block";
  source?:
    | { kind: "builtin" }
    | { kind: "mcp"; serverName: string; rawName: string };
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
  presentCall?(input: unknown): ToolPresentation;
  presentResult?(result: ToolResult): ToolPresentation;
};
```

`ToolContext` 还提供两个受 Runtime 控制的协作入口：`appendEvent(type, payload)` 用于 `plan` / `todo_write` 这类 session projection 工具，`requestUserInput(input)` 用于 `ask_user`。工具不能自行写数据库、绕过 workspace 或直接操作 SSE；这两个入口最终仍由 ToolRuntime 追加事件。

MCP 工具使用 `mcp__<server>__<tool>` 的稳定 namespace；原始 MCP 名称只用于 wire call，不从 public name 反解析。`source` 只用于 API/Web 展示，执行仍由本地 ToolRuntime 负责。

## 统一执行流程

```text
discover
  → schema validate
  → workspace/policy check
  → approval (auto/ask/deny)
  → execute
  → progress
  → structured result
  → presentation
  → event append
```

任何工具都必须支持稳定的 `toolCallId`、超时、取消、错误 code、可选进度和结构化结果。MCP 工具不能因为来自外部 server 就绕过这些步骤。

每次调用和审批还必须绑定 `caller`、`sessionId`、可选 `turnId`、`toolCallId` 和 `workspaceRoot`。审批具有 `expiresAt`，过期后不能再执行副作用。

## 第一批内置工具

| 工具 | 风险 | 默认执行 | 关键安全规则 |
|---|---|---|---|
| `read_file` | read | auto | workspace 内 UTF-8 文本、1-based offset/limit、行号和继续读取提示 |
| `glob` | read | auto | 只返回 workspace 内确定性排序的匹配结果，限制数量并标记截断 |
| `grep` | read | auto | literal/regex、大小写、上下文行、路径、文件大小和输出限制 |
| `edit_file` | write | ask | 兼容 old/new；支持多段唯一替换、expectedHash、stale/conflict 和 unified diff |
| `write_file` | write | ask | `create`/`overwrite`/`append` 模式，兼容 `overwrite=true`，支持 expectedHash 和 diff |
| `apply_patch` | write | ask | 解析多文件 unified patch，支持 dry-run、hunk/context 校验、stale/conflict、create/update/delete 和 patchId |
| `reject_patch` | read | auto | 拒绝当前 host session 的 patch preview，只追加审计事件，不修改文件 |
| `rollback_patch` | write | ask | 按 patchId 比较 after-state 后回滚，不覆盖更新后的用户修改 |
| `git_status` | read | auto | 固定 cwd，结构化输出 |
| `git_diff` | read | auto | 限制输出，避免泄露 workspace 外内容 |
| `run_command` | execute | ask | argv 优先、超时、输出截断、进程树终止 |
| `run_tests` | execute | ask | 复用 command policy，记录 exit/stdout/stderr |
| `bash`（POSIX roster） | execute | ask | 显式 fresh shell、workspace cwd、stdout/stderr、timeout、取消；长任务可返回 job id |
| `pwsh`（Windows roster） | execute | ask | 显式 PowerShell、native cwd/环境语义、非交互约束、exit/timeout/cancel |
| `job_output` | read | auto | session/workspace 归属、增量输出、状态、truncated/spill 边界 |
| `job_kill` | execute | ask | 只终止当前 session 的 background job，记录取消和最终状态 |
| `job_retry` | execute | ask | 仅使用 durable executable/args 元数据创建 bounded replacement attempt；原失败保留审计 |
| `job_list` | read | auto | 只列出当前 session/workspace 的 job 元数据 |
| `terminal_open` | execute | ask | 独立 session、固定 cwd、argv 或受控 shell、输出缓冲；生命周期写入 `terminal/session` |
| `terminal_send` | execute | ask-on-execute | 只能写入当前 session 的 terminal，不能跨 workspace |
| `terminal_read` | read | auto | 增量读取、等待上限和输出预算 |
| `terminal_signal` | execute | ask | 仅允许 SIGINT/SIGTERM/SIGKILL，并终止进程树 |
| `terminal_close` | execute | ask | 关闭进程并保留审计摘要 |
| `terminal_list` | read | auto | 只列出当前 session/workspace 的 terminal；重启遗留进程显示 `interrupted` |
| `delete_file` | write | ask | 默认移动到 `.agent-trash`，永久删除必须显式确认 |
| `git_log` | read | auto | 固定 workspace cwd、提交数量和路径边界 |
| `git_show` | read | auto | 校验 ref、固定 workspace cwd、输出预算 |
| `ask_user` | read | auto | 追加 interaction 事件并暂停当前 turn |
| `plan` | read | auto | 全量写入可回放的计划 projection |
| `todo_write` | read | auto | 全量替换可回放的 todo projection |
| `create_goal` | read | auto | 创建带 success criteria/budget 的 durable goal |
| `update_goal` | read | auto | 只更新当前 session 已存在的 goal；`active`/`paused` 写入 `goal/updated`，终态写入 `goal/ended` |
| `get_goal` | read | auto | 读取当前 session 的 goal projection |
| `session_query` | read | auto | 只查询当前 session 的 bounded public events，不暴露 SQL |
| `read_image` | read | auto | 仅在 vision capability 可见时提供，先做 media/size/workspace 检查 |
| `lsp_diagnostics` / `lsp_definition` / `lsp_references` | read | auto | 只调用 host 配置的 LSP server，不接受任意 executable；transport 有生命周期、取消、消息/文档/stderr 预算和崩溃后一次重建 |
| `capability_status` | read | auto | 展示 Web/Skill/Subagent/Workflow 的显式开关和预算/depth/iteration 限制 |

Worktree 生命周期由 Host/API command 管理，不作为模型可任意调用的 Git shell 字符串：`createWorktree`、`attachWorktree`、`switchWorktree`、`cleanupWorktree` 都经过 workspace/repository 校验、command idempotency、dirty/conflict protection 和 durable `worktree/*` 事件。工具执行使用 Session 的 `activeWorkspaceRoot`（若存在），不能通过输入绕过仓库边界或删除主 worktree。

## 工具结果

```ts
type ToolResult = {
  ok: boolean;
  // 完整工具输出，进入 durable audit event
  output?: unknown;
  audit?: unknown;
  // 经过预算控制、可进入模型或 UI 的视图
  modelView?: unknown;
  error?: {
    code: string;
    message: string;
    remedy?: string;
  };
  diff?: {
    path: string;
    before: string;
    after: string;
  };
  usage?: {
    bytes: number;
    truncated: boolean;
  };
};
```

工具结果进入上下文前必须经过预算控制；完整 stdout/stderr、diff 和审计字段进入事件存储，模型只接收符合预算的视图。

文件编辑必须遵守以下不变量：

- `edit_file` 的每个 replacement 必须唯一匹配；任一段失败时不写入任何段；
- `expectedHash` 与当前内容不一致时返回 `EDIT_STALE`；读取后到写入前检测到变化时返回 `EDIT_CONFLICT`；两者都保留当前文件，不覆盖用户修改；
- 成功的编辑/写入结果包含 before/after hash、结构化操作状态和 bounded unified diff，并追加 `diff/preview` 事件；
- `write_file` 默认是 create，覆盖和删除仍受审批；append 只追加用户明确提供的内容。

多文件 patch 必须遵守以下不变量：

- parser 先校验 file header、hunk 行数和 workspace-relative path，再读取任何目标；绝对路径、盘符路径、路径穿越和重复目标均拒绝；
- preview 阶段先读取所有 base，`expectedHashes` 或 hunk/context 不匹配时一个文件都不写；
- apply 过程中任一目标写入失败，runtime 尝试恢复本批 before-state；rollback 还要验证每个目标仍匹配记录的 after-state；
- `patch/preview`、`patch/applied`、`patch/rejected`、`patch/rolled_back` 是审计事实，完整 snapshot 位于 `.agent-artifacts/patches/<patchId>.json`，reject 不伪造 apply，rollback 不删除历史。

LSP 只读工具必须遵守以下不变量：

- server command 和参数来自 host 配置，工具输入只能选择已配置 serverId 与 workspace-relative 文件；
- JSON-RPC request 取消要发送 `$/cancelRequest` 并产生 `lsp/request` 状态，超时、取消、协议错误和 server crash 使用不同 code；
- transport 对单消息、header、文档和 stderr 都有界；server crash 后下一次请求最多重建一次 transport，不能无限自动重试；
- LSP 只能返回只读观察，任何写入必须回到 edit_file/apply_patch/permission 管线。

工具事件的 `tool/call` payload 包含 call presentation；结果优先使用工具自己的 `presentResult`，否则使用结构化 `ToolResult.presentation`。完整 audit 与有界 model view 分离。

进程工具的 `audit` 至少记录 `stdout`、`stderr`、`exitCode` 和终止 signal。取消或超时必须终止进程树，而不仅是顶层 shell/child process。

`bash` 和 `pwsh` 是显式 shell 工具：每次前台调用使用 fresh shell，`workdir` 由 workspace resolver 解析，shell 字符串不会进入默认 `run_command` argv 接口。`pwsh` 使用非交互、无 profile 启动，并注入受控 LanguageMode 约束；环境变量使用 PowerShell 原生 `$env:NAME` 语义。长任务通过 `run_in_background` 返回 `jobId`，后续只通过 `job_output`/`job_kill`/`job_retry`/`job_list` 操作，job 状态和输出通过 `job/started`、`job/output`、`job/ended` 事件审计。`job/started` 可携带 bounded executable/args、attempt/maxAttempts 和 deadlineAt；不得写入环境变量或凭据。deadline、调用方取消和 host shutdown 必须在最终 job error/status 中可区分。

### 平台 shell roster

内置工具组装按宿主平台固定选择一个 shell：

| 宿主平台 | 注册并暴露给 Agent 的 shell | 启动方式 |
|---|---|---|
| `win32` | `pwsh` | 解析 `CODE_REVIEW_AGENT_PWSH`、PowerShell 7 默认目录、PATH 和 Windows PowerShell 5.1，使用 `-NoLogo -NoProfile -NonInteractive -Command` |
| `linux` / `darwin` / 其他 POSIX | `bash` | 使用 `bash -lc` |

未选中的 shell 不进入 `ToolRegistry.list()`、`ToolRuntime.listTools()`、模型 schema 或工具 Prompt。直接查找未注册 shell 时，`ToolRegistry` 抛出 `ToolNotFoundError`，稳定错误码为 `TOOL_NOT_FOUND`；AgentHost 的模型工具调用边界会将该错误记录为失败的 `tool/result`。系统不会把 Bash 文本转换为 PowerShell，也不会把 PowerShell 文本转换为 Bash 或 `cmd.exe`；Windows 应用别名的存在不代表 WSL `/bin/bash` 可用。

## 调度与禁用

- `parallel` 工具可以并行执行；`exclusive` 工具在同一 Session 内串行；
- 批量工具默认在一个兄弟调用失败时取消仍在运行的兄弟工具；
- ToolRegistry 支持 enable/disable，禁用工具仍保留定义和历史事件，但不会被发现或执行。
- permission preset 在模型发现阶段过滤 deny 工具，在执行阶段再次校验；重启恢复的 terminal 只恢复摘要，不恢复不存在的进程。
