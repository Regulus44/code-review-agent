# Architecture Decisions

本文记录 Coding Agent 重建期间不可随意改变的架构决策。新的设计以 DSH 的 TypeScript 分层和 Web 信息架构为主参考，以 Claude Code 的 Agent 行为、工具体验、权限和上下文策略为行为参考。

## ADR-001：后端重建为 TypeScript/Node.js

状态：accepted

目标后端使用 TypeScript/Node.js。旧 Python 原型不进入新 Runtime 的 import graph，也不作为新 API、Session、Tool 或 Event 类型的来源。

TypeScript 版本已经通过 Read-only、Edit、Test 三个垂直场景，旧 Python 源码、测试和启动入口已从工作树移除。历史行为和迁移决策通过 Git 提交与开发日志保留，当前运行时只保留一套 TypeScript 实现。

## ADR-002：DSH 负责主骨架，Claude Code 负责行为层

状态：accepted

选择 DSH 作为主骨架，因为它的本地快照已经提供了适合网页 Coding Agent 的 TypeScript 包分层、Session API、事件 API、MCP client、Subagent 和 Web 前端组织方式。

选择 Claude Code 作为行为参考，因为它在单次 turn 内的流式工具调度、工具权限、文件编辑体验、上下文压缩和任务协调方面更接近成熟 Coding Agent 的用户行为。

冲突时使用以下顺序裁决：

1. 本项目的事件、工具、任务和 workspace 安全不变量；
2. DSH 的包边界、Session/Event API 和 Web 信息架构；
3. Claude Code 的工具行为、权限交互和上下文处理；
4. 当前实现的便利性。

## ADR-003：允许按许可边界选择性借鉴上游代码

状态：accepted

本项目不复制整个上游仓库，但允许在许可证和来源清晰的前提下选择性复用代码或代码片段：

- DSH 根仓库明确为 MIT，可以作为代码和结构的主要来源；复制其代码时保留版权和许可证声明，并记录来源文件；
- Claude Code 本地快照没有发现根 `LICENSE` 文件，因此默认只把它当作源码级参考；只有确认某个具体包或文件有兼容许可证、或取得明确授权后，才复制实现代码；
- 在未确认许可前，可以自由复刻目录边界、类型设计、状态机、算法思路和行为测试，但不整段搬运实现；
- 新文件必须保留本项目的版权、测试和安全策略，不把第三方内部类型直接暴露为公共 API。

## ADR-004：不复制整个上游仓库

状态：accepted

本项目建立自己的 TypeScript workspace，只选择性重建下列最小闭包：

```text
packages/contracts
packages/llm
packages/storage
packages/workspace
packages/tools
packages/runtime
packages/protocols
apps/api
apps/web
```

不复制 DSH 的全部 Cordis、插件、桌面端、工作流和发布系统；不复制 Claude Code 的 CLI、账户、遥测、商业服务或与本项目无关的逆向工程实现。每次引入上游设计都必须能映射到一个本项目验收场景。

## ADR-005：Web 先于复杂协议，但后端事件先于 UI 定制

状态：accepted

`apps/web` 在 Phase 1 就建立 DSH 风格的 Shell，使 Session sidebar、Conversation、Tool row、Diff、Permission 和 Terminal 等区域尽早验证。但 UI 只能消费本项目的事件和 API 类型，不能直接依赖 DSH 内部类型。

在事件重放、断线重连和权限请求稳定之前，不做大规模视觉或交互创新。品牌、图标、颜色、文案和 API client 可以替换；信息架构不重新发明。

## ADR-006：协议按 MCP → 内部 Subagent → A2A 的顺序引入

状态：accepted

- MCP 是外部工具、资源和 Prompt 接入协议，先实现 MCP Client；
- 内部 Subagent 是本项目自己的任务委派模型，先稳定父子 Session、权限和报告契约；
- A2A 只作为外部 Agent 互操作适配层，必须映射到内部 Task/Session，不能直接调用 ToolRegistry。

这样可以避免在内部任务模型尚未稳定时，用 A2A 的外部协议反过来决定核心 Runtime。

## ADR-007：事件日志是唯一事实来源

状态：accepted

所有 model-visible 状态变化、工具调用、权限请求、子任务生命周期和用户消息都先追加到 EventStore，再投影给 Web、查询 API 或外部协议。SSE 断线后按 sequence 重放，不能只依赖内存状态或“turn 完成后保存整段消息”。

## ADR-008：安全策略属于本项目

状态：accepted

DSH 和 Claude Code 的工具体验可以参考，但 workspace resolver、路径穿越防护、命令执行 policy、输出截断、权限审批和审计字段由本项目维护。任何 MCP、Subagent 或 A2A 调用都必须经过同一套权限和 workspace 检查。

## ADR-009：System prompt 使用静态 section 与动态 turn context

状态：accepted

Coding Agent 的 system prompt 采用可测试的 section builder，而不是长期维护一段无法审计的字符串。静态部分约束身份、任务执行、工具优先、读后编辑、权限、安全、验证、沟通和恢复行为；动态部分只注入当前 Session 的 workspace、经过 policy 过滤的可见工具、可选 permission preset、恢复状态和应用级补充指令。

选择这一结构是因为 Claude Code 的 prompt section pipeline 能清晰区分长期行为与 session/environment context，DSH 的生命周期和工具管线则要求 tool/permission/event 的事实来自运行时，而不是 prompt 自己声明。工具 schema 继续通过 `ModelRequest.tools` 传递，外部 MCP 描述不直接作为可信指令拼进系统规则。

以下规则不可由应用级自定义 prompt 覆盖：workspace 边界、权限审批、工具结果信任边界、秘密保护和完成前验证。尚未进入真实 ToolRegistry 的 Subagent、A2A、LSP、Worktree、Web Search、Skills、上下文压缩和图像/Notebook 不得在 prompt 中宣称可用。

## ADR-010：MCP 配置与凭据引用持久化，但秘密不进入事件事实源

状态：accepted

MCP server 配置由 SQLite 的 `mcp_server_configs` 表持久化，记录 scope、owner/workspace/session binding、enabled、revision、非敏感 transport config 和 opaque `credentialRef`。credential material 只能由 host-owned resolver 在 transport 创建时短暂注入；token、Authorization、cookie、private key 和 credential-shaped env/header 不得进入普通 config JSON、EventStore、projection、SSE、Web 或 model view。

## ADR-011：MCP discovery 使用可验证的 generation swap 与不可信内容边界

状态：accepted

每个 MCP server 独立维护 generation、client、transport、discovery catalog 和工具 ownership。list-changed 只能排队触发串行 discovery；候选 generation 必须在 schema 预算、policy、allowlist 和 registry conflict 校验完成后原子替换旧工具。旧 generation 的回调被 generation guard 丢弃。

外部 tool/resource/prompt description 和结果都是不可信数据。ToolRuntime 仍是 MCP tool 的唯一执行入口；resource/prompt 只能产生有界 model view 和低优先级追加上下文，不能覆盖本地 system prompt、workspace、permission、security 或 verification 规则。

## ADR-012：Phase 7 Web 收敛不等待 A2A

状态：accepted（2026-08-23）

Phase 5 已完成内部 Task/Subagent、父子 Session、权限、workspace、MCP scope、report、cancel 和恢复语义。当前产品目标是 Web Coding Agent，暂无跨产品或跨组织 Agent 互操作的验收场景，因此 Phase 6 A2A 暂缓，不作为 Phase 7 Web 收敛的前置门禁。

Phase 7 只消费本项目内部 EventStore、Session、Task、Permission 和 Workspace projection；不把 A2A 作为内部 Subagent transport，也不在 Web contract 中预留未经验证的外部 envelope。未来恢复 Phase 6 时，A2A 仍必须作为 inbound adapter 映射到已有内部 Task/Session，并独立完成 Agent Card、认证、租户、Artifact、流式恢复和安全验收。完整记录见 [`docs/adr/phase-7-web-with-a2a-deferred.zh-CN.md`](adr/phase-7-web-with-a2a-deferred.zh-CN.md)。

## ADR-013：Context Window 与 Auto-Compact Budget 由独立预算层计算

状态：accepted（2026-08-26，M01）

上下文窗口、输出预留、auto-compact buffer、warning/error/auto/blocking threshold 不再由 `packages/compaction` 的固定压缩参数隐式推导。新增 `@code-review-agent/context` 预算层，输入为 `ModelContextCapability` 与 `ContextBudgetConfig`，输出为 request-scoped `ContextBudgetSnapshot` 和 `ContextWarningState`。

本决策直接仿照 Claude Code `src/utils/context.ts` 与 `src/services/compact/autoCompact.ts` 的职责分离：窗口能力只回答 provider/model 的上限；effective window 先扣除摘要/输出预留；auto-compact buffer 按窗口大小选择 13K、30K 或 50K；blocking threshold 单独保留 3K 手动 compact headroom。M01 不实现精确 token API、tool pairing、microcompact、summary agent、boundary recovery 或 context collapse，它们分别属于后续 M02、M04–M14。

模型 adapter 通过 `ChatModel.contextCapability` 提供能力；tenant route 可以附带同一份无秘密 capability。没有能力元数据时，host 使用保守 fallback，并把 snapshot `source` 标记为 `estimate`；host policy 覆盖窗口或输出预留时标记为 `hybrid`。每个 `step/started` 事件记录脱敏预算快照和 warning state，EventStore 仍是唯一事实来源，重放不依赖内存预算状态。

旧 `ContextBudget` 的 `maxTokens/recentMessageTokens/maxToolResultChars/maxSummaryChars` 继续作为 compaction 兼容配置。runtime 只把 M01 的 `autoCompactThreshold` 映射为当前压缩 gate；更精确的消息计数和工具结果预算必须等待对应模块，不能在 M01 内复制新的估算器。

## ADR-014：Token 计数采用 estimate-first、boundary-exact 的双路径

状态：accepted（2026-08-26，M02）

上下文 token 计数由 `@code-review-agent/context` 的 `TokenCounter` 统一抽象。每个请求先使用 provider-neutral estimate；只有模型 capability 声明支持 exact count，且 estimate 已接近 warning 或 predictive boundary 时，才调用可选的 `ChatModel.countTokens()`。这样保留 Claude Code 的热路径低延迟和关键决策高准确度。

估算结果必须携带 `source`、`confidence` 和 breakdown。exact 调用失败不能返回 0，也不能覆盖为虚假的 provider usage：没有显式 stale usage 时保留 estimate 并记录 `exactError`；只有调用方明确提供旧 usage 时才允许返回 `source: "stale_usage"`。Runtime 将 token count 诊断写入 `step/started`，不把 provider 原始 body 或凭据写入事件。

M02 的 estimator 只处理当前 model-visible messages/tools，不负责 API round、消息 normalize、tool pairing、工具结果裁剪、附件恢复或 provider-specific SDK；这些能力按研究文档的 M03–M14 模块继续实现。

## ADR-015：Canonical Context Assembly 统一 model-visible 请求输入

状态：accepted（2026-08-26，M03）

每次模型请求必须由一个 canonical `ContextAssembly` 同时提供 system prompt、history、attachments、visible tool schemas 和 M02 token estimator 的 `ModelContextView`。Runtime 不得分别手工构造“用于计数的消息”和“用于发送的消息”，也不得在 `runTurn()`、恢复流程和 tool loop 中维护互相漂移的 system prompt 拼装逻辑。

System prompt 使用稳定的 static/dynamic section 分层。static section 负责 identity、task execution、safety、verification 和 communication；dynamic section 负责当前工具、tool guidance、workspace、permission、recovery 和 custom instructions。Assembler 按 `phase → order → id` 排序，tools 按名称排序，history 保留事件回放顺序，attachments 按 `order → id` 排序。外部文件、MCP、工具结果和应用上下文都通过明确的 untrusted-data wrapper 进入 model view，不能覆盖本地安全、workspace、permission 或 verification 规则。

Assembler 对规范化后的 sections、tools、history、attachments 生成稳定 fingerprint，并在 `step/started.payload.contextAssembly` 中记录 fingerprint 和 section/attachment IDs。fingerprint 只用于 request/replay 关联，不替代 EventStore sequence，也不把完整 prompt、凭据或外部原文写入事件。

M03 不实现 API round、message normalize、tool pairing、tool-result microcompact、summary agent、durable compact boundary 或 overflow recovery；这些能力必须在后续 M04–M10 中按研究文档单独接入。compact 或 tool loop 改变 model-visible history 后，Runtime 必须重新调用 assembler 并重新计数。

回滚策略：删除 M03 assembler 接入并回退到 M02 checkpoint；新增 section 类型和 `contextAssembly` 诊断字段均保持附加兼容，不要求旧事件迁移。

## 参考代码入口

- DSH Agent Loop：`D:/Develop/deepseek-harness-fork/packages/core/agent-loop/src/agent.ts`
- DSH 工具调度：`D:/Develop/deepseek-harness-fork/packages/core/agent-loop/src/tool-calls.ts`
- DSH Session API：`D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/sessions.ts`
- DSH Event API：`D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/events.ts`
- DSH Web：`D:/Develop/deepseek-harness-fork/packages/client`、`D:/Develop/deepseek-harness-fork/apps/web`
- Claude Code Agent Loop：`D:/Develop/claude-code/src/query.ts`
- Claude Code Streaming Tool Executor：`D:/Develop/claude-code/src/services/tools/StreamingToolExecutor.ts`
- Claude Code 工具总表：`D:/Develop/claude-code/src/tools.ts`
- Claude Code 上下文压缩：`D:/Develop/claude-code/src/services/contextCollapse`
