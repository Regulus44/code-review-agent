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
session/model_selected
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
skills/change
```

`skills/change` is a bounded invalidation lifecycle event. Its payload is `{ version: 1, revision, reason, provider?, scope? }`; S3 workspace mutations may additionally include `{ pathCount, paths }` where paths are at most 32 workspace-relative entries capped at 512 characters each. It never contains SKILL.md正文, absolute paths, prompt text, credentials or provider error details. Consumers refetch their own cwd/scope catalog and may safely ignore unknown reasons. A registry invalidation is not a successful Skill invocation and must not create a tool/result event.

`step/started` / `step/ended` 标记一个 turn 内的模型请求和工具执行边界。`assistant/message` 的 payload 可以包含 `toolCalls`，每个元素至少包含 `id`、`name` 和 JSON `arguments`；后续 `tool/result` 通过 `toolCallId` 关联到该调用。`plan/updated` 是当前实施计划的全量替换事件，`todo/updated` 是当前待办列表的全量替换事件。`interaction/requested` / `interaction/resolved` 表示 `ask_user` 暂停和恢复，不等同于工具权限审批。工具、权限、交互和 queue 事件都必须经过同一事件存储和 SSE 回放管线。

`user/message` 的 payload 至少包含 `content`。Host 生成的模型可见提示可以复用该事件并附带可选 `source`，例如 DSH-style 重复工具调用提醒：`{ kind: "plugin", plugin: "repeat-tool-reminder", form: "notice", summary: "<tool> × <count>" }`。这类 notice 必须在触发它的 `tool/result` 之后追加，重放时按 Session `sequence` 作为普通 user message 提供给模型；它不改变原始 `tool/result`，也不新增事件类型。观察 hash 和重复调用计数属于 host 内存状态，不从事件日志恢复。

Credential metadata 是 Phase 8.5 的 control-plane 配置事实，不属于 Session event 集合。`CredentialRecord` 只保存 tenant、kind、状态、版本和时间；secret material 只能存在 host-owned resolver 中，不能写入 EventStore、SQLite metadata、route、MCP config、SSE、diagnostics 或 Web projection。model route 的实际使用仍通过所属 Session 的 `turn/started` 或恢复 `agent/status` bounded metadata 记录；credential create/rotate/revoke/delete 本身不伪造一条 Session event。rotation 递增 credential version，旧 reference 必须 fail closed；revocation 要先停止可控的 live consumer，随后清除或标记不可用的 route。

P8.5-MR0 为后续 provider/model routing 追加了 `ModelSelection`、`ModelCatalogEntry`、`ResolvedModelInfo` 与 `PreparedModelRoute` 公共类型。前两者和解析结果不携带 credential material；`PreparedModelRoute` 是执行期对象，不能写入事件、projection、SSE 或 SQLite。Provider catalog 只用于展示和能力提示，不能作为路由的硬 allowlist。MR4 的 `session/model_selected` payload 为 `{ provider, model, reasoningEffort? }`，只保存无秘密的 Session 选择；`turn/started` 或恢复 `agent/status` 同时记录当次不可变 route snapshot，后续 model/provider 切换不得改变已启动 Turn。旧事件和 tenant `ModelRouteRecord` 在没有 Session 选择时继续保持兼容回退。

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

M10 增加 `context/transcript_segment` 和 `context/session_restored`。前者保存 `{ version: 1, boundaryId, algorithmVersion, sourceSequence, headMessageId?, anchorMessageId?, tailMessageId?, createdAt }`，只作为 compact boundary 与完整 transcript 的 durable link，不保存消息正文。`headMessageId` 必须使用 EventStore append 返回的 `eventId`；Runtime-only 的 turnId/responseId 不能作为跨重启锚点。后者保存 `{ mode: "boundary" | "legacy", boundaryId?, algorithmVersion?, sourceSequence?, reason }`，表示本次 model view 恢复决定，不复制或修改 transcript。segment 缺 boundary、boundary ID 不匹配、head 缺失或 head 不在 transcript 中时，Runtime 必须回退完整 transcript，不猜测 sequence 或静默丢弃历史。

M11 增加 `context/session_memory_extraction_started`、`context/session_memory_extraction_completed`、`context/session_memory_extraction_failed` 和 `context/session_memory_extraction_cancelled`。started 保存 `{ initialized, sourceSequence, sourceMessageId?, trigger, lastExtractedTokens, toolCallsSinceLastExtraction, extractorSessionId, startedAt }`；completed 额外保存 `{ lastExtractedMessageId?, lastExtractedTokens, memoryChars, memoryUpdatedAt, completedAt }`；failed/cancelled 只保存 source metadata 与 bounded error。memory 正文只能进入 host-owned `SessionMemoryStore`，不得写入 EventStore、SSE、projection 或 Web diagnostics。`SessionProjection.contextSessionMemory` 由这些事件 replay 得到，running/queued 状态在 Host restart 后可重新排队；若 memory 已覆盖相同 source message id，host 追加幂等 completed receipt，不重复调用 extractor。

M12/M3 增加 `context/project_memory_loaded`、`context/project_memory_recalled`、`context/project_memory_stale`、`context/project_memory_incomplete` 和 `context/project_memory_disabled`。事件 payload 只允许保存 `scopeKey`、`entrypointName: "MEMORY.md"`、bounded `entrypointBytes`/`entrypointLines`、`truncated`、`topicCount`、`scanStatus`、`usingLastGood`、最多 5 个 `recalledTopicIds` 或 `staleTopicIds`、最多 8 个 `failedTopicIds`、`ignored`、有限 `reason` 和由 EventStore 生成的 sequence。`MEMORY.md` 正文和 topic 正文不得写入 EventStore、SSE、projection 或 Web diagnostics；正文由 host-owned `ProjectMemoryStore` 在当前 model view 中按需提供。`SessionProjection.contextProjectMemory` 由五类事件 replay 得到，InMemory 与 SQLite 使用相同 reducer。用户明确忽略 memory 或 adapter 读取失败时使用 disabled receipt；stale reference topic 不进入 model view。扫描不完整时可使用 adapter 提供的 last-good bounded manifest，并通过 `usingLastGood` 观察；没有 last-good 时 fail closed。

M13 的 `step/started` payload 可以携带 `contextBudget`、`contextWarning`、`tokenCount` 和 `modelRequestId`。其中 `tokenCount` 只允许 value、source、confidence、stale/exactAttempted 标志和有限 breakdown；`contextBudget` 只允许 provider/model capability、effective window、reserved output、四类 threshold、source 等无秘密字段；`contextWarning` 只允许 token usage、percent left 和 warning/error/auto-compact/blocking/predictive 布尔状态。Storage 将这些字段投影为 `SessionProjection.contextDiagnostics`，Web 优先消费该 projection。

M13 的 compact 事件（`context/compacted`、`context/microcompacted`、`context/session_memory_compacted`、`context/summary_compacted`、`context/compact_boundary` 及对应失败事件）可携带 `preCompactTokens`、`postCompactTokens` 和 `tokensSaved`。microcompact 通常只提供 `tokensSaved`；这些字段只表示 model-visible view 的 bounded 计数，不替代完整 transcript。recovery 事件可投影为最多 16 项 `{ status, attempt, errorClass?, transitionReason?, providerStatus?, lastSequence }`，用于诊断和回放，不允许客户端直接驱动恢复。

M13 事件和 projection 不得保存完整 prompt、transcript、工具原文、provider response body、credential、header 或 secret。旧事件缺少 diagnostics 时，客户端可以使用明确标记为 estimate 的兼容 ContextMeter；不能把本地估算冒充 provider usage。

M14 当前只暴露 `ContextCollapseCapability` 元数据，不追加 `context/collapse_*` 事件。capability 包含 version、enabled、`deferred/unavailable` status、bounded reason，以及 read-time projection、background collapse、overflow drain、snip 四项布尔 feature；不包含 prompt、transcript、工具结果、provider body、凭据或 workspace 内容。`deferred` 表示 Claude Code 集成点已识别但本地快照核心仍为 stub，`unavailable` 表示 host 没有暴露 capability。完整 collapse 事件只有在独立 ADR 接受算法和 replay contract 后才允许新增。

`worktree/*` 记录 Git worktree 的发现、绑定、切换、清理和失败。payload 至少包含 `{ id, repoRoot, path, status }`，可选包含 `branch`、`commit`、`sessionId`、`taskId` 和 bounded `error`。`worktree/switched` 还使 Session projection 的 `activeWorktreeId` 与 `activeWorkspaceRoot` 指向该 worktree；工具、权限和 system prompt 使用 active root，但主仓库 root 仍保留为 Session 的 `workspaceRoot`。清理必须先检查 dirty/conflicted 状态，除非显式 force，否则不能删除未提交修改；主仓库 worktree 永远不能被清理。

MCP 生命周期事件只携带 `serverName`、状态、动作和脱敏错误；env/header/token 等配置秘密不得进入 payload。MCP 工具调用本身仍使用公共 `tool/*` 和 `permission/*` 事件。`mcp/resource` / `mcp/prompt` 只记录 server、资源 URI 或 prompt name、动作、bounded bytes/truncated 和 trust marker，不记录远端原始内容。

`turn/steered` 表示用户向当前运行中的 turn 追加一条指导。payload 至少包含 `{ content, receiptId, status: "accepted" }`，并通过 `correlationId` 关联幂等 command。该事件先落盘，再注入下一次模型请求；它不会覆盖原始 `user/message`，回放时作为同一 turn 下的独立 user message。非运行中的 turn 返回 `accepted: false`，不追加 steer 事件。

`attachment/received` / `attachment/rejected` 记录浏览器上传的文件 receipt，不记录 base64 或原始内容。payload 是 `AttachmentReceipt`：包含 attachment id、原始文件名、归一化 MIME、字节数、`file`/`image` kind、状态、workspace-relative artifact path 或结构化拒绝 code/reason。上传必须先通过 host capability、大小、类型、workspace 和 symlink 检查，再写入 `.agent-artifacts/attachments/`；重复 command 返回同一 receipt。

`workspace/reordered` 是由 host 持久化的 Workspace → Session 导航顺序快照，payload 为 `{ order: string[] }`，其中每个值是归一化 workspace key。事件挂在 host 选定的 workspace anchor Session 上，API/Web 只能提交包含当前 workspace 集合的完整顺序；启用 tenant scope 时 payload 还包含 `tenantId` 与 `principalId`，回放只在相同 tenant 的 Session catalog 中生效。重复 command 返回同一 `WorkspaceCatalog`，Session Conversation projection 忽略该导航事件，刷新和重启通过事件重建顺序。

`workspace/updated` 是 host 持久化的 Workspace 生命周期快照，payload 至少包含 `{ key, action, updatedAt }`，可选字段为 `label`、`archived` 和 `deleted`。Workspace 仍以 Session 的 workspace root 为物理边界；更新事件会追加到该 workspace 的非删除 Session，以便任一存活 Session 的历史都能重建 label、归档和软删除状态。启用 tenant scope 时 payload 还包含 `tenantId` 与 `principalId`，更新只追加到该 tenant 的成员 Session，回放不得跨 tenant 合并元数据。删除只隐藏导航元数据，不删除 Session、文件或 EventStore 历史。重复 rename/archive/delete command 必须幂等，Conversation projection 忽略该导航事件。跨租户 Workspace 查询和 mutation 必须返回统一 404，避免泄露 Workspace 存在性。

MCP config 的 durable record 可选包含 `tenantId`；schema v4 的 `mcp_server_configs.tenant_id`、`owner_id`、scope/binding、scrubbed `config` 和 credential reference 共同构成恢复边界。未认证本地 MCP catalog 只显示 legacy unscoped configs；authenticated API 只显示调用者 tenant 的 configs，`get/catalog/resource/prompt/enable/disable/reconnect/delete` 对其他 tenant 统一返回 404。MCP tool definition 的 `source` 带有可选 `tenantId`，ToolRuntime 在发现、model-visible tool list 和 execute 阶段再次检查 tenant，拒绝越权调用并追加 bounded `tool/call`/`tool/result` 审计；credential material 永不进入事件或 SQLite config。

Tenant model route 由 schema v5 的 `model_routes` durable backend 保存，键为 `tenantId`，记录 `provider`、`model`、可选 `baseUrl` 和 opaque `credentialRef`；credential material 不属于该记录。`GET/POST /v1/models` 在认证请求下只读取或更新调用者 tenant 的 route，跨租户 route 不出现在 catalog、capability 或 route receipt 中。route 选中后，`turn/started` 与重启恢复追加的 `agent/status` 会携带 provider/model 以及可选 baseUrl/credentialRef，供 replay、审计和后续诊断使用；payload 不得携带 API key、header、env 或其他 secret value。若持久 route 存在但 host 没有对应 model selector，恢复必须 fail closed；tenant mutation 在没有 durable routing backend 时返回配置错误。

## 全日志统计 Projection（Phase 4）

`SessionProjection.stats` 是由完整 Event Store 折叠得到的 whole-log usage projection；history page 只承载当前 Web 窗口，不能作为全局统计来源。统计 contract 包含 `version`、`sourceSequence`、`complete`、`latestPrompt`、turn/step/tool 数量、turn/LLM/tool duration、TTFT、provider token usage、total tokens、generation speed、cache hit 和当前 Session status。

Storage 的 `baseProjection` 初始化 version `1` 的 stats，`applyEvent`/`replayProjection` 在每个 sequence 上使用公共 `reduceSessionStats` 更新；SQLite reopen 会从完整 events 表 rebuild，因此 projection、InMemory replay 与 SQLite 冷启动保持一致。为支持高 sequence tail replay，stats 同时保存受限的内部 fold cursor（turn/step/tool start time），不保存 prompt 之外的 transcript 或 provider secret。

Web `SessionStore` 只将 stats 作为服务端全日志 baseline，并在无 gap 的实时高 sequence 事件上调用同一 reducer；prepend older history 不重复累计 stats。`sourceSequence` 必须单调，`complete=false` 只用于没有服务端 whole-log baseline 的旧 projection 兼容回退；usage presenter 在 projection 缺失时明确说明统计只覆盖当前窗口。

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
- `skill/invocation` 与 `skill/result` 仅记录 Skill 名称、调用模式、调用方和正文字节数；Skill 正文不得进入 EventStore/SSE。catalog digest 在每次 model context assemble 时可重建。

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
