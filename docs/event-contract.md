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
user/message
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

`terminal/session` 记录持久终端的元数据生命周期。payload 至少包含 `action`（`opened`、`signalled`、`exited`、`closed` 或 `interrupted`）、`terminalId`、`workspaceRoot`、`cwd`、`command` 和 `status`；它只记录可回放的会话摘要，不记录环境变量或完整 stdout。进程重启时，最近状态为 `running` 的终端必须追加 `interrupted` 事件并在 `terminal_list` 中显示为 `interrupted`，不得伪造一个仍然存在的子进程。

`job/started`、`job/output`、`job/ended` 记录显式 bash/pwsh background job 的归属、增量输出和最终 exit/signal/status。完整 stdout/stderr 持久化到 workspace 内 `.agent-artifacts/jobs/<jobId>.log`；事件中的 `text` 只允许 bounded live chunk，并携带 `spillPath`、`totalBytes` 和 `truncated` metadata。job payload 不得包含环境变量或凭据；job 只能由同一 session/workspace 通过 `job_output`、`job_kill` 和 `job_list` 访问。

`patch/*` 记录多文件 unified patch 的 preview、apply、reject 和 rollback 决策。完整 before/after snapshot 持久化到 workspace 内 `.agent-artifacts/patches/<patchId>.json`，payload 只携带 `patchId`、文件操作/哈希/统计和安全错误，不把未经预算的完整 patch 文本写入 model view；rollback 必须再次比较 after-state，不能覆盖更新后的用户文件。reject/rollback 成功后删除对应快照 artifact，但保留事件历史。

`lsp/server` 记录 host-configured LSP transport 的 started、initialized、crashed、restart_requested 和 disposed 生命周期；`lsp/request` 记录 initialize/diagnostics/definition/references 等请求的 started、completed、cancelled、timeout 或 failed。事件只保留 serverId、workspace、method、requestId、状态、错误 code、stderr 字节数等 bounded metadata，不写入原始 stderr、凭据或完整文档。

`goal/*` 记录 durable goal 的 title、successCriteria、status、budget/result/reason 和 last sequence；`get_goal` 只读取当前 session projection，`update_goal` 不允许凭空创建未知 goal。`job/*` 的完成状态和 bounded output 可以在 AgentHost 重启后由事件恢复；若原进程不再附着，恢复记录标记为 `orphaned`，不能继续 kill 或 send 一个虚构的进程。

MCP 生命周期事件只携带 `serverName`、状态、动作和脱敏错误；env/header/token 等配置秘密不得进入 payload。MCP 工具调用本身仍使用公共 `tool/*` 和 `permission/*` 事件。`mcp/resource` / `mcp/prompt` 只记录 server、资源 URI 或 prompt name、动作、bounded bytes/truncated 和 trust marker，不记录远端原始内容。

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
