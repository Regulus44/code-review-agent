# 事件契约

事件是 Session 的事实来源。内存状态、数据库 projection、SSE 和 Web UI 都由事件派生。

## Envelope

```ts
type AgentEvent = {
  eventId: string;
  sequence: number;
  schemaVersion: 1;
  sessionId: string;
  turnId?: string;
  type: AgentEventType;
  createdAt: string;
  correlationId?: string;
  payload: Record<string, unknown>;
};
```

`sequence` 在一个 Session 内严格单调递增。`eventId` 用于唯一标识事件，command id 单独写入 `commands` 表用于请求幂等；`schemaVersion` 只在 wire/durable 格式发生不兼容变化时递增。

## 第一版事件集合

```text
session/created
session/updated
workspace/updated
workspace/reordered
user/message
turn/steered
attachment/received
attachment/rejected
turn/queued
turn/started
step/started
step/ended
turn/ended
assistant/chunk
assistant/message
tool/call
tool/progress
tool/result
diff/preview
patch/preview
patch/applied
patch/rejected
patch/rolled_back
lsp/server
lsp/request
permission/requested
permission/resolved
agent/status
agent/error
queue/changed
task/created
task/updated
task/ended
goal/created
goal/updated
goal/ended
plan/updated
todo/updated
interaction/requested
interaction/resolved
terminal/session
job/started
job/output
job/ended
mcp/server
mcp/tool
mcp/resource
mcp/prompt
```

`step/started` / `step/ended` 标记一个 turn 内的模型请求和工具执行边界。`assistant/message` 的 payload 可以包含 `toolCalls`，每个元素至少包含 `id`、`name` 和 JSON `arguments`；后续 `tool/result` 通过 `toolCallId` 关联到该调用。`plan/updated` 是当前实施计划的全量替换事件，`todo/updated` 是当前待办列表的全量替换事件。`interaction/requested` / `interaction/resolved` 表示 `ask_user` 暂停和恢复，不等同于工具权限审批。工具、权限、交互和 queue 事件都必须经过同一事件存储和 SSE 回放管线。

`queue/changed` 的 payload 是当前 Session 尚未启动的队列快照：

```ts
{ queuedTurnIds: string[] }
```

数组顺序是唯一的队列顺序，`queuedTurnIds[0]` 将最先启动。事件不携带父 Session 之外的队列事实，也不允许客户端自行修改顺序；projection 可将该顺序投影为 `TurnProjection.queuePosition`。运行中的 turn 不出现在数组中。重排、取消、启动和重启恢复都必须通过该快照重建，重复命令仍由 command idempotency 保证。

`terminal/session` 记录持久终端的元数据生命周期。payload 至少包含 `action`（`opened`、`signalled`、`exited`、`closed` 或 `interrupted`）、`terminalId`、`workspaceRoot`、`cwd`、`command` 和 `status`；它只记录可回放的会话摘要，不记录环境变量或完整 stdout。进程重启时，最近状态为 `running` 的终端必须追加 `interrupted` 事件并在 `terminal_list` 中显示为 `interrupted`，不得伪造一个仍然存在的子进程。

`job/started`、`job/output`、`job/ended` 记录显式 bash/pwsh background job 的归属、增量输出和最终 exit/signal/status。完整 stdout/stderr 持久化到 workspace 内 `.agent-artifacts/jobs/<jobId>.log`；事件中的 `text` 只允许 bounded live chunk，并携带 `spillPath`、`totalBytes` 和 `truncated` metadata。`job/started` 可记录 bounded executable/args、attempt/maxAttempts 和 deadlineAt，供受控 retry/recovery 使用；不得记录环境变量或凭据。deadline、调用方取消和 host shutdown 通过结构化 error/status 保留。job 只能由同一 session/workspace 通过 `job_output`、`job_kill`、`job_retry` 和 `job_list` 访问。

Turn 的 `traceId` 在 `turn/started`、`agent/error` 和 `turn/ended` 边界中保持一致，用于有限的运行追踪和 recovery correlation；trace id 不携带凭据、prompt 内容或外部租户信息。

`patch/*` 记录多文件 unified patch 的 preview、apply、reject 和 rollback 决策。完整 before/after snapshot 持久化到 workspace 内 `.agent-artifacts/patches/<patchId>.json`，payload 只携带 `patchId`、文件操作/哈希/统计和安全错误，不把未经预算的完整 patch 文本写入 model view；rollback 必须再次比较 after-state，不能覆盖更新后的用户文件。reject/rollback 成功后删除对应快照 artifact，但保留事件历史。

`lsp/server` 记录 host-configured LSP transport 的 started、initialized、crashed、restart_requested 和 disposed 生命周期；`lsp/request` 记录 initialize/diagnostics/definition/references 等请求的 started、completed、cancelled、timeout 或 failed。事件只保留 serverId、workspace、method、requestId、状态、错误 code、stderr 字节数等 bounded metadata，不写入原始 stderr、凭据或完整文档。

`goal/*` 记录 durable goal 的 title、successCriteria、status、budget/result/reason 和 last sequence。状态为 `active`、`paused`、`completed`、`blocked` 或 `cancelled`；`active`/`paused` 追加 `goal/updated`，终态追加 `goal/ended`。Host 的 Web command 以 goal `lastSequence` 执行 CAS，并使用 durable command idempotency；冲突不得追加事件。`get_goal` 只读取当前 session projection，`update_goal` 不允许凭空创建未知 goal。`job/*` 的完成状态和 bounded output 可以在 AgentHost 重启后由事件恢复；若原进程不再附着，恢复记录标记为 `orphaned`，不能继续 kill 或 send 一个虚构的进程。

`context/compacted` 记录一次模型上下文压缩的 durable receipt：`sourceSequence`、bounded `summary`、原始/压缩后消息数、估算 token、丢弃数、受保护 tool 数和被 microcompact 的 tool result 数。`context/compaction_failed` 记录失败原因并保留原上下文，不能因为压缩失败而丢弃 pending permission、pending interaction、running task 或 tool-call/tool-result 边界。Web 只展示 receipt，不把摘要当作新的用户事实。

`worktree/*` 记录 Git worktree 的发现、绑定、切换、清理和失败。payload 至少包含 `{ id, repoRoot, path, status }`，可选包含 `branch`、`commit`、`sessionId`、`taskId` 和 bounded `error`。`worktree/switched` 还使 Session projection 的 `activeWorktreeId` 与 `activeWorkspaceRoot` 指向该 worktree；工具、权限和 system prompt 使用 active root，但主仓库 root 仍保留为 Session 的 `workspaceRoot`。清理必须先检查 dirty/conflicted 状态，除非显式 force，否则不能删除未提交修改；主仓库 worktree 永远不能被清理。

MCP 生命周期事件只携带 `serverName`、状态、动作和脱敏错误；env/header/token 等配置秘密不得进入 payload。MCP 工具调用本身仍使用公共 `tool/*` 和 `permission/*` 事件。`mcp/resource` / `mcp/prompt` 只记录 server、资源 URI 或 prompt name、动作、bounded bytes/truncated 和 trust marker，不记录远端原始内容。

`turn/steered` 表示用户向当前运行中的 turn 追加一条指导。payload 至少包含 `{ content, receiptId, status: "accepted" }`，并通过 `correlationId` 关联幂等 command。该事件先落盘，再注入下一次模型请求；它不会覆盖原始 `user/message`，回放时作为同一 turn 下的独立 user message。非运行中的 turn 返回 `accepted: false`，不追加 steer 事件。

`attachment/received` / `attachment/rejected` 记录浏览器上传的文件 receipt，不记录 base64 或原始内容。payload 是 `AttachmentReceipt`：包含 attachment id、原始文件名、归一化 MIME、字节数、`file`/`image` kind、状态、workspace-relative artifact path 或结构化拒绝 code/reason。上传必须先通过 host capability、大小、类型、workspace 和 symlink 检查，再写入 `.agent-artifacts/attachments/`；重复 command 返回同一 receipt。

`workspace/reordered` 是由 host 持久化的 Workspace → Session 导航顺序快照，payload 为 `{ order: string[] }`，其中每个值是归一化 workspace key。事件挂在 host 选定的 workspace anchor Session 上，API/Web 只能提交包含当前 workspace 集合的完整顺序；重复 command 返回同一 `WorkspaceCatalog`，Session Conversation projection 忽略该导航事件，刷新和重启通过事件重建顺序。

`workspace/updated` 是 host 持久化的 Workspace 生命周期快照，payload 至少包含 `{ key, action, updatedAt }`，可选字段为 `label`、`archived` 和 `deleted`。Workspace 仍以 Session 的 workspace root 为物理边界；更新事件会追加到该 workspace 的非删除 Session，以便任一存活 Session 的历史都能重建 label、归档和软删除状态。删除只隐藏导航元数据，不删除 Session、文件或 EventStore 历史。重复 rename/archive/delete command 必须幂等，Conversation projection 忽略该导航事件。

## 不变量

- 任何到达模型请求的输入，都能从 Session 事件重建；
- 任何工具调用都先产生 `tool/call`，再产生 `tool/progress` 或 `tool/result`；
- 需要用户决定的动作必须产生 `permission/requested`，结果必须产生 `permission/resolved`；
- `ask_user` 必须产生 `interaction/requested`，回答、取消或过期必须产生 `interaction/resolved`，并通过 `interactionId` 幂等；
- `plan/updated` 和 `todo/updated` 的 payload 必须是可回放的全量状态，不能只依赖内存镜像；
- `terminal/session` 必须能从事件重建终端元数据；重启后的 `interrupted` 状态不能继续发送输入或发送信号；
- `job/*` 必须保留 owner、workspace、状态和 bounded output 事实；job 控制不能绕过 ToolRuntime、权限或取消；
- permission 事件必须记录 caller、workspace、toolCall、创建时间和过期时间；过期、拒绝、取消都必须有 terminal tool/result；
- 事件先落盘，再推送 SSE；
- 重复发送消息、重复批准、重复取消必须幂等；
- 重复 steer command 必须返回同一个 receipt；只有当前运行中的 turn 可以接受 steer；
- 客户端可以用 `Last-Event-ID` 或 `after_sequence` 补发事件；
- 事件 payload 不直接暴露第三方仓库的内部类型。

## SSE 规则

```text
GET /v1/sessions/{sessionId}/events?after_sequence=42
Last-Event-ID: 42
```

服务端先发送 sequence 大于游标的历史事件，再订阅新事件。客户端按 sequence 去重；检测到 gap 时重新请求补发，不自行猜测状态。

## 回放测试

每个影响 model-visible 状态的功能必须提供事件 fixture，至少验证：

1. 从空 Session 回放到当前状态；
2. 在任意事件后断线并按 sequence 恢复；
3. 重复同一 command 不产生重复副作用；
4. 失败、取消和权限拒绝都能从事件解释。
