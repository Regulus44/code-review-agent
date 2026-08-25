# Claude Code 上下文管理机制调研与本项目演进依据

状态：`research`（仅调研，不代表已接受的实现决策）  
日期：2026-08-26  
归属：Phase 8 上下文管理能力的后续演进  
范围：`D:/Develop/code-review-agent` 与本地参考快照 `D:/Develop/claude-code`

## 1. Claude Code 上下文管理的总体架构分层

Claude Code 的上下文系统可以拆成八层。每层都有独立的输入、输出、持久化边界和失败处理；自动压缩只是其中一层。

| 层级 | 模块 | 负责的问题 | 主要输出 | Claude Code 主要入口 |
|---|---|---|---|---|
| L1 | 模型能力与预算层 | 当前模型能接收多少输入、需要为输出和摘要预留多少空间 | `ContextWindow`、`EffectiveWindow`、warning/auto/blocking threshold | `src/utils/context.ts`、`src/services/compact/autoCompact.ts` |
| L2 | Token 计数层 | 如何快速估算、何时调用 provider 精确计数、如何处理图片/JSON/tool input | `TokenCount { value, source }` | `src/services/tokenEstimation.ts`、`src/services/compact/microCompact.ts` |
| L3 | Context Assembly 层 | 如何把 system prompt、工具 schema、用户上下文、历史和附件组装成一次请求 | canonical model context view | `src/constants/prompts.ts`、`src/context.ts`、`src/utils/messages.ts` |
| L4 | API 消息合法性层 | streaming assistant 如何合并、API round 如何划分、tool_use/tool_result 如何配对 | normalized API messages、pairing report | `src/services/compact/grouping.ts`、`src/utils/messages.ts` |
| L5 | Context Reduction 层 | 先清理哪些内容、何时 microcompact、何时 Session Memory、何时调用摘要模型 | reduced context、compact result | `src/services/compact/microCompact.ts`、`sessionMemoryCompact.ts`、`compact.ts` |
| L6 | Post-Compact Rebuild 层 | 压缩后如何重新注入最近文件、plan、skill、MCP 和 hooks | boundary + summary + preserved + attachments | `src/services/compact/compact.ts` |
| L7 | Overflow Recovery 层 | provider 已返回 400/413 或 prompt-too-long 后如何降级、重试和熔断 | retry transition、recovery receipt、final error | `src/query.ts`、`src/services/compact/reactiveCompact.ts` |
| L8 | 持久化、记忆和观测层 | 原始 transcript、boundary、Session/Project Memory、usage 和 UI 诊断如何保存/恢复 | replayable context state、context diagnostics | `src/services/sessionTranscript/`、`src/utils/sessionRestore.ts`、`src/services/SessionMemory/`、`src/memdir/` |

### 1.1 从会话到模型请求的完整数据流

```text
Event / transcript / runtime state
    ↓
L8 读取历史、最近文件、plan、memory、MCP 状态
    ↓
L3 组装 system sections + user context + conversation view
    ↓
L1 解析模型窗口、输出预留、阈值
    ↓
L2 快速 token estimate（必要时 exact countTokens）
    ↓
L5.1 snip / tool-result budget / microcompact
    ↓
L5.2 Session Memory Compact（已有结构化摘要时优先）
    ↓
L5.3 LLM Summary Compact（需要模型调用时）
    ↓
L6 生成 compact boundary、summary、保留消息和附件
    ↓
L4 API round grouping + normalize + tool pairing validation
    ↓
L1 再次检查 blocking/predictive threshold
    ↓
Model provider request
    ├─ 成功 → usage、assistant/tool events、L8 transcript
    └─ 400/413 → L7 collapse/reactive compact/retry/circuit breaker
```

### 1.2 三种同时存在的上下文

Claude Code 实际上维护三种不同视图，不能把它们混成一个 `messages[]`：

| 视图 | 内容 | 是否允许被压缩 | 用途 |
|---|---|---|---|
| Durable transcript | 完整 user、assistant、tool、hook、attachment 和错误事件 | 不删除 | UI、审计、恢复和回放 |
| Runtime conversation state | 当前进程为了继续 loop 保存的状态 | 可以释放大对象 | 工具执行、permission、steering、取消 |
| Model-visible context view | 本次请求最终发送给 provider 的内容 | 可 microcompact、summary、重建 | token budget 和模型推理 |

这一区分是 Claude Code 工具结果压缩、缓存编辑和压缩后重建的基础，也是本项目后续不应继续直接修改原始 `messages` 的原因。

## 2. Claude Code 的模块与子功能总表

下面的表格是后续逐模块阅读和实现的索引。后文按此顺序展开。

| 模块 | 子功能 | 入口文件/函数 | 关键数据 | 对本项目的参考方式 |
|---|---|---|---|---|
| 模型预算 | context window 解析、输出 token 预留、auto compact buffer、warning/error/blocking | `context.ts:getContextWindowForModel()`；`autoCompact.ts:getEffectiveContextWindowSize()`、`getAutoCompactThreshold()`、`calculateTokenWarningState()` | model capability、effective window、threshold | 直接仿照分层接口；替换为本项目 provider/model route |
| Token 技术 | rough estimate、精确 countTokens、provider fallback、媒体和结构化内容估算 | `tokenEstimation.ts:countMessagesTokensWithAPI()`、`roughTokenCountEstimation()`；`microCompact.ts:estimateMessageTokens()` | `TokenCount.source`、input usage | 直接仿照“两级计数”，禁止把未知计数当 0 |
| Context assembly | 静态/动态 system prompt、user context、tool schemas、attachments、memory | `src/context.ts`、`constants/prompts.ts`、`utils/messages.ts` | system sections、dynamic boundary、attachment | 对应本项目 `system-prompt.ts` 和 ContextAssembler |
| 工具结果预算 | 每工具最大结果、媒体大小、结果内存释放 | `query.ts:526-582`、`microCompact.ts:137-205` | tool result view、content replacement | 先实现本地 bounded view，不先做 provider cache edit |
| MicroCompact | 时间衰减、旧工具白名单、最近 N 个结果、cached microcompact | `microCompact.ts:257-365,426-520`；`cachedMicrocompact.ts` | cleared tool IDs、tokens saved、cache edits | 直接仿照无损 transcript + 可变 model view |
| API round | assistant response ID 分组、streaming chunk 合并边界 | `grouping.ts:22-63` | `responseId`、round groups | 本项目 assistant event 要补 response/request ID |
| Tool pairing | 缺 result、孤儿 result、重复 ID、server tool result、strict/repair | `messages.ts:2292-2670,5591-5947` | pairing report、synthetic result | 作为所有模型请求的共同 API gate |
| Session Memory Compact | 已摘要边界、保留窗口、文本消息最小数、tool pair 回溯 | `sessionMemoryCompact.ts:234-390,516-590` | last summarized UUID、memory file、preserved segment | 后续独立 memory store/adapter；不与 Project Memory 混用 |
| Summary Compact | pre-hook、媒体剥离、fork summary agent、PTL retry | `compact.ts:411-690` | summary usage、retry count、recompaction info | 直接仿照状态机；摘要 agent 禁止工具 |
| Boundary | compact/microcompact marker、pre token、summary range、preserved segment | `messages.ts:4967-5090`；`compact.ts:373-389` | boundary metadata、head/anchor/tail | 变成 durable Event/Projection，而非普通 user message |
| Post-Compact | 最近文件、plan、skill、MCP、agent listing、SessionStart | `compact.ts:1467-1650`、`buildPostCompactMessages()` | bounded attachments、dedupe | 对应 `ContextRebuilder`，每类附件单独预算 |
| Reactive Recovery | prompt-too-long、media error、collapse drain、一次恢复重试 | `query.ts:1349-1470`、`reactiveCompact.ts` | transition、hasAttempted、error class | 对应本项目 `ContextRecoveryCoordinator` |
| Session Memory | 后台提取、阈值、fork agent、受限写权限 | `SessionMemory/sessionMemory.ts:135-357` | extraction state、last summarized ID | 可仿照调度和 fork 隔离 |
| Project Memory | MEMORY.md 索引、四种类型、byte/line cap、按需召回 | `memdir/memdir.ts:34-315`、相关 memory scan | memory manifest、frontmatter | 采用 host-owned path 和 bounded index |
| 恢复/Transcript | 原始 JSONL、boundary 链、parent UUID、resume | `sessionTranscript/`、`sessionRestore.ts` | transcript entry、relink metadata | 对应 EventStore replay + model view rebuild |
| 观测/UI | token warning、compact progress、usage、context inspector | `query.ts`、`components/TokenWarning.tsx`、`analyzeContext.ts` | context status、usage、recovery chain | 对应 `ContextCompactionProjection` 和 Web presenter |

## 3. 本项目当前上下文管理实现（对照）

### 3.1 Runtime 调用路径

当前 AgentHost 在每个模型 step 开始前执行压缩：

```text
runTurn / runRecoveredTurn
  → runSteps
    → appendSteers
    → compactTurnContext
    → step/started
    → collectModelResponse
    → assistant/message
    → tool/result
    → 下一 step
```

参考入口：

- `packages/runtime/src/index.ts`：`runSteps()`、`compactTurnContext()`、`conversationMessages()`；
- `packages/compaction/src/index.ts`：`compactMessages()`；
- `packages/contracts/src/index.ts`：`ContextCompactionProjection`。

这意味着 compact 不是“调用若干工具后固定触发”。每个 step 都会检查一次；只有当前消息的估算 token 超过预算，或者超长工具结果需要被收缩时，才会形成 `context/compacted` 事件。

### 3.2 当前预算和算法

默认预算为：

```ts
maxTokens: 16_000
recentMessageTokens: 8_000
maxToolResultChars: 8_000
maxSummaryChars: 4_000
```

估算使用 `(content + toolCalls + 16) / 4`。算法顺序如下：

1. 超过 `maxToolResultChars` 的 `tool` 消息直接截断；
2. 若估算总量未超过 `maxTokens`，返回工具结果收缩后的消息；
3. 若超预算，保留全部 `system` 消息和最近消息；
4. 待批准 permission 或 interaction 对应的 tool call/result 进入 protected set；
5. 被移除的旧消息被转换为一个 bounded 的历史摘要，并以 `user` 消息插入；
6. `repairToolBoundaries()` 删除无法配对的 tool call/result。

### 3.3 事件、投影与恢复

压缩成功时追加 `context/compacted`；出错时追加 `context/compaction_failed` 并继续使用原始上下文。projection 记录最后一次压缩的摘要、消息数、估算 token、保护消息数和工具结果截断数。

当前 receipt 是观察记录，不是可重放的 compact view。Runtime 重启后从原始 EventStore 重新构造消息，再按当前预算重新压缩。这保持了事件事实源原则，但也意味着同一历史在预算、算法或模型配置改变后可能得到不同的 model-visible context。

### 3.4 当前优势和限制

当前优势：

- 压缩在 model request 前执行；
- pending permission/interaction 工具对不容易被错误移除；
- 失败不会让压缩自身中断 turn；
- EventStore、SQLite reopen、SSE replay 与 Web 投影已有基础。

当前限制：

- 固定的 16K 预算没有考虑实际模型窗口、输出预留、system prompt、工具 schema 或 provider；
- `/4` 字符估算无法区分 JSON、图片、文档和工具 schema；
- 工具结果被就地截断，历史原文与 model view 没有明确分离；
- 工具配对修复是局部且事后进行，缺少 API-round 边界和严格校验；
- usage 虽已写入 assistant message，尚未驱动上下文预算；
- 上游 400/413 错误没有形成专门的 context-overflow recovery；
- 没有压缩后文件、plan、skill、MCP 指令等关键上下文重建；
- 没有 Session Memory 或 Project Memory。

## 4. Claude Code 参考实现的主调用链

Claude Code 的主循环把上下文管理放在每次模型调用之前，并在模型拒绝过大请求后进入反应式恢复：

```text
完整消息记录
  → 释放非 API 必需的 UI tool payload
  → 单个工具结果预算 / snip / microcompact
  → 自动压缩阈值判断
  → Session Memory Compact
  → LLM Summary Compact
  → 压缩后附件与状态重建
  → API 格式规范化与 tool pairing 校验
  → 模型调用
  → prompt-too-long / media-too-large 时 reactive recovery
```

关键源码入口：

| 能力 | Claude Code 入口 |
|---|---|
| 主循环与 413 恢复 | `src/query.ts` |
| 模型窗口与输出预算 | `src/utils/context.ts` |
| 自动压缩阈值 | `src/services/compact/autoCompact.ts` |
| 微压缩 | `src/services/compact/microCompact.ts` |
| 全量压缩及重建 | `src/services/compact/compact.ts` |
| API round 分组 | `src/services/compact/grouping.ts` |
| API 消息规范化、配对和边界 | `src/utils/messages.ts` |
| 精确/近似 token 计数 | `src/services/tokenEstimation.ts` |
| 会话记忆 | `src/services/SessionMemory/` |
| 项目记忆 | `src/memdir/` |
| 恢复链路 | `src/utils/sessionRestore.ts` |

### 4.1 模型感知的 token budget

Claude Code 先按模型和 provider 解析 context window，而不是把历史消息直接限制在固定数字。窗口可来自环境变量、模型能力、模型名 1M 标记、beta capability 或默认值。随后计算：

```text
effectiveContextWindow
  = modelContextWindow - min(modelMaxOutputTokens, compactSummaryOutputReserve)

autoCompactThreshold
  = effectiveContextWindow - autoCompactBuffer
```

默认 buffer 为 13K token；400K、800K 以上窗口使用更大的 buffer。系统还区分 warning、error、blocking limit，并使用“当前上下文 + 一次可能的最大增长”做预测式压缩。

### 4.2 两级 token 计数

热路径用快速近似计数，关键决策尽可能使用 provider 的 `countTokens` 能力。对于不支持精确计数的 provider，回退到估算。

估算也不是单一的 `/4`：JSON/JSONL 使用更保守比例，图片和文档有专门估算，thinking、tool input、tool result 均单独纳入。这样可减少“本地估算未超限、provider 实际拒绝请求”的偏差。

### 4.3 工具结果的分级收缩

MicroCompact 只面向旧的、可压缩工具结果，例如 Read、Bash、Grep、Glob、WebSearch、WebFetch、Edit 和 Write。它优先清空旧内容并以简短标记代替，最近工具结果保留更多信息。

设计关键点：原始内容仍保留在 transcript，用于用户查看、恢复和审计；只有送往模型的 context view 被收缩。因此工具输出变大不会导致 UI、审计和模型请求共享同一个不可逆截断结果。

### 4.4 API round 与消息合法性

Claude Code 不按普通用户轮次切分历史，而是按 assistant response ID 分组为 API round。一个 group 包含该次 assistant 响应、期间产生的 tool use/result 以及同 response ID 的流式片段。

`normalizeMessagesForAPI()` 和 `ensureToolResultPairing()` 在发请求前维护 API 不变量：

- 同一流式 assistant response 的内容块正确合并；
- 每个 tool_use 都有相应 tool_result；
- orphan tool_result 被移除或以安全占位修复；
- 重复 tool_use ID 被去重；
- 工具名、工具 input 和 provider 特定字段在 API 边界规范化；
- 压缩窗口从中间截断时，会回溯到完整 tool pair 与 thinking block 的起点。

这套机制与 provider 400 的排查直接相关：上下文压缩不只是“减少 token”，也必须始终产生格式合法的 messages payload。

### 4.5 三层全量压缩

压缩入口并非只有一种路径：

1. **MicroCompact**：无模型调用，释放旧工具结果；
2. **Session Memory Compact**：使用后台维护的会话记忆，替换较早历史；
3. **LLM Summary Compact**：会话记忆不可用或不足时，调用摘要 agent。

LLM 摘要会尽量使用 forked agent 与主请求相同的缓存前缀。摘要请求本身若过大，则按 API round 从最旧部分开始缩减并有限重试。自动压缩连续失败达到阈值时触发 circuit breaker，避免一轮轮重复失败。

### 4.6 Compact boundary 与上下文重建

Claude Code 保存 compact boundary，记录压缩类型、压缩前 token、原消息锚点、摘要、保留段、已发现工具等元数据。后续 model view 从最近 boundary 后开始构建，而 transcript 继续保存完整历史。

压缩成功后不会只发送摘要。系统会在 bounded 总预算内恢复：

- 最近读取的文件，通常最多 5 个；
- plan 文件与 plan mode 状态；
- 已激活 skill 的内容；
- deferred tools、agent listing 和 MCP 说明的增量；
- SessionStart / PostCompact hook 的结果；
- prompt cache 的新基线。

目标是让模型保留“正在工作的对象”，而不是每次压缩后重新读取全部文件。

### 4.7 溢出与错误恢复

系统同时有主动和反应式两条路径：

- 主动路径：阈值或预测增长超过余量时，在请求前压缩；
- 反应式路径：provider 返回 prompt-too-long、413 或媒体过大错误时，先进行更低成本的收缩，再做全量压缩，随后只重试一次恢复后的请求。

错误不会被误当作正常 assistant 输出，也不会在 prompt-too-long 后运行会继续注入上下文的 stop hook。该行为用于避免“错误 → hook 注入消息 → 再次过长”的循环。

### 4.8 记忆与 system prompt 分层

Session Memory 是会话级、结构化、持续更新的摘要，保存当前目标、进度、重要决策、错误和未完成事项。Project Memory 是项目范围的 Markdown 文件系统：`MEMORY.md` 作为受限索引，具体记忆按相关性按需加载。

System prompt 则拆分成静态段和动态段。静态规则尽量固定，workspace、可用工具、memory、日期和 session 状态位于动态段，以便 provider 支持 prompt cache 时保持稳定前缀。

## 4. 对本项目的目标架构建议

建议在 `packages/runtime` 与 `packages/compaction` 之间建立显式的 Context Manager 边界，而不是继续把功能堆叠到 `compactMessages()`。

```text
EventStore / Transcript
   ↓
ContextAssembler
   ├─ system sections、tools、memory、attachments
   └─ 生成 canonical conversation view
   ↓
ContextBudgetResolver
   ├─ model/provider capabilities
   ├─ output reservation
   └─ warning / auto / blocking thresholds
   ↓
ContextEstimator
   ├─ fast estimate
   └─ optional provider exact count
   ↓
ContextReducer
   ├─ per-tool budget
   ├─ microcompact
   ├─ session-memory compact
   └─ LLM summary compact
   ↓
ApiMessageValidator
   ├─ API round grouping
   ├─ tool pair validation
   └─ provider request normalization
   ↓
ModelAdapter
   ↓ failure
ContextRecoveryCoordinator
   ├─ overflow classification
   ├─ bounded recovery retry
   └─ circuit breaker
   ↓
EventStore / Context projection / Web diagnostics
```

其中 EventStore 继续是唯一事实来源；`ContextAssembler` 和 `ContextReducer` 生成的是特定请求的 model-visible view，不应篡改原始 user、assistant、tool、permission 或 artifact 事件。

## 5. 按 Claude Code 总体架构分层的模块开发记录

本节不再按“我们想解决什么问题”划分工作，而是沿 Claude Code 的上下文调用链逐层实现。模块编号是固定的；后续开发记录、PR、ADR 和测试应引用这些编号，避免重新发明一套上下文流程。

### 5.0 固定模块依赖顺序

```text
M01 Context Window / Budget
  ↓
M02 Token Estimation
  ↓
M03 Context Assembly / System Prompt
  ↓
M04 API Round / Message Normalize / Tool Pairing
  ↓
M05 Tool Result Budget / MicroCompact
  ↓
M06 Session Memory Compact
  ↓
M07 Summary Compact
  ↓
M08 Compact Boundary / Post-Compact Rebuild
  ↓
M09 Query Proactive + Reactive Recovery
  ↓
M10 Transcript / Session Restore
  ↓
M11 Session Memory Extraction
  ↓
M12 Project Memory
  ↓
M13 Context Diagnostics / Web Projection
  ↓
M14 Context Collapse（Claude Code 快照中仍是 stub，最后评估）
```

这里的顺序对应 Claude Code 的职责分层和调用关系。M05–M09 是一次模型请求的核心闭环；M10–M13 负责跨请求、跨重启和跨会话的持久化与可观察性。

### M01：Context Window 与 Auto-Compact Budget

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/utils/context.ts:60-120`；`src/services/compact/autoCompact.ts:33-165` |
| 关键函数 | `getContextWindowForModel()`、`getEffectiveContextWindowSize()`、`getAutocompactBufferTokens()`、`getAutoCompactThreshold()`、`calculateTokenWarningState()` |
| 子功能 | 模型窗口解析、1M capability、输出预留、自动压缩 buffer、warning/error/blocking、predictive growth |
| 本项目落点 | `D:/Develop/code-review-agent/packages/context/src/budget.ts`（拟建）；读取 `ModelRoute`/provider capability；Runtime 在每次请求前生成 snapshot |
| 直接仿照程度 | 算法和字段职责可以直接仿照；模型能力来源必须接入本项目 adapter，不复制 Claude Code 的 provider 判断 |

实现内容：

1. 先解析 `maxInputTokens`，再扣除 `min(maxOutputTokens, summaryOutputReserve)`；
2. 根据 effective window 选择 auto-compact buffer；
3. 同时计算 `warningThreshold`、`autoCompactThreshold`、`blockingThreshold`；
4. 预测当前历史加上一次最大输出/工具增长后是否会越过窗口；
5. 保存 `source=provider|estimate|hybrid`，不能只保存一个 token 数。

对应 Claude Code 的代码关系：`context.ts` 只负责能力和窗口，`autoCompact.ts` 负责把窗口转换成可执行阈值；`query.ts:790-888` 使用 blocking 和 predictive 判断。后续本项目不能把这些逻辑继续放在 `packages/compaction/src/index.ts` 的固定 `maxTokens=16_000` 中。

模块验收：相同消息在不同 model route 下得到不同 snapshot；关闭 auto compact 时仍保留 blocking limit；预测式 compact 不会和本 step 的实际 compact 重复执行。

### M02：Token Estimation 与 Provider Exact Count

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/services/tokenEstimation.ts:131-250,263-353`；`src/services/compact/microCompact.ts:137-205` |
| 关键函数 | `countMessagesTokensWithAPI()`、`countTokensWithAPI()`、`roughTokenCountEstimation()`、`roughTokenCountEstimationForFileType()`、`estimateMessageTokens()` |
| 子功能 | 热路径粗估、关键路径精确计数、provider fallback、JSON/媒体/thinking/tool input 分类 |
| 本项目落点 | `D:/Develop/code-review-agent/packages/context/src/estimator.ts`（拟建）；ModelAdapter 暴露可选 `countTokens()` |
| 直接仿照程度 | 两级计数和 fallback 直接仿照；Anthropic/Bedrock/Vertex 的具体调用改为 provider adapter |

实现内容：

```ts
interface TokenCount {
  readonly value: number;
  readonly source: "provider" | "estimate" | "stale_usage";
  readonly confidence: "exact" | "conservative" | "unknown";
}

interface TokenCounter {
  estimate(view: ModelContextView): TokenCount;
  countExact?(view: ModelContextView, signal?: AbortSignal): Promise<TokenCount | undefined>;
}
```

估算器必须分开处理：普通文本、JSON/tool input、tool result、image/document、thinking block、system prompt、工具 schema。精确计数失败时回退到保守估算并记录原因，不能返回 0，也不能无标记覆盖 provider 已报告的 usage。

模块验收：估算路径不阻塞每一个 step；达到关键阈值时可调用 exact count；provider 不支持 exact count 时仍能稳定触发 compact；估算来源在 API/Web projection 中可解释。

### M03：Context Assembly 与 System Prompt Sections

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/context.ts`；`src/constants/prompts.ts`；`src/utils/systemPrompt.ts`；`src/utils/messages.ts:3841-4000` |
| 关键结构 | 静态 system prompt、动态 boundary、workspace/tool/memory/session context、attachment |
| 子功能 | system section 排序、动态上下文注入、tool schema、用户上下文、压缩后 attachment 注入 |
| 本项目落点 | `D:/Develop/code-review-agent/packages/context/src/assembler.ts`、`packages/runtime/src/system-prompt.ts`、`packages/runtime/src/index.ts`（已实现） |
| 直接仿照程度 | section 分层和稳定排序直接仿照；本项目安全规则和 EventStore projection 是权威来源 |

Claude Code 把 system prompt 拆为稳定前缀和动态区，目的是让 workspace、tools、memory、日期和 session 状态变化时不破坏全部缓存前缀。后续本项目的 `ContextAssembler` 应接收：

```ts
interface ContextAssemblyInput {
  readonly systemSections: readonly SystemPromptSection[];
  readonly visibleTools: readonly ToolSchema[];
  readonly workspace: WorkspaceContext;
  readonly memory?: MemoryContext;
  readonly attachments: readonly ContextAttachment[];
  readonly recovery?: RecoveryContext;
}
```

组装器只生成 model view，不把 MCP description 或工具结果变成可覆盖本地安全规则的 system instruction。动态 section 必须有稳定排序和独立 token 统计，否则后续 budget 无法解释。

模块验收：同一 EventStore replay 产生稳定的 section 顺序；tool visibility、workspace root、permission preset 来自 host projection；compact 后动态 section 能重新组装；MCP/skill 内容不能覆盖安全 section。

### 13.4 M03 实施状态（2026-08-26）

M03 已按上述设计完成，详细代码对照记录见 [`claude-code-context-m03-implementation.zh-CN.md`](claude-code-context-m03-implementation.zh-CN.md)。当前实现入口如下：

| 层次 | 实际入口 | 当前行为 |
|---|---|---|
| Section builder | `packages/runtime/src/system-prompt.ts:buildAgentSystemPromptSections()` | 将 identity、task execution、safety、verification、communication 固定为 static sections；workspace、tools、permissions、recovery、custom instructions 作为 dynamic sections，并提供稳定 `id/order` |
| Canonical assembler | `packages/context/src/assembler.ts:assembleContext()` | static-first、phase/order/id 稳定排序；tools 按名称排序；history 保留原顺序；attachments 按 order/id 排序并包装为不可信 context data |
| Model view | `ContextAssembly.modelView` | 统一输出 system message、history、attachment messages 和 visible tool schemas，直接交给 M02 estimator 与 model adapter |
| Replay metadata | `ContextAssembly.fingerprint`、`step/started.payload.contextAssembly` | 对 sections/tools/history/attachments 做稳定序列化并生成 `ctx_<8 hex>` fingerprint；事件记录 sectionIds、静态/动态分组和 attachmentIds |
| Runtime integration | `packages/runtime/src/index.ts:assembleTurnContext()`、`runSteps()` | runTurn、恢复 turn 和每个 model step 都重新组装；compact 后重新生成 assembly 与 token count，避免沿用过期 model view |

M03 的边界保持清晰：尚未实现 M04 的 API round、message normalize、tool pairing，也没有实现 M05 的 tool-result microcompact。attachments 当前是有界的 model-view wrapper；持久化 transcript、memory 和压缩后重建仍由后续模块负责。

### M04：API Round、Message Normalize 与 Tool Pairing

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/services/compact/grouping.ts:22-63`；`src/utils/messages.ts:2292-2670,5591-5947` |
| 关键函数 | `groupMessagesByApiRound()`、`normalizeMessagesForAPI()`、`ensureToolResultPairing()` |
| 子功能 | streaming assistant 合并、API round、tool pair、duplicate ID、orphan result、provider 字段清理 |
| 本项目落点 | `packages/context/src/api-round.ts`、`api-normalize.ts`、`tool-pairing.ts`（拟建）；ModelAdapter 的共同 request gate |
| 直接仿照程度 | round/group 和双向 pairing 逻辑直接仿照；synthetic result 的最终策略需要本项目 ADR |

先按 assistant response ID 分 API round，再进行 compact 起点计算；不能按 user turn 简单切割。`ensureToolResultPairing()` 的逻辑分为：

```text
1. 收集全局 tool_use ID，发现跨 assistant duplicate
2. 检查 assistant → 后继 user 的 tool_result
3. tool_use 无 result：repair 模式插入 synthetic error result
4. tool_result 无 tool_use：移除 orphan result
5. 起始 user/assistant 角色非法：插入最小 meta user marker
6. 记录 PairingReport；strict 模式直接拒绝请求
```

本项目的 pairing validator 必须位于所有模型请求的共同入口，不能只在 summary agent 中调用。`packages/compaction` 中现有 `repairToolBoundaries()` 可以保留为兼容 facade，但最终应委托该 validator。

模块验收：压缩、恢复、steer、parallel tool 和 streaming chunk 都不会产生 orphan/duplicate ID；严格模式可复现失败结构；repair 事件能关联到原始 turn/request。

### M05：Tool Result Budget 与 MicroCompact

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/query.ts:526-624`；`src/services/compact/microCompact.ts:137-365,426-520`；`src/services/compact/cachedMicrocompact.ts` |
| 关键函数 | `calculateToolResultTokens()`、`estimateMessageTokens()`、`microcompactMessages()`、time-based trigger、cached path |
| 子功能 | 每工具结果上限、媒体估算、旧结果白名单、时间衰减、缓存编辑、cleared tool IDs |
| 本项目落点 | `packages/context/src/tool-result-budget.ts`、`microcompact.ts`（拟建）；原始结果仍在 EventStore/Artifact |
| 直接仿照程度 | 非破坏性 model-view microcompact 直接仿照；cached provider edit 暂不直接实现 |

Claude Code 的 query 顺序是 snip → microcompact → collapse → autocompact。MicroCompact 只替换模型请求中的旧工具结果，不修改 transcript。工具结果估算包括文本、image/document 和结构化 block；可压缩工具由白名单控制，避免清理 permission、交互或不可重复的状态结果。

本项目应把当前 `maxToolResultChars` 截断改成：

```ts
interface ToolResultContextView {
  readonly toolCallId: ToolCallId;
  readonly originalEventSequence: number;
  readonly mode: "full" | "bounded" | "cleared";
  readonly content: string;
  readonly tokensSaved: number;
}
```

第一版按工具类型、年龄和最近 N 个结果清理；第二版再评估 provider cache edit。缓存编辑依赖 Claude Code 的 provider-specific cache state，不能先复制到多 provider Runtime。

模块验收：UI/审计可重新读取原始 tool result；model view 清理后 token 下降可测；清理操作幂等；pending tool、最近结果、不可重放结果不被清理。

### M06：Session Memory Compact

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/services/compact/sessionMemoryCompact.ts:45-127,234-390,439-590` |
| 关键函数 | `calculateMessagesToKeepIndex()`、`adjustIndexToPreserveAPIInvariants()`、`trySessionMemoryCompaction()` |
| 子功能 | 已摘要 UUID、最小 token 窗口、最小文本消息数、最大保留窗口、tool pair/thinking 回溯、SessionStart hooks |
| 本项目落点 | `packages/context/src/session-memory-compact.ts`（拟建），读取 host-owned SessionMemory store |
| 直接仿照程度 | 保留窗口计算和 API invariant 调整可直接仿照；memory storage 与权限适配本项目 Session/tenant |

`calculateMessagesToKeepIndex()` 从 `lastSummarizedMessageId` 后开始，若保留区不足，则向前扩展直到满足 `minTokens` 和 `minTextBlockMessages`，达到 `maxTokens` 时停止；最后调用 `adjustIndexToPreserveAPIInvariants()` 向前补齐匹配的 tool_use 和共享 message ID 的 thinking block。

`trySessionMemoryCompaction()` 有两个恢复分支：正常会话知道最后摘要 UUID；重启会话只有 memory 内容却不知道边界时，先采用保守保留策略，无法确认边界则回退传统 summary compact。这个“边界未知时不猜”的行为应直接保留。

模块验收：已有 session memory 时不必每次调用摘要模型；摘要边界未知不会静默丢历史；tool pair 和 thinking block 不被切开；Session Memory 失败能回退 summary compact。

### M07：LLM Summary Compact

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/services/compact/compact.ts:126-310,411-530,540-690,1159-1450` |
| 关键函数 | `compactConversation()`、`streamCompactSummary()`、`stripImagesFromMessages()`、`truncateHeadForPTLRetry()`、`createCompactCanUseTool()` |
| 子功能 | pre-compact hooks、媒体剥离、skill attachment 剥离、fork summary agent、PTL retry、summary usage、compaction result |
| 本项目落点 | `packages/context/src/summary-input.ts`、`summary-compact.ts`、`summary-agent.ts`（拟建） |
| 直接仿照程度 | summary 状态机、无工具权限和 API-round oldest-drop 可直接仿照；prompt cache sharing 需 provider adapter |

实现顺序应与 Claude Code 相同：

```text
PreCompact hook
  → strip image/document 和可重新注入附件
  → summary agent（purpose=context_summary，tools=[]）
  → 如果摘要请求 prompt-too-long：按 API round 删除最老 group
  → 最多三次 PTL retry
  → 生成 boundary + summary + preserved metadata
```

`truncateHeadForPTLRetry()` 特别处理两点：至少保留一组消息供摘要；删除 group 0 后若第一条变成 assistant，插入 synthetic user marker，避免摘要请求因角色顺序再次失败。`createCompactCanUseTool()` 表明摘要 agent 不允许执行普通工具。

模块验收：摘要请求自身过大时能有限重试；摘要 agent 无权写 workspace、调用 MCP 或执行工具；summary usage 与主请求 usage 分开记录；摘要失败返回结构化 context error。

### M08：Compact Boundary 与 Post-Compact Rebuild

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/utils/messages.ts:4967-5090`；`src/services/compact/compact.ts:336-389,540-690,1467-1650` |
| 关键函数 | `createCompactBoundaryMessage()`、`createMicrocompactBoundaryMessage()`、`getMessagesAfterCompactBoundary()`、`buildPostCompactMessages()`、`annotateBoundaryWithPreservedSegment()` |
| 子功能 | compact marker、micro marker、head/anchor/tail、summary、preserved messages、文件/plan/skill/MCP/hook attachments |
| 本项目落点 | `packages/context/src/boundary.ts`、`post-compact.ts`、`attachments.ts`；contracts/EventStore 增加 durable metadata |
| 直接仿照程度 | 消息顺序、boundary 元数据和附件预算直接仿照；事件名称映射到本项目 contracts |

Claude Code 的 post-compact 顺序固定为：

```text
boundary marker
→ summary messages
→ messagesToKeep
→ recent file / plan / skill / MCP attachments
→ SessionStart / PostCompact hook results
```

最近文件恢复最多 5 个，每文件约 5K token，总附件预算约 50K；skill 另有每 skill 和总预算。附件生成前会跳过 preserved messages 已经包含的 Read 结果，避免 compact 后立即再次超限。boundary 的 preserved segment 记录 head/anchor/tail，恢复 loader 依靠它重连消息链。

模块验收：重复 compact 不重复注入附件；SQLite reopen 能从 boundary 得到相同 model view；最近编辑文件和 plan 在摘要后仍可用；附件预算不会让下一次请求立即再 compact。

### M09：Query Proactive 与 Reactive Recovery

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/query.ts:584-888,1349-1470`；`src/services/compact/autoCompact.ts:270-380`；`src/services/compact/reactiveCompact.ts` |
| 关键函数 | snip/microcompact 调用链、`autoCompactIfNeeded()`、blocking check、predictive compact、collapse drain、`tryReactiveCompact()` |
| 子功能 | 主动阈值压缩、prompt-too-long/413 分类、reactive compact、retry transition、failure circuit breaker |
| 本项目落点 | `packages/context/src/recovery.ts` + `packages/runtime/src/index.ts:runSteps()` |
| 直接仿照程度 | query 状态机、guard、失败后不执行 stop hook 的逻辑直接仿照；错误分类由本项目 adapter 实现 |

Claude Code 的主动路径在模型请求前运行；反应式路径在 provider 已返回 prompt-too-long 后运行。恢复成功后重新进入 query loop；恢复失败则直接暴露错误，避免错误 → hook 注入 → 再次过长的循环。自动 compact 连续失败三次后停止无意义重试。

本项目应为每次恢复保存：`turnId`、原始 request hash、provider status、error class、已尝试模块、attempt number 和 transition reason。guard 必须按 turn/session 隔离，不能使用全局布尔值。

模块验收：主动 compact 和 reactive compact 不互相递归；同一 request 最多执行规定次数；连续失败会熔断；provider 400 能区分 context overflow、tool pairing、schema 和其他错误。

### M10：Transcript、Boundary Replay 与 Session Restore

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/services/sessionTranscript/`；`src/utils/sessionRestore.ts`；`src/utils/messages.ts:5045-5090` |
| 关键函数/结构 | transcript segment、parent UUID、compact boundary、preserved segment、restore session state |
| 子功能 | 原始消息落盘、compact 后重链、resume、重启后的最近 boundary view、memory/agent/worktree 恢复 |
| 本项目落点 | `packages/storage` EventStore、`packages/runtime/src/index.ts:conversationMessages()`、新增 Context projection/replay builder |
| 直接仿照程度 | “原文永久保留、model view 按 boundary 重建”的原则直接仿照；Claude JSONL loader 改写为本项目 EventStore replay |

当前本项目只记录 `context/compacted` receipt，重启后重新压缩。M10 要增加 boundary 的 durable record 和 algorithm version；恢复优先使用 boundary，旧历史没有 boundary 时才走兼容路径。必须验证 event replay 和 model-visible view 是两个不同 reducer。

模块验收：重启、SSE 断线、重复恢复和跨进程打开后，发送给模型的消息顺序和 boundary 一致；完整 tool result 仍能从 EventStore 查询；旧版本事件可迁移。

### M11：Session Memory Extraction

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/services/SessionMemory/sessionMemoryUtils.ts:16-210`；`sessionMemory.ts:135-181,273-357` |
| 关键函数 | `shouldExtractMemory()`、`markExtractionStarted()`、`waitForSessionMemoryExtraction()`、`extractSessionMemory()` |
| 子功能 | token/tool 双阈值、自然对话断点、后台顺序提取、fork context、受限 memory file tool |
| 本项目落点 | `packages/context/src/session-memory.ts` + host-owned SessionMemoryStore |
| 直接仿照程度 | 调度和隔离直接仿照；存储改用 tenant/session-scoped backend，不复制其文件路径逻辑 |

Claude Code 不在每个 turn 都提取 memory。初始化 token threshold、两次提取间 token 增长、tool call 数和“上一轮无 tool call”共同决定是否提取；提取使用 forked agent，只允许编辑指定 memory file。主 turn 不等待失败结果，也不会把提取错误作为 assistant message。

模块验收：提取任务串行、可取消、不会共享父 agent 全部权限；主 turn 与 memory extraction 相互隔离；提取完成后更新 last summarized boundary；重启可恢复 extraction state。

### M12：Project Memory / memdir

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/memdir/memdir.ts:34-315,419-470`；`src/memdir/findRelevantMemories.ts`；`src/memdir/memoryTypes.ts` |
| 关键函数 | `truncateEntrypointContent()`、`buildMemoryLines()`、`buildMemoryPrompt()`、`loadMemoryPrompt()` |
| 子功能 | `MEMORY.md` bounded index、user/feedback/project/reference 四类、按需召回、过期验证 |
| 本项目落点 | `packages/context/src/project-memory.ts` + Workspace/tenant path resolver |
| 直接仿照程度 | 索引上限、类型约束和验证规则直接仿照；召回和存储接入本项目 workspace/tenant policy |

`MEMORY.md` 不是所有记忆内容的容器，而是有 200 行和 25,000 bytes 上限的入口索引；详细内容放在独立 topic files，相关记忆才按需加载。记忆中提到的文件、函数和 flag 在使用前必须重新检查，不能把过期记忆当事实。

模块验收：不同 workspace/tenant 的 memory 不互相泄露；超大索引自然截断并有 warning；用户要求忽略 memory 时 model view 不再注入；删除/过期 memory 可回放。

### M13：Context Diagnostics 与 Web Projection

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/components/TokenWarning.tsx`；`src/utils/analyzeContext.ts`；`src/query.ts` 的 compact progress/log events |
| 子功能 | 当前 token、剩余百分比、warning/error/blocking、compact progress、前后 token、recovery chain、context inspector |
| 本项目落点 | `packages/contracts/src/index.ts:ContextCompactionProjection`、Runtime events、`apps/web` ContextMeter/diagnostic presenter |
| 直接仿照程度 | 状态类别和诊断维度直接仿照；Web 只能消费 durable projection，不自行猜测 token 事实 |

模块验收：UI 能区分 estimate/provider exact；能显示最近 boundary、microcompact 节省和失败原因；刷新、SSE replay 和 API restart 后诊断状态一致。

### M14：Context Collapse（最后评估）

| 项目 | 内容 |
|---|---|
| Claude Code 参考 | `D:/Develop/claude-code/src/services/contextCollapse/index.ts`、`operations.ts`、`persist.ts`、`docs/features/context-collapse.md` |
| 子功能 | read-time projection、后台折叠摘要、collapse commit log、overflow drain、snip |
| 本项目落点 | 在 M01–M13 稳定后再决定是否新增 `packages/context-collapse` |
| 直接仿照程度 | 只能仿照接口和 query 集成点；本地快照核心标记为 stub，不直接复制算法 |

M14 不是新的替代压缩系统，而是 Claude Code 在已有 microcompact、Session Memory、summary compact 之外的可选历史折叠层。只有当 M01–M13 的 model view、boundary、recovery 和 replay 通过真实 provider 验收后，才进入该模块。

## 6. 建议的公共契约与事件

后续设计至少需要讨论以下对象；字段名称只是建议，最终以 ADR 为准。

```ts
interface ContextBudgetSnapshot {
  model: string;
  provider: string;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  systemTokens: number;
  toolSchemaTokens: number;
  conversationTokens: number;
  totalInputTokens: number;
  autoCompactThreshold: number;
  blockingThreshold: number;
  source: "provider" | "estimate" | "hybrid";
}

interface ContextBoundary {
  id: string;
  kind: "micro" | "session_memory" | "summary" | "reactive";
  sourceSequence: number;
  preservedEventSequences: readonly number[];
  summarizedEventRange?: { from: number; to: number };
  preCompact: ContextBudgetSnapshot;
  postCompact: ContextBudgetSnapshot;
  trigger: "auto" | "manual" | "overflow" | "recovery";
}

interface ContextRecoveryAttempt {
  providerStatus?: number;
  errorClass: "context_overflow" | "media_overflow" | "invalid_tool_pair" | "other";
  attempt: number;
  action: "microcompact" | "summary_compact" | "retry" | "give_up";
}
```

建议事件保持 append-only，例如：

```text
context/estimated
context/microcompacted
context/boundary_created
context/compacted
context/recovery_attempted
context/recovery_exhausted
context/compaction_failed
```

事件中不存储完整工具输出、模型请求、provider secret 或未脱敏 response body。详细输出继续由既有 ToolResult/Artifact/受控错误审计路径管理。

## 7. 测试与安全门槛

每个切片至少应覆盖以下测试。

| 类别 | 关键场景 |
|---|---|
| 单元 | token 估算、预算解析、API-round grouping、tool pairing、boundary 构建和去重 |
| 合同 | 不同 provider 的 context capability、usage、400/413 错误分类、模型请求规范化 |
| 恢复 | compact 后 SQLite reopen、未决 permission、未决 interaction、重新连接、重复 request、重复批准 |
| 安全 | tool result 中的 prompt injection 不提升权限；memory 路径限制；secret 脱敏；MCP 文本不覆盖本地规则 |
| 回放 | 同一 event log + boundary metadata 能得到稳定的 model-visible view |
| E2E | read → edit → approve → test 的长会话跨越 microcompact、summary compact 和重启恢复 |
| 压力 | 多轮大 Read/Bash 输出、并行工具、streaming tool result、模型连续 overflow、circuit breaker |

还应加入针对历史失败的回归 fixture：压缩后的下一次模型请求要保留原始 provider 错误 body 的脱敏摘要，并能定位是预算、工具配对、schema 还是 provider 能力不兼容。

## 8. ADR 前必须回答的问题

开始 M01–M04 实现前，需单独创建或更新 ADR，并明确回答：

1. 模型能力和 provider context window 的权威来源是什么？无法获取时如何 fail safe？
2. `ModelUsage` 的 provider 上报值、精确 countTokens 和本地估算冲突时，哪个用于阈值？
3. 原始 transcript、EventStore 和 model-visible compact view 的持久化关系是什么？
4. tool pairing 不一致时是修复、拒绝请求还是 fail turn？不同 provider 是否不同？
5. 何时允许删除模型 view 中的工具结果，用户仍如何查看完整原文？
6. compact boundary 的幂等键、锚点、回放和版本迁移如何定义？
7. overflow recovery 能重试几次，哪些状态和副作用必须禁止重试？
8. summary agent、Session Memory 更新器和主 agent 各自能使用哪些工具与权限？
9. 记忆的存储位置、租户隔离、保留期限、删除与过期验证策略是什么？
10. 哪些数据可以显示给 Web，哪些仅限 host 审计？

## 9. 不应直接照搬的部分

- Claude Code 的 feature flag、分析事件、账户体系和内部服务依赖；
- 与其 provider、prompt cache、工具搜索和商业运行环境绑定的实现细节；
- 未确认许可的源码、类型和提示词文本；
- 当前本地快照中被标记为 stub 的 `contextCollapse` 实现；
- 将全部原始历史或父 agent 的完整上下文直接复制给 subagent 的做法。

本项目应保留现有不变量：EventStore 是事实来源；工具必须经统一 permission/workspace 管线；MCP、Subagent 与未来 A2A 不得绕过审计、取消、权限或租户隔离。

## 10. 参考材料

本次调研只使用本地只读参考：

- `D:/Develop/claude-code/docs/context/token-budget.mdx`
- `D:/Develop/claude-code/docs/context/compaction.mdx`
- `D:/Develop/claude-code/docs/context/system-prompt.mdx`
- `D:/Develop/claude-code/docs/context/project-memory.mdx`
- `D:/Develop/claude-code/docs/features/context-collapse.md`
- `D:/Develop/claude-code/src/query.ts`
- `D:/Develop/claude-code/src/services/compact/`
- `D:/Develop/claude-code/src/services/SessionMemory/`
- `D:/Develop/claude-code/src/memdir/`

本项目关联入口：

- `packages/compaction/src/index.ts`
- `packages/runtime/src/index.ts`
- `packages/runtime/src/system-prompt.ts`
- `packages/contracts/src/index.ts`
- `docs/architecture-decisions.md`（ADR-007、ADR-009）
- `docs/phase-status.zh-CN.md`（Phase 8.1 完成证据）
- `docs/phase-plans/phase-8-productization.zh-CN.md`

## 11. Claude Code 代码级入口索引

以下行号以 2026-08-26 本地快照为准。快照后续变化时，应以函数名和数据流为主重新定位行号。

| 实现问题 | Claude Code 入口 | 关键函数/常量 | 本项目仿照位置 |
|---|---|---|---|
| context window 解析 | `D:/Develop/claude-code/src/utils/context.ts:60-120` | `getContextWindowForModel()` | 新建 `packages/context/src/budget.ts`，读取 `ModelRoute` capability |
| 输出预留和自动阈值 | `D:/Develop/claude-code/src/services/compact/autoCompact.ts:33-165` | `getEffectiveContextWindowSize()`、`getAutoCompactThreshold()`、`calculateTokenWarningState()` | `packages/context/src/budget.ts` + Runtime preflight |
| 自动 compact 入口 | `D:/Develop/claude-code/src/services/compact/autoCompact.ts:270-380` | `autoCompactIfNeeded()` | `packages/context/src/manager.ts` |
| 近似/精确 token | `D:/Develop/claude-code/src/services/tokenEstimation.ts:131-250` | `countMessagesTokensWithAPI()`、`roughTokenCountEstimation()` | `packages/context/src/estimator.ts` + model adapter capability |
| 工具结果 microcompact | `D:/Develop/claude-code/src/services/compact/microCompact.ts:137-230,257-365` | `calculateToolResultTokens()`、`estimateMessageTokens()`、`microcompactMessages()` | `packages/context/src/microcompact.ts` |
| API round 分组 | `D:/Develop/claude-code/src/services/compact/grouping.ts:22-63` | `groupMessagesByApiRound()` | `packages/context/src/api-round.ts` |
| Session Memory compact | `D:/Develop/claude-code/src/services/compact/sessionMemoryCompact.ts:234-390,516-590` | `adjustIndexToPreserveAPIInvariants()`、`calculateMessagesToKeepIndex()`、`trySessionMemoryCompaction()` | `packages/context/src/session-memory-compact.ts` |
| 摘要输入清理 | `D:/Develop/claude-code/src/services/compact/compact.ts:149-227` | `stripImagesFromMessages()`、`stripReinjectedAttachments()` | `packages/context/src/summary-input.ts` |
| 摘要请求 PTL 重试 | `D:/Develop/claude-code/src/services/compact/compact.ts:247-297,411-515` | `truncateHeadForPTLRetry()`、`compactConversation()` | `packages/context/src/summary-compact.ts` |
| 压缩后消息顺序 | `D:/Develop/claude-code/src/services/compact/compact.ts:336-389` | `buildPostCompactMessages()`、`annotateBoundaryWithPreservedSegment()` | `packages/context/src/post-compact.ts` |
| 最近文件/plan/skill 恢复 | `D:/Develop/claude-code/src/services/compact/compact.ts:1467-1585` | `createPostCompactFileAttachments()`、`createPlanAttachmentIfNeeded()`、`createSkillAttachmentIfNeeded()` | `packages/context/src/attachments.ts` |
| boundary | `D:/Develop/claude-code/src/utils/messages.ts:4967-5090` | `createCompactBoundaryMessage()`、`createMicrocompactBoundaryMessage()`、`getMessagesAfterCompactBoundary()` | contracts + EventStore projection |
| API 消息规范化 | `D:/Develop/claude-code/src/utils/messages.ts:2292-2670` | `normalizeMessagesForAPI()` | `packages/context/src/api-normalize.ts` |
| tool pair 修复 | `D:/Develop/claude-code/src/utils/messages.ts:5591-5947` | `ensureToolResultPairing()` | `packages/context/src/tool-pairing.ts` |
| query 中的调用顺序 | `D:/Develop/claude-code/src/query.ts:584-665,790-888` | snip → microcompact → collapse → autocompact → blocking/predictive | `packages/runtime/src/index.ts` 的 `runSteps()` |
| 413/reactive recovery | `D:/Develop/claude-code/src/query.ts:1349-1470` | `tryReactiveCompact()`、collapse drain、retry guard | `packages/context/src/recovery.ts` |
| Session Memory 提取 | `D:/Develop/claude-code/src/services/SessionMemory/sessionMemory.ts:135-181,273-357` | `shouldExtractMemory()`、`extractSessionMemory()` | 后续 `packages/context/src/session-memory.ts` |
| Project Memory 索引 | `D:/Develop/claude-code/src/memdir/memdir.ts:34-103,199-315,419-470` | `truncateEntrypointContent()`、`buildMemoryPrompt()`、`loadMemoryPrompt()` | 后续 `packages/context/src/project-memory.ts` |

## 12. M01：如何仿照 Claude Code 实现模型感知预算

### 12.1 Claude Code 的实现关系

Claude Code 把“窗口解析”和“自动 compact 阈值”拆成两个模块：

1. `getContextWindowForModel(model)` 只回答模型输入窗口是多少；
2. `getEffectiveContextWindowSize(model)` 扣除输出预留；
3. `getAutocompactBufferTokens(model)` 按窗口大小提供增长余量；
4. `getAutoCompactThreshold(model)` 得到真正的自动压缩点；
5. `calculateTokenWarningState()` 同时返回 warning、error、auto compact 和 blocking 状态。

核心伪代码如下，语义来自上述源码，但类型和实现属于本项目设计：

```ts
export interface ModelContextCapability {
  readonly provider: string;
  readonly model: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly supportsExactCount: boolean;
  readonly supportsPromptCache: boolean;
}

export interface ContextBudgetSnapshot {
  readonly capability: ModelContextCapability;
  readonly reservedOutputTokens: number;
  readonly effectiveWindowTokens: number;
  readonly autoCompactThreshold: number;
  readonly blockingThreshold: number;
  readonly source: "provider" | "estimate" | "hybrid";
}

export function resolveBudget(capability: ModelContextCapability): ContextBudgetSnapshot {
  const reservedOutputTokens = Math.min(capability.maxOutputTokens, 20_000);
  const effectiveWindowTokens = Math.max(
    1,
    capability.maxInputTokens - reservedOutputTokens,
  );
  const buffer = effectiveWindowTokens >= 800_000
    ? 50_000
    : effectiveWindowTokens >= 400_000
      ? 30_000
      : 13_000;

  return {
    capability,
    reservedOutputTokens,
    effectiveWindowTokens,
    autoCompactThreshold: effectiveWindowTokens - buffer,
    blockingThreshold: effectiveWindowTokens - 3_000,
    source: "provider",
  };
}
```

实现时不能直接把 `maxInputTokens` 当成历史消息预算。system prompt、工具 schema、用户上下文和输出预留必须从同一份 snapshot 中扣除或至少单独记录，否则会产生“本地估算未超限、provider 返回 400/413”的错判。

### 12.2 当前项目的具体改写方式

当前 `D:/Develop/code-review-agent/packages/compaction/src/index.ts` 的 `ContextBudget` 是静态压缩参数，不应继续承担模型能力解析。建议拆成：

```text
ContextBudgetConfig       // 用户/Host 配置：buffer、摘要上限、工具上限
ModelContextCapability     // provider/model 能力
ContextBudgetSnapshot      // 某次请求的计算结果
```

`AgentHost` 在每个 turn 开始时解析 capability，在每次 model request 前生成 snapshot，并把 snapshot 的摘要写入 `context/estimated` 或 `step/started` 的非敏感 payload。这样可以解释某一次 compact 为什么发生。

### 12.3 预测式 compact

Claude Code 在真正调用 API 前还估计“本轮最大增长”，对应 `autoCompact.ts:84-94` 和 `query.ts:848-888`。本项目可采用以下顺序：

```ts
const current = await estimator.estimate(requestView);
const growth =
  capability.maxOutputTokensForTurn +
  toolRuntime.estimatedMaxResultTokens();

if (current + growth >= snapshot.effectiveWindowTokens) {
  await contextManager.compact({
    reason: "predictive_growth",
    snapshot,
  });
}
```

这里的 `growth` 不是精确承诺，而是保守上限。它的作用是避免等到 provider 已经拒绝后才开始压缩。

### 12.4 M01 实施状态（2026-08-26）

M01 已按上述分层落地，详细代码对照记录见 [`claude-code-context-m01-implementation.zh-CN.md`](claude-code-context-m01-implementation.zh-CN.md)。当前实现入口如下：

| 层次 | 已落地入口 | 结果 |
|---|---|---|
| Contract | `packages/contracts/src/index.ts` 的 `ModelContextCapability`、`ContextBudgetConfig`、`ContextBudgetSnapshot`、`ContextWarningState` | model adapter、tenant route 和 runtime 使用同一份公共类型 |
| Budget | `packages/context/src/index.ts` | 输出预留、effective window、13K/30K/50K buffer、warning/error/auto/blocking/predictive 状态 |
| Adapter | `packages/llm/src/index.ts` 的 `contextCapability` | DeepSeek adapter 提供 host-owned 128K/8K capability；旧 adapter 可省略并走 estimate fallback |
| Runtime | `packages/runtime/src/index.ts` 的 `contextBudgetSnapshot()`、`runSteps()` preflight | 每次 `step/started` 写入非敏感预算快照和 warning state，并把 auto threshold 交给现有 compaction facade |
| API | `apps/api/src/server.ts` 的 `contextPolicy`、`/v1/capabilities` | host policy 可注入；能力状态通过既有 capabilities projection 暴露 |

M01 已完成的验证是预算公式和 runtime 事件记录；M02 已在 `packages/context/src/estimator.ts` 落地，M04 的 API round/tool pairing、M05 的工具结果预算仍未提前实现。M01 的兼容记录保留其当时边界，M02 的实际入口和验证见 [`claude-code-context-m02-implementation.zh-CN.md`](claude-code-context-m02-implementation.zh-CN.md)。

## 13. M02：如何仿照 Claude Code 实现两级 token 计数

### 13.1 Claude Code 的入口和降级关系

`D:/Develop/claude-code/src/services/tokenEstimation.ts:131-212` 的 `countMessagesTokensWithAPI()` 会根据 provider 选择精确计数路径；`roughTokenCountEstimation()` 是快速 fallback。关键原则是：

```text
热路径：估算，不阻塞每个 step
关键决策：精确 countTokens（可用时）
provider 不支持：记录 source=estimate，继续使用保守估算
```

精确计数失败不能把 token 结果当作 0，也不能静默覆盖上一份可信 usage。应返回：

```ts
type TokenCount =
  | { readonly value: number; readonly source: "provider" | "estimate" }
  | { readonly value: number; readonly source: "stale_usage"; readonly stale: true };
```

### 13.2 本项目的 estimator 设计

建议 `packages/context/src/estimator.ts` 只依赖一个可注入接口：

```ts
export interface TokenCounter {
  estimate(input: ModelContextView): TokenCount;
  countExact?(input: ModelContextView, signal?: AbortSignal): Promise<TokenCount | undefined>;
}
```

估算至少区分：

- 普通文本：约 `/4`；
- JSON/tool input：使用更保守的 `/2`；
- 图片/document：按 provider 能力或固定上限；
- tool result：分别计算文本、结构化内容和媒体；
- system prompt 与工具 schema：单独计数，不能藏在普通 message 估算中。

每个估算结果必须记录 `source` 和 `confidence`，Web 只能把 estimate 展示为 estimate，不能称为 provider 的实际 token 使用量。

### 13.3 M02 实施状态（2026-08-26）

M02 已按上述设计完成：

| 层次 | 实际入口 | 当前行为 |
|---|---|---|
| Estimator | `packages/context/src/estimator.ts` | `estimateContextTokens()` 按 system/message/schema/arguments/results 输出 breakdown；普通文本 `/4`，结构化 JSON `/2` |
| Exact seam | `packages/contracts/src/index.ts:ChatModel.countTokens()`、`createTokenCounter()` | 可选 provider exact count，不绑定具体 SDK |
| Fallback | `countContextTokens()` | exact 不可用直接 estimate；exact 失败保留 estimate 并写 `exactError`；显式 stale usage 才返回 `stale_usage` |
| Boundary gate | `shouldUseExactTokenCount()` | 仅在 capability 支持且接近 warning/predictive threshold 时调用 exact |
| Runtime | `packages/runtime/src/index.ts:runSteps()` | `step/started.payload.tokenCount` 记录 value/source/confidence/breakdown，compact 后重新 estimate |

M02 已验证 exact 成功、exact 失败、stale usage、结构化内容分项和 Runtime 事件 provenance。图片/document provider tokenizer、API round、tool pairing、microcompact 仍属于后续模块；详细实现记录见 [`claude-code-context-m02-implementation.zh-CN.md`](claude-code-context-m02-implementation.zh-CN.md)。

## 14. M04：如何仿照 API round 分组和 tool pairing

### 14.1 API round 分组

Claude Code 的 `groupMessagesByApiRound()`（`grouping.ts:22-63`）只在出现不同 `assistant.message.id` 时切组。它特意不按 user turn 切分，因为一次 user prompt 可能触发多轮 assistant/tool loop。

本项目当前 `ChatMessage` 没有等价的 provider assistant response ID。应在 `assistant/message` event 中新增稳定的 `responseId` 或 `modelRequestId`，并将同一次流式响应的 tool calls 绑定到它。

仿照实现的本项目伪代码：

```ts
export function groupByModelRound(messages: readonly ContextMessage[]): ContextMessage[][] {
  const groups: ContextMessage[][] = [];
  let current: ContextMessage[] = [];
  let lastResponseId: string | undefined;

  for (const message of messages) {
    const startsNewRound =
      message.role === "assistant" &&
      message.responseId !== undefined &&
      message.responseId !== lastResponseId &&
      current.length > 0;

    if (startsNewRound) {
      groups.push(current);
      current = [];
    }
    current.push(message);
    if (message.role === "assistant") lastResponseId = message.responseId;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
```

不要通过“未完成 tool ID 一直存在”来阻止所有后续分组。Claude Code 的注释明确指出，异常 transcript 应由 API 边界的 pairing validator 修复；否则一个坏的 tool call 会把整段后续历史粘成一个 group，反而无法恢复。

### 14.2 压缩边界保护

`sessionMemoryCompact.ts:234-315` 的 `adjustIndexToPreserveAPIInvariants()` 做两次反向扫描：

1. 从保留区收集所有 `tool_result.tool_use_id`，向前找到匹配的 assistant tool_use；
2. 收集保留区 assistant 的 `message.id`，向前补齐同 ID 的 thinking/streaming 片段。

本项目的 `repairToolBoundaries()` 发生在消息已经截断之后，应该增加一个“选取起点调整”阶段：先修正起点，再做摘要或丢弃，最后才做 API 规范化。

### 14.3 API validator 的两种模式

Claude Code 的 `ensureToolResultPairing()`（`messages.ts:5591-5947`）同时检查两个方向：

- tool_use 没有 result：插入 synthetic error result；
- tool_result 没有 tool_use：移除 orphan result；
- duplicate tool_use/tool_result ID：去重；
- 恢复从半个 turn 开始时，避免 payload 以 assistant 或空 user 开头。

本项目建议提供两个模式：

```ts
type PairingMode = "repair" | "strict";

interface PairingReport {
  readonly repaired: boolean;
  readonly insertedResults: readonly string[];
  readonly removedResults: readonly string[];
  readonly duplicateIds: readonly string[];
  readonly mode: PairingMode;
}
```

生产 Coding Agent 默认可以 `repair`，但必须追加 `context/pairing_repaired` 事件并把报告关联到后续请求；高风险评测或训练路径可用 `strict`，直接 fail turn，避免模型在合成结果上继续生成。

## 15. M05：如何仿照 MicroCompact，而不是直接截断工具结果

### 15.1 Claude Code 的执行顺序

`D:/Develop/claude-code/src/query.ts:584-624` 展示了主循环顺序：

```text
history snip（如果启用）
  → microcompact
  → context collapse projection（如果启用）
  → autoCompact
  → blocking/predictive check
  → model request
```

`microCompact.ts:137-205` 对 tool result 做内容级估算，图片/document 使用单独上限；`microcompactMessages()` 再根据时间或缓存条件选出旧结果。

### 15.2 本项目仿照实现

当前 `microcompactToolResults()` 返回新消息但直接截取字符串，建议改为 model-view replacement：

```ts
interface ToolResultView {
  readonly toolCallId: ToolCallId;
  readonly originalEventId: string;
  readonly content: string;
  readonly mode: "full" | "cleared" | "bounded";
  readonly tokensSaved: number;
}

function microcompact(view: ContextMessage[], policy: MicrocompactPolicy): ReductionResult {
  const eligible = view
    .filter(isToolResult)
    .filter(result => policy.compactableTools.has(result.toolName))
    .filter(result => result.ageMs >= policy.minAgeMs)
    .sort(oldestFirst);

  const next = cloneMessages(view);
  for (const result of eligible) {
    if (estimate(next) <= policy.targetTokens) break;
    replaceToolContent(next, result.toolCallId, "[old tool result content cleared]");
  }
  return { messages: next, clearedToolCallIds: ids(eligible), originalEventsUnchanged: true };
}
```

重要差异：`EventStore` 中的 `tool/result` 不修改；只修改传给模型的 `ContextMessage[]`。如果 Web 需要查看完整输出，通过 `toolCallId` 回到原始事件或 bounded artifact。

### 15.3 缓存编辑不应作为第一批能力

Claude Code 还有 `cachedMicrocompact.ts`，通过 provider cache edit 删除缓存中的旧 tool result。它依赖特定 provider 的缓存语义、累计 `cache_deleted_input_tokens` 和全局状态。当前项目是多 provider 路由，第一阶段只实现“model view 清理 + durable receipt”；确认某 provider 的 cache contract 后再单独增加 cache edit adapter。

## 16. M07/M08：如何仿照 Compact Boundary 与摘要输入准备

### 16.1 Boundary 的数据结构

Claude Code 的 `createCompactBoundaryMessage()`（`messages.ts:4967-4992`）创建 system marker；`createMicrocompactBoundaryMessage()`（`4994-5020`）记录释放 token 和被清理的 tool ID；`getMessagesAfterCompactBoundary()`（`5080-5090`）从最新 boundary 开始生成 model view。

本项目不建议把 boundary 伪装成普通 user message。建议在 contracts 中增加：

```ts
interface ContextBoundaryRecord {
  readonly boundaryId: string;
  readonly kind: "micro" | "summary" | "session_memory" | "reactive";
  readonly trigger: "auto" | "manual" | "overflow";
  readonly sourceSequence: number;
  readonly lastIncludedEventSequence: number;
  readonly preservedMessageIds: readonly string[];
  readonly summarizedEventRange?: { readonly from: number; readonly to: number };
  readonly preTokens: number;
  readonly postTokens: number;
  readonly tokensSaved?: number;
  readonly algorithmVersion: string;
}
```

`algorithmVersion` 很重要：恢复时可以知道历史 boundary 是由哪一版算法生成的，不会把旧 boundary 与新 compact 规则混用。

### 16.2 摘要前清理

Claude Code 的 `stripImagesFromMessages()`（`compact.ts:149-205`）把 image/document 替换为 `[image]`、`[document]`；`stripReinjectedAttachments()`（`215-227`）移除压缩后会再次注入的 skill attachment。

本项目的摘要输入应采用独立的 `SummaryInputBuilder`：

```ts
function buildSummaryInput(view: ContextMessage[], state: ContextState): ContextMessage[] {
  return view
    .filter(message => !isReinjectableAttachment(message))
    .map(message => replaceMediaWithMarker(message))
    .map(message => stripUiOnlyPayload(message));
}
```

不能直接把主请求 messages 原数组交给摘要模型并在其中修改内容，因为 UI、EventStore projection 和摘要请求会共享可变对象。

### 16.3 摘要 agent 的权限边界

Claude Code 的 `createCompactCanUseTool()`（`compact.ts:1159` 附近）拒绝摘要 agent 的普通工具调用。摘要 agent 只负责输出摘要，不应执行 Bash、Edit、MCP 或写 workspace 操作。

本项目应使用独立 `ModelRequestPurpose = "context_summary"`，由 ToolRuntime 明确拒绝工具执行，并在 `model/requested` 或 `context/summary_started` 事件中写入 purpose。这样可以避免压缩过程意外产生副作用。

## 17. M07：如何仿照 LLM 摘要和 PTL 重试

### 17.1 Claude Code 的控制流

`compact.ts:411-515` 的 `compactConversation()` 先执行 pre-compact hook，再调用摘要模型。如果摘要请求本身返回 prompt-too-long：

1. `groupMessagesByApiRound()` 把摘要输入分组；
2. `truncateHeadForPTLRetry()` 从最老 group 开始删除，至少保留一组用于摘要；
3. 如果删除后第一条变成 assistant，则插入 synthetic user marker；
4. 最多 `MAX_PTL_RETRIES = 3` 次；
5. 仍失败则记录 `tengu_compact_failed` 并向上抛出。

本项目的等价控制器可以写成：

```ts
async function summarizeWithRecovery(input: ContextMessage[], ctx: SummaryContext) {
  let candidate = input;
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const response = await summaryModel.summarize(candidate, {
      purpose: "context_summary",
      tools: [],
      signal: ctx.signal,
    });
    if (response.ok) return response;
    if (!isPromptTooLong(response.error)) throw response.error;

    const groups = groupByModelRound(candidate);
    if (groups.length < 2) break;
    candidate = dropOldestGroupsButKeepOne(groups, response.error.tokenGap);
  }
  throw new ContextError("SUMMARY_CONTEXT_OVERFLOW");
}
```

这里的 `dropOldestGroupsButKeepOne()` 必须保证：

- 不跨 tool pair 删除；
- 不让 payload 以 assistant 开头；
- 不反复删除同一个 retry marker；
- 每次 retry 都有可计算的进展；
- 删除量、剩余 group 和 provider error 被记录。

### 17.2 Prompt cache sharing 的适配边界

Claude Code 的 `streamCompactSummary()` 会通过 forked agent 复用主线程的 system/tools/context cache；这依赖 Anthropic cache key 和 `cacheSafeParams`。本项目应先抽象：

```ts
interface SummaryRequestContext {
  readonly systemPrompt: string;
  readonly tools: readonly ToolSchema[];
  readonly messages: readonly ContextMessage[];
  readonly cacheKey?: string;
}
```

只有 provider adapter 明确支持 cache key 复用时才启用；不支持时走普通摘要请求，不能把主请求的内部缓存字段发送给第三方兼容层。

## 18. M08：如何仿照压缩后上下文重建

### 18.1 Claude Code 的顺序

`buildPostCompactMessages()`（`compact.ts:336-343`）给出了基本顺序：

```text
boundary marker
→ summary messages
→ messagesToKeep
→ attachments
→ hook results
```

`compactConversation()` 的 `540-621` 进一步生成：

- 最近文件附件；
- async agent 状态；
- plan 文件；
- plan mode 指令；
- invoked skill；
- deferred tools/agent/MCP delta；
- SessionStart hook。

### 18.2 本项目的 PostCompactBuilder

建议实现为纯函数 + 有界异步附件解析：

```ts
interface PostCompactInput {
  readonly boundary: ContextBoundaryRecord;
  readonly summary: string;
  readonly preserved: readonly ContextMessage[];
  readonly state: ContextState;
}

async function buildPostCompactView(input: PostCompactInput): Promise<ContextMessage[]> {
  const attachments = await collectAttachmentsWithinBudget({
    recentFiles: input.state.recentFiles,
    plan: input.state.plan,
    activeSkills: input.state.activeSkills,
    mcpDelta: input.state.mcpDelta,
    budgetTokens: 50_000,
  });

  return [
    boundaryMessage(input.boundary),
    summaryMessage(input.summary),
    ...input.preserved,
    ...attachments,
  ];
}
```

附件必须做 dedupe：如果 preserved messages 已经包含某文件的最新 Read result，就不应再次注入。每类附件需要独立上限，不能让一个超大 plan 或 skill 消耗完整 post-compact 预算。

## 19. M09：如何仿照 Query Loop 的 proactive/reactive recovery

### 19.1 主动路径

Claude Code 在 `query.ts:584-665` 先 microcompact，再调用 autoCompact；`790-888` 处理 blocking limit 和 predictive compact。对本项目，`runSteps()` 应从“每次直接 compact”演进为：

```ts
const view = await contextManager.prepare(messages, runtimeState);

if (view.blocking) {
  await contextManager.compact({ reason: "blocking_limit" });
}

const predictive = contextManager.shouldPredictiveCompact(view);
if (predictive) {
  await contextManager.compact({ reason: "predictive_growth" });
}

const request = await contextManager.finalizeForModel(view);
const response = await model.request(request);
```

`prepare()` 不应产生多次摘要；同一 step 用 `turnId + step + contextViewHash` 做幂等键。

### 19.2 反应式路径

Claude Code 在 `query.ts:1349-1470` 对 withheld 的 prompt-too-long 先尝试 collapse drain，再尝试 reactive compact；恢复成功后以 `reactive_compact_retry` 状态重新进入 loop，失败则直接返回错误，不再执行可能注入新 token 的 stop hook。

本项目建议：

```ts
try {
  return await model.request(request);
} catch (error) {
  const classified = classifyProviderContextError(error);
  if (!recoveryGuard.canAttempt(turnId, classified)) throw error;

  if (classified.kind === "context_overflow") {
    const recovered = await contextManager.recoverAfterOverflow(messages, classified);
    if (recovered) return await model.request(recovered.request);
  }
  throw error;
}
```

恢复 guard 至少需要：`turnId`、原始 request hash、错误分类、已尝试阶段和次数。不能只用一个全局 `hasAttemptedCompact`，否则并行 session 或子 Agent 会互相污染。

## 20. M11：如何仿照 Session Memory

### 20.1 提取触发条件

Claude Code 的 `shouldExtractMemory()`（`sessionMemory.ts:135-181`）同时使用：

- 初始化 token threshold；
- 上次提取以来的 token 增长；
- 上次提取以来的 tool call 数；
- 最后一轮是否已经没有 tool call。

关键逻辑是 token threshold 始终必须满足，tool call threshold 不能单独触发提取。这样可以避免每次工具调用都启动一个 memory agent。

本项目可以将它改成事件驱动的 `ContextMemoryScheduler`：

```ts
interface MemoryScheduleState {
  readonly initialized: boolean;
  readonly lastExtractedSequence?: number;
  readonly lastExtractedTokens: number;
  readonly extractionInFlight: boolean;
}

function shouldExtract(state: MemoryScheduleState, current: ContextStats): boolean {
  const tokenGrowth = current.estimatedTokens - state.lastExtractedTokens;
  const enoughTokens = tokenGrowth >= 10_000;
  const enoughTools = current.toolCallsSince(state.lastExtractedSequence) >= 8;
  const atNaturalBreak = current.lastAssistantToolCalls === 0;
  return enoughTokens && (enoughTools || atNaturalBreak) && !state.extractionInFlight;
}
```

### 20.2 隔离 memory agent

`sessionMemory.ts:273-357` 只在 main REPL thread 运行 extraction，通过 `runForkedAgent()` 和 `createMemoryFileCanUseTool()` 限制为特定 memory 文件编辑。

本项目必须保留三个边界：

1. memory agent 不能继承父 agent 的全部工具权限；
2. memory agent 只能写 host 允许的 memory store；
3. extraction 失败不能影响主 turn 完成，也不能把失败文本写进 memory。

## 21. M12：如何仿照 Project Memory

### 21.1 文件和索引约束

Claude Code 的 `memdir.ts:34-103` 用 `MEMORY.md` 作为入口索引，并限制 200 行和 25,000 bytes；超限时按自然换行截断并追加 warning。`buildMemoryLines()`（`199-265`）定义四种记忆类型和使用规则，`buildMemoryPrompt()`（`272-315`）再把受限索引注入上下文。

本项目不应把完整 memory 目录全部拼入 system prompt。建议：

```text
每次加载：MEMORY.md bounded index
按需加载：被当前用户目标命中的 topic memory
使用前验证：路径、函数、配置 key 是否仍存在
```

### 21.2 路径和租户安全

Memory path 必须由 Host 根据 canonical workspace/session ownership 计算。不能允许仓库内配置文件把 memory 根目录指向任意绝对路径，也不能把 memory secret material 放入 EventStore、SSE 或 model-visible diagnostics。

## 22. 从 Claude Code 到本项目的文件级落地映射

建议的新目录不需要照搬 Claude Code 的目录名，但职责应一一对应：

```text
packages/context/
├── budget.ts              # context window、output reserve、threshold
├── estimator.ts           # rough/exact token counter
├── api-round.ts           # model response round grouping
├── api-normalize.ts       # provider-neutral message normalization
├── tool-pairing.ts        # strict/repair pairing validator
├── microcompact.ts        # model-view tool result reduction
├── boundary.ts             # durable boundary creation/replay
├── summary-input.ts        # media/UI/attachment stripping
├── summary-compact.ts     # summary agent + bounded PTL retry
├── post-compact.ts        # preserved messages + attachments
├── recovery.ts            # 400/413 classification and retry guard
├── session-memory.ts      # session memory scheduler/extractor adapter
├── project-memory.ts      # bounded index and on-demand recall
└── manager.ts             # prepare → reduce → finalize → recover orchestration
```

现有文件的职责调整：

| 当前文件 | 建议调整 |
|---|---|
| `packages/compaction/src/index.ts` | 保留兼容 facade，内部委托 `ContextManager`；不再继续堆叠 provider、memory、recovery 逻辑 |
| `packages/runtime/src/index.ts` | 在 `runSteps()` 中调用 `prepare/finalize/recover`，只负责 turn/step 生命周期和事件追加 |
| `packages/contracts/src/index.ts` | 增加 boundary、budget snapshot、recovery attempt、pairing report 的公共投影类型 |
| `packages/runtime/src/system-prompt.ts` | 保持静态/动态 section 分层，增加 post-compact context attachment 的安全入口 |
| model adapters | 暴露 capability、精确计数可选接口、结构化 provider error，不直接掌握 compact 算法 |
| `apps/web` presenter | 只消费 context projection，展示预算来源、compact stage、recovery 状态和诊断原因 |

## 23. 按模块编号执行的开发记录

本节只使用 M01–M14，与第 5 节的 Claude Code 架构模块一一对应。每个模块完成后建立独立 checkpoint；模块之间按照表中的依赖推进，不能跳过前置模块直接在 Runtime 中自由增加新的 context 行为。

| 模块 | Claude Code 依据 | 本项目主要文件/交付物 | 前置模块 | 模块完成标志 |
|---|---|---|---|---|
| M01 | `context.ts`、`autoCompact.ts` | `packages/context/src/budget.ts`、capability contract、budget snapshot | 无 | 不同 route 得到正确窗口、输出预留和 threshold |
| M02 | `tokenEstimation.ts`、`microCompact.ts` | `packages/context/src/estimator.ts`、exact-count adapter seam（已实现） | M01 | estimate/exact/fallback 来源可解释 |
| M03 | `context.ts`、`prompts.ts`、system prompt builder | `packages/context/src/assembler.ts`、`runtime/src/system-prompt.ts` | M01、M02 | system/tools/history/attachments 稳定组装并可计数 |
| M04 | `grouping.ts`、`messages.ts` | `api-round.ts`、`api-normalize.ts`、`tool-pairing.ts` | M02、M03 | 所有 model request 通过 round/pairing gate |
| M05 | `query.ts`、`microCompact.ts` | `tool-result-budget.ts`、`microcompact.ts`、micro receipt | M02、M04 | 原文不变、model view 可释放旧工具结果 |
| M06 | `sessionMemoryCompact.ts` | session-memory compact adapter、保留窗口和边界调整 | M02、M04、M05 | 已有 session summary 时可无摘要模型压缩 |
| M07 | `compact.ts` | summary input、summary agent、PTL retry、summary usage | M02、M04、M06 | 摘要请求过大可有限重试并安全失败 |
| M08 | `messages.ts`、`compact.ts` | boundary event、preserved segment、post-compact attachments | M05、M06、M07 | compact 后消息顺序、附件和 dedupe 稳定 |
| M09 | `query.ts`、`autoCompact.ts`、`reactiveCompact.ts` | proactive/reactive recovery coordinator | M01–M08 | 400/413 恢复有 guard、transition 和 circuit breaker |
| M10 | transcript/session restore | EventStore boundary replay、context view rebuild | M08、M09 | restart/replay 后 model view 与 boundary 一致 |
| M11 | `SessionMemory/sessionMemory.ts` | extraction scheduler、fork context、受限 memory store | M02、M08、M10 | memory extraction 与主 turn 隔离且可恢复 |
| M12 | `memdir/memdir.ts`、memory scan | bounded `MEMORY.md` index、topic recall、path policy | M03、M10、M11 | memory 按需加载、过期验证、租户隔离 |
| M13 | TokenWarning/analyzeContext/query events | Context projection、API/Web diagnostic presenter | M01、M05、M08、M09、M10 | refresh/replay 后诊断状态一致 |
| M14 | `contextCollapse/*`、`context-collapse.md` | 仅在前述模块稳定后评估 collapse/snip | M01–M13 | 明确实现、保持 stub 或延后，不伪造可用状态 |

### M01–M03：预算、计数和 Context Assembly

先完成 Claude Code L1–L3。这里的开发记录必须包含：

- `ModelContextCapability` 的 provider/model 来源；
- `ContextBudgetSnapshot` 的计算公式和 source；
- system prompt、工具 schema、用户上下文、历史和附件的分项估算；
- provider exact count 不可用时的保守 fallback；
- 为每个 request 生成可回放的 assembly fingerprint。

参考代码对照：`D:/Develop/claude-code/src/utils/context.ts`、`src/services/compact/autoCompact.ts`、`src/services/tokenEstimation.ts`。本项目实现以 `packages/context` 新包为主，`packages/runtime` 只调用接口，不在 `runSteps()` 内复制预算公式。

### M04：API Round 与消息合法性

M04 是所有后续 compact 模块的共同底座。开发时必须同时完成：

1. assistant response/request ID 在 EventStore 中的保存；
2. 按 response ID 的 API round 分组；
3. 压缩起点向前寻找完整 tool pair 和 thinking block；
4. request 发送前的 normalize、duplicate detection、orphan repair；
5. repair/strict 两种策略及其事件。

参考代码对照：`D:/Develop/claude-code/src/services/compact/grouping.ts`、`D:/Develop/claude-code/src/utils/messages.ts:2292-2670`、`5591-5947`。完成前，M05–M09 只能使用 fixture，不应把不完整 pairing 逻辑接入真实模型。

### M05：Tool Result Budget 与 MicroCompact

M05 只对应 Claude Code L5 的工具结果局部清理，不包含全局摘要。开发记录要对照：

- `COMPACTABLE_TOOLS` 白名单；
- tool result 文本、image/document、JSON input 的估算；
- time-based trigger 和最近结果保留；
- `clearedToolUseIds`、`tokensSaved` 和 micro boundary；
- transcript 原文与 model view 的分离；
- cached microcompact 是否支持、为什么暂时关闭或启用。

参考代码对照：`D:/Develop/claude-code/src/services/compact/microCompact.ts`、`cachedMicrocompact.ts`、`D:/Develop/claude-code/src/query.ts:584-624`。

### M06–M08：Session Memory Compact、Summary Compact 和 Post-Compact Rebuild

这三个模块对应 Claude Code L5.2、L5.3 和 L6，必须按该顺序记录：

- M06 先验证已有 session memory 是否能提供可靠摘要边界；
- M07 在 M06 返回 null 或 memory 为空时，调用无工具的 summary agent；
- M08 将 boundary、summary、保留消息、最近文件、plan、skill、MCP 和 hooks 按固定顺序重建。

参考代码对照：

- `D:/Develop/claude-code/src/services/compact/sessionMemoryCompact.ts`；
- `D:/Develop/claude-code/src/services/compact/compact.ts:411-690`；
- `D:/Develop/claude-code/src/services/compact/compact.ts:1467-1650`；
- `D:/Develop/claude-code/src/utils/messages.ts:4967-5090`。

M06–M08 的 checkpoint 必须包含压缩前后消息 fixture、tool pair 边界 fixture、摘要请求超限 fixture、附件去重 fixture 和 boundary replay fixture。

### M09–M10：Query Recovery 与 Durable Restore

M09 依照 Claude Code query loop 接入主动阈值、预测式 compact、prompt-too-long/413 reactive compact 和 circuit breaker。M10 再把 boundary、preserved segment 和 algorithm version 写入本项目 EventStore/SQLite，使恢复不依赖当前进程内的压缩结果。

参考代码对照：`D:/Develop/claude-code/src/query.ts:790-888,1349-1470`、`D:/Develop/claude-code/src/services/compact/autoCompact.ts:270-380`、`D:/Develop/claude-code/src/utils/sessionRestore.ts`、`src/services/sessionTranscript/`。

M09–M10 完成后，才允许把真实 DeepSeek/provider 的长任务 smoke 作为上下文恢复验证；此前只能验证本地 deterministic fixture。

### M11–M13：Memory、Project Memory 与 Context Diagnostics

M11 对应 Claude Code Session Memory 的后台提取；M12 对应 `memdir` 项目记忆；M13 对应 TokenWarning、ContextVisualization 和 query compact events。

参考代码对照：

- `D:/Develop/claude-code/src/services/SessionMemory/sessionMemory.ts`；
- `D:/Develop/claude-code/src/services/SessionMemory/sessionMemoryUtils.ts`；
- `D:/Develop/claude-code/src/memdir/memdir.ts`；
- `D:/Develop/claude-code/src/memdir/findRelevantMemories.ts`；
- `D:/Develop/claude-code/src/components/TokenWarning.tsx`。

M11/M12 的 memory 内容不能成为新的事实来源，必须由 EventStore、workspace resolver、tenant policy 和实时文件验证约束；M13 只投影事实，不在 Web 端重新估算或伪造 compact 状态。

### M14：Context Collapse 的最后决策

Claude Code 的 `contextCollapse` 目录虽然接入了 query、persist 和 recovery 位置，但本地快照文档明确说明核心为 stub。M14 的开发记录只允许有三种结果：

1. 按源码补齐并通过独立 ADR；
2. 保留接口但明确 `deferred/unavailable`；
3. 证明前述 M01–M13 已无法满足真实场景后再开启实现。

不能因为 Claude Code 存在 `ContextCollapse` 名称，就在本项目 Web 或 system prompt 中宣称该能力已经可用。

## 24. 代码审查时的关键问题清单

审查任何上下文管理 PR 时，应逐项回答：

- 新增的 token 数是否包含 system prompt、工具 schema 和 output reserve？
- 估算值是否标记来源，provider 精确值失败是否安全降级？
- compact 是否只改变 model view，而没有修改原始 EventStore 事实？
- 压缩边界是否会切断 thinking、tool_use、tool_result 或 streaming response？
- pairing repair 是否有报告、事件和 strict mode？
- summary agent 是否完全禁止工具和 workspace 副作用？
- overflow retry 是否按 turn/request 隔离并有最大次数？
- retry 失败后是否避免执行会继续注入 token 的 hook？
- post-compact 附件是否去重、有界并验证 workspace/tenant 权限？
- 重启、SSE replay、重复 command 后，model-visible view 是否稳定？
- Web 展示的是 durable projection，还是前端自行猜测的上下文状态？

## 25. 参考和许可边界补充

Claude Code 本地快照没有在本次调研中确认一个可供本项目复制其内部实现的根许可证。因此本文件中的伪代码是本项目重新表达的设计草图，不是 Claude Code 源码复制；后续实现只登记为 `behavior-reference`，除非另行确认具体文件/package 的许可证和允许的改编范围。

涉及上游行为的实现提交，应在 PR/issue 中注明：

```text
Reference: D:/Develop/claude-code/<path>
Reference type: behavior-reference
Adaptation: rewritten for this project's EventStore/Session/Tool/Permission contracts
Validation: unit + contract + recovery + security + replay tests
```
