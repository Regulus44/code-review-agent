# Coding Agent 改造总计划

> 目标：把 `code-review-agent` 从“面向仓库分析的单 Agent 服务”演进为“网页上的 Coding Agent Runtime”，具备流式对话、文件修改、终端执行、权限控制、MCP 工具接入、可恢复 Session、内部多 Agent 协作，并为后续 A2A 互操作预留稳定边界。

本文是改造期间的主计划。实现、评审和取舍都应回到本文，避免项目在“复制 DSH”“复制 Claude Code”“加入更多工具”“加入多 Agent”之间发生目标漂移。

## 1. 目标和非目标

### 1.1 最终目标

```text
浏览器 Web UI
  ├─ Session 列表、工作区选择、模型选择
  ├─ 流式消息、思考/工具/终端/差异展示
  ├─ 权限请求、取消、继续、steer、队列
  └─ 子 Agent / 任务 / MCP 状态
          │
          ├─ REST：命令、查询、批准、配置
          └─ SSE：事件、增量、进度、状态、重连
          │
Coding Agent Host
  ├─ Session/Event Store
  ├─ Agent Loop（turn → step → model → tools）
  ├─ Context/Compaction
  ├─ Permission/Policy
  ├─ Built-in Tool Runtime
  ├─ MCP Client / Tool Catalog
  ├─ Subagent Registry / Scheduler
  └─ Workspace / Shell / Git / Process boundary
```

### 1.2 明确非目标

- 不把现有 Python Runtime 继续作为目标后端底座；Python 代码只保留为需求、行为和测试参考。
- 不把整个 DSH monorepo 原样复制进本项目；只选择性重建能够支撑本项目目标的包和接口。
- 不直接复制 DSH 的 Cordis、全部插件和桌面端代码。
- 不复制本地 Claude Code 仓库的完整逆向工程实现、CLI、商业服务、遥测或账户体系；在来源和许可证清晰的前提下，可以选择性复用局部代码，否则按其源码重建行为。
- 不把每一个外部能力都重新实现成内置工具；外部工具优先走 MCP。
- 不在 Agent Loop 尚未稳定前引入 Subagent、A2A、Code Mode 和复杂工作流。
- 不把 ACP、MCP、A2A 当成同一种协议。

## 2. 稳定性原则：哪些东西可以照搬，哪些不能照搬

### 2.1 可以照搬的部分

这些部分属于通用运行时模式，可以按 DSH/Claude Code 的设计改编：

- turn/step 型 Agent Loop；
- 事件优先的 Session 日志；
- 模型增量和工具进度的流式传输；
- 工具执行模式（parallel / exclusive）；
- 工具权限和审批状态机；
- 文件工具的 diff presentation；
- 上下文压缩和工具结果预算；
- Session fork、resume、cancel、steer；
- Subagent registry、父子关系和生命周期；
- Web UI 的信息架构和交互分区。

### 2.2 必须保留本项目边界的部分

- 目标后端是 TypeScript/Node.js；现有 Python 包不参与新 Runtime 的运行时依赖图。
- 迁移期间不删除 Python 代码，但将其明确标记为 legacy/reference，等 TypeScript 垂直切片达到验收后再决定归档或移除。
- SQLite 先继续使用，但通过 TypeScript Store 接口访问，不把 Python ORM 或 FastAPI 类型带入新代码。
- 本项目的工作区安全策略必须比“直接允许 shell”更严格。
- API 事件契约由本项目维护，不直接暴露第三方内部类型。
- MCP/A2A/ACP 都通过适配层接入，协议细节不能污染 Agent Loop。
- 每个阶段必须有可运行的垂直切片和回滚点。

## 3. 参考仓库映射

### 3.1 DeepSeek Harness：运行时和 Web 架构主参考

| 能力 | 参考位置 | 采用方式 |
|---|---|---|
| Agent 生命周期、turn/step | `packages/core/agent-loop/src/agent.ts` | 在 TypeScript Runtime 中重建，保留 turn/step、取消、队列语义 |
| 工具调度 | `packages/core/agent-loop/src/tool-calls.ts` | 参考 parallel/exclusive 分组、结果按模型顺序提交、abort 合成结果 |
| Tool schema/runtime | `packages/core/tools/src/` | 参考 schema、执行模式、presentation、结果结构，不复制实现 |
| 文件工具 | `packages/fs/tool-fs/` | 参考 read/write/edit 的输入、输出、diff、观测约束 |
| 搜索工具 | `packages/fs/tool-fs-search/` | 参考 glob/grep 与 subprocess 的边界 |
| Shell/Terminal | `packages/shell/`、`packages/terminal/`、`packages/subprocess/` | 参考进程树、超时、输出流、终止和工作目录模型 |
| Session API | `packages/host/apiproxy/src/api/sessions.ts` | 参考 Session list/history/send/fork/cancel/queue 的 API 形状 |
| 事件 API | `packages/host/apiproxy/src/api/events.ts` | 参考 mux、session event、queue、projection、approval/question 帧 |
| Web host | `packages/host/webserver/`、`packages/bundle/web-app/` | 参考 Web Server 和静态前端托管边界 |
| Web 前端 | `packages/client/`、`apps/web/` | 基本沿用信息架构和组件分区，只改品牌、图标、文案和后端适配 |
| MCP | `packages/mcp/mcp-client/` | 参考连接、发现、重连、工具命名和失败状态 |
| 内部 Subagent | `packages/subagent/`、`packages/subagent/tool-subagent/` | 参考 registry、child lifecycle、spawn/fork/report |
| ACP | `packages/acp/`、`packages/subagent/subagent-acp/` | 作为 Agent Client/自动化互操作参考，不当作 A2A 实现 |

### 3.2 Claude Code：产品行为和工具体验主参考

| 能力 | 参考位置 | 采用方式 |
|---|---|---|
| Agentic Loop | `src/query.ts` | 参考流式请求、恢复、终止、max turns、工具后续循环 |
| Streaming Tool Executor | `src/services/tools/StreamingToolExecutor.ts` | 参考工具并发、进度、兄弟失败取消、合成错误 |
| 工具总表 | `src/tools.ts` | 参考 built-in/MCP 工具池、按权限过滤、懒加载工具 |
| 文件/命令工具 | `packages/builtin-tools/src/tools/` | 参考 Bash、Read、Edit、Write、Glob、Grep、Task 的 UX 和结果格式 |
| 上下文 | `src/context.ts`、`src/services/contextCollapse/`、`src/utils/context*` | 参考预算、microcompact、collapse、autocompact 和恢复路径 |
| 权限 | `src/hooks/toolPermission/`、`src/Tool.ts` | 参考 requires-action、批准/拒绝、工具级权限与模式 |
| MCP | `packages/mcp-client/` | 参考 server config、transport、discovery、错误和工具名称隔离 |
| Task/Team/Subagent | `packages/builtin-tools/src/tools/Task*`、`Team*`、`src/utils/swarm/`、`src/coordinator/` | 参考任务状态、团队消息、协调者/Worker、权限同步 |
| Web 远程控制 | `packages/remote-control-server/` | 参考 Session API、EventBus、SSE、Web UI 组件和重连 |

### 3.3 协议边界校准

| 协议 | 解决的问题 | 本项目的计划定位 |
|---|---|---|
| MCP | Agent 调用外部工具、资源、Prompt | 第一优先级的外部工具扩展协议 |
| ACP | Agent 被程序化客户端驱动 | 可作为外部 Client/自动化接入适配层 |
| A2A | Agent 与 Agent 之间发现、委派、任务协作 | 在内部 Subagent 稳定后再做的外部互操作层 |

本地 DSH/Claude Code 快照中没有完整的 A2A 实现。DSH 的 ACP、Subagent registry 和 Claude Code 的 Team/Coordinator 是 A2A 的内部设计参考，但不能宣称它们已经实现 A2A。

## 4. 目标后端分层

新 Runtime 在仓库根目录建立 TypeScript workspace。当前 `src/code_review_agent` 不再是新后端的依赖；它只作为 legacy/reference 保留，直到新 Runtime 覆盖既有验收场景。

```text
packages/
  contracts/       事件、工具、任务和模型的公共 TypeScript 类型
  llm/             Provider-neutral stream/response/usage 与 OpenAI-compatible adapter
  runtime/         Session、Turn、AgentHost、任务协调
  tools/           built-in、MCP tool adapter、tool scheduler
  storage/         event log、projection、session metadata
  workspace/       path、fs、git、shell、process、terminal boundary
  protocols/       mcp、acp、a2a 适配层
apps/
  api/             Node.js HTTP/SSE host
  web/             DSH 风格的独立 TypeScript/Vite 前端

legacy-reference/
  （未来可选的归档位置；Phase 0 不移动现有 `src/code_review_agent`）
```

现有模块的迁移原则：

- `harness/agent.py`、`runtime/session_service.py`、`tools/` 和 `session/` 只提供行为样本和测试输入；
- `apps/repo_analyst` 变成 TypeScript preset/app，不再定义核心 Agent 行为；
- 新 `packages/runtime` 先实现 `AgentHost`、Session、Turn 和事件日志；
- 新 `packages/tools` 先实现 workspace resolver、read/glob/grep/edit/write/run_command；
- 新 `apps/web` 直接围绕 DSH 的 Session sidebar、Conversation、Tool row、Diff、Permission 信息架构构建。

## 5. 分阶段路线图

每一阶段都必须满足“交付物 + 验收条件 + 回滚点”，前一阶段未达到验收条件，不进入后一阶段。

### Phase 0：TypeScript 基线和防漂移机制

**目标**：建立唯一方向和可回滚的开发基线。

交付物：

- 本文作为主计划；
- 根目录 `AGENTS.md`：长期开发规则、任务模板和防漂移门禁；
- TypeScript monorepo（`packages/*`、`apps/*`）和 Node.js 运行入口；
- `docs/architecture-decisions.md`：记录关键架构决策；
- `docs/protocol-boundaries.md`：记录 MCP/ACP/A2A 边界；
- `docs/event-contract.md`：记录事件类型、sequence 和重连规则；
- `docs/tool-contract.md`：记录工具输入、输出、权限和 presentation；
- `docs/source-reuse-register.md`：记录从 DSH/Claude Code 直接复用或改编的代码来源、许可证和测试；
- `docs/phase-0-checklist.zh-CN.md`：把 Phase 0 拆成可执行任务和退出门禁；
- `docs/phase-plans/README.zh-CN.md`：各阶段的详细开发计划、参考入口和验收标准；
- `docs/phase-status.zh-CN.md`：当前阶段状态和实际验收证据；
- `docs/agents-governance.zh-CN.md`：根目录 `AGENTS.md` 的修改权限和治理流程；
- 每个阶段使用独立 feature branch；
- 为每个阶段建立最小 e2e smoke 场景。

验收条件：

- 新需求可以明确映射到某个 Phase；
- 如果一个需求不能映射到 Phase，先写决策记录，不能直接编码；
- 旧 Python 测试仍能运行；新 TypeScript 包可以独立 typecheck/test；
- 新 Runtime 的依赖图不包含 `src/code_review_agent`。

### Phase 1：Agentic Coding Core（DSH Web Shell + 真正工具调用）

**目标**：网页上完成一次真实的“阅读 → 修改 → 测试 → 总结”，并且由模型自动发起工具调用，工具结果和权限状态能够回到同一个 Agent Loop。

详细执行计划见：[Phase 1：Agentic Coding Core](phase-plans/phase-1-agentic-coding-core.zh-CN.md)。当前执行单元是 Phase 1A：同时恢复 model → tool → model 流程，并把文件、搜索、Shell、持久终端、计划、任务和用户交互工具补齐为 TypeScript 内置工具池。此前的 Web Shell 实现是可回滚的历史 checkpoint，不是本阶段的最终退出条件。

范围：

- DeepSeek/OpenAI-compatible streaming 接口；
- OpenAI-compatible/DeepSeek tool-calling contract、参数增量和 tool result continuation；
- `AgentHost`、Session、Turn、EventStore 的 TypeScript 最小实现；
- Agent turn/step 事件化和真正的 model → tool → model 循环；
- SSE 事件流和断线重连；
- `read_file`、`write_file`、`edit_file`、`glob`、`grep`；
- `run_command` 的安全 workspace 模式；
- diff presentation；
- 权限 preset、审批暂停/恢复和模型工具过滤；
- Web UI 对话、工具卡片、diff 卡片、停止按钮。

Phase 1A 的 TypeScript 工具迁移边界：旧 `src/code_review_agent/tools/` 只作 legacy/reference；新 Runtime 只依赖 `packages/tools`，不把 Python 工具重新接回后端。工具实现可以参考 DSH/Claude Code 的行为和结果形状，但必须经过本项目的 workspace、permission、event、cancel 和 output budget 管线。

不包含：MCP、A2A、Subagent、LSP、Code Mode、Worktree。

说明：本阶段的 Web shell 只服务于真实 Agent Loop 验收。前端可以沿用 DSH 信息架构，但不能用静态 UI 代替模型 tool call、permission 或 tool result。

核心验收场景：

1. 用户要求修改一个文件；
2. Agent 读取文件并生成 edit；
3. Web UI 显示 pending diff；
4. 用户批准；
5. Agent 执行修改；
6. Agent 运行测试；
7. 流式显示结果；
8. 刷新网页后 Session 可以恢复完整事件。

### Phase 2：事件优先的 Session 和可恢复执行

**目标**：运行中、断线后、进程重启后都能恢复正确状态。

事件最小集合：

```text
session/created
turn/started
turn/ended
step/started
step/ended
user/message
assistant/chunk
assistant/message
tool/call
tool/progress
tool/result
permission/requested
permission/resolved
agent/status
agent/error
queue/changed
```

要求：

- SQLite 追加事件时分配单调 sequence；
- 事件先写入 Store，再推送给 SSE；
- 客户端使用 `Last-Event-ID` 或 `after_sequence` 补发；
- message、tool、permission、status 都从事件重建；
- 不把“Turn 完成后才保存消息”作为唯一事实来源；
- 对重放、重复批准、重复取消保持幂等。

### Phase 3：工具运行时和权限系统

**目标**：把当前潦草的内置工具变成稳定的 Tool Runtime。

工具策略不是“所有工具都自己写”或“所有工具都交给 MCP”二选一：文件读写、workspace resolver、diff、进程终止和权限审计属于本地安全基元，保留为少量内置工具；Git 托管、数据库、浏览器、知识库、Issue、云服务等扩展能力优先通过 MCP 接入。

TypeScript 工具定义统一包含：

```ts
type ToolDefinition = {
    name: string;                 // 稳定外部名称
    description: string;          // 模型描述
    inputSchema: JsonSchema;
    executionMode: "parallel" | "exclusive";
    riskLevel: "read" | "write" | "execute" | "network";
    approvalMode: "auto" | "ask" | "deny";
    interruptBehavior: "cancel" | "block";
    execute: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
    presentCall?: (input: unknown) => ToolPresentation;
    presentResult?: (result: ToolResult) => ToolPresentation;
}
```

内置工具顺序：

1. `read_file`
2. `glob`
3. `grep`
4. `edit_file`
5. `write_file`
6. `git_status`
7. `git_diff`
8. `run_command`
9. `run_tests`
10. `terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` / `terminal_close` / `terminal_list`

安全要求：

- 所有路径经过 workspace resolver；
- 不使用 `shell=True`；
- 命令执行采用 argv 或显式 shell policy；
- 支持超时、输出截断、进程树终止；
- 写入和执行都有审批边界；
- 工具错误携带稳定 error code 和可行动 remedy；
- diff、stdout、stderr、exit code 都是结构化结果。

### Phase 4：MCP Client 和外部工具目录

**目标**：外部能力优先通过 MCP 接入，不继续堆积本地业务工具；本地安全基元仍由本项目维护。

MCP 组件：

```text
McpConfigStore
  ├─ stdio server
  ├─ SSE/HTTP server
  └─ future streamable HTTP
        ↓
McpConnectionManager
        ↓
McpDiscovery
  ├─ tools/list
  ├─ resources/list
  └─ prompts/list
        ↓
McpToolAdapter / McpResourceAdapter
        ↓
ToolRegistry（命名、权限、presentation、事件）
```

借鉴 DSH `packages/mcp/mcp-client/` 和 Claude Code `packages/mcp-client/`：

- server 配置和 scope；
- 连接状态：pending/connected/failed/needs_auth/disabled；
- 发现结果和工具名称隔离；
- MCP 错误分类、重连和超时；
- MCP 工具也必须进入本项目的权限和事件体系；
- MCP 工具不能绕过 workspace、审计和取消机制；
- Web UI 展示 MCP server 状态和工具来源。

第一批不实现 MCP Server，只实现稳定的 MCP Client。

### Phase 5：内部多 Agent / Subagent

**目标**：让一个主 Agent 能安全地委派独立任务，并在网页上看到子任务。

前置门禁：Phase 1 Agentic Coding Core 的真实 `read → edit → approve → test` 场景已经通过；Subagent 不能用来绕过主 Agent 的 tool-calling、permission 或 workspace 边界。

先定义内部抽象，不立即做 A2A：

```text
SubagentRegistry
  ├─ descriptor
  ├─ parent_id / child_id
  ├─ workspace scope
  ├─ tool scope
  ├─ model route
  ├─ lifecycle
  └─ result/report channel
```

最小生命周期：

```text
created → queued → running → waiting → completed
                                  ├→ failed
                                  ├→ cancelled
                                  └→ blocked
```

能力顺序：

1. `spawn_subagent`：创建子 Agent；
2. `list_subagents`：查看状态；
3. `send_subagent_message`：发送上下文；
4. `wait_subagent`：等待结果；
5. `cancel_subagent`：取消；
6. `report_subagent`：结构化汇报；
7. 并发上限、深度上限、预算上限和工具白名单。

参考：

- DSH `packages/subagent/subagent/` 的 descriptor、lifecycle、parent/child、projection；
- DSH `packages/subagent/tool-subagent/` 和 `tool-subagent-control/`；
- Claude Code 的 Task/Team 工具、`src/coordinator/` 和 `src/utils/swarm/`。

主 Agent 不应直接共享子 Agent 的全部上下文。子 Agent 通过明确的 task contract 输入，通过 report contract 输出。

### Phase 6：A2A 互操作层

**目标**：允许外部 Agent 通过 A2A 调用本项目 Agent 或委派给本项目的 Agent。

前置门禁：Phase 1 Agentic Coding Core、Phase 2 恢复契约和 Phase 5 parent/child lifecycle 均已通过。

前置条件：

- Phase 2 的事件模型稳定；
- Phase 5 的内部 Subagent contract 稳定；
- Session、Task、Artifact、Permission 的生命周期已有稳定 ID；
- MCP 工具不会阻塞 A2A 任务状态机。

A2A 只作为适配层：

```text
A2A HTTP/JSON/SSE adapter
        ↓
AgentTaskService
        ↓
Internal Subagent / AgentHost
        ↓
Session Event Store
```

A2A 适配层负责：

- Agent Card / capability discovery；
- task create / get / cancel；
- message / artifact；
- streaming updates；
- auth、tenant、correlation id；
- 外部任务和内部 Session 的映射。

A2A 不应直接调用 ToolRegistry，也不应绕过本项目的权限和 workspace policy。

### Phase 7：DSH 风格 Web 前端收敛

**目标**：尽量复用 DSH 的前端信息架构，而不是重新设计一套产品。

建议在 `apps/web` 中逐步补齐这些 UI 分区。DSH 的 `packages/client/web`、`web-react`、`connection`、`runtime` 和多个 `ui-*` 包形成的完整依赖闭包较大，因此先复刻 Shell 和信息架构，再按功能选择性移植组件；不要把整个 DSH client workspace 作为本项目依赖。

优先补齐：

- AppRoot / boot status；
- Session sidebar；
- Conversation column；
- Message / reasoning / tool call row；
- Diff card；
- Permission request；
- Terminal/output panel；
- Plan/Todo；
- Subagent activity；
- Settings/model/provider；
- Workspace picker。

改动范围只包括：

- 项目名称和品牌；
- icon、logo、颜色、文案；
- API client 和事件类型；
- 本项目独有的权限和模型配置。

不要在这个阶段重做交互范式。优先让 UI 对本项目后端协议适配。

### Phase 8：高级能力和产品化

只有前面阶段稳定后再做：

- worktree / branch workspace；
- LSP；
- Code Mode / `run_code`；
- background jobs；
- scheduled tasks；
- model fallback / retry policy；
- session fork / replay / export；
- remote auth、multi-user、quota；
- desktop wrapper。

## 6. 统一事件和任务契约

### 6.1 事件是不变量

每个运行状态都必须能由事件解释：

```text
用户输入 → turn/started
模型输出 → assistant/chunk / assistant/message
工具调用 → tool/call
工具执行 → tool/progress / tool/result
需要批准 → permission/requested
批准完成 → permission/resolved
运行结束 → turn/ended
```

禁止只更新数据库状态而不追加事件，也禁止只推送 UI 事件而不落盘。

### 6.2 工具契约是不变量

任何工具，无论是内置工具还是 MCP 工具，都必须经过同一个流程：

```text
discover → schema validate → policy check → approval
        → execute → progress → structured result
        → presentation → event append
```

### 6.3 任务契约是不变量

主 Agent、Subagent、A2A 外部任务都统一映射到：

```text
TaskId
SessionId
ParentTaskId?
WorkspaceId
status
input
output/artifacts
budget
created_at / updated_at
cancel / retry semantics
```

## 7. 防止目标、任务和规则漂移

### 7.1 每个功能必须回答五个问题

1. 它属于哪个 Phase？
2. 它是在解决 Agent Runtime、工具、协议还是 UI 问题？
3. 它是否改变了事件契约？
4. 它是否改变了权限或 workspace 安全边界？
5. 它是否已经有对应的验收场景？

### 7.2 参考优先级

发生冲突时按以下顺序裁决：

1. 本文的最终目标和安全边界；
2. 本项目的事件/工具/任务契约；
3. DSH 的运行时和 Web 结构；
4. Claude Code 的工具和交互行为；
5. 单个实现细节或个人偏好。

### 7.3 禁止的漂移信号

出现以下情况时暂停编码并记录决策：

- 为了“像 DSH”而引入完整插件框架，但没有对应用户场景；
- 为了“像 Claude Code”而复制 CLI、账户、遥测或商业服务；
- MCP 工具绕过统一权限和事件体系；
- A2A 直接进入 ToolRegistry；
- 子 Agent 直接共享父 Agent 的全部 Session；
- 前端开始重新设计交互，而后端事件契约尚未稳定；
- 没有回归测试就替换已有的工作区和命令安全策略。

## 8. 质量门禁

每个 Phase 至少需要以下测试类型：

- 单元测试：schema、状态机、路径、权限、事件序列；
- 合同测试：LLM stream、MCP adapter、SSE、A2A adapter；
- 恢复测试：断线、重启、重复请求、重复审批、取消；
- 安全测试：路径穿越、命令注入、权限绕过、输出泄露；
- e2e：浏览器完成一个真实的 coding task；
- 回放测试：从事件日志重建 UI 和 Session 状态。

核心验收任务固定为以下四个：

1. **Read-only**：定位一个函数并解释调用关系；
2. **Edit**：修改一个文件并显示 diff；
3. **Test**：运行测试并展示 stdout/stderr/exit code；
4. **Delegation**：主 Agent 委派子 Agent，等待结构化报告并继续任务。

## 9. 第一批实现顺序

第一批不追求“大而全”，只做能锁定后续方向的垂直切片：

1. 创建 TypeScript workspace 和 Node.js API 入口；
2. 定义事件、工具、任务三个 TypeScript contract；
3. 实现 DSH 风格 `AgentHost`、turn/step 和 SSE replay；
4. 接入 OpenAI-compatible streaming adapter；
5. 实现 `read_file`、`glob`、`grep`、`edit_file` 和 diff presentation；
6. 实现 permission request/resolution；
7. 将 DSH 风格 Web shell 接到 TypeScript API；
8. 通过 Read-only/Edit/Test 三个 e2e 场景；
9. 再开始 MCP Client；
10. MCP 稳定后再开始 Subagent；
11. Subagent 稳定后再开始 A2A。

## 10. 当前建议的下一步

下一步不是立即实现 MCP 或 A2A，而是先建立 Phase 0 和 Phase 1 的 TypeScript 基线与契约：

- `event-contract.md`；
- `tool-contract.md`；
- `protocol-boundaries.md`；
- `architecture-decisions.md`；
- TypeScript monorepo 和运行脚本；
- 流式模型的最小接口；
- SSE 的最小接口；
- `edit_file` 的最小工具契约。

这三个契约一旦稳定，后面的 MCP、Subagent、A2A 和 DSH 风格前端都可以接在同一条运行时主干上，而不会各自发明一套状态、消息和权限模型。
