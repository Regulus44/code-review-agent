# MCP 与 A2A 演进执行计划

状态：`planned`（2026-08-23）

执行顺序：`Phase 4B MCP 加固 → Phase 5 内部 Task/Subagent → Phase 6 A2A Adapter`。

本计划承接已完成的 Phase 3B 和 Phase 4 MCP Client。目标是把 MCP 从“可连接、可发现、可调用”的集成能力提升为可持久化、可恢复、可审计、按作用域隔离的工具平台，再以稳定的内部 Task/Subagent contract 为基础增加 A2A 入站互操作层。

本计划不把 MCP、Subagent、ACP 和 A2A 合并成一个通用调用接口。每个协议继续经过本项目的 Session、Task、Permission、Workspace、EventStore 和 ToolRuntime 边界。

## 1. 参考优先级与 DSH 关注等级

### 1.1 参考优先级

1. 本项目的 Event、Tool、Task、Permission、Workspace contract；
2. DSH 的 TypeScript 分层、生命周期、事件和工具行为；
3. Claude Code 的配置、权限、远程控制和产品交互行为；
4. A2A 官方协议与兼容性测试；
5. 单个实现细节。

DSH 是本计划的主要架构参考。Claude Code 用于补充产品行为，A2A 官方协议负责外部线上的协议事实。Claude Code 本地快照没有作为默认代码复制来源，具体来源和许可证仍按 `docs/source-reuse-register.md` 处理。

### 1.2 DSH 关注等级

| 等级 | 含义 | 开发要求 |
|---|---|---|
| R0：必须对照 | 该部分决定本项目的运行时边界或恢复语义 | 开发前逐文件阅读 DSH 入口；实现时建立行为 fixture；PR 中列出对应差异 |
| R1：重点参考 | 该部分影响工具体验、可观测性或权限交互 | 对照输入/输出/失败路径；允许按本项目 contract 改写 |
| R2：辅助参考 | 该部分主要提供命名、UI 或实现提示 | 只吸收行为，不阻塞核心退出门禁 |

### 1.3 必须额外关注 DSH 的部分

以下部分属于 R0，不能只阅读 README 或凭印象实现：

| 领域 | DSH 入口 | 必须吸收的实现方法 |
|---|---|---|
| MCP server 生命周期 | `packages/mcp/mcp-client/src/index.ts`、`connection.ts` | 每个 server 独立实例、namespace reservation、generation、启动失败语义、dispose 和 bounded reconnect |
| MCP 工具同步 | `packages/mcp/mcp-client/src/tools.ts` | discovery 后完整构造新工具集合，注册失败时回滚，list-changed 不产生半套工具 |
| MCP transport | `packages/mcp/mcp-client/src/transport.ts` | stdio 环境清理、直接 argv、HTTP transport 生命周期、关闭顺序和进程回收 |
| Agent Loop 工具调度 | `packages/core/agent-loop/src/agent.ts`、`tool-calls.ts` | parallel/exclusive 分组、取消、兄弟失败、结果顺序和模型续接 |
| 内部 Subagent descriptor | `packages/subagent/subagent/src/descriptor.ts` | parent/child 身份、持久化描述符、workspace/tool scope 和 JSON 边界 |
| Subagent lifecycle | `packages/subagent/subagent/src/lifecycle.ts`、`continuation.ts` | one-shot 与 continuable 两类运行、Activation、inbox、冷恢复和 dispose 所有权 |
| Subagent 控制权限 | `packages/subagent/tool-subagent-control/src/index.ts` | `send_message` 与 `interrupt_agent` 的直接父级/祖先授权、取消幂等和消息投递语义 |
| ACP 流式桥接 | `packages/acp/acp/src/index.ts`、`codec.ts` | 程序化 Client 的 session、turn、审批、取消和流式编码边界 |
| Session/Event API | `packages/host/apiproxy/src/api/sessions.ts`、`events.ts` | session history、event mux、cursor replay、cold session 和恢复后的状态投影 |
| Prompt/工具目录 | `packages/core/system-prompt/src/index.ts`、`packages/core/tools/src/presentation.ts` | 有序 prompt section、工具目录生成、调用/结果 presentation 和动态能力过滤 |

R1 参考包括 DSH `packages/plan`、`packages/todo`、`packages/interaction`、`packages/goal`、`packages/session-query`、`packages/shell`、`packages/terminal` 和 `packages/client/ui-tool`。R2 参考包括 Claude Code 的 `packages/mcp-client`、`packages/remote-control-server`、`src/coordinator` 和 `src/utils/swarm` 的产品交互与错误呈现。

DSH 本地仓库没有完整 A2A server/client 实现。A2A 的外部 envelope、Agent Card、Task、Message、Artifact 和 streaming semantics 以 A2A 官方协议为准；DSH 的 ACP、Session/Event 和 Subagent 只负责提供内部骨架。

## 2. 当前基线与必须先解决的差距

### 2.1 当前 MCP 基线

当前入口：

- `packages/mcp-client/src/config.ts`：server 配置与脱敏视图；
- `packages/mcp-client/src/manager.ts`：连接、发现、注册、重连和事件；
- `packages/mcp-client/src/bridge.ts`：MCP tool 到 `ToolDefinition` 的转换；
- `packages/mcp-client/src/discovery.ts`：tools/resources/prompts discovery；
- `packages/mcp-client/src/adapters.ts`：resource/prompt 直接调用；
- `apps/api/src/server.ts`：MCP server 管理和 resource/prompt 路由。

Phase 4 已通过原有退出门禁，但下一阶段需要重点复核以下差距：

1. `McpConfigStore` 当前是内存 store，server 配置、scope 和启停状态尚未形成持久化事实来源；
2. secret 虽然脱敏，但缺少独立 credential reference、OAuth 生命周期和授权恢复；
3. resource/prompt 有直接 manager/API 调用路径，尚未完全进入与 tool 相同的 policy、审计和 artifact 管线；
4. MCP schema 转换必须覆盖更多 JSON Schema 组合，不能静默丢失模型约束；
5. server 事件与 Session scope 的映射需要复核，不能用全局广播替代授权投影；
6. tool generation 在 list-changed、重连和注册冲突时需要严格保证原子替换和旧 generation 清理；
7. MCP server description、tool description、resource 内容和 prompt 内容必须经过不可信输入边界处理；
8. server 级风险需要补充工具级覆盖、allowlist 和 capability policy。

### 2.2 当前 A2A 基线

当前仓库已有 Task projection 和协议边界文档，但没有完整的 `TaskService`、durable `SubagentService`、A2A adapter、Agent Card 或外部 Task API。因此 Phase 6 不能直接开始 HTTP endpoint 实现。

进入 A2A 前必须先完成：

- Task input/output/artifact/budget contract；
- parent/child Session 与 Task 生命周期；
- one-shot 与 continuable child 运行模式；
- 子 Agent 工具、MCP、workspace 和权限白名单；
- 取消、重试、等待用户输入和服务重启恢复；
- 报告与 artifact 的结构化投影。

## 3. 目标架构

```text
MCP Server
  ↓ tools/resources/prompts
McpConnectionSupervisor
  ↓ scoped generation + discovery catalog
McpTool/Resource/Prompt Adapter
  ↓
ToolRuntime / ResourceService / PromptService
  ↓
PermissionPolicy + WorkspacePolicy + EventStore
  ↓
AgentHost / TaskService
  ↓
Child Session / Subagent
  ↓
A2A Adapter（仅协议映射，不直接执行工具）
```

### 3.1 不可越权关系

| 请求 | 唯一路径 |
|---|---|
| Agent 调用 MCP tool | Agent Loop → ToolRuntime → MCP adapter → MCP server |
| Agent 读取 MCP resource | Agent/ResourceService → scope/policy → MCP adapter → artifact/model view |
| Agent 使用 MCP prompt | PromptService → trust boundary → prompt registry → Agent context |
| 父 Agent 委派子任务 | Agent Loop → TaskService → SubagentService → child Session |
| 外部 Agent 调用本项目 | A2A Adapter → TaskService → AgentHost/Subagent |
| 外部 Agent 请求写入或执行 | A2A Adapter → input-required/permission state；不能直接批准 |

A2A 不直接调用 `ToolRegistry.execute`、MCP server、文件系统、Shell 或 Terminal。MCP server 也不能直接创建 A2A Task。

## 4. Phase 4B：MCP 加固

### 4B.0：契约审计与 DSH 对照冻结

交付：

- MCP server、generation、tool/resource/prompt identity 的 contract；
- `scope → visible Session → visible tools/resources/prompts` 的规则；
- credential reference、audit redaction、capability policy 的 ADR；
- DSH R0 逐文件对照表和当前实现差异清单；
- hostile MCP fixture：恶意 description、超大 schema、重复 tool、list-changed 风暴和错误 transport。

**DSH 重点：R0。** 必须逐项对照 `index.ts` 的 server namespace reservation、`connection.ts` 的 reconnect/dispose/generation 和 `tools.ts` 的 registration failure 行为。此阶段只冻结 contract，不扩展运行时。

### 4B.1：持久化配置、作用域与凭据

交付：

- SQLite 中的 MCP server config、scope、enabled、revision 和 owner；
- secret store 或 credential reference，不把 token 写入事件、projection、日志和普通数据库字段；
- user/project/session 覆盖规则与可见性查询；
- API 幂等 upsert/delete/enable/disable；
- 重启后配置和 enabled 状态恢复。

**DSH 重点：R1。** 参考 DSH 的 per-plugin config、serverName reservation 和 loader 生命周期；本项目保留自己的 SQLite、API 和 tenant/workspace 边界。Claude Code 的 config/discovery 分层用于补充用户配置体验。

### 4B.2：连接 Supervisor 与 atomic generation swap

交付：

- 每个 MCP server 独立 supervisor；
- 新连接建立、握手、discovery、schema 校验和 tool registration 完成后才成为 active generation；
- list-changed 事件串行化、去抖和可取消；
- 重连指数退避、最大尝试、稳定窗口和最终 failed 状态；
- 旧 generation 的工具、进程和在途调用有明确的 quiesce/close 顺序；
- 连接失败不影响其他 server 和 built-in tool。

**DSH 重点：R0。** 这是本阶段最需要复刻行为的部分：`connection.ts` 的 `syncChain`、`isCurrent`、generation guard、close timeout、failed attempt budget 和 dispose 顺序都要建立对应 fixture。不能只实现“断线后 setTimeout 重连”。

### 4B.3：Schema、工具风险与 Prompt Registry

交付：

- lossless MCP JSON Schema contract；无法安全表达的 schema 显式降级并记录原因；
- tool annotation 解析为低信任 hint，server policy 可覆盖；
- server 默认风险 + tool 级 risk/approval/allowlist；
- MCP tool 使用 Phase 3B 的 ToolPromptRegistry fallback；
- tool catalog 显示 source、server、raw name、generation、risk、approval 和 disabled reason；
- MCP description 和工具结果都标记为不可信数据。

**DSH 重点：R0/R1。** R0 对照 DSH `packages/core/tools` 的 schema/presentation 分层与 `mcp-client/tools.ts` 的 public namespace；R1 对照 DSH system-prompt tool provider，确保动态工具只进入当前可见 prompt。Claude Code 的工具过滤和 description 截断作为补充。

### 4B.4：Resources、Prompts 与交互能力

交付：

- `resources/list/read`、resource templates、`prompts/list/get` 进入统一 service boundary；
- resource 内容通过 bounded artifact/model view 进入 Agent context；
- MCP Prompt 只能追加低优先级上下文，不能覆盖安全、workspace、permission 和 verification 规则；
- 未来 elicitation、sampling 等 server→client 请求先设计状态机，未经审批不启用；
- resource/prompt 调用有 timeout、cancel、audit、scope 和重放测试。

**DSH 重点：R1。** DSH 当前 MCP client 重点放在 tool plugin；因此这里要参考 DSH system-prompt registry、tool presentation 和 interaction contract 的边界，不能把远程 Prompt 当作完整 system prompt。A2A 不参与这一阶段。

### 4B.5：API/Web 与可观测性

交付：

- MCP server 设置页：scope、transport、状态、revision、授权、enable/disable/reconnect；
- discovery catalog、tool generation、last error、retry schedule、resource/prompt 状态；
- SSE 中按权限投影 `mcp/server`、`mcp/tool`、`mcp/resource`、`mcp/prompt` 事件；
- secret、authorization、cookie、MCP 原始敏感内容脱敏；
- server 级和 tool 级诊断可分别回滚。

**DSH 重点：R2/R1。** 参考 DSH `packages/client/ui-tool` 的 tool row/presentation 和 `packages/host/apiproxy` 的 event mux；Claude Code `packages/remote-control-server` 重点参考断线重连、控制请求和权限展示。

### 4B.6：Phase 4B 门禁

- stdio、SSE、Streamable HTTP 真实/fixture server；
- schema 组合、重复工具、list-changed、generation swap、重连耗尽；
- scope、重启、secret、OAuth/needs_auth、resource/prompt policy；
- MCP 与 built-in 工具的 permission/cancel/timeout/audit 统一性；
- 浏览器完成“添加 server → 发现工具 → 调用只读工具 → 断线 → 重连 → 恢复”；
- `pnpm typecheck`、`pnpm test`、`git diff --check` 和 MCP browser smoke。

Phase 4B 完成后才开放 Phase 5 的 MCP-aware Subagent。

## 5. Phase 5：内部 Task/Subagent

### 5.0：Task contract 与 durable projection

交付：

- `TaskId`、`ParentTaskId`、`SessionId`、`WorkspaceId`、owner、budget、toolScope、artifact manifest；
- `created → queued → working → input_required → completed/failed/cancelled/rejected` 生命周期；
- `task/created`、`task/updated`、`task/input-required`、`task/report`、`task/artifact`、`task/ended` 事件；
- SQLite 恢复、幂等 create/cancel/retry、SSE replay 和 projection rebuild。

**DSH 重点：R0。** 对照 DSH subagent descriptor、lifecycle、session persistence 和 task settlement，尤其关注身份的不可变性、parent/child 关系和 cold child 枚举。不得用内存 Map 作为 Task 事实来源。

### 5.1：One-shot Subagent

交付：

- `spawn_subagent` 支持 foreground 和 background 两种路径；
- foreground 返回结构化 `TaskReport`；
- background 返回 Task ID，后续由 task query/output/cancel 工具管理；
- child 只接收显式 prompt、workspace、tool allowlist、MCP allowlist 和 permission preset；
- child 失败、取消、token limit、refusal 和 partial output 都有稳定结果。

**DSH 重点：R0。** 逐项对照 `tool-subagent/src/index.ts` 的 foreground disposal、background Task、partial output、stop reason 和 provider capability 检查。Claude Code Task 工具只用于补充用户体验。

### 5.2：Continuable Child 与控制工具

交付：

- durable child Session 和单一 inbox；
- `send_message` 作为下一 turn 投递，不重定向当前进行中的 turn；
- `interrupt_agent` 只停止当前 turn，不销毁 child；
- ancestor/parent authority、depth limit、预算、取消传播和冷恢复；
- `list_agents` 只展示实际可恢复的 child，不能从 Task 历史虚构 Agent。

**DSH 重点：R0。** 必须对照 `continuation.ts`、`tool-subagent-control/src/index.ts` 和 `list-agents.ts` 的权限判断、inbox 排序、冷恢复和幂等中断语义。这里禁止简化成“共享父 Session + 一个 childId”。

### 5.3：MCP-aware Subagent

交付：

- child 的 MCP tool scope 显式继承或显式清空；
- 子 Agent 不能因为 parent 有 MCP 权限就自动升级；
- MCP connection failure、tool generation 变化和 child cancel 正确关联；
- parent report 只返回 MCP 结果摘要和 artifact 引用。

**DSH 重点：R0/R1。** R0 对照 DSH subagent provider capability、toolFilter、depthLimit 和 context inheritance；R1 对照 DSH tools/system-prompt 的动态 tool visibility。重点验证子 Agent 不继承父 Agent 的全部权限。

### 5.4：Phase 5 门禁

- 一个 parent 并行启动两个互不冲突的只读 child；
- child 使用 MCP 只读工具并返回结构化报告；
- child 写入需要独立 approval；
- depth/concurrency/time/token/tool/MCP budget 生效；
- parent、child、MCP、background job 取消不遗留 running 状态；
- 服务重启后 child catalog、Task 和报告可恢复；
- Web 展示 parent/child 树、状态、报告和 artifact。

## 6. Phase 6：A2A Adapter

### 6.0：A2A Server 边界

第一版只实现 inbound A2A server：外部 Agent 调用本项目。暂不实现 outbound A2A client，也不将 A2A 用作内部 Subagent transport。

交付：

- 独立 `packages/a2a` 协议 mapper；
- `apps/api` 中隔离的 A2A route 或独立 A2A host；
- 固定 A2A 目标版本、Agent Card、Task、Message、Artifact、JSON/HTTP/SSE contract；
- 外部 Task 与内部 Task/Session 的双 ID 映射；
- `Idempotency-Key`、`correlationId`、principal、tenant、workspace 和 quota context。

**DSH 重点：R0/R2。** A2A envelope 以官方规范为准；内部映射必须对照 DSH ACP codec、ACP approval/turn tests、Host API session/event mux。不要在 DSH 中寻找不存在的 A2A 实现，也不要把 ACP 名称直接当成 A2A。

### 6.1：Agent Card 与能力发现

交付：

- Agent Card 从静态产品能力、当前模型、可用工具类别和 auth requirement 生成；
- 不宣称被 permission preset、feature flag、scope 或 deployment policy 隐藏的工具；
- 明确支持的输入模式、streaming、task state、artifact、auth 和限制；
- Agent Card 版本和 capability hash 可审计。

**DSH 重点：R1。** 参考 DSH system-prompt/tool catalog、ACP descriptor 和 host API capability 组织方式；外部 capability 字段遵守 A2A 官方 contract。

### 6.2：Task/Message 映射

交付：

- 外部 task create/send/get/cancel/retry 的幂等路由；
- A2A Message 映射为 TaskService input 或 child Session user message；
- 内部 assistant、tool、permission、task、artifact 事件映射为有界 A2A updates；
- `input-required` 表示本地用户输入或审批等待，不能伪造成 completed；
- A2A stream 支持 cursor/replay、断线和服务重启恢复。

**DSH 重点：R0。** 重点对照 DSH `host/apiproxy` 的 session history、event mux、cold-session lookup、cancel 和 resume。A2A mapper 不直接读取工具内部状态。

### 6.3：Artifact 与安全投影

交付：

- artifact manifest：opaque ID、MIME、大小、hash、来源、过期时间；
- artifact 下载按 task ownership、tenant、workspace 和 principal 校验；
- 禁止把绝对路径、secret、完整 audit、原始授权 header 放进 A2A response；
- diff、测试结果、报告和日志用 artifact 引用或有界摘要外发。

**DSH 重点：R1。** 参考 DSH Session artifact/export 的持久化和边界处理；远程控制展示参考 Claude Code remote-control-server，协议字段仍由 A2A 规范决定。

### 6.4：认证、审批与取消

交付：

- inbound A2A principal → tenant/workspace/permission preset 映射；
- 未经本地授权，外部 Agent 不能批准写入、Shell、MCP OAuth 或任意 network action；
- 外部 cancel 传播到 Task、child turn、MCP tool、terminal/job；
- 认证失败、权限拒绝、配额耗尽和 workspace 越界使用稳定错误分类；
- rate limit、max task duration、artifact quota 和 concurrent task limit。

**DSH 重点：R0/R1。** R0 对照 DSH ACP approval tests、Subagent authority 和 interrupt；R1 对照 Claude Code remote-control-server 的 ingress auth、session ownership 和 permission control。不得用 HTTP 身份直接替换本项目 PermissionPolicy。

### 6.5：Phase 6 门禁

- 官方 A2A client fixture 能发现 Agent Card；
- 外部 Agent 完成一个只读仓库任务；
- 外部 Agent 完成一个需要本地审批的编辑任务，并正确进入 input-required；
- 外部 Agent 可查询、流式接收、取消、重试和恢复 Task；
- MCP tool、Subagent、permission、artifact 事件不泄露越权内容；
- 服务重启、SSE 断线、重复请求保持幂等；
- 关闭 A2A adapter 不影响 Web、MCP、内置工具和内部 Subagent。

## 7. MCP 与 A2A 交叉验收

必须同时验证以下边界：

1. A2A Task 只能使用本 Task 的 MCP allowlist；
2. parent 的 MCP approval 不能自动转移给 child 或外部 Agent；
3. MCP server 断线只能让相关 tool/task 进入可解释失败或等待状态；
4. A2A 断线只影响外部 stream，不终止内部 Task；
5. A2A stream 恢复使用 EventStore cursor，不重新执行 MCP tool；
6. MCP resource/prompt 内容不能覆盖 A2A、workspace、permission 和安全规则；
7. 外部 artifact 只能通过 A2A artifact service 读取，不能从 MCP result 泄露本地路径。

## 8. 阶段提交、回滚与文档门禁

| Checkpoint | 主要交付 | 独立提交建议 | 回滚方式 |
|---|---|---|---|
| 4B.0 | MCP/A2A contract、DSH 对照清单、ADR | `docs(mcp-a2a): define execution plan and reference gates` | 仅回滚文档 |
| 4B.1 | MCP durable scope/credential | `feat(mcp): persist scoped configuration` | 关闭 durable provider，保留旧 manager |
| 4B.2 | MCP supervisor/generation | `feat(mcp): add supervised generation swaps` | 禁用 reconnect generation，保留单次连接 |
| 4B.3 | MCP schema/policy/resource/prompt | `feat(mcp): harden catalog and content boundaries` | 关闭 resource/prompt 或回退旧 adapter |
| 4B.4 | MCP Web/OAuth/恢复测试 | `feat(mcp): add scoped auth and recovery ui` | MCP provider 全部 disable |
| 5.0–5.3 | Task、one-shot、continuable、MCP-aware child | `feat(task): add durable subagent lifecycle` | Subagent preset 关闭 |
| 6.0–6.4 | A2A Agent Card、Task mapper、stream、artifact、auth | `feat(a2a): add inbound task adapter` | 独立关闭 A2A route |
| 6.final | A2A + MCP + Subagent 联合 smoke | `test(a2a): verify mcp-aware task interoperability` | 保留上一通过 checkpoint |

每个 checkpoint 都必须同步对应 Phase 开发日志、`phase-status.zh-CN.md`、contract/ADR 和测试证据，然后立即 commit。未提交的阶段性更新不能标记为完成。

## 9. 明确不进入本轮的内容

- outbound A2A client；
- A2A 直接替代内部 Subagent；
- 公网匿名 Agent endpoint；
- 任意 MCP server 自动安装；
- 外部 Agent 自动批准本地写入或执行；
- MCP Prompt 覆盖本地 system prompt；
- 用共享父 Session 简化 child Session；
- 用内存 Map 作为 Task、MCP config 或恢复状态事实来源；
- 为了对齐 DSH 引入完整 Cordis、桌面端、插件市场或 Claude Code 商业服务。

## 10. 下一步

下一次开发先执行 `4B.0`：建立 MCP/A2A contract audit、DSH R0 参考清单、差异 fixture 和 ADR。完成该 checkpoint 后再进入 MCP durable scoped configuration，不直接开始 A2A HTTP endpoint。
