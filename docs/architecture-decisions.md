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

## ADR-016：模型请求统一经过 API Round 与 Tool Pairing Gate

状态：accepted（2026-08-26，M04）

所有发送给 provider 的 model-visible messages 必须经过统一的 normalize → pairing → round grouping gate。API round 按 assistant `responseId` 分组，不按 user turn 切分；同一 response 的 streaming assistant chunks、tool calls 和 tool results 保持同一 round。旧事件没有 responseId 时继续兼容，并归入无 ID round。

消息合法性提供 `repair` 与 `strict` 两种模式。Runtime 默认 `repair`：合并同 response 的 assistant chunks，规范化 tool id/name/arguments，移除 duplicate/orphan result，并为 missing result 插入有界 synthetic error result。`strict` 模式发现任何问题即拒绝本次模型请求，避免在安全敏感或调试场景下静默修复。

repair 只改变 model-visible view，不删除或修改 EventStore transcript、工具审计结果或用户可见历史。实际修复追加 `context/messages_normalized` 和 `context/tool_pairing_repaired` 事件；`step/started` 记录 round 数量、issue codes、synthetic/removed 统计。事件不得包含完整工具输出、provider body、凭据或未脱敏 prompt。

每个 model step 生成 `modelRequestId`，成功 assistant message 写入 `requestId` 与 `responseId`。Runtime 重启后从 EventStore 恢复 responseId，round grouping 不依赖进程内缓存。compact 后和每个 tool loop 下一步都必须重新执行 gate。

M04 不包含 M05 工具结果 microcompact、provider cache edit、summary agent、compact boundary 或 overflow recovery。回滚时可退回 M03 assembly；新增字段和事件均采用兼容追加方式。

## ADR-017：Tool Result Budget 只改变 model view，MicroCompact 通过白名单和幂等 receipt 工作

状态：accepted（2026-08-26，M05）

M05 在 M04 normalize/pairing gate 之后增加工具结果局部预算层。`packages/context/src/tool-result-budget.ts` 可以对可压缩工具结果做 per-result bounded view，并按 count、bounded token 总量或结果年龄触发 microcompact；清理结果使用 `[Old tool result content cleared]` marker。默认 compactable 白名单覆盖 Read/Bash/Grep/Glob/WebSearch/WebFetch/Edit/Write 语义，不在白名单中的工具结果保持完整。

model view 与 transcript 必须分离。`applyToolResultBudget()` 永远返回新消息数组，不能修改 EventStore 中的 `tool/result` payload、审计原文或用户可见历史。Runtime 的 token estimator 和 provider request 必须消费同一份 `prepared.view`，避免预算诊断与实际请求漂移。

pending permission 或 interaction 对应的 tool call 进入 protected set；protected 结果本阶段不 bounded、不 cleared。Runtime 从 projection 获取 protected IDs，从 EventStore 获取 `tool/result.createdAt`，每个 turn 维护 `alreadyClearedToolCallIds`，保证同一旧结果不会在每个 step 重复追加 microcompact receipt。Runtime 重启后允许根据当前 policy 重新构造 model view，因为 transcript 才是唯一事实来源。

M05 追加 `context/tool_results_budgeted` 和 `context/microcompacted` 事件，并在 `step/started.payload.toolResultBudget` 保存 counts、IDs、trigger、tokensSaved、protected IDs 和 policy 摘要。事件不得包含完整工具输出、prompt、provider body、credential 或 secret。

Claude Code 的 `cachedMicrocompact.ts` 只作为行为参考，provider cache edit 暂不实现。该能力依赖具体 provider 的 cache state、request boundary 和 replay contract，不能在多 provider Runtime 中假设通用语义。M05 不包含 Session Memory、LLM summary、compact boundary、overflow recovery 或 UI projection。

回滚策略：移除 M05 budget gate、两个事件类型、step 诊断字段和对应测试，即可回到 M04 的合法消息 view；旧 `contextBudget.maxToolResultChars` 兼容映射不要求事件迁移。

## ADR-018：Session Memory Compact 优先使用已有摘要，边界不可靠时回退

状态：accepted（2026-08-26，M06）

M06 在 M05 model-view reduction 和 legacy summary compact 之间增加只读的 SessionMemoryStore adapter。Store 只提供已有 memory 内容、可选 `lastSummarizedMessageId` 和更新时间；M06 不负责 memory extraction/update，后者留给 M11。Session memory 与 Project Memory 是不同边界，不能把项目级 `MEMORY.md` 当作本模块输入。

已知边界时，保留窗口从 `lastSummarizedMessageId` 后开始；窗口不足 `minTokens` 或 `minTextBlockMessages` 时向前扩展，达到 `maxTokens` 后停止。无边界 ID 但 memory 有内容时采用 resumed-session 保守策略，从尾部向前扩展。已知 ID 不存在于当前 transcript 时不得猜测边界，必须追加 `context/session_memory_compaction_failed` 并回退 legacy `compactMessages()`。

起点调整必须先于消息丢弃完成。保留区内的 tool result 会向前补齐对应 assistant tool call；保留区内 assistant 的 `responseId` 会向前补齐同一 streaming response 的旧片段。system message 和 pending/protected tool call 永远保留。M04 normalize/pairing 在随后 provider 请求前继续运行。

Session memory 以 `<session-memory>` 不可信历史上下文 wrapper 注入 model view，并受 `maxMemoryChars` 限制。Runtime 请求与 token estimator 使用同一 compacted `prepared.view`。原始 transcript、memory store 内容和 compact receipt 分离；事件只保存 kind、边界是否可靠、计数、memory 长度、更新时间和 fallback 原因，不保存 memory 原文或 provider body。

成功追加 `context/session_memory_compacted`，storage projection 将最近上下文压缩标记为 `kind=session_memory`；读取异常或边界缺失追加 `context/session_memory_compaction_failed`。M06 不实现摘要模型、Session Memory extraction、Project Memory、compact boundary、post-compact rebuild 或 reactive overflow recovery。

回滚策略：移除 SessionMemoryStore 注入、M06 keep-window adapter、两个事件类型和 projection kind 即可恢复 M05 后的 legacy compact；`ChatMessage.messageId` 与新增字段均为可选，不要求旧事件迁移。

## ADR-019：LLM Summary Compact 使用独立无工具请求和有界 PTL 重试

状态：accepted（2026-08-26，M07）

M07 位于 M06 Session Memory Compact 之后、legacy deterministic compact 之前。M06 未成功替换历史时，Runtime 使用当前 tenant model 发起独立的 `purpose=context_summary` 请求；该请求固定 `tools=[]`、`toolChoice=none`，不得进入普通 ToolRuntime，也不得产生主会话的 `assistant/chunk` 或 `assistant/message` 事件。摘要 usage 单独写入 summary receipt。

摘要输入必须是与主 model view、EventStore transcript 分离的不可变副本。输入阶段移除内部 `messageId`，把 image/document 替换为 bounded marker，并去除压缩后会再次注入的 skill attachment。摘要输出以不可信历史上下文 wrapper 注入 model view，保留近期消息和 API pairing 边界。

摘要请求返回 prompt-too-long、context length、413 或 too-many-tokens 时，按 API round 从头部删除完整 group；首条变为 assistant 时插入 synthetic user marker；retry marker 在下一次重试前移除，最多执行 `maxPtlRetries`（默认 3）次。非 PTL、空摘要或重试耗尽均记录结构化失败，并回退现有 legacy compact。

Runtime 追加 `context/summary_started`、`context/summary_retried`、`context/summary_compacted` 和 `context/summary_compaction_failed`；Storage projection 将 summary compact 标记为 `kind=summary`。事件不得包含 provider body、完整摘要请求、工具输出或 memory 原文。

M07 不实现 provider prompt-cache sharing、PreCompact/SessionStart 外部 hooks、compact boundary、post-compact attachments 和 reactive overflow recovery；这些能力必须在后续模块或 provider adapter 中单独决策。

回滚策略：移除 summary input/compact 模块、Runtime summary gate、四类 summary 事件、`ModelRequest.purpose` 和 projection kind 即可恢复 M06 后的 compact 顺序；旧事件无需迁移。

## ADR-020：Compact Boundary 是 durable model-view 重建锚点

状态：accepted（2026-08-26，M08）

M08 在 M06/M07/legacy compact 成功后追加独立的 context/compact_boundary 事件。事件保存 version=1 的 ContextBoundaryMetadata、summary/preserved 统计、preserved segment 的 head/anchor/tail、pre-compact token 和附件 ID/kind/tokenEstimate。EventStore transcript 永远保留完整原始消息；boundary 只决定后续 model view 的重建范围。

Post-compact model view 固定按 boundary → summary → preserved → bounded attachments 排列。附件通过 host-owned PostCompactAttachmentProvider 生成，默认只恢复当前 active/draft/approved plan；文件最多 5 个，总附件、单附件和 skill 分别受 token cap 限制。已有 attachment ID 和 preserved segment 中的 context-attachment 不重复注入。

Runtime 重启或新 turn 时优先读取 projection boundary 的 preserved head，在完整 transcript 中找到该消息后截取后缀并重新插入 boundary/summary；head 缺失时走兼容完整历史，不猜测或静默丢弃消息。附件原文、完整工具输出、provider body、凭据和 secret 不进入 boundary 事件。

context/post_compact_rebuild_failed 只记录 bounded provider error；附件重建失败不撤销已成功的 compact boundary，也不阻塞后续 turn。M08 不实现 reactive overflow recovery、provider prompt cache edit、完整 Session Restore、Session Memory extraction 或 Project Memory。

回滚策略：移除 boundary/post-compact 模块、两个 M08 事件和 Runtime rebuild wiring，继续使用 M07/M06 compact result；既有 transcript 和旧 compact 事件无需迁移。

## ADR-021：主动与反应式上下文恢复使用请求级状态机和熔断

状态：accepted（2026-08-26，M09）

M09 在每个 `runSteps()` turn 内创建独立的 `ContextRecoveryGuard`，将请求前主动 compact 与 provider overflow 后的 reactive compact 纳入同一条可重放诊断链。guard 不使用全局布尔值：同一 turn 默认最多一次 reactive attempt，连续三次 compact 无有效缩减时打开 circuit；compact 成功清零连续失败计数。不同 session/turn 的 guard 互不共享。

Provider error 必须先经过 provider-neutral 分类。HTTP 413、prompt/context too long、too many tokens 归入 `prompt_too_long`；带 image/media/document/attachment 语义的容量错误归入 `media_too_large`；tool pairing、schema 和普通网络错误不触发 M09 compact。分类器只读取 status/code/providerCode 和 bounded message，不能把 provider body、凭据或完整 prompt 写入事件。

Reactive compact 发生在 provider 已返回错误之后，成功后使用同一 `turnId` 重新进入 query loop；失败直接暴露原错误，不创建新的 transcript message，也不继续执行可能注入更多上下文的 stop hook。请求 hash 对发送给 provider 的 model-visible messages/tools 做稳定 SHA-256 指纹，用于关联 recovery_started、transition、succeeded、failed 和 circuit_open 事件。

新增事件类型为 `context/recovery_started`、`context/recovery_transition`、`context/recovery_succeeded`、`context/recovery_failed` 和 `context/recovery_circuit_open`。Storage 只投影最近一次 `ContextRecoveryProjection`；EventStore transcript 和 M08 boundary 仍是事实来源。M09 不实现 context collapse、provider cache edit、hooks、Session Memory extraction 或完整 transcript restore。

回滚策略：删除 `packages/context/src/recovery.ts`、Runtime recovery catch、LLM provider status 适配、五类 recovery 事件和 `contextRecovery` projection，即可回到 M08 compact 行为；既有 M01–M08 事件无需迁移。

## ADR-022：Transcript 永久保留，Boundary Replay 只重建 model view

状态：accepted（2026-08-26，M10）

M10 将 EventStore transcript 与 model-visible context 明确分成两个 reducer。user/message、assistant/message、tool/result 等原始事件永久按 sequence 保留；`context/compact_boundary` 和 `context/transcript_segment` 只保存 boundary、算法版本和 preserved head/anchor/tail 的有界链接。重启、SSE replay 或跨进程打开时，Runtime 使用纯函数 replay builder 从完整 transcript 重建 boundary → summary → preserved suffix，不把压缩后的 view 写回 transcript。

preserved segment 的 message ID 必须是 EventStore append 返回的 durable `eventId`。Runtime-only 的 turnId、responseId 或 toolCallId 只能作为兼容 fallback，不能作为跨进程边界锚点。segment 缺失 boundary、boundary ID 不一致、head 不存在或 projection 不完整时，必须返回完整 transcript，不得猜测 sequence 或静默丢弃历史。

`context/session_restored` 是恢复诊断 receipt，保存 mode、boundary ID、algorithm version、source sequence 和 bounded reason；Storage 只投影最近一次决定，不能把 receipt 当作新的消息事实。M08 旧 boundary 没有 algorithmVersion 时按 `legacy-boundary-v1` 兼容读取。

该决策直接参考 Claude Code `src/services/sessionTranscript/`、`src/utils/sessionRestore.ts` 和 `src/utils/messages.ts` 的 transcript/boundary/resume 分工；由于本地 sessionTranscript 文件为 stub，本项目不复制 JSONL loader，而使用已有 EventStore、SQLite projection replay 和本项目 Session/Tool/Permission contract 重新实现。

回滚策略：停止追加 M10 两类事件并移除 replay builder/restore projection，回退到 M08 boundary slice；已存在的 M10 事件保留为未知扩展，原始 transcript 不删除。

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
