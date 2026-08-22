# Phase 5：内部 Task/Subagent 多 Agent（DSH 对照执行计划）

状态：`planned`（已完成架构调研和执行计划，尚未合并 Phase 5 运行时代码）
计划建立：2026-08-23

本阶段的目标是让当前主 Agent 可以安全地创建、观察、等待、继续、打断和回收子 Agent。实现路径以 DeepSeek Harness（DSH）的 TypeScript 包边界和生命周期语义为主参照，继续复用本项目已经完成的 EventStore、ToolRuntime、PermissionPolicy、WorkspaceResolver、MCP generation 和 Web/SSE 管线。

本计划覆盖内部多 Agent。A2A HTTP endpoint、外部 Agent Card 和公网互操作继续留在 Phase 6。

## 1. 结论：我们要复刻 DSH 的哪一层

DSH 的多 Agent 能力由四层组成，调用方向和所有权边界非常清晰：

```text
Host/API/Web
    ↓ 读取 projection，发送 prompt / interrupt
model-facing tools
    ↓ 调用 ctx.subagents 的稳定服务接口
SubagentRuntime（provider registry + lifecycle + continuation）
    ↓ 创建或恢复 child Agent
Agent / Agent Loop / Inbox
    ↓ 追加 child Session Event，经过同一套 tools / permission / workspace
Provider（spawn / fork / ACP / 外部 SDK）
```

本项目按以下方式落地：

| DSH 层 | 本项目 Phase 5 目标 | 保留的边界 |
|---|---|---|
| `ctx.subagents` service seam | 新建 `packages/subagent`，提供 `SubagentRuntime` 和 provider registry | Tool、API、MCP 不直接持有 child Agent |
| `Agent` / `Agent Loop` / `Inbox` | 复用 `packages/runtime` 的 `AgentHost` turn queue，增加 child session 调度适配 | child 有独立 Session 和 turn 队列 |
| `Session Event` / projection | 扩展 `packages/contracts`、`packages/storage` 的 Task/Subagent 事件和 projection | EventStore 是唯一事实来源 |
| `tool-subagent` | 在 `packages/tools` 增加 `spawn_subagent` | 只提交显式 prompt 和 policy，不传递父完整上下文 |
| `tool-subagent-control` | 增加 `send_message`、`interrupt_agent`、`list_agents` | 只允许 parent/ancestor authority |
| `tool-subagent-report` | 增加 child-scoped `report` | 只投递给 direct parent，不写任意 session |
| DSH provider packages | 先实现 in-process one-shot/continuable provider，后续保留 ACP/进程 provider 接口 | Phase 5 不引入完整 Cordis 或 DSH runtime |

关键裁决：模型只看到工具和结构化结果；父子关系、授权、恢复和 disposal 全部由服务层负责。

## 2. DSH 项目结构调研结果

### 2.1 Subagent 核心服务

DSH 入口：

- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent/src/index.ts`
- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent/src/types.ts`
- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent/src/descriptor.ts`
- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent/src/child-agent.ts`
- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent/src/depth.ts`
- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent/src/lifecycle.ts`
- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent/src/continuation.ts`
- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent/src/projection.ts`
- `D:/Develop/deepseek-harness-fork/packages/subagent/subagent/src/run-settlement.ts`

这些文件共同形成一个独立的 service seam：

1. `SubagentRuntime` 注册多个命名 provider，不把 provider 细节暴露给模型工具；
2. `start()` 返回一个 one-shot `SubagentRun`，发布后由 `result` 和 `dispose()` 完成所有权交接；
3. `startContinuable()` 先保留 durable child identity，再把首条消息提交到 child inbox；
4. `ContinuationManager` 持有 child Agent，负责 FIFO、冷恢复、child-first disposal、settlement 和 parent report；
5. `descriptor` 作为版本化 Session Event 保存 child 模式、provider 和恢复所需的 composition；
6. `projection` 从事件重建 child identity、mode 和 timing，供 API/Web 查询；
7. `run-settlement` 把 completed、aborted、error、max-tokens、refusal 等结果转换为统一 Task/Job 语义。

### 2.2 模型工具与控制工具

DSH 将“创建子 Agent”和“控制已经存在的子 Agent”分开：

- `D:/Develop/deepseek-harness-fork/packages/subagent/tool-subagent/src/index.ts`
  - provider-bound `subagent` 工具；
  - foreground 等待 `run.result`，无论成功或失败都执行 `run.dispose()`；
  - background 只返回 child/job id，结果由 Task 或 child Session 读取；
  - provider 不支持某项 capability 时在启动前明确失败；
  - `toolFilter` 同时影响 prompt 可见性和实际执行权限。
- `D:/Develop/deepseek-harness-fork/packages/subagent/tool-subagent-control/src/index.ts`
  - `send_message`：把消息作为 child 下一次 FIFO turn；
  - `interrupt_agent`：只停止当前 turn，保留 inbox 和 child；
  - 调用工具把 `exec.agent` 作为 authority credential 传给服务层。
- `D:/Develop/deepseek-harness-fork/packages/subagent/tool-subagent-control/src/list-agents.ts`
  - `children` / `descendants` 两种枚举范围；
  - status 从 live Agent registry 读取；
  - `ready` 只表示可从存储恢复，不能凭历史记录虚构运行中的 Agent。
- `D:/Develop/deepseek-harness-fork/packages/subagent/tool-subagent-report/src/index.ts`
  - `report` 只在 continuable child scope 中注册；
  - recipient 从 durable direct parent 推导；
  - `wakeup` 和 `quiet` 是 host 调度策略，模型不能自行修改。

### 2.3 Agent、Session、Persistence 和 API 的支撑层

DSH 相关入口：

- Agent inbox/dispatch：
  - `D:/Develop/deepseek-harness-fork/packages/core/agent/src/inbox.ts`
  - `D:/Develop/deepseek-harness-fork/packages/core/agent/src/dispatch.ts`
  - `D:/Develop/deepseek-harness-fork/packages/core/agent/src/types.ts`
- Agent Loop：
  - `D:/Develop/deepseek-harness-fork/packages/core/agent-loop/src/agent.ts`
  - `D:/Develop/deepseek-harness-fork/packages/core/agent-loop/src/tool-calls.ts`
- Session 和持久化：
  - `D:/Develop/deepseek-harness-fork/packages/core/session/src/types.ts`
  - `D:/Develop/deepseek-harness-fork/packages/session/session-persistence/src/*`
  - `D:/Develop/deepseek-harness-fork/packages/session/session-persistence-sqlite/src/*`
  - `D:/Develop/deepseek-harness-fork/packages/session/session-projection/src/*`
- Host API：
  - `D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/subagents.ts`
  - `D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/subagents.schema.ts`
- ACP bridge（仅用于 provider/自动化边界参考）：
  - `D:/Develop/deepseek-harness-fork/packages/acp/acp/src/index.ts`
  - `D:/Develop/deepseek-harness-fork/packages/acp/acp/src/codec.ts`

DSH 的重要架构关系是：child 的详细 transcript 留在 child Session，父 Agent 只收到显式 report、settlement notice 或 one-shot 的结构化结果。API 读取 catalog/history，控制请求仍通过父子 authority 检查，Web 不直接读取 live Agent 对象。

## 3. 本项目目标目录和依赖方向

Phase 5 计划新增一个 DSH 风格的独立 package seam：

```text
packages/subagent/
  src/index.ts              # SubagentRuntime、provider registry、public service API
  src/types.ts              # start/run/result/continuation/report contracts
  src/descriptor.ts         # versioned child descriptor
  src/child-agent.ts        # child options、depth、workspace、policy snapshot
  src/lifecycle.ts          # start/end/activation observer
  src/continuation.ts       # FIFO inbox、cold resume、authority、disposal
  src/projection.ts         # child identity/timing projection
  src/run-settlement.ts     # one-shot result → Task report
  src/providers/in-process.ts
```

现有 package 的职责调整如下：

| 目录 | Phase 5 变更 |
|---|---|
| `packages/contracts` | 增加 `SubagentDescriptor`、`SubagentRun`、`TaskReport`、`ArtifactRef`、parent/child authority 和新增事件 payload；收紧 `TaskProjection` 字段 |
| `packages/storage` | 增加 child session metadata、Task/Subagent projection、descriptor 校验、重启恢复和幂等 command；不能只把 child 放进内存 Map |
| `packages/subagent` | 承载 DSH 风格 service seam、lifecycle、continuation 和 provider registry |
| `packages/runtime` | 为 parent/child 提供 AgentHost adapter、turn queue、AbortSignal 传播和恢复入口；继续保留现有工具调用循环 |
| `packages/tools` | 只承载 model-facing `spawn_subagent`、`send_message`、`interrupt_agent`、`list_agents`、child-scoped `report` 适配器和工具级 prompt |
| `packages/mcp-client` | 提供 child 的显式 MCP allowlist/scope 解析；child 不能通过继承父 session 自动获得全部 MCP 能力 |
| `apps/api` | 增加 subagent catalog/history/prompt/interrupt/task/report API，并沿用 revision、idempotency、SSE 和 redaction 约束 |
| `apps/web` | 增加 parent/child 树、状态、报告、artifact、取消和 child history 视图；状态来自 projection 和 SSE |

依赖方向固定为：

```text
contracts → storage
contracts → subagent
storage   → subagent
subagent  → runtime adapter
subagent  → tools adapter
runtime   → api
api       → web
mcp-client → subagent child policy（只读解析，不反向控制 lifecycle）
```

`packages/tools` 不直接创建 Agent；`apps/api` 不直接操作 ToolRegistry；MCP、内置工具和 Subagent 都继续经过 ToolRuntime 的权限、取消、审计和事件管线。

## 4. DSH 文件到本项目交付物的对照表

| DSH 入口 | 观察到的职责 | 本项目拟实现 | 参考等级 |
|---|---|---|---|
| `subagent/src/index.ts` | named provider registry、`start`、`startContinuable`、followup、interrupt、list | `packages/subagent/src/index.ts` | R0 |
| `subagent/src/types.ts` | capabilities、start request、run/result、stop reason | `packages/subagent/src/types.ts` + `packages/contracts` | R0 |
| `subagent/src/descriptor.ts` | versioned durable child identity、one-shot/continuable mode | `packages/subagent/src/descriptor.ts` + SQLite event | R0 |
| `subagent/src/child-agent.ts` | child options、workspace/policy snapshot、delegation depth | `packages/subagent/src/child-agent.ts` | R0 |
| `subagent/src/depth.ts` | absolute depth cap、monotonic delegation depth | `packages/subagent/src/child-agent.ts` | R0 |
| `subagent/src/lifecycle.ts` | paired `subagent/start`/`subagent/end`、contained observers | `packages/subagent/src/lifecycle.ts` | R0 |
| `subagent/src/continuation.ts` | child lock、FIFO inbox、cold resume、settlement、child-first disposal | `packages/subagent/src/continuation.ts` | R0 |
| `subagent/src/projection.ts` | identity/timing projections from session events | `packages/subagent/src/projection.ts` + storage projector | R0 |
| `subagent/src/run-settlement.ts` | final assistant output and stop reason normalization | `packages/subagent/src/run-settlement.ts` | R0 |
| `tool-subagent/src/index.ts` | foreground/background/continuable model tool | `packages/tools/src/subagent.ts` | R0 |
| `tool-subagent-control/src/index.ts` | `send_message` and `interrupt_agent` authority adapter | `packages/tools/src/subagent-control.ts` | R0 |
| `tool-subagent-control/src/list-agents.ts` | children/descendants catalog and live status | `packages/tools/src/list-agents.ts` | R0 |
| `tool-subagent-report/src/index.ts` | child-scoped report and parent scheduling | `packages/tools/src/subagent-report.ts` | R0/R1 |
| `subagent-spawn-in-process/src/index.ts` | fresh child provider | `packages/subagent/src/providers/in-process.ts` | R0 |
| `subagent-fork-in-process/src/index.ts` | parent history seed provider | Phase 5.2 optional fork mode | R1 |
| `subagent-in-process-driver/src/*` | per-run scoped composition and disposal | `packages/subagent/src/providers/in-process-driver.ts` | R0 |
| `subagent-acp/src/*` | external automation provider boundary | Phase 5 后续研究；Phase 6/ACP adapter | R1 |
| `core/agent/src/inbox.ts` | next-step/next-turn FIFO and cancellation semantics | `AgentHost` child queue adapter | R0 |
| `core/agent-loop/src/agent.ts` | driver lifecycle、turn start/end、idle convergence | `packages/runtime` shared loop | R0 |
| `host/apiproxy/src/api/subagents*.ts` | browser-safe catalog/history/prompt/interrupt RPC | `apps/api` routes + contracts | R1 |

本阶段只做行为级和结构级对照。DSH 的 Cordis Context、scope implementation、品牌类型和内部 package 类型不会直接成为本项目公共依赖。

## 5. 公共 contract 设计

### 5.1 Durable identity

每个 child 必须同时拥有以下身份：

```text
TaskId             # parent 看到的委派任务身份
SessionId          # child transcript 和 turn event 的事实来源
ParentTaskId       # 直接父任务，可为空
ParentSessionId    # 直接父 Session，禁止通过“最近活跃 Session”推导
WorkspaceId/root   # child 的 workspace 边界
delegationDepth    # 单调递增的当前深度
mode               # one-shot | continuable
provider           # 建立 child 的 provider 名称
```

`TaskId` 和 `SessionId` 不合并。one-shot 的 Task 在父 Session 中有 projection，child Session 保留完整执行日志；continuable child 的 Session 在多次 activation 之间保持同一 id。

### 5.2 Descriptor

新增版本化 `subagent/descriptor` 事件，最小字段如下：

```ts
interface SubagentDescriptor {
  version: number;
  mode: "one-shot" | "continuable";
  provider: string;
  label?: string;
  parentTaskId?: TaskId;
  parentSessionId: SessionId;
  workspaceRoot: string;
  permissionPreset: PermissionPreset;
  toolAllowlist?: readonly string[];
  mcpAllowlist?: readonly string[];
  model?: string;
  delegationDepth: number;
}
```

仅保存可恢复的 composition。单次 activation 的 token、timeout、output schema 等参数留在 Task/Run contract，不能因为父 Agent 后续配置变化而隐式改写 child 的 durable identity。

### 5.3 Lifecycle 和事件

父 Session 追加委派侧事件：

```text
task/created
task/updated
task/input-required
task/report
task/artifact
task/ended
```

child Session 追加自身的普通事件：

```text
session/created → turn/queued → turn/started → tool/* / assistant/* → turn/ended
```

生命周期观察事件使用：

```text
subagent/start
subagent/end
```

每个事件都携带 `taskId`、`parentTaskId`、`childSessionId`、`runId` 或 `correlationId` 中适用的字段。事件追加先于 projection、SSE 和模型可见结果；重复 command 通过现有 idempotency claim 处理。

### 5.4 Result 和 report

one-shot 使用统一的 `TaskReport`：

```ts
interface TaskReport {
  taskId: TaskId;
  childSessionId: SessionId;
  status: "completed" | "failed" | "cancelled" | "rejected" | "partial";
  stopReason?: "completed" | "aborted" | "error" | "max-tokens" | "refusal";
  summary: string;
  output?: unknown;
  artifacts: readonly ArtifactRef[];
  diagnostics?: readonly ToolError[];
}
```

foreground 工具只把摘要和结构化输出返回给 parent；background 工具返回 `taskId`，后续由 `task_query`、`task_output`、`task_cancel` 或 settlement notice 获取结果。child 中间过程保留在 child Session，避免将完整 transcript 注入 parent 上下文。

## 6. 分阶段实施路线

### 5.0：Task contract 与 durable projection

交付：

- 在 `packages/contracts` 拆出 Task/Subagent 公共类型和事件 payload schema；
- 扩展现有 `TaskProjection`，加入 parent/child、workspace、provider、mode、depth、budget、artifact manifest 和 terminal reason；
- 在 `packages/storage` 增加 child session metadata、descriptor 校验和 projection rebuild；
- 实现 `TaskService.create/cancel/retry/query/report/artifacts` 的幂等边界；
- 为 parent Session 和 child Session 建立事件关联；
- 重启后恢复 Task catalog、child descriptor、pending approval 和未完成 activation 的可解释状态；
- 增加 fixture：重复 create、重复 cancel、崩溃后恢复、损坏/未知 descriptor、sequence gap。

DSH R0 对照：`descriptor.ts`、`projection.ts`、`session-persistence`、`session-projection`。重点验证 identity 不可变、mode 可恢复、父子关系显式保存和 cold child 可枚举。

退出条件：只通过 EventStore 就能重建 parent/child Task 树，尚未启动的 Task 不会被误报为 running。

### 5.1：One-shot Subagent

交付：

- `SubagentRuntime.registerProvider()` 和 provider capability catalog；
- in-process spawn provider：新建独立 child Session，显式传入 prompt、workspace、permission preset、tool/MCP allowlist；
- `spawn_subagent` 支持 foreground 和 background；
- foreground 严格执行 `start → result → dispose`，结果和 disposal 双失败时保留两个诊断；
- background 创建 Task 后立即返回 id，后续通过 Task API 读取结果；
- provider 在启动前检查 `outputSchema`、`toolFilter`、`maxDepth` 等 capability，缺少能力时返回明确拒绝；
- sibling child 可并行运行，父 Session 不因 child 的中间事件污染模型历史。

DSH R0 对照：`tool-subagent/src/index.ts`、`subagent-spawn-in-process/src/index.ts`、`subagent-in-process-driver/src/index.ts`、`run-settlement.ts`。重点验证 partial output、stop reason、AbortSignal 传递和 child-first dispose。

退出条件：parent 能并发启动两个只读 child，foreground 得到结构化报告，background 能通过 Task query 读取终态。

### 5.2：Continuable Child、Inbox 和控制工具

交付：

- `startContinuable()` 预留 durable child identity，并在 inbox 接受首条消息后返回 receipt；
- child Agent 复用 `AgentHost` 的 turn loop，但拥有独立消息队列和 Session；
- 一个 child 同时最多执行一个 turn，后续消息按 FIFO 排队；
- `send_message` 只投递下一 turn，不能重定向当前 turn；
- `interrupt_agent` 只中断当前 turn，保留 queued inbox、child Session 和已发布 descendants；
- `list_agents` 支持 `children` 和 `descendants`，状态来自 live registry 与 durable projection 的交集；
- child cold resume 从 descriptor 和 Session 恢复，不能从历史 Task 行推导虚假 Agent；
- parent/ancestor authority、depth、concurrency 和 cancellation propagation 由 service 层统一检查。

DSH R0 对照：`continuation.ts`、`core/agent/src/inbox.ts`、`tool-subagent-control/src/index.ts`、`list-agents.ts`。重点覆盖 ChildLock、接受边界、冷恢复、幂等中断和 parent/ancestor 检查。

退出条件：child 在运行中收到 follow-up 时保持当前 turn 完整，interrupt 后 queued message 仍可继续执行；重启后 `ready` child 可被重新唤醒。

### 5.3：Report、Settlement 和 MCP-aware Child

交付：

- child-scoped `report` 工具只安装在 continuable child；
- report recipient 由 durable direct parent 推导，工具参数不接受任意 recipient；
- 支持 `wakeup` 和 `quiet` 两种 parent delivery policy；
- child settlement 产生独立 notice，报告和终态事件可分别恢复；
- child 的 MCP scope 必须显式继承、显式清空或受 allowlist 限制；
- MCP tool generation、断线、取消和 approval 等状态在 parent report 中只保留摘要和 artifact 引用；
- parent 的 MCP 权限、workspace 写权限和 execute 权限不能因为 child 创建自动扩张。

DSH R0/R1 对照：`tool-subagent-report/src/index.ts`、`continuation.ts`、`child-agent.ts`、MCP tool filtering/system-prompt sections。重点验证 report 不会改变当前 parent turn，nested child 只能报告给 direct parent，且外部内容不会提升 trust。

退出条件：child 可主动报告中间发现，parent 依据 wakeup policy 获得下一轮输入；child 调用 MCP 只读工具时 scope、generation 和权限事件可追溯。

### 5.4：API/Web 集成与 Phase 5 门禁

交付：

- API：`subagent.list`、`subagent.history`、`subagent.prompt`、`subagent.interrupt`、`task.query`、`task.output`、`task.cancel`；
- SSE：parent/child 事件按 parent scope 投影，断线按 sequence 补发；
- Web：parent/child 树、running/idle/ready/failed 状态、报告、artifact、审批、取消和 child history；
- 多 Agent 测试 fixture：两个并行只读 child、一个独立审批写入 child、一个 MCP 只读 child；
- API 重启后 catalog、Task、报告和 child Session 恢复；
- 所有阶段日志、contract、ADR、source reuse register 与测试证据同步后独立 commit。

DSH R0/R1 对照：`host/apiproxy/src/api/subagents.ts`、`subagents.schema.ts`、`core/session` projections 和 Web subagent panels。Web 只消费本项目 DTO，不暴露 DSH 内部 Agent 对象。

## 7. 工具、Prompt 与模型可见性

### 7.1 工具池

Phase 5 的首批模型工具：

| 工具 | 作用 | 默认返回 |
|---|---|---|
| `spawn_subagent` | 创建 one-shot 或 continuable child | `TaskReport` 或 `taskId/childSessionId` |
| `task_query` | 查询 Task 状态和 diagnostics | 有界 Task projection |
| `task_output` | 读取最终报告、部分输出和 artifact manifest | bounded report |
| `task_cancel` | 取消 one-shot/background Task | cancellation receipt |
| `send_message` | 给 continuable child 排队下一 turn | message receipt |
| `interrupt_agent` | 中断 child 当前 turn | interrupt receipt |
| `list_agents` | 列出 direct children 或 descendants | stable catalog |
| `report` | child 向 direct parent 报告 | message receipt |

工具 schema 中必须说明等待、取消、部分结果、权限和恢复语义。工具可见性由当前 parent/child capability 和 permission preset 计算，Prompt 只解释行为，不能宣称运行时没有注册的工具。

### 7.2 DSH 风格工具 Prompt section

为每个工具增加独立 Prompt section：

- `tool:spawn_subagent`：独立、可并行、互不冲突的任务优先 background；下一步依赖结果时才 foreground；显式传递 workspace、目标、工具白名单和验收标准；
- `tool:task_query`：先查状态，再决定等待、读取输出或取消；不要把 queued/ready 当作 completed；
- `tool:send_message`：消息进入 child 下一 turn，不会返回 child 答案；
- `tool:interrupt_agent`：只停止当前 turn，queued inbox 和 descendants 继续保留；
- `tool:list_agents`：使用 children 查看直接委派，使用 descendants 查看树；`ready` 代表可恢复；
- `tool:report`：在结束前发送一次自包含报告，重要中间发现可以提前发送；report 不结束当前 turn；
- `tool:task_output`：优先读取摘要、diagnostics 和 artifact 引用，按需读取 child history，避免将全部 transcript 放回 parent。

## 8. 统一安全和生命周期不变量

1. Child session 必须拥有独立 `SessionId`、`TaskId` 和事件序列；共享 parent Session 只允许作为显式 seed，不能作为运行时事实来源。
2. Parent/ancestor authority 由 live Agent identity 和 durable parentSessionId 同时校验；session id 字符串自身不构成权限。
3. `toolFilter` 同时限制模型可见 schema 和 ToolRuntime 执行；MCP allowlist 采用相同规则。
4. workspaceRoot 在创建时经过 WorkspaceResolver 校验，并冻结到 descriptor；child 不得通过 prompt 改写 workspace。
5. parent 取消按策略传播；child dispose 必须 child-first，所有 running turn、background job、MCP call 和 terminal process 都进入可解释终态。
6. `send_message` 的取消信号只拥有 admission，消息接受后由 child inbox 负责后续执行；`interrupt_agent` 的 accepted 语义不等同于已经 quiescent。
7. one-shot result、background Task、continuable settlement notice 三条结果路径必须可区分，不能把 partial/error 当作成功摘要。
8. MCP resource/prompt/tool 内容属于不可信输入，parent report 只能带 bounded modelView、摘要和 artifact 引用。
9. EventStore 先追加、projection 后更新、SSE 再投影；任何内存 catalog 都只能作为加速缓存。

## 9. 测试矩阵和验收场景

### 单元/合同测试

- descriptor 版本、未知字段、mode/provider/policy 校验；
- Task 状态机合法迁移和重复 terminal event；
- parent/child/depth/workspace/toolScope 计算；
- provider capability fail-loud；
- one-shot stop reason、partial output、双失败 disposal；
- inbox FIFO、child lock、follow-up 与 interrupt；
- report direct-parent authority、wakeup/quiet；
- MCP allowlist、generation change、cancel 关联。

### 恢复和安全测试

- 创建 child 后 API 立即重启；
- child turn 执行中进程退出，恢复为 `ready`/`interrupted` 并提供 diagnostics；
- 重复 `spawn`、`send_message`、`interrupt`、`cancel` 使用同一 idempotency key；
- parent 取消级联 child、job、terminal、MCP request；
- self、sibling、stale parent、非 ancestor 调用被拒绝；
- workspace escape、MCP credential 泄露、未经授权的工具升级被拒绝；
- 从 parent/child 事件分别 rebuild projection，SSE replay 不重复。

### 端到端门禁

1. parent 并发启动两个只读 child，二者在同一 workspace 中只执行互不冲突的查询。
2. 一个 child 使用 MCP read-only tool，返回摘要和 artifact 引用。
3. 一个 child 尝试编辑文件，在 `ask-on-write` 下进入独立 approval；拒绝后 parent 仍能完成。
4. continuable child 在运行中接受 `send_message`，之后由 `interrupt_agent` 停止当前 turn，再恢复 queued message。
5. Web 刷新和 SSE 断线后，parent/child 树、工具事件、报告和终态保持一致。

## 10. DSH 对照等级

| 等级 | 含义 | Phase 5 要求 |
|---|---|---|
| R0 | 逐文件对照并建立行为 fixture | `subagent` 核心、descriptor、lifecycle、continuation、inbox、control、one-shot disposal |
| R1 | 对照公共行为和 API，不复制实现 | report、MCP-aware child、Host API、Web catalog、ACP provider boundary |
| R2 | 只记录未来方向 | 多进程 provider roster、复杂 preset composition、远程 session、调度策略和完整 ACP 自动化 |

每个 R0 工作项必须在开发日志中写出 DSH 文件路径、本项目对应文件、行为差异、测试 fixture 和回滚开关。

## 11. 明确不进入 Phase 5

- A2A HTTP server、Agent Card、外部 Task mapper；
- outbound A2A client；
- 无限制自主 swarm、自动角色规划和跨 workspace 写入；
- 共享父 Agent 全部历史、权限或 MCP catalog；
- 直接复制 Cordis、DSH Session 类型、DSH Web 组件或品牌资源；
- 让 child 直接调用 `ToolRegistry.execute` 绕过 ToolRuntime；
- 以 live Agent registry 或内存 Map 作为 Task 恢复事实源；
- 先实现 Web 假数据再补事件契约。

## 12. 进入、退出、回滚和提交门禁

### 进入条件

- Phase 3B、Phase 4B 已完成并有独立 checkpoint；
- 当前 EventStore、permission、workspace、MCP generation 和 SSE replay 测试保持通过；
- Phase 5.0 contract audit、DSH R0 参考清单和差异 fixture 先提交。

### 退出条件

- Phase 5.0–5.3 交付物全部实现；
- Phase 5.4 的并发、权限、恢复、Web 和真实模型 smoke 全部通过；
- parent/child/task/mcp/tool/permission event 可回放；
- 所有 checkpoint、开发日志、状态看板、ADR 和 source reuse register 已同步。

### 回滚

- `subagent` capability 可按 preset/feature flag 关闭；
- 禁用后保留普通 Session、内置工具、MCP Client 和历史 child transcript；
- provider 可单独禁用，已发布 Task 进入 `rejected`/`failed` 并带 diagnostics；
- 每个 5.0–5.4 checkpoint 独立 commit，禁止把 Phase 6 A2A 代码混入 Phase 5 提交。

## 13. 下一步执行清单

下一次开发从 `5.0.0` 开始：

1. 建立 `packages/subagent` package skeleton 和 DSH R0 source map；
2. 在 `packages/contracts` 定义 descriptor、TaskReport、ArtifactRef、authority 和事件 schema；
3. 给 `packages/storage` 增加 child session metadata 与 Task/Subagent projector fixture；
4. 输出 ADR：child Session 与 parent Task 的事实来源、descriptor 版本和恢复状态；
5. 只实现 contract、projection 和 fixture，完成后独立 commit；
6. 通过 5.0 门禁后再实现 one-shot provider，不提前接入 A2A。

该清单完成后，Phase 5 才从 `planned` 进入 `in_progress`。
