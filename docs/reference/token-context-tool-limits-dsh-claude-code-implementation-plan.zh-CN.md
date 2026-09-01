# Token、上下文、工具结果与并行限制调研及确定实施计划

状态：`accepted-plan`（调研与实施基线已确定，本文创建时尚未修改运行时代码）
日期：2026-08-28
所属阶段：Phase 8，高级上下文能力与 Coding Agent 可靠性
调研范围：

- 当前仓库：本仓库根目录
- DSH：`D:/Develop/deepseek-harness-fork`
- Claude Code：`D:/Develop/claude-code`

本文固定后续实施路径。实施时按第 6 节的阶段和文件清单逐项修改，不再重新选择参数，不在编码阶段增加并行的候选方案。

## 1. 本任务的阶段与契约边界

| 治理问题 | 本次结论 |
|---|---|
| 所属 Phase | Phase 8；模型能力与上下文预算属于 8.1，工具结果持久化和并行调度属于 8.4 可靠性增强 |
| 解决的问题 | LLM 请求输出上限过低、未知模型窗口回退过低、Agent step 上限过低、工具结果直接截断、单消息并行工具结果聚合失控、时间型压缩策略不一致、并行工具调用无统一并发上限 |
| 契约影响 | 在 `ModelContextCapability` 中补充独立的 `defaultMaxOutputTokens`，保留现有 `maxOutputTokens` 作为模型可用上限；同步 `ModelCatalogEntry`、`ModelProtocolModelConfig`、`ToolResultBudgetPolicy`；新增工具结果替换记录和并行调度配置；不改变权限和 workspace 越界规则 |
| DSH 参考入口 | `packages/llm/llm-deepseek/src/adapter.ts`、`packages/llm/llm-pi-ai/src/config.ts`、`packages/core/agent-loop/src/constants.ts`、`index.ts`、`tool-calls.ts` |
| Claude Code 参考入口 | `src/utils/context.ts`、`src/services/api/claude.ts`、`src/query.ts`、`src/constants/toolLimits.ts`、`src/utils/toolResultStorage.ts`、`src/services/compact/timeBasedMCConfig.ts` |
| 上游代码使用方式 | DSH 和 Claude Code 均只作行为与结构参考；实施时使用本项目 contract、EventStore、WorkspaceResolver 和 ToolRuntime 自行实现。若直接复制或大量改编 DSH 代码，必须更新 `docs/../source-reuse-register.md` 并保留 MIT 许可证信息 |
| 验收场景 | v4pro Anthropic-compatible 请求默认发送 32K 输出预算；64K 以内显式配置受模型上限校验；未知模型按 200K 窗口预算；Agent 可运行 32 个默认 step 且接受 512 上限；大工具结果落盘并给模型预览；单消息工具结果不超过聚合预算；时间压缩默认关闭；并行调用最多 10 个 |
| 回滚 | 每个实施阶段使用独立 Git checkpoint；按阶段回滚，不删除 EventStore 原始工具结果和已落盘 artifact，不降低 workspace、permission、取消和审计规则 |

## 2. 当前仓库的实际限制

当前系统同时存在 Provider 输出、上下文、Agent step、工具结果和摘要五类预算。它们必须分别处理。

| 层级 | 当前值 | 当前代码入口 | 实际作用 |
|---|---:|---|---|
| Anthropic Messages adapter 默认输出 | `8192` tokens | `packages/llm/src/providers/anthropic-messages/adapter.ts:DEFAULT_MAX_OUTPUT_TOKENS` | 构造 adapter 时未提供 `maxOutputTokens` 的请求默认值 |
| Anthropic wire 请求 | adapter 解析后的固定值 | `packages/llm/src/providers/anthropic-messages/serialize.ts:serializeAnthropicRequest()` | 写入请求体 `max_tokens`，本次 v4pro 的 `ANTHROPIC_MAX_TOKENS` 发生在这一层 |
| 内置 Anthropic capability | `200000 / 8192` | `packages/llm/src/index.ts:createConfiguredChatModel()` | Runtime 上下文预算和 adapter bootstrap |
| 内置 DeepSeek capability | `1000000 / 8000` | `packages/llm/src/index.ts:createConfiguredChatModel()` | 当前 OpenAI-compatible adapter 不发送 `max_tokens`；`8000` 主要用于本地预算 |
| Yayi 模型推断 | DS `1000000 / 8000`，其他 `200000 / 8000` | `packages/llm/src/catalog.ts:inferModelContextCapability()` | 自定义 Yayi profile 未显式登记能力时的 host 估算 |
| 未知模型 context fallback | `16000 / 0` | `packages/context/src/index.ts:fallbackModelContextCapability()` | adapter 和 route 都无 capability 时的输入窗口与输出能力回退 |
| Legacy compaction 默认 | `16000` tokens | `packages/compaction/src/index.ts:DEFAULT_CONTEXT_BUDGET` | 旧压缩 facade 的兼容默认值 |
| Runtime step 默认与合法范围 | 默认 `12`，范围 `1–100` | `packages/runtime/src/index.ts:AgentHost.constructor()`、`runSteps()` | 达到上限时抛出 `MAX_AGENT_STEPS_EXCEEDED` |
| 评测 step 默认与合法范围 | 默认 `32`，范围 `1–100` | `scripts/eval-mvp/run-pilot.ps1`、`run-agent-task.ts` | 评测 Runner 单独覆盖 Runtime 默认值 |
| 单个工具结果 model view | `8000` 字符 | `packages/context/src/tool-result-budget.ts:normalizePolicy()` | 当前直接生成 bounded model view，完整原文只在 EventStore transcript 中 |
| 工具结果数量触发 | `10` 个 | 同上 | 触发旧结果 microcompact |
| 工具结果 token 触发 | `20000` tokens | 同上 | 按近似 token 触发 microcompact |
| 工具结果时间触发 | `30` 分钟 | 同上 | 当前默认启用，超过时间间隔会触发 |
| 最近工具结果保留 | `5` 个 | 同上 | microcompact 后保留最新结果 |
| Summary 近期消息 | `8000` tokens | `packages/context/src/summary-compact.ts:DEFAULT_SUMMARY_COMPACT_CONFIG` | 摘要后保留的近期消息预算 |
| Summary 最终文本 | `4000` 字符 | 同上 | `conversation-summary` 中最终保存的摘要长度 |
| Summary PTL 重试 | `3` 次 | 同上 | 摘要模型 prompt-too-long 的有界重试 |
| Summary 输出预留 | `20000` tokens | `packages/context/src/index.ts:MAX_SUMMARY_OUTPUT_TOKENS` | 上下文 effective window 的摘要输出预留，不是最终摘要字符数 |

### 2.1 v4pro 当前调用链

`apps/api/.data/provider-profiles.json` 中的 `yayi-deepreasoning-ds-v4pro` 使用 `anthropic-messages` 协议。当前调用链为：

```text
ProviderProfile
  → packages/llm/src/catalog.ts:createModelFromProviderProfile()
  → packages/llm/src/index.ts:ModelProtocolRegistry
  → packages/llm/src/providers/anthropic-messages/adapter.ts
  → packages/llm/src/providers/anthropic-messages/serialize.ts
  → request.max_tokens
```

profile 未设置 `defaultMaxOutputTokens` 时，catalog 不传 `maxOutputTokens`，adapter 回退到 `8192`。与此同时，`inferModelContextCapability()` 为该 DS 模型推断 `maxOutputTokens=8000`。这两个值属于不同入口：

- `8192` 决定 Anthropic 请求体；
- `8000` 决定 Runtime 本地上下文预算；
- 两者都需要在实施阶段 1 统一到同一份模型能力解析结果。

因此，v4pro 本次 `ANTHROPIC_MAX_TOKENS` 失败发生在单次输出预算耗尽，不是 1M 输入窗口或 Runtime 上下文窗口耗尽；实施阶段 1 先处理请求输出上限，阶段 2 再处理未知能力 fallback。

## 3. DSH 与 Claude Code 的实际实现

### 3.1 DSH

| 能力 | DSH 实现 | 源码入口 | 本项目采用方式 |
|---|---|---|---|
| DeepSeek 默认 context | `1000000` | `packages/llm/llm-deepseek/src/adapter.ts:DEFAULT_CONTEXT_WINDOW` | 保留 1M 模型能力表达方式 |
| DeepSeek 默认输出 | `256000` | `packages/llm/llm-deepseek/src/adapter.ts:DEFAULT_MAX_TOKENS` | 不采用该数值 |
| DeepSeek 模型级输出值 | model entry `maxTokens` 覆盖 connection `maxTokens` | `packages/llm/llm-deepseek/src/adapter.ts:resolveModel()` | 学习“模型级值覆盖 provider 默认值”的解析顺序 |
| 通用 pi-ai fallback | context `262144`，output `32768` | `packages/llm/llm-pi-ai/src/config.ts` | 证明通用 Coding Agent fallback 不应停留在 16K；本项目按已确定值使用 200K/32K |
| Agent 主循环 | 没有固定的统一默认 step 上限 | `packages/core/agent-loop/src/agent.ts` | 本项目继续保留安全硬上限，但提高到 512 |
| 并行工具默认 | `10` | `packages/core/agent-loop/src/constants.ts:DEFAULT_MAX_PARALLEL_TOOL_CALLS` | 直接采用数值和 rolling pool 行为 |
| 并行调度 | parallel rolling pool、exclusive barrier、结果按模型顺序提交、abort 后停止补充并 drain 已启动调用 | `packages/core/agent-loop/src/tool-calls.ts` | 按相同行为重写本项目 scheduler |
| 基础压缩 | threshold ratio `0.8`、retain ratio `0.16`、summary `8192` tokens | `packages/compaction/compaction-basic/src/config.ts` | 只作压缩结构参考，不用于本轮固定参数 |
| 工具结果中段剪枝 | threshold `8192` 字符、head `4096`、tail `1024` | `packages/compaction/compaction-tool-result-pruner/src/config.ts` | 不作为新的单工具结果主路径；新主路径采用 Claude Code 落盘与预览 |

### 3.2 Claude Code

| 能力 | Claude Code 实现 | 源码入口 | 本项目采用方式 |
|---|---|---|---|
| 未知模型 context | `200000` | `src/utils/context.ts:MODEL_CONTEXT_WINDOW_DEFAULT` | 直接采用 |
| 通用默认输出 | `32000` tokens | `src/utils/context.ts:MAX_OUTPUT_TOKENS_DEFAULT` | 直接采用到 Anthropic-compatible adapter |
| 通用请求上限 | `64000` tokens | `src/utils/context.ts:MAX_OUTPUT_TOKENS_UPPER_LIMIT` | 直接采用为协议硬上限 |
| 新模型特殊上限 | 部分模型 `128000` | `src/utils/context.ts:getModelMaxOutputTokens()` | 当前本项目硬上限仍固定 `64000`，不开放 128K |
| 8K slot reservation cap | 默认请求可暂用 `8000`，触发后升级 `64000` 重试 | `src/services/api/claude.ts`、`src/query.ts:max_output_tokens_escalate` | 不采用 8K 默认；本项目直接从 32K 开始 |
| Summary effective-window 预留 | `20000` tokens | `src/services/compact/autoCompact.ts` | 保留现有独立预留 |
| 单工具结果落盘阈值 | `50000` 字符 | `src/constants/toolLimits.ts:DEFAULT_MAX_RESULT_SIZE_CHARS` | 直接采用 |
| 单工具结果硬上限 | `100000` tokens | `src/constants/toolLimits.ts:MAX_TOOL_RESULT_TOKENS` | 直接采用为安全硬上限 |
| 单消息工具结果聚合预算 | `200000` 字符 | `src/constants/toolLimits.ts:MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` | 直接采用 |
| 落盘预览 | 完整结果写入 session `tool-results`，模型收到路径和前 `2000` bytes 预览 | `src/utils/toolResultStorage.ts:persistToolResult()`、`buildLargeToolResultMessage()` | 按本项目 workspace/artifact 规则自行实现 |
| 聚合收缩 | 对每个 API user message 分组，优先落盘最大的 fresh 结果，直到聚合大小回到预算内 | `src/utils/toolResultStorage.ts:enforceToolResultBudget()` | 直接采用行为 |
| 替换稳定性 | `seenIds`、`replacements` 固定已见结果命运，并将 replacement record 写入 transcript 供 resume 重建 | `src/utils/toolResultStorage.ts:ContentReplacementState`、`reconstructContentReplacementState()` | 通过 EventStore receipt 和恢复投影实现 |
| Bash 输出 | 默认 `30000` 字符，上限 `150000` 字符 | `src/utils/shell/outputLimits.ts` | 纳入单工具输出实施阶段 |
| 时间型 microcompact | 默认关闭；启用后 gap `60` 分钟；保留最近 `5` 个 | `src/services/compact/timeBasedMCConfig.ts` | 直接采用 |
| 主循环 turn 上限 | 由调用方传入 `maxTurns`，没有统一固定默认值 | `src/QueryEngine.ts`、`src/query.ts` | 本项目保留默认 32、硬上限 512 |

## 4. 已确定的目标参数

以下值是实施目标，不在实施阶段重新讨论。

| 项目 | 确定目标 | 说明 |
|---|---:|---|
| Anthropic-compatible 默认输出 | `32000` tokens | profile 未提供默认值时生效 |
| Anthropic-compatible 协议硬上限 | `64000` tokens | 任何 profile、环境变量或 catalog 配置都不能突破 |
| 模型级输出上限 | 必须校验 | 保留 `ModelContextCapability.maxOutputTokens` 的“模型可用上限”语义；模型上限低于 64K 时使用更低的模型上限；默认值、显式值、模型上限和协议 64K 硬上限在构造 adapter 前校验 |
| DSH DeepSeek `256000` | 不采用 | 不进入本项目默认值、fallback 或 hard cap |
| Runtime 默认 step | `32` | 删除默认 `12` |
| Runtime/评测 step 合法范围 | `1–512` | 删除现有 `100` 上限，`512` 是统一硬上限 |
| 未知模型 context fallback | `200000` tokens | 仅用于 adapter 无能力信息时的本地估算，不代表服务端真实能力 |
| 未知 Anthropic-compatible 输出 fallback | 默认 `32000`，能力上限 `64000` tokens | `defaultMaxOutputTokens` 用于请求默认值；`maxOutputTokens` 用于模型级上限与上下文能力元数据 |
| Summary 最终文本 | `8192` 字符 | 修改 `maxSummaryChars`；`MAX_SUMMARY_OUTPUT_TOKENS=20000` 仍是独立的摘要请求预留 |
| 单工具结果落盘阈值 | `50000` 字符 | 超限后保存完整结果，模型只接收预览引用，不直接截断原文 |
| 单工具结果硬上限 | `100000` tokens | 防止不可控内存、磁盘和请求占用 |
| 单消息工具结果聚合预算 | `200000` 字符 | 按最终 API user message 分组计算 |
| 工具结果预览 | 前 `2000` bytes + artifact 路径 | 路径必须由 host 生成并受 workspace/artifact 规则约束 |
| Shell model-visible 输出 | 默认 `30000` 字符，最大 `150000` 字符 | 与通用工具结果落盘配合，不改变完整后台 job spill |
| 时间型 microcompact | 默认关闭 | 开启后 `60` 分钟触发，保留最近 `5` 个可压缩结果 |
| 并行工具调用 | 最多 `10` 个 in-flight | parallel 工具使用 rolling pool；exclusive 工具形成 barrier；结果按模型声明顺序提交 |

### 4.1 输出能力解析规则

实施后的解析顺序固定为：

```text
ModelCatalogEntry.defaultMaxOutputTokens
  ?? ModelContextCapability.defaultMaxOutputTokens
  ?? Anthropic-compatible protocol default 32000
        ↓
ModelContextCapability.maxOutputTokens
  ?? protocol hard upper limit 64000
        ↓
校验 1 <= default <= model upper <= 64000
        ↓
ModelProtocolModelConfig
        ↓
AnthropicMessagesChatModel
        ↓
serializeAnthropicRequest().max_tokens
```

模型声明的上限小于 `32000` 时，catalog 必须同时声明较低的 `defaultMaxOutputTokens`；配置不一致时在 adapter 构造阶段失败，不向 provider 发送必然失败的请求。

### 4.2 Context fallback 的含义

未知模型按以下 capability 进入本地预算：

```yaml
maxInputTokens: 200000
maxOutputTokens: 64000
defaultMaxOutputTokens: 32000
source: estimate
```

现有 Claude Code 风格摘要预留仍为 `min(maxOutputTokens, 20000)`，因此默认 effective window 为：

```text
200000 - 20000 = 180000 tokens
```

该 fallback 只控制 warning、auto-compact、blocking 和预测增长判断。provider 仍可用 400/413 或能力发现结果纠正估算。

### 4.3 工具结果目标数据流

```text
ToolRuntime 完成工具
  → EventStore 追加完整 tool/result
  → 单工具结果检查
      ├─ <= 50000 chars：保留 model view 原文
      └─ > 50000 chars：完整结果写入 session artifact，model view 替换为路径 + 2000-byte 预览
  → 按最终 API user message 聚合 tool_result
      ├─ <= 200000 chars：保持
      └─ > 200000 chars：从最大的 fresh 结果开始落盘替换，直到回到预算内
  → count/token microcompact
  → 可选的时间型 microcompact（默认关闭，60min，keep 5）
  → normalize/tool pairing
  → provider request
```

EventStore 的完整 `tool/result` 不被替换或删除。落盘、预览和 microcompact 只改变 model-visible view。

## 5. 不纳入本轮目标的内容

- 不采用 DSH DeepSeek `256000` 默认输出；
- 不开放 Claude Code 部分新模型的 `128000` 输出上限；
- 不复制 Claude Code GrowthBook、遥测、账户或 prompt-cache 商业逻辑；
- 不把工具结果 artifact 写到 workspace 之外；
- 不用 `maxSteps=512` 代替取消、超时、quota 和 context blocking；
- 不在本轮重写 M06–M14 Session Memory、Project Memory、context collapse 或 provider cached microcompact；
- 不修改 `AGENTS.md`。

## 6. 下一步实施阶段

每个阶段直接列明修改点、上游参照、验收和回滚。阶段按顺序执行，每阶段完成后运行相应门禁并建立独立 checkpoint。

### 阶段 1：统一 Anthropic-compatible 输出能力与请求上限

本阶段修改以下内容：

| 本仓库文件/入口 | 直接修改内容 | 对照源码 |
|---|---|---|
| `packages/contracts/src/index.ts:ModelContextCapability` | 增加可选 `defaultMaxOutputTokens`；保留现有 `maxOutputTokens` 的模型可用上限语义；校验语义固定为 default 不得高于 model upper | Claude Code `src/utils/context.ts:getModelMaxOutputTokens()` |
| `packages/contracts/src/index.ts:ContextBudgetConfig` | 增加可选 `defaultMaxOutputTokens`，用于无 capability 时区分“请求默认值 32K”和“模型能力上限 64K” | Claude Code default/upper 双值解析 |
| `packages/contracts/src/index.ts:ModelCatalogEntry` | 继续使用现有 `defaultMaxOutputTokens` 表达模型默认值；由 `contextCapability.maxOutputTokens` 表达模型上限 | Claude Code `src/utils/context.ts`；DSH model entry `maxTokens` |
| `packages/llm/src/registry.ts:ModelProtocolModelConfig` | 保留 adapter 的请求 `maxOutputTokens`；把已解析的 capability 一并传入，adapter 以 capability.maxOutputTokens 执行模型级上限校验 | DSH `llm-deepseek/src/adapter.ts` 的 connection/model 覆盖顺序 |
| `packages/llm/src/providers/anthropic-messages/types.ts` | 保留 `maxOutputTokens` 请求默认配置，并让 adapter 接收 `contextCapability` 作为模型上限来源 | Claude Code `src/services/api/claude.ts` |
| `packages/llm/src/providers/anthropic-messages/adapter.ts` | 将默认值改为 `32000`；增加协议硬上限 `64000`；以 `contextCapability.maxOutputTokens` 和协议上限校验请求值；移除当前允许到 `1000000` 的宽泛校验 | Claude Code `MAX_OUTPUT_TOKENS_DEFAULT`、`MAX_OUTPUT_TOKENS_UPPER_LIMIT` |
| `packages/llm/src/providers/anthropic-messages/serialize.ts` | 保持 `max_tokens` 单一写入点；只接收 adapter 已校验的 resolved 值，不在 serializer 重新猜测默认值 | Claude Code `claude.ts:getMaxOutputTokensForModel()` |
| `packages/llm/src/index.ts:createBuiltInModelProtocolRegistry()` | 把 `contextCapability` 和已解析的 `maxOutputTokens` 请求默认值传入 Anthropic adapter；模型上限从 capability.maxOutputTokens 读取 | 当前 registry 数据流 |
| `packages/llm/src/index.ts:createConfiguredChatModel()` | 内置 Anthropic capability 设为 `maxOutputTokens=64000`、`defaultMaxOutputTokens=32000`；DeepSeek 保持 provider-specific `8000`，不引入 `256000` | Claude Code 通用 32K/64K；DSH 256K 仅作排除项 |
| `packages/llm/src/catalog.ts:inferModelContextCapability()` | Yayi Anthropic-compatible DS/GL/QW profile 设为 `maxOutputTokens=64000`、`defaultMaxOutputTokens=32000`；context 仍按 DS 1M、其他 200K 推断 | Claude Code 32K/64K；当前 Yayi inference |
| `packages/llm/src/catalog.ts:createModelFromProviderProfile()` | 同时传递 model default 和 capability upper；profile/catalog 配置不一致时 fail fast | DSH model-level override |
| `apps/api/src/server.ts` 的内置模型 capability 和 discovery normalization | API catalog 保留、返回并验证 default/upper；不把本地 profile 中的 8K 旧推断继续投影为最终能力 | 当前 API model catalog |
| `packages/llm/src/providers/anthropic-messages/*.test.ts`、`packages/llm/src/index.test.ts`、`catalog.test.ts`、`apps/api/src/server.test.ts` | 增加 32K 默认、64K 边界、64001 拒绝、模型低上限、v4pro profile 实际 `max_tokens=32000` 合同测试 | Claude Code model limit tests 的行为 |

阶段 1 验收：

- v4pro 未显式配置输出值时，请求 JSON 的 `max_tokens` 为 `32000`；
- 显式 `64000` 可通过；`64001` 在发起 HTTP 前失败；
- model upper 为 `8192` 且 default 为 `8192` 时正常；default 为 `32000` 且 model upper 为 `8192` 时配置失败；
- Runtime capability、API catalog 和 adapter 请求值来自同一解析结果；
- DeepSeek 路由没有出现 `256000`。

阶段 1 回滚：回滚 capability upper 字段和 Anthropic adapter 解析；已有 profile metadata 保持可读，未知 upper 按旧字段忽略。

### 阶段 2：统一 context fallback、step 上限与摘要字符上限

本阶段修改以下内容：

| 本仓库文件/入口 | 直接修改内容 | 对照源码 |
|---|---|---|
| `packages/context/src/index.ts` | `DEFAULT_CONTEXT_WINDOW_TOKENS` 从 `16000` 改为 `200000`；新增 capability 上限 fallback `64000` 和默认请求 fallback `32000`；保留 `MAX_SUMMARY_OUTPUT_TOKENS=20000`；补充 fallback/effective-window 测试 | Claude Code `src/utils/context.ts`、`autoCompact.ts` |
| `packages/compaction/src/index.ts:DEFAULT_CONTEXT_BUDGET` | legacy `maxTokens` 从 `16000` 改为 `200000`，避免旧 facade 在 capability 缺失时重新形成 16K 瓶颈；`maxSummaryChars` 改为 `8192` | Claude Code 200K fallback；用户确定的 8192 字符 |
| `packages/context/src/summary-compact.ts:DEFAULT_SUMMARY_COMPACT_CONFIG` | `maxSummaryChars` 从 `4000` 改为 `8192`；`recentMessageTokens=8000`、`maxPtlRetries=3` 保持不变 | Claude Code summary 与当前 M07 行为 |
| `packages/runtime/src/index.ts:AgentHost.constructor()` | 默认 `maxSteps` 从 `12` 改为 `32`；合法范围从 `1–100` 改为 `1–512`；错误文案同步 | Claude Code 调用方 budget；本项目评测已使用 32 |
| `packages/runtime/src/index.ts:runSteps()` | 继续以 resolved `maxSteps` 控制循环；保留 `MAX_AGENT_STEPS_EXCEEDED`，事件中记录实际上限 | 当前 Runtime 主循环 |
| `packages/runtime/src/subagent-provider.ts` | 子 Agent 显式值和继承值使用同一 `1–512` 规则，不保留隐藏的 100 上限 | Runtime 主 Agent 规则 |
| `apps/api/src/server.ts` | API Host 继续传入 `maxSteps`，新增边界测试验证 512 可用、513 拒绝 | 当前 API Host 构造入口 |
| `scripts/eval-mvp/run-pilot.ps1` | `[ValidateRange(1, 100)]` 改为 `[ValidateRange(1, 512)]`，默认仍为 `32` | 统一硬上限 |
| `scripts/eval-mvp/run-agent-task.ts` | `parseBoundedInteger(..., 1, 100)` 改为 `1, 512` | 统一硬上限 |
| `docs/evaluation/coding-agent-bench-mvp.zh-CN.md` | 实施完成后更新旧的 `12`/`100` 描述，记录普通默认 32、硬上限 512 | 当前评测事实文档 |
| `packages/context/src/index.test.ts`、`summary-compact.test.ts`、`packages/compaction/src/index.test.ts`、`packages/runtime/src/index.test.ts` | 覆盖 fallback `200000/32000`、effective `180000`、summary `8192` 字符、maxSteps 32/512/513 | Claude Code fallback 和本项目 Runtime contract |

阶段 2 验收：

- 无 capability 的模型在 `step/started.contextBudget` 中报告 `maxInputTokens=200000`、`maxOutputTokens=64000`、`defaultMaxOutputTokens=32000`、`effectiveWindowTokens=180000`、`source=estimate`；
- 普通 Host 默认运行 32 step；显式 512 可构造；513 立即拒绝；
- Eval Runner 接受 512 且拒绝 513；
- Summary 最终正文最多 `8192` 字符；
- 全仓库不再存在会影响运行行为的 16K context fallback、12 step 默认或 100 step 上限。

阶段 2 回滚：回滚默认常量和校验范围；事件 schema 不变，旧事件继续可回放。

### 阶段 3：按 Claude Code 实现单工具结果落盘与预览（已完成，2026-08-28）

本阶段修改以下内容：

| 本仓库文件/入口 | 直接修改内容 | 对照源码 |
|---|---|---|
| `packages/contracts/src/index.ts` | 增加 provider-neutral 的 `ToolResultReplacementRecord`、artifact reference 和 replacement reason；记录 `toolCallId`、artifact 相对路径、原始大小、preview、阈值，不把完整内容重复写入 receipt | Claude Code `ContentReplacementRecord` |
| 新增 `packages/context/src/tool-result-storage.ts` | 实现 `50000` 字符落盘阈值、`100000` token 硬上限、`2000` bytes 预览、文本/JSON 后缀、原子或 exclusive create、已存在文件幂等；preview/receipt 先脱敏常见 credential-shaped 字段，artifact 仍保存完整原文；生成 model-visible preview reference | Claude Code `src/utils/toolResultStorage.ts:persistToolResult()`、`buildLargeToolResultMessage()` |
| `packages/context/src/tool-result-budget.ts` | 移除以 `maxResultChars=8000` 为默认的直接前缀截断主路径；改为调用 storage adapter 获取完整/preview view；保留 protected tool result 排除和 token 估算 | Claude Code 单工具结果持久化 |
| `packages/runtime/src/index.ts:prepareModelContext()` | 在 normalize/tool pairing 后、聚合预算前应用单结果持久化；使用 Session、workspace 和 toolCallId 构造稳定 artifact path | Claude Code query-loop 调用顺序 |
| `packages/runtime/src/index.ts:conversationMessages()` 与恢复路径 | EventStore 仍读取完整 `tool/result`；同时重放 replacement receipt，使重启后的 model view 继续使用字节一致的 preview | Claude Code `reconstructContentReplacementState()` |
| `packages/runtime/src/index.ts` 事件写入 | 新增 `context/tool_result_persisted` 或等价稳定事件；只记录 metadata、relative artifact path 和 preview，不记录 secret/provider body | Claude Code transcript replacement record |
| `packages/workspace/src/index.ts:WorkspaceResolver` | 复用现有路径边界，artifact 固定写入 workspace 内 `.agent-artifacts/tool-results/<session>/<toolCallId>.txt|json`；拒绝路径穿越、symlink 越界和跨 Session 覆盖 | 本项目 workspace 安全不变量 |
| `packages/tools/src/builtin.ts` | shell/terminal model-visible 默认输出改为 `30000` 字符，允许配置到 `150000`；完整长任务输出继续使用 job spill，不删除现有 512 KiB host buffer 安全上限 | Claude Code `src/utils/shell/outputLimits.ts` |
| `apps/api/src/artifacts.ts`、`apps/api/src/server.ts` | 通过现有 artifact 安全读取路径暴露结果文件；公开响应不返回宿主绝对路径，不允许跨 Session/tenant 读取 | Claude Code path reference 行为 + 本项目 tenant/workspace 规则 |
| 新增/更新 context、runtime、workspace、API 测试 | 覆盖 49999/50000/50001、100K token 硬上限、Unicode bytes、JSON、image/non-text 排除、落盘失败、EEXIST 幂等、重启恢复、跨 workspace 拒绝和 preview 脱敏 | Claude Code toolResultStorage tests 的行为 |

阶段 3 验收：

- `50000` 字符以内的普通文本保持原文；超限结果完整落盘，模型看到 artifact 引用和最多 `2000` bytes 预览；
- EventStore 原始 `tool/result` 完整；replacement receipt 不重复保存完整结果；
- 同一 `toolCallId` 重放不会重复写文件或改变 preview；
- API/Web 只能通过受控 artifact 入口读取，不能使用绝对路径绕过 tenant/workspace；
- 落盘失败时 fail closed：保留有界错误结果，不把无限大原文继续发送给模型。

阶段 3 回滚：停止创建新 replacement，保留已有 artifact 和事件可读；model view 回退到 EventStore 原始结果与现有 microcompact。

阶段 3 已按上述入口完成。实际实现固定使用 `.agent-artifacts/tool-results/<session>/<toolCallId>.(txt|json)` 的 workspace-relative 路径，`context/tool_result_persisted` 只保存 receipt metadata；Runtime 在 `prepareModelContext()` 的 normalize/tool pairing 后执行单结果持久化，preview/receipt 先做 credential-shaped 字段脱敏，重启回放从完整 `tool/result` 和 receipt 重建相同 preview。阶段 4 的单消息聚合、时间型 microcompact 和阶段 5 的并行 scheduler 未提前实现。详细过程见 [阶段 3 单工具结果落盘实施日志](../archive/development-log/phase-3-tool-result-storage-2026-08-28.zh-CN.md)。

### 阶段 4：实现单消息工具结果聚合预算和 Claude Code 时间型 microcompact（已完成，2026-08-28）

本阶段修改以下内容：

| 本仓库文件/入口 | 直接修改内容 | 对照源码 |
|---|---|---|
| `packages/context/src/tool-result-budget.ts` | 新增 `maxToolResultsPerMessageChars=200000`；按 `normalizeMessagesForAPI()` 最终会形成的 API user message 分组，不按 EventStore 中的单条 `tool/result` 事件分组 | Claude Code `collectCandidatesByMessage()` |
| 同文件的 aggregate selector | 对每个超预算 message 选择最大的 fresh 结果落盘，直到剩余 model-visible 字符数不高于 `200000`；已见未替换结果冻结，已替换结果复用相同 preview | Claude Code `selectFreshToReplace()`、`enforceToolResultBudget()` |
| 同文件的 policy | 增加独立 `timeBasedMicrocompactEnabled`，默认 `false`；`timeBasedGapMs` 改为 `60 * 60_000`；`keepRecentResults=5`；count/token trigger 继续独立生效 | Claude Code `timeBasedMCConfig.ts` |
| `packages/runtime/src/index.ts` 的 per-turn replacement state | 维护 `seenIds`、`replacements`；新 replacement 追加 durable receipt；resume/fork/subagent 通过 transcript/event 重建，避免同一历史在后续 step 改变替换决定 | Claude Code `ContentReplacementState`、`provisionContentReplacementState()` |
| `packages/runtime/src/index.ts:prepareModelContext()` | 固定顺序为单结果持久化 → 单消息聚合 → count/token microcompact → 可选时间 microcompact → token count/provider request | Claude Code `query.ts` 与 `toolResultStorage.ts` |
| `packages/contracts/src/index.ts` 和 projection | 增加聚合预算、time trigger 和 replacement 诊断字段；事件不保存完整工具结果 | 当前 `context/tool_results_budgeted`、`context/microcompacted` |
| `packages/context/src/tool-result-budget.test.ts`、`packages/runtime/src/index.test.ts`、恢复测试 | 覆盖 10 个并行结果聚合、最大优先替换、跨 assistant 边界分组、progress/attachment 不错误分组、默认无 time trigger、60 分钟触发、保留 5 个、resume 字节一致 | Claude Code aggregate budget 与 time-based tests |

阶段 4 验收：

- 单条最终 API user message 的 model-visible tool results 不超过 `200000` 字符，除非只有已冻结结果构成不可逆历史；
- 10 个各 40K 的并行结果会落盘足够多的最大结果，而不是形成 400K user message；
- 同一替换在后续 step、summary、重启和恢复中保持相同 preview；
- 默认运行超过 60 分钟也不会仅因时间触发 microcompact；显式开启后使用 60 分钟与 keep 5；
- count/token/time 三类 trigger 在事件和 `step/started` 诊断中可区分。

阶段 4 回滚：关闭 aggregate 和 time-based 开关；保留单结果落盘、artifact 和 receipt 可读。

阶段 4 已按上述入口完成。默认聚合预算为 `200000` 字符，Runtime 在单结果落盘后按最终 API user message 选择最大 fresh 结果落盘；per-turn `seenIds/replacements` 保持同一替换在后续 step、重启和恢复中的稳定性。时间型 microcompact 默认关闭，显式开启后使用 `60` 分钟 gap 和 `keepRecentResults=5`。详细过程见 [阶段 4 单消息工具结果聚合与时间型 MicroCompact 实施日志](../archive/development-log/phase-4-tool-result-aggregate-microcompact-2026-08-28.zh-CN.md)。

### 阶段 5：按 DSH 实现最多 10 个并行工具调用（已完成，2026-08-28）

本阶段修改以下内容：

| 本仓库文件/入口 | 直接修改内容 | 对照源码 |
|---|---|---|
| 新增 `packages/runtime/src/tool-call-scheduler.ts` | 实现 parallel rolling pool、exclusive barrier、最多 10 个 in-flight、停止补充、drain 已启动任务、模型顺序提交结果 | DSH `packages/core/agent-loop/src/tool-calls.ts` |
| `packages/runtime/src/index.ts:AgentHostOptions` | 增加 `maxParallelToolCalls?: number`，默认 `10`，Host 硬上限为 `512`；该值由 Host 拥有 | DSH `agent-loop/src/constants.ts`、`index.ts:resolveMaxParallelToolCalls()` |
| `packages/runtime/src/index.ts:runSteps()` | 将当前 `Promise.all(response.toolCalls.map(...))` 替换为 scheduler；不直接同时启动所有 tool call | DSH `runGroup()`、`fillPool()` |
| `packages/tools/src/runtime.ts:ExecuteToolInput`、`commitDeferredResult()` | scheduler 路径延迟 `tool/result`/`diff/preview` 事件，由 Runtime 的 commit 回调按 assistant 声明顺序落盘；普通 `execute()` 调用继续即时提交 | DSH 结果按模型顺序提交的行为；本项目 EventStore contract |
| `packages/runtime/src/index.ts` 与既有 `ToolRuntime.registry` | 调度开始前重新读取每个未启动工具的 `executionMode`；`exclusive` 调用等待当前 parallel pool drain 后单独执行；不改变 ToolRuntime 的权限、workspace、tenant 或取消管线 | DSH tool reclassification/barrier |
| `apps/api/src/server.ts` | 允许 Host 配置并投影实际 `maxParallelToolCalls=10`，不由 Web 直接控制运行中 pool | DSH settings ownership；本项目 Host ownership |
| `packages/runtime/src/tool-call-scheduler.test.ts`、`packages/runtime/src/index.test.ts`、`apps/api/src/server.test.ts` | 覆盖最多 10 个、11+ rolling replenishment、exclusive barrier、模型顺序、abort、取消后不启动剩余调用、Host 配置和 API capability 投影；既有 ToolRuntime tests 保持 permission/interaction/tenant/workspace/cancel 回归 | DSH scheduler tests 的行为 |

阶段 5 验收：

- 一次 assistant step 返回 25 个 parallel tool call 时，同时运行数始终不超过 10；
- 结果进入下一次 model request 的顺序与 assistant 声明顺序一致；
- EventStore 中 `tool/result`（以及存在时的 `diff/preview`）顺序与 assistant 声明顺序一致；
- exclusive 工具前后都形成 barrier；
- abort 后不再补充新调用，已启动调用被 drain 并形成 completed/cancelled/failed 的结构化结果；
- permission、workspace、tenant 和 tool cancellation 仍经过统一 ToolRuntime 管线。

阶段 5 回滚：将 Host 配置设为 `1` 可退化为串行；代码级回滚恢复旧调度时不得删除已产生的工具事件。

阶段 5 已按上述入口完成。Host 默认 `maxParallelToolCalls=10`，允许范围固定为 `1–512`；`runSteps()` 通过 scheduler 在 parallel pool、exclusive barrier 和 abort drain 之间切换。`ToolRuntime` 对 scheduler 调用延迟 `tool/result`/`diff/preview` 写入，并由 scheduler 按 assistant 声明顺序 commit；下一次 model request 的 tool results 与 EventStore 顺序一致，阶段 4 的 aggregate budget/replacement state 保持不变。详细过程见 [阶段 5 并行工具调用 Scheduler 实施日志](../archive/development-log/phase-5-parallel-tool-scheduler-2026-08-28.zh-CN.md)。

### 阶段 6：集成门禁、迁移说明和文档收敛（已完成，2026-08-28）

本阶段修改以下内容：

| 本仓库文件/入口 | 直接修改内容 | 对照依据 |
|---|---|---|
| `docs/reference/claude-code-context-m01-implementation.zh-CN.md` | 增加后续变更记录，说明 16K/0 fallback 已被 200K/32K 取代；保留原实施历史 | 本文阶段 2 |
| `docs/reference/claude-code-context-m05-implementation.zh-CN.md` | 增加 M05 重构记录，说明 8K 直接 bounded path 已被落盘/预览/聚合预算取代；时间默认关闭、60 分钟 | 本文阶段 3–4 |
| `docs/reference/claude-code-context-management-research.zh-CN.md` | 把本文列为最新 accepted implementation baseline | 本文全部阶段 |
| `docs/../source-reuse-register.md` | 登记 DSH scheduler 行为参考、Claude Code tool result storage/aggregate/time-based 行为参考；标明未复制 Claude Code 代码 | AGENTS.md 上游复用要求 |
| `docs/status.zh-CN.md` 和 Phase 8 计划 | 只有全部门禁通过并建立 checkpoint 后，记录对应 slice 为 completed；不得仅因默认值已改就宣布 Phase 8 完成 | 阶段治理 |
| `README.zh-CN.md`、评测文档 | 更新公开默认值、配置范围、artifact 位置和诊断方法 | 实际运行行为 |
| `packages/runtime/src/index.test.ts` | 增加 Windows PowerShell 并行大结果、artifact 持久化、EventStore 顺序和 Host 重启 replay 的组合验收场景 | 阶段 3–5 组合 contract |
| `docs/archive/development-log/phase-6-integration-gate-2026-08-28.zh-CN.md` | 固化历史阶段 6 的修改范围、命令、证据、回滚和后续入口 | 历史治理记录 |
| `pnpm typecheck`、`pnpm test`、LLM/Context/Runtime/API 定向测试、评测 smoke、Windows e2e | 形成最终证据；有 v4pro endpoint/credential 时再执行真实网络 smoke，验证 32K 默认不会立即触发 `ANTHROPIC_MAX_TOKENS`，64K 只在服务端能力允许时启用 | 当前测试门禁 |

阶段 6 的必过场景：

1. **Provider 合同**：32K 默认、64K 上限、模型低上限、413/429/529、partial output、abort；
2. **Context 单元**：200K fallback、180K effective window、8192 字符 summary、warning/auto/blocking；
3. **Step 合同**：默认 32、显式 512、513 拒绝、达到上限的稳定错误；
4. **工具结果单元**：单结果落盘、preview、100K token hard cap、200K 单消息聚合、replacement resume；
5. **恢复测试**：API 重启、Session replay、summary 后重建、artifact 已存在、replacement receipt 重放；
6. **安全测试**：路径穿越、symlink、跨 tenant、绝对路径泄露、超大输出磁盘占用、prompt injection 只作为工具内容；
7. **并行测试**：10 并发、exclusive barrier、失败、取消、permission、模型顺序；
8. **E2E**：Windows PowerShell coding task 产生多个并行工具结果，其中至少一个超过 50K，重启后 Agent 能继续并读取 artifact；
9. **评测 smoke**：`maxSteps=32` 与 `maxSteps=512` 均可运行，Runner/Runtime 不再因 100 上限配置失败。

阶段 6 完成标准：全部测试有命令和结果证据；阶段 1–5 各自有独立 checkpoint；文档、契约、默认值、API 诊断和实际请求保持一致。

阶段 6 已按上述入口完成。M01/M05 和总调研文档已标记当前 accepted implementation baseline；README 与评测说明已同步 `32000/64000` 输出、`200000/180000` context、`32/512` steps、`8192` 字符 summary、artifact/aggregate/time-based microcompact 和 10 并行 scheduler。Grader gold/empty 自检、32/512 Runner smoke、Windows PowerShell 并行大结果重启 replay、全 workspace tests、typecheck 和 diff 检查均通过。详细证据见 [阶段 6 集成门禁实施日志](../archive/development-log/phase-6-integration-gate-2026-08-28.zh-CN.md)。

## 7. 实施顺序与依赖

```text
阶段 1 输出能力与 32K/64K 上限
  ↓
阶段 2 200K fallback、32/512 steps、8192-char summary
  ↓
阶段 3 单工具结果落盘与预览
  ↓
阶段 4 单消息聚合与时间型 microcompact
  ↓
阶段 5 最多 10 个并行工具调用
  ↓
阶段 6 全链路恢复、安全、评测与文档门禁
```

阶段 1 必须先完成，因为阶段 2 的 context budget 需要可信的默认输出值。阶段 3 必须先于阶段 4，因为聚合预算依赖稳定的落盘与 replacement record。阶段 4 必须先于阶段 5 的最终压力验收，因为 10 个并行结果会直接触发单消息聚合预算。

## 8. 最终代码入口索引

| 改造模块 | 本项目主入口 | 上游主参考 |
|---|---|---|
| Anthropic 默认输出和 hard cap | `packages/llm/src/providers/anthropic-messages/adapter.ts` | Claude Code `src/utils/context.ts`、`src/services/api/claude.ts` |
| Anthropic wire `max_tokens` | `packages/llm/src/providers/anthropic-messages/serialize.ts` | Claude Code `src/services/api/claude.ts` |
| Provider/model capability | `packages/contracts/src/index.ts`、`packages/llm/src/catalog.ts`、`packages/llm/src/index.ts` | DSH `llm-deepseek/src/adapter.ts`；Claude Code `src/utils/context.ts` |
| 未知 context fallback | `packages/context/src/index.ts` | Claude Code `src/utils/context.ts`、`autoCompact.ts` |
| Step 默认和硬上限 | `packages/runtime/src/index.ts`、`scripts/eval-mvp/*` | Claude Code `src/QueryEngine.ts`；DSH `agent.ts` |
| Summary 字符上限 | `packages/context/src/summary-compact.ts`、`packages/compaction/src/index.ts` | Claude Code compact 体系 |
| 单工具结果落盘 | 新增 `packages/context/src/tool-result-storage.ts` | Claude Code `src/constants/toolLimits.ts`、`src/utils/toolResultStorage.ts` |
| 单消息工具结果聚合 | `packages/context/src/tool-result-budget.ts`、`packages/runtime/src/index.ts` | Claude Code `src/utils/toolResultStorage.ts:enforceToolResultBudget()` |
| 时间型 microcompact | `packages/context/src/tool-result-budget.ts` | Claude Code `src/services/compact/timeBasedMCConfig.ts` |
| 10 并行 rolling pool | 新增 `packages/runtime/src/tool-call-scheduler.ts`、`packages/runtime/src/index.ts` | DSH `packages/core/agent-loop/src/constants.ts`、`tool-calls.ts` |
| Artifact 安全读取 | `packages/workspace/src/index.ts`、`apps/api/src/artifacts.ts`、`apps/api/src/server.ts` | 本项目 workspace/tenant 安全规则 |
| 恢复和回放 | `packages/runtime/src/index.ts`、EventStore projection | Claude Code replacement reconstruction；本项目事件事实源 |

本文已经提供能够直接进入编码的文件级实施清单。下一步从阶段 1 开始，不跨阶段同时修改工具结果架构和并行 scheduler。

## 阶段 1 实施结果（2026-08-28）

阶段 1 已按本文件的入口完成，改动范围限定在 Anthropic-compatible 输出能力和模型级上限校验：

- `packages/contracts/src/index.ts` 为 `ModelContextCapability` 增加 `defaultMaxOutputTokens`，并为 `ContextBudgetConfig` 预留同名 fallback 字段；现有 `maxOutputTokens` 继续表示模型可用上限。
- `packages/llm/src/providers/anthropic-messages/types.ts` 固定协议默认 `32000`、协议硬上限 `64000`；`adapter.ts` 在构造阶段校验默认值、显式请求值、模型上限和协议上限，超过边界时不调用 fetch。
- `packages/llm/src/index.ts` 的内置 Anthropic capability 统一为 upper `64000`、default `32000`，DeepSeek 继续保持 `8000`，未引入 DSH 的 `256000`。
- `packages/llm/src/catalog.ts` 的 Yayi DS/GL/QW 推断统一产出 upper `64000`、default `32000`；profile/catalog 显式较低上限时要求同时声明不超过该上限的 default，否则 fail fast。
- `apps/api/src/server.ts` 的 bootstrap catalog 同步返回 Anthropic default/upper 元数据，v4pro 等 Yayi profile 通过同一推断链路传入 adapter。
- 测试覆盖默认 `max_tokens=32000`、显式 `64000`、`64001` 请求前拒绝、模型 upper `8192` 的一致/不一致配置，以及 Yayi profile 的 `32000/64000` 解析。

验证结果：`pnpm --filter @coding-agent/llm test`（33 项通过）、`pnpm --filter @coding-agent/api test`（51 项通过）、`pnpm typecheck`、`git diff --check` 均通过。阶段 2 的 200K context fallback、512 step、8192 字符 summary，以及阶段 3–5 的工具结果和并行调度本次未实施。

## 阶段 2 实施结果（2026-08-28）

阶段 2 已按本文件入口完成，改动范围限定在 fallback、step budget 和 summary 字符预算：

- `packages/context/src/index.ts` 的未知能力 fallback 改为 `maxInputTokens=200000`、`maxOutputTokens=64000`、`defaultMaxOutputTokens=32000`；默认 context budget 计算得到 `effectiveWindowTokens=180000`，仍保留摘要请求预留 `20000` tokens。
- `packages/compaction/src/index.ts` 的 legacy `DEFAULT_CONTEXT_BUDGET.maxTokens` 改为 `200000`，`maxSummaryChars` 改为 `8192`，避免旧 facade 重新形成 16K/4K 瓶颈。
- `packages/context/src/summary-compact.ts` 的默认 `maxSummaryChars` 改为 `8192`，`recentMessageTokens=8000`、`maxPtlRetries=3` 保持不变。
- `packages/runtime/src/index.ts` 的 AgentHost 默认 `maxSteps` 改为 `32`，合法硬上限统一为 `512`；`packages/runtime/src/subagent-provider.ts` 继续复用 AgentHost 校验，不保留隐藏的 100 上限。
- `apps/api/src/server.test.ts`、`packages/runtime/src/index.test.ts` 和评测 Runner 同步覆盖 `512` 可用、`513` 拒绝；`scripts/eval-mvp/run-pilot.ps1` 与 `run-agent-task.ts` 使用同一 `1–512` 范围。
- 评测文档将旧的 12-step 运行标为历史结果，当前默认与硬上限更新为 `32/512`。

验证结果：`pnpm test` 全 workspace 通过；阶段 2 新增 fallback、summary、compaction、Runtime/API step boundary 测试通过；`pnpm typecheck`、`git diff --check` 通过。阶段 3–5 的工具结果落盘/聚合、时间型 microcompact 和 10 并行 scheduler 本次未实施。
