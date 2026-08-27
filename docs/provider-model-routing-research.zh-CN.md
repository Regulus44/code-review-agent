# Provider / Model 路由与 Anthropic 协议适配调研草案

状态：`research-draft`（调研和实施索引，不代表已接受的公共契约）；P8.5-MR0–MR6 已按本索引落地

日期：2026-08-27

归属：Phase 8.5 provider/model routing 与 credential lifecycle 后续切片

调研对象：

- 当前项目：`D:/Develop/code-review-agent`
- DSH：`D:/Develop/deepseek-harness-fork`
- Claude Code 本地快照：`D:/Develop/claude-code`

本文用于指导后续供应商注册、模型目录、会话模型选择、Anthropic Messages
协议适配、凭据注入和错误恢复。每个实施切片都列出具体上游程序、文件、类、
函数和参考边界，后续开发应按切片编号回查源码，避免局部需求改变 Runtime
边界。

## 1. 结论

后续 provider/model 架构以 DSH 为主要骨架，以 Claude Code 为 Anthropic
协议行为参考：

- DSH 提供成熟的 provider-neutral LLM seam、Adapter Registry、Provider
  Profile、模型目录、精确模型能力、会话级选择和请求快照；
- Claude Code 提供成熟的 Anthropic Messages 请求构造、raw stream 事件处理、
  `tool_use` 增量、usage、stop reason、取消和 provider 错误行为；
- 当前项目保留 `ChatModel`、AgentHost、Context、EventStore 和 ToolRuntime，
  在 `packages/llm` 内自行实现轻量 Provider Registry 和协议 Adapter；
- 第一版不引入 DSH 的 Cordis Runtime，不整体引入 `@earendil-works/pi-ai`，不复制
  Claude Code 源码；
- DSH 根仓库为 MIT。若后续直接复制或大量改编具体代码，必须登记
  `docs/source-reuse-register.md` 并保留许可证声明；
- Claude Code 本地快照未发现根许可证，且仓库声明为 reverse-engineered /
  decompiled。该仓库只用于行为、状态机和测试场景参考。

目标结构如下：

```text
ProviderProfile（如何连接）
  providerId + protocol + baseUrl + credentialRef + model catalog
                         │
                         ▼
ProtocolAdapterRegistry（谁负责翻译协议）
  openai-chat-completions / anthropic-messages / echo
                         │
Session ModelSelection（本会话使用什么）
  provider + model + reasoningEffort
                         │
                         ▼
PreparedModelRoute（一次 Turn 的不可变快照）
  resolved model + capability + credential material + ChatModel
                         │
                         ▼
AgentHost → provider-neutral ModelStreamPart → EventStore / ToolRuntime
```

## 2. 本任务的治理回答

| 问题 | 决定 |
|---|---|
| 1. 属于哪个 Phase | Phase 8.5 产品化中的 provider/model routing 与 credential lifecycle 后续切片 |
| 2. 解决什么问题 | Runtime 路由、LLM 协议适配、配置存储、凭据安全、Session 模型选择和 Web 设置 |
| 3. 是否改变 contract | 调研本身不改变 contract；正式实施预计新增 ProviderProfile、ModelSelection 和 Session 模型选择事件，并兼容追加现有 ModelRoute contract |
| 4. 参考哪些入口 | 架构主参考 DSH `packages/llm/llm`、`packages/llm/llm-pi-ai`、`packages/host/apiproxy`、`packages/client/ui-model-selection`；Anthropic 行为参考 Claude Code `src/services/api/client.ts`、`claude.ts`、`withRetry.ts` |
| 5. 是否需要登记来源 | 当前为只读 `behavior-reference`，无需新增登记；直接复制或大量改编 DSH 时登记 MIT 来源；Claude Code 无明确兼容许可时禁止复制 |
| 6. 验收场景 | 自定义 Anthropic provider 完成文本、工具、usage 和错误流；切换路由不影响在途 Turn；重启恢复 Session 选择；所有公开面无 token |
| 7. 如何回滚 | 各切片独立 checkpoint；迁移期保留旧 DeepSeek bootstrap；通过关闭 Provider Registry v2 或回滚对应提交恢复旧路径 |

## 3. 当前项目基线

### 3.1 已有能力

| 能力 | 当前入口 | 可复用基础 |
|---|---|---|
| Provider-neutral 请求 | `packages/contracts/src/index.ts`：`ChatMessage`、`ModelRequest`、`ChatModel` | AgentHost 不依赖 OpenAI wire 类型 |
| Provider-neutral 流 | `packages/contracts/src/index.ts`：`ModelStreamPart` | 已覆盖文本、工具调用增量、usage、error 和 done |
| OpenAI-compatible Adapter | `packages/llm/src/index.ts`：`OpenAICompatibleChatModel` | 已有 fetch、SSE、工具 schema、usage 和 bounded provider error |
| 模型上下文能力 | `ModelContextCapability`、`ChatModel.contextCapability` | 可承载 provider/model 的窗口和输出上限 |
| Tenant 路由持久化 | `ModelRouteRecord`、`ModelRouteBackend`、SQLite `model_routes` | 已保存 provider、model、baseUrl、credentialRef 和 capability |
| 凭据引用 | `apps/api/src/credentials.ts`：`CredentialVault`、`SecretProvider` | secret material 与 SQLite/Event/API 分离 |
| Runtime 路由 | `packages/runtime/src/index.ts`：`setTenantModel()`、`modelForTenant()` | Tenant 之间已有隔离 |
| 真实路由审计 | `turn/started` payload 中的 provider/model/baseUrl | 已能记录一次 Turn 宣称采用的路由 |

### 3.2 当前限制

1. `ConfiguredModelProvider` 只允许 `echo | deepseek`；
2. `createConfiguredChatModel()` 将环境配置和具体 DeepSeek Adapter 绑定在一起；
3. `createConfiguredApiServer()` 的 selector 强制 `MODEL_PROVIDER=deepseek`；
4. 生产 selector 只合并 `credential.env`，没有合并 `credential.headers`；
5. `/v1/models` 把 `availableModels` 当作硬 allowlist，自定义模型 ID 会被拒绝；
6. provider、protocol、endpoint、credential 和 model selection 没有独立领域对象；
7. 当前路由是 tenant 级可变 Map，Session 没有独立选择事实；
8. 模型切换和在途 Turn 之间没有不可变 route snapshot；
9. reasoning capability 由 API 层按 `provider === "deepseek"` 硬编码；
10. `ModelProviderError` 还没有统一 request ID、retry-after、finish reason 和空流语义。

这些限制说明第一步应先建立 Provider Registry 和 Profile/Selection 分层，再加入
Anthropic Adapter。直接在现有 `OpenAICompatibleChatModel` 中增加分支会继续扩大
硬编码边界。

## 4. DSH 调研

### 4.1 Provider-neutral LLM seam

主要入口：

- `D:/Develop/deepseek-harness-fork/packages/llm/llm/src/types.ts`
  - `GenerateOptions`
  - `StreamChunk`
  - `LlmProviderInfo`
  - `LlmModelInfo`
  - `LlmResolvedModelInfo`
  - `LlmFailure`
  - `FinishReason`
- `D:/Develop/deepseek-harness-fork/packages/llm/llm/src/index.ts`
  - `LlmAdapter`
  - `LlmRuntime`
  - `LlmError`

关键设计：

- `GenerateOptions.provider` 与 `GenerateOptions.model` 分离；
- Adapter 只负责 provider wire 与标准消息/流之间的翻译；
- `listModels()` 提供 advisory catalog；
- `resolveModel()` 返回 exact-route 权威能力；
- reasoning effort 是 Adapter 拥有的不透明 ID；
- `StreamChunk` 有 block start/end、文本、reasoning、tool delta、usage 和 terminal
  finish；
- `LlmFailure` 保存稳定 code、status、retry-after 和 request ID。

本项目参考方式：

- 保留现有 `ChatModel` 和 `ModelStreamPart`；
- 增加 Registry、ProviderProfile、ModelSelection 和 PreparedModelRoute；
- 逐步补充 finish reason、request ID 和 retry-after，不直接替换整个 Runtime
  流协议。

### 4.2 Adapter Registry 与原子路由更新

主要入口：

- `packages/llm/llm/src/index.ts`
  - `LlmRuntime.registerAdapter()`
  - `AdapterRegistrationHandle.replace()`
  - `prepareRoutes()`
  - `commitRoutes()`
  - `llm/adapters-updated`

关键行为：

1. 一个 Adapter 可以拥有多个 provider route；
2. 同一 provider 不能由两个 Adapter 同时拥有；
3. route replacement 先完整校验，再原子提交；
4. 替换失败时旧注册继续工作；
5. topology 变化通过统一事件通知目录和 UI 重新读取；
6. 注册 disposal 会释放全部 route。

本项目参考方式：

- Registry 初期可保持进程内实现，不引入 Cordis；
- 注册键优先采用 protocol ID，例如 `anthropic-messages`、
  `openai-chat-completions`；
- ProviderProfile 通过 protocol 找到 Adapter，并形成 provider route；
- Registry 更新必须原子，失败时保留最后可用配置。

### 4.3 模型目录与精确能力

主要入口：

- `packages/llm/llm/src/index.ts`
  - `listModels()`
  - `resolveModelInfo()`
  - `resolveCallConfig()`
  - `resolveCallFor()`
- `packages/llm/llm/src/types.ts`
  - `LlmConfigurableProvider`
  - `LlmModelDiscoveryRequest`
  - `LlmDiscoveredModel`
  - `LlmModelReasoningInfo`

关键行为：

- catalog membership 只影响展示；
- route 是否由 Adapter 服务决定请求是否可路由；
- exact model lookup 决定 context、default max tokens、modalities 和 reasoning；
- 显式选择不支持的 reasoning 会在 provider I/O 前失败；
- 一个 provider 的 catalog 查询失败不会隐藏其他 provider。

本项目参考方式：

- 移除 `/v1/models` 的全局硬 allowlist；
- `GET models` 返回 provider 分组、每组失败和当前 selection；
- 手工配置的模型允许调用；
- Adapter 的 `resolveModel()` 是 capability 权威来源；
- Web 只展示 catalog，不把 catalog 当成事实来源。

### 4.4 Prepared Call 与配置快照

主要入口：

- `packages/llm/llm/src/index.ts`
  - `prepareCall()`
  - `PreparedLlmCall`
  - `adapterStream()`
  - `streamWithRegistration()`
- `packages/llm/llm-pi-ai/src/adapter.ts`
  - `PiAiAdapter.current()`
  - `PiAiAdapter.profileOf()`
  - `PiAiAdapter.modelOf()`
  - `PiAiAdapter.stream()`

关键行为：

- exact model 能力解析与最终 dispatch 绑定到同一个 Adapter registration；
- 一个 prepared call 只能 dispatch 一次；
- 配置变化构造新的 immutable snapshot；
- 已经开始的操作继续使用旧 snapshot；
- consumer 提前停止时调用 iterator return 并中止上游。

本项目参考方式：

- 本项目一个 Turn 会执行多个 model/tool step，因此目标对象采用
  `PreparedModelRoute`；
- `PreparedModelRoute` 在 `turn/started` 前完成并贯穿整个 Turn；
- 在途 Turn 保持 provider、model、credential version、capability 和 fallback
  列表不变；
- Web 选择只影响下一个尚未组装的 Turn。

### 4.5 Provider Profile 与 protocol table

主要入口：

- `packages/llm/llm-pi-ai/src/config.ts`
  - `PiAiProviderProfile`
  - `ResolvedPiAiProviderProfile`
  - `Config`
  - `assertServiceable()`
  - `resolveProfiles()`
- `packages/llm/llm-pi-ai/src/provider.ts`
  - `PROTOCOLS`
  - `supportedProtocols()`
  - `routeAuth()`
  - `buildProvider()`
- `packages/llm/llm-pi-ai/src/index.ts`
  - `apply()`

DSH 当前可声明的通用协议包括：

```text
openai-completions
openai-responses
anthropic-messages
```

关键行为：

- provider ID 是稳定路由键；
- protocol、base URL、credential reference 和 models 属于 provider profile；
- 模型选择只保存 provider/model/reasoning；
- profile 可以来自内置 catalog，也可以手工声明；
- 每次操作读取一份完整 profile snapshot；
- credential 在请求时解析，不进入 profile snapshot；
- 配置无法完整表达的认证协议不会伪装成可用。

本项目参考方式：

- 新增 `ProviderProfileRecord`，不要继续把 endpoint 和 credential 放在
  Session model selection 中；
- `protocol` 使用开放字符串，由 Registry 验证是否存在 Adapter；
- 第一批 protocol：`echo`、`openai-chat-completions`、
  `anthropic-messages`；
- AWS Bedrock、Vertex、Azure、OAuth 等复杂认证需要独立 profile schema 和
  Adapter，不用 API key profile 假装支持。

### 4.6 Session 模型选择

主要入口：

- `packages/host/apiproxy/src/api-proxy.ts`
  - `createApiProxy()`
  - `selectionFor()`
  - `sessions.models()`
  - `sessions.selectModel()`
- `packages/host/apiproxy/src/api/sessions.ts`
  - `ModelSelection`
  - `SessionModels`
  - `SessionsApi.models()`
  - `SessionsApi.selectModel()`
- `packages/client/ui-model-selection/src/client/directory.ts`
  - `ModelDirectory`
- `packages/client/ui-model-selection/README.zh.md`
  - “模型体验”与“KV Cache 影响”

关键行为：

- selection 是 provider/model/reasoning 的完整组合；
- Session 选择与全局默认值分离；
- Host 在下一次 prompt assembly 边界读取 selection；
- 运行中的 step 使用已组装选择；
- catalog membership 不决定 routable；
- provider catalog 局部失败保留其他 provider；
- 模型不支持已有图片时，选择阶段拒绝切换；
- provider topology 和 settings 变化触发目录刷新。

本项目参考方式：

- 新增 Session 级 `ModelSelection`；
- 选择命令先追加 durable event，再更新 projection；
- `turn/started` 记录实际 resolved route；
- blank Session 可跟随 tenant/default selection；
- 已执行过请求的 Session 默认恢复自身 selection；
- fork Session 默认继承父 Session selection；
- Subagent 初期继续继承父任务的 prepared route，不开放独立 Web 选择。

### 4.7 取消、超时、错误和重试

主要入口：

- `packages/llm/llm-pi-ai/src/adapter.ts`
  - `AbortSignal.any()` 组合 caller 与 consumer signal
  - `idleWatchdog()`
  - iterator teardown
- `packages/llm/llm-pi-ai/src/stream.ts`
  - `toStreamChunks()`
  - `mapUsage()`
  - `mapStopReason()`
- `packages/llm/llm/src/index.ts`
  - `adapterFailureChunk()`
  - `LlmError`
  - provider retry policy

关键行为：

- Adapter 的单次 `stream()` 只发起一次 provider 请求；
- retry budget 由上层策略拥有，避免 SDK 和 Agent 双重重试；
- caller abort 与 idle timeout 使用不同稳定错误码；
- 源流没有 terminal event 时报告 `STREAM_CLOSED`；
- usage 在 finish 前发出；
- provider throw 与 in-stream error 都归一为终止状态。

本项目参考方式：

- 保留 AgentHost 的 fallback/recovery 决策权；
- Adapter 只做有限的 pre-response 网络重试，或完全关闭 SDK retry；
- 已产生文本或工具 delta 后禁止自动 fallback；
- 引入 `ABORTED`、`TIMEOUT`、`AUTH`、`RATE_LIMIT`、`OVERLOADED`、
  `CONTEXT_WINDOW_EXCEEDED`、`STREAM_CLOSED` 等稳定 code。

## 5. Claude Code 调研

### 5.1 Provider 选择与 Client Factory

主要入口：

- `D:/Develop/claude-code/src/utils/model/providers.ts`
  - `APIProvider`
  - `getAPIProvider()`
  - `isFirstPartyAnthropicBaseUrl()`
- `D:/Develop/claude-code/src/services/api/client.ts`
  - `getAnthropicClient()`
  - `configureApiKeyHeaders()`
  - `buildFetch()`
- `D:/Develop/claude-code/packages/@ant/model-provider/src/client/types.ts`
  - `ClientFactories`
- `D:/Develop/claude-code/packages/@ant/model-provider/src/client/index.ts`
  - `registerClientFactories()`
  - `getClientFactories()`

可参考行为：

- API client 创建与模型调用逻辑分离；
- Anthropic API key 和 bearer authToken 是不同认证路径；
- base URL、custom headers、fetch override 和 SDK client 可以由 Host 注入；
- 认证 client 获取失败时 fail fast；
- Bedrock、Vertex、Foundry 使用独立 client 类型，不复用 API-key 逻辑。

不采用部分：

- 全局环境变量优先级作为长期 provider registry；
- Claude.ai 订阅、OAuth staging、内部 header、账户状态和遥测；
- 将 firstParty/Bedrock/Vertex 等产品身份直接暴露为本项目公共类型。

### 5.2 Anthropic 请求构造

主要入口：

- `src/services/api/claude.ts`
  - `userMessageToMessageParam()`
  - `assistantMessageToMessageParam()`
  - `buildSystemPromptBlocks()`
  - `queryModelWithStreaming()`
  - `getMaxOutputTokensForModel()`
  - `paramsFromContext` 内部请求组装

可参考行为：

- system prompt 使用 Anthropic 顶层 `system`；
- assistant text 与 `tool_use` 保持同一 content block 序列；
- tool result 使用 `tool_use_id` 关联；
- `max_tokens` 明确提供；
- tool choice、thinking、temperature 的组合由 provider constraint 决定；
- `AbortSignal` 直接传到请求；
- request capture、日志和诊断不保存凭据。

第一版边界：

- 支持 text、tool_use、tool_result 和 usage；
- 不启用 Anthropic beta、prompt cache、server tools、citations、thinking signature
  和内部 metadata；
- 显式请求尚未支持的 reasoning effort 时返回稳定错误，不静默忽略。

### 5.3 Raw stream 状态机

主要入口：

- `src/services/api/claude.ts`
  - raw `anthropic.beta.messages.create({ stream: true })`
  - `content_block_start` 分支
  - `content_block_delta` 分支
  - `input_json_delta` 分支
  - `content_block_stop` 分支
  - `message_delta` 分支
  - `cleanupStream()`
  - `updateUsage()`

可参考行为：

1. 使用 raw stream，避免 SDK 对每个 `input_json_delta` 反复 partial parse；
2. 以 block index 管理 text/tool 状态；
3. tool input 只拼接 `partial_json` 原始字符串；
4. text start 里的初始文本可能与 delta 重复，状态机需要定义唯一采信路径；
5. block stop 前必须存在对应 block；
6. usage 和 stop reason 可能在较晚的 `message_delta` 才完整；
7. `max_tokens`、context overflow、tool use 和 normal stop 分别映射；
8. consumer 停止后清理 stream；
9. 缺失 terminal event 不能伪造成功。

本项目 Adapter 输出映射：

| Anthropic event | 本项目输出 |
|---|---|
| `message_start.usage` | `usage` 的 input/cache 初值 |
| text `content_block_start` | 建立 block index，通常不直接输出文本 |
| `text_delta` | `text_delta` |
| tool `content_block_start` | `tool_call_start` |
| `input_json_delta` | `tool_call_delta`，保留 raw JSON fragment |
| `content_block_stop` | `tool_call_end` 或关闭 text block |
| `message_delta.usage` | 合并 output usage |
| `message_delta.stop_reason` | 保存 finish reason |
| `message_stop` | `done`，前置校验终止状态完整 |
| `error` | `ModelProviderError` 或 `ModelStreamPart.error` |

### 5.4 Tool pairing 与恢复

主要入口：

- `src/services/api/claude.ts`
  - `userMessageToMessageParam()`
  - `assistantMessageToMessageParam()`
  - tool_use/tool_result pairing repair 注释和相关转换逻辑
- 当前项目已有入口：
  - `packages/context/src/api-normalize.ts`
  - `packages/context/src/tool-pairing.ts`
  - `packages/runtime/src/index.ts`：`prepareModelContext()` 路径

参考决定：

- pairing repair 继续由本项目 Context API gate 负责；
- Anthropic Adapter 只做 wire serialization，不再维护第二套 transcript repair；
- Adapter 遇到无法表示的孤儿 tool result 时返回协议错误；
- EventStore 原始 transcript 不因 provider serialization 被修改。

### 5.5 错误与重试

主要入口：

- `src/services/api/withRetry.ts`
  - `withRetry()`
  - `getRetryDelay()`
  - `is529Error()`
  - `getRetryAfterMs()`
  - `shouldRetry()`
- `src/services/api/errors.ts`
  - 401/403/404/413/429/529 分类
  - context window 和 connection error 映射

可参考行为：

- 401 后重新建立 auth client；
- 429 尊重 `retry-after`；
- 529/overloaded 与普通 5xx 分开；
- 413/context overflow 进入上下文恢复，不作为普通网络重试；
- background/auxiliary 请求拥有更小 retry budget；
- streaming 已产生内容后的错误不重放为第二份内容。

本项目采用边界：

- 错误分类和 bounded metadata 可复现；
- 账户、fast mode、subscriber gates、持久重试和 UI 消息不复现；
- retry policy 进入 Provider Registry / Runtime policy，不写死在 Anthropic Adapter。

## 6. 对比与选型

| 维度 | DSH | Claude Code | 本项目决定 |
|---|---|---|---|
| Provider Registry | 正式、原子、可动态替换 | 全局分支和 client factory | 采用 DSH 结构 |
| Provider/Profile 分离 | 完整 | 主要依赖 env/settings | 采用 DSH 结构 |
| 自定义 protocol | `anthropic-messages` 等 protocol table | 以产品 provider 为主 | 采用 DSH 结构 |
| 模型目录 | advisory + exact resolve | 产品 catalog/映射 | 采用 DSH 结构 |
| Session 选择 | 会话级、组装边界快照 | 偏 CLI/全局模型 | 采用 DSH 结构 |
| Anthropic wire | 由 pi-ai 承担 | 原生 SDK + 完整 raw stream | 参考 Claude Code 行为 |
| Tool JSON delta | 通用事件映射 | 原始增量拼接成熟 | 参考 Claude Code 行为 |
| Usage/stop | 标准 finish contract | Anthropic 事件顺序成熟 | 两者结合 |
| Credential | per-request reference resolution | API key/OAuth/client factory | 采用 DSH seam，参考 Claude header 行为 |
| Retry | provider policy + runtime normalization | 产品化重试状态机 | DSH 拥有边界，选择性参考 Claude 分类 |
| License | MIT | 根许可不明确 | DSH 可登记复用；Claude 只做行为参考 |

## 7. 目标领域模型草案

以下类型用于讨论，正式实现前必须通过 ADR 和 contract review。

```ts
interface ProviderProfileRecord {
  id: string;
  tenantId?: string;
  displayName: string;
  protocol: string;
  baseUrl?: string;
  credentialRef?: McpCredentialReference;
  models: readonly ProviderModelRecord[];
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface ProviderModelRecord {
  id: string;
  displayName?: string;
  contextCapability?: ModelContextCapability;
  inputModalities?: readonly ("text" | "image")[];
  defaultMaxOutputTokens?: number;
  reasoning?: {
    efforts: readonly ModelReasoningEffort[];
    defaultEffort?: string;
  };
}

interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

interface ModelProviderAdapter {
  protocol: string;
  validateProfile(profile: ProviderProfileRecord): void;
  listModels(profile: ProviderProfileRecord, signal?: AbortSignal):
    Promise<readonly ProviderModelRecord[]>;
  resolveModel(profile: ProviderProfileRecord, model: string,
    signal?: AbortSignal): Promise<ResolvedModelInfo>;
  createModel(input: {
    profile: ProviderProfileRecord;
    model: ResolvedModelInfo;
    credential?: CredentialMaterial;
  }): ChatModel;
}

interface PreparedModelRoute {
  selection: ModelSelection;
  profileRevision: number;
  credentialVersion?: number;
  resolved: ResolvedModelInfo;
  model: ChatModel;
  fallbacks: readonly PreparedFallbackRoute[];
}
```

### 7.1 持久化边界

| 数据 | 事实来源 | 是否含 secret |
|---|---|---|
| Provider profile metadata | SQLite ProviderProfileBackend | 否 |
| Credential metadata | SQLite CredentialBackend | 否 |
| Credential material | HostOwned/External SecretProvider | 是，仅执行期短暂读取 |
| Tenant/default selection | Model route/default settings backend | 否 |
| Session selection | EventStore + projection | 否 |
| Turn 实际路由 | `turn/started` event | 否 |
| Provider request/response body | 不持久化普通事件 | 可能含敏感内容，禁止直接落盘 |
| Usage/error/request ID | bounded event diagnostics | 否 |

### 7.2 建议事件

```text
session/model_selected
  provider, model, reasoningEffort?, source, commandId

provider/profile_changed
  providerId, protocol, revision, enabled

turn/started
  provider, model, reasoningEffort?, profileRevision,
  credentialRef metadata?, contextCapability?
```

`provider/profile_changed` 是否进入 Session EventStore 需要 ADR 决定。Provider
Profile 自身属于 Host/Tenant 配置，可使用独立配置审计表；任何影响某个 Turn 的
最终值仍必须写入 `turn/started`。

## 8. 实施切片与源码映射

### P8.5-MR0：ADR、契约与兼容边界

目标：接受 ProviderProfile、ModelSelection、PreparedModelRoute、catalog advisory
和 Session selection 的职责边界。

| 项目 | 内容 |
|---|---|
| 本项目预计入口 | `docs/architecture-decisions.md` 或新 ADR；`packages/contracts/src/index.ts`；`docs/event-contract.md` |
| DSH 参考 | `packages/llm/llm/src/types.ts` 的 `GenerateOptions`、`LlmResolvedModelInfo`、`StreamChunk`；`packages/host/apiproxy/src/api/sessions.ts` 的 `ModelSelection`、`SessionModels` |
| Claude Code 参考 | 无需复制契约；只在 ADR 中说明后续 Anthropic wire 参考 `src/services/api/claude.ts` |
| 明确不包含 | Anthropic HTTP、Web 表单、模型发现、复杂认证 |
| 验收 | 类型边界、事件字段、迁移与回滚方案完成评审；旧数据库和旧事件保持可读 |
| 回滚 | 删除兼容追加类型和 ADR；现有 `ModelRouteRecord` 保持不变 |

### P8.5-MR1：Provider Registry 与现有 Adapter 迁移

目标：在不改变 DeepSeek 行为的前提下，移除 API Host 中的 provider 硬编码。

| 项目 | 内容 |
|---|---|
| 本项目预计入口 | 新增 `packages/llm/src/registry.ts`、`providers/echo/`、`providers/openai-compatible/`；重构 `packages/llm/src/index.ts`、`apps/api/src/server.ts` |
| DSH 参考 | `packages/llm/llm/src/index.ts` 的 `LlmAdapter`、`registerAdapter()`、`AdapterRegistrationHandle.replace()`、`prepareRoutes()`、`commitRoutes()` |
| Claude Code 参考 | `packages/@ant/model-provider/src/client/index.ts` 的 factory fail-fast 仅用于依赖注入边界对照 |
| 明确不包含 | 新协议、Session selection、Web 自定义 provider |
| 验收 | echo/deepseek 现有测试不回退；重复 protocol/provider 注册失败且不破坏旧注册；Registry disposal 可测试 |
| 回滚 | 保留旧 `createConfiguredChatModel()` feature path，关闭 Registry v2 |

### P8.5-MR2：Provider Profile 与凭据解析

目标：把 protocol/baseUrl/credential/models 从选择事实中分离，支持多个自定义
provider 使用同一协议 Adapter。

| 项目 | 内容 |
|---|---|
| 本项目预计入口 | `packages/contracts` 新 ProviderProfileBackend；`packages/storage` schema；`apps/api/src/credentials.ts`；新 `apps/api/src/providers.ts` 或等价模块 |
| DSH 参考 | `packages/llm/llm-pi-ai/src/config.ts` 的 `PiAiProviderProfile`、`assertServiceable()`、`resolveProfiles()`；`provider.ts` 的 `PROTOCOLS`、`supportedProtocols()`、`routeAuth()`、`buildProvider()` |
| Claude Code 参考 | `src/services/api/client.ts:getAnthropicClient()`、`configureApiKeyHeaders()`，用于区分 x-api-key、Bearer 和独立 client auth |
| 明确不包含 | Bedrock、Vertex、Foundry、OAuth、云 secret manager 实装 |
| 验收 | profile metadata 可持久化/reopen；secret 不进入 SQLite/Event/API；header/env credential 都能注入；stale/revoked reference fail closed |
| 回滚 | ProviderProfile 表采用兼容新增；关闭新 API 后旧 tenant route 继续可用 |

### P8.5-MR3：Anthropic Messages Adapter

目标：让第三方 Token Plan 通过原生 Anthropic Messages wire 完成 Agent Loop。

| 项目 | 内容 |
|---|---|
| 本项目预计入口 | 新增 `packages/llm/src/providers/anthropic-messages/{adapter,serialize,stream,errors,types}.ts` 及 tests |
| DSH 参考 | `packages/llm/llm-pi-ai/src/provider.ts` 的 `anthropic-messages` protocol 注册；`adapter.ts` 的 snapshot/abort/idle timeout；`stream.ts` 的 usage/finish/error 归一；`context.ts` 的 system/tool/result 转换边界 |
| Claude Code 参考 | `src/services/api/claude.ts:userMessageToMessageParam()`、`assistantMessageToMessageParam()`、raw stream request、`content_block_start/delta/stop`、`input_json_delta`、`message_delta`、`updateUsage()`、`cleanupStream()` |
| 明确不包含 | beta headers、prompt caching、server tools、citations、thinking signature、Claude.ai OAuth |
| 验收 | text、tool_use、tool_result、usage、stop、max_tokens、401/413/429/529、abort、idle timeout、stream closed 合同测试；真实第三方 smoke 使用本地 secret |
| 回滚 | 删除 protocol 注册并禁用对应 profile；其他 Adapter 不受影响 |

### P8.5-MR4：Session 模型选择与 Turn 快照

目标：模型选择成为可恢复的 Session 事实，在途 Turn 保持不可变路由。

| 项目 | 内容 |
|---|---|
| 本项目预计入口 | `packages/contracts` Event/Projection；`packages/storage` reducer；`packages/runtime/src/index.ts` queue/turn preparation；`apps/api` session model endpoints |
| DSH 参考 | `packages/host/apiproxy/src/api-proxy.ts:selectionFor()`、`sessions.models()`、`sessions.selectModel()`；`packages/client/ui-model-selection/README.zh.md` 的“下一次提示词组装边界”语义；`packages/llm/llm/src/index.ts:prepareCall()` |
| Claude Code 参考 | `src/query.ts`/`src/services/api/claude.ts` 只用于验证一次 query 使用固定 model/client；不采用全局 provider env 路由 |
| 明确不包含 | Subagent 独立选择、跨 Turn 自动模型策略、成本路由 |
| 验收 | 切换不影响运行中 Turn；下一 Turn 使用新选择；重启恢复；fork 继承；重复命令幂等；事件回放与 Web 一致 |
| 回滚 | 兼容读取 Session 无 selection 时回退 tenant/default route；移除新选择事件不影响旧日志 |

### P8.5-MR5：Model Catalog、Discovery 与 Web 设置

目标：支持 provider 分组、局部失败、自定义 provider/profile 和模型选择。

| 项目 | 内容 |
|---|---|
| 本项目预计入口 | `apps/api` provider/model catalog endpoints；`apps/web/src/client/api.ts`；Settings presenter；Session composer model selector |
| DSH 参考 | `packages/llm/llm/src/index.ts:listModels()`、`resolveModelInfo()`；`packages/host/apiproxy/src/api/sessions.ts:SessionModels`；`packages/client/ui-model-selection/src/client/directory.ts:ModelDirectory`；`docs/user/guide/providers.zh.md` 自定义 provider 流程 |
| Claude Code 参考 | 不采用其账户/登录 UI；仅借鉴 provider 错误文案需脱敏和可诊断 |
| 明确不包含 | 自动购买、计费、provider marketplace、账户登录 |
| 验收 | catalog advisory；单 provider 失败不隐藏其他组；unlisted-but-routable 模型可继续使用；连接重置后重新拉取；凭据字段只写不读 |
| 回滚 | Web 隐藏自定义 provider 表单；Host 环境配置继续可用 |

### P8.5-MR6：Retry、Fallback 与模型发现收敛

目标：统一 provider failure taxonomy、retry ownership、fallback 路由和可观测性。

| 项目 | 内容 |
|---|---|
| 本项目预计入口 | `packages/llm` error/retry policy；`packages/runtime` fallback；Context recovery；Event diagnostics |
| DSH 参考 | `packages/llm/llm/src/index.ts:LlmError`、`adapterFailureChunk()`、provider retry policy；`packages/llm/llm-pi-ai/src/adapter.ts` 单请求/idle timeout；`stream.ts:mapStopReason()` |
| Claude Code 参考 | `src/services/api/withRetry.ts:withRetry()`、`getRetryDelay()`、`is529Error()`、`getRetryAfterMs()`；`src/services/api/errors.ts` 的 401/403/413/429/529/context 分类 |
| 明确不包含 | subscriber fast mode、unattended persistent retry、账户 cooldown、内部 telemetry |
| 验收 | retry-after 生效；413 进入 context recovery；部分输出后不 fallback；辅助模型和主 Agent 各有预算；错误事件不含 provider body/token |
| 回滚 | 关闭新 policy，保留现有一次网络 retry 和 AgentHost fallback |

实施状态：已完成。对应实现说明见
[P8.5-MR6 实施说明](provider-model-routing-mr6-implementation.zh-CN.md)。
`packages/llm/src/failures.ts` 提供统一 failure taxonomy、脱敏和 retry-after 解析；
OpenAI-compatible 与 Anthropic adapter 在该边界执行有限的 pre-response retry；
`packages/runtime/src/index.ts:collectModelResponse()` 负责 partial-output gate、fallback
诊断和 M09 Context recovery 衔接。主 Agent 请求最多两次，`context_summary` 辅助请求一次。

## 9. Anthropic Adapter 合同清单

### 9.1 请求

```text
POST {normalizedBaseUrl}/messages
```

Profile 必须明确 base URL 是否已经包含 `/v1`。Adapter 只追加 `/messages`，避免
同时支持多种猜测路径。

必需字段：

- `model`
- `max_tokens`
- `stream: true`
- `messages`

可选字段：

- `system`
- `tools`
- `tool_choice`
- 未来经能力声明开放的 reasoning/thinking

鉴权策略由 ProviderProfile/credential material 决定：

```text
x-api-key: <token>
anthropic-version: <configured version>
```

或：

```text
Authorization: Bearer <token>
anthropic-version: <configured version>
```

Adapter 不从持久化 profile 读取 token，不把完整 headers 写入错误或事件。

### 9.2 消息转换

| 本项目消息 | Anthropic wire |
|---|---|
| system | 顶层 `system`；多段按确定顺序组合 |
| user text | `role=user` + text block |
| assistant text | `role=assistant` + text block |
| assistant toolCalls | 同一 assistant content 中的 `tool_use` blocks |
| tool result | `role=user` + `tool_result` block，使用 `tool_use_id` |

转换前置条件：

- 当前 Context normalize/pairing gate 已运行；
- tool call ID 唯一；
- tool result 能找到对应 tool call；
- tool arguments 保持 JSON 字符串，序列化时只验证能否形成 Anthropic `input`
  对象；
- 失败时返回 stable protocol error，不修改 EventStore transcript。

### 9.3 流状态

每个 block index 维护：

```ts
type AnthropicOpenBlock =
  | { kind: "text"; chunks: string[] }
  | { kind: "tool"; id: string; name: string; jsonChunks: string[] };
```

状态不变量：

1. delta 必须引用已开始 block；
2. block stop 必须且只能关闭一次；
3. tool start 立即输出 `tool_call_start`；
4. 每个 `partial_json` 原样输出 `tool_call_delta`；
5. usage 合并采用非负有限数字；
6. `message_stop` 前记录 stop reason；
7. 流结束但没有 `message_stop` 返回 `STREAM_CLOSED`；
8. abort 返回 `ABORTED`；
9. 已输出内容后 provider error 带 `partialOutput=true`，禁止 fallback。

## 10. 测试矩阵与上游对照

| 测试 | 本项目目标 | DSH 对照 | Claude Code 对照 |
|---|---|---|---|
| Registry duplicate | 原子拒绝且保留旧注册 | `LlmRuntime.registerAdapter()` tests | 无 |
| Profile invalid protocol | 保存前拒绝 | `assertServiceable()`、`supportedProtocols()` | 无 |
| Credential redaction | SQLite/Event/API 无 secret | pi-ai per-request credential resolution | `getAnthropicClient()` auth 分离 |
| Advisory catalog | unlisted model 可路由 | `listModels()` 与 `resolveModelInfo()` | 无 |
| Exact reasoning | 不支持时 provider I/O 前失败 | `resolveCallFor()` | Anthropic thinking 参数约束 |
| Turn snapshot | 切换不影响在途 Turn | `prepareCall()`、`selectionFor()` | query 固定 client/model |
| Text stream | delta 顺序完整 | `toStreamChunks()` | `text_delta` 分支 |
| Tool JSON stream | raw fragments 不重复解析 | tool-call chunks | `input_json_delta` 分支 |
| Late usage | message delta 合并 | `mapUsage()` | `updateUsage()` |
| Max tokens | 非成功 stop | `mapStopReason()` | `stopReason === 'max_tokens'` |
| Context overflow | 进入 M09 recovery | context failure code | 413/context error 分类 |
| Rate limit | bounded retry-after | provider retry policy | `getRetryAfterMs()` |
| Overloaded | 与普通 5xx 分开 | stable LlmFailure | `is529Error()` |
| Abort/timeout | 稳定 code + iterator cleanup | `AbortSignal.any()`、idleWatchdog | signal + `cleanupStream()` |
| Stream closed | 不伪造 done | `STREAM_CLOSED` | raw stream terminal handling |
| Restart | selection/profile/credential ref 恢复 | Session/request header selection | 无直接复用 |

## 11. 防目标漂移规则

后续实现应逐项检查：

1. Provider ID、Protocol ID 和 Model ID 保持三个独立概念；
2. Web 不直接构造 ChatModel，不持有 token，不成为 selection 事实来源；
3. Provider catalog 不作为硬 allowlist；
4. Adapter 不读取 EventStore，不执行工具，不决定权限；
5. MCP 继续负责外部工具，不能承担 LLM provider 调用；
6. Credential material 不进入 ProviderProfile、ModelSelection、Event、Projection、
   SSE、Web 或 model view；
7. Session selection 先追加事件，再更新 projection；
8. 在途 Turn 使用 prepared snapshot，配置变更只影响后续 Turn；
9. Context normalize/pairing 仍是所有 Adapter 的共同前置 gate；
10. Provider-specific retry 不绕过 Runtime 的取消、上下文恢复和 fallback budget；
11. 直接复制 DSH 代码时登记 MIT 来源；Claude Code 无明确许可时只参考行为；
12. 每个 MR 切片独立 commit，并在提交说明中列出对应上游程序和验证命令；
13. 新增 Bedrock、Vertex、Azure、OAuth 前先增加 ADR，不能把 API key profile
    扩展成无法表达完整认证的伪支持；
14. 不引入 DSH 完整 Cordis/plugin 平台，除非出现独立验收场景和 ADR；
15. 不引入 Claude Code 账户、遥测、商业 provider、CLI 或内部 beta 能力。

## 12. 推荐实施顺序

```text
P8.5-MR0 ADR / contract
  → P8.5-MR1 Registry + 现有 DeepSeek 迁移
  → P8.5-MR2 ProviderProfile + credential
  → P8.5-MR3 Anthropic Messages Adapter
  → P8.5-MR4 Session selection + Turn snapshot
  → P8.5-MR5 API / Web catalog 与自定义 provider
  → P8.5-MR6 retry / fallback / discovery 收敛
```

MR3 可以在 MR4 前通过 Host 默认 route 完成真实第三方 smoke。面向用户的可靠模型
切换必须等待 MR4 的 Session selection 和 Turn snapshot 完成。

## 13. 开发任务引用模板

后续 issue、计划、PR 或开发日志至少写明：

```text
切片：P8.5-MR<n>
本项目入口：<files / types / functions>
DSH 参考：<repo path + symbol + intended behavior>
Claude Code 参考：<repo path + symbol + intended behavior>
复用方式：behavior-reference | adapt | copy
许可证处理：<none / MIT notice / blocked>
Contract 变化：<Event / Tool / Task / Permission / Workspace / Provider>
验收：<unit / contract / recovery / security / e2e>
回滚：<feature flag / compatible schema / commit>
```

如果实现无法映射到本文某个切片，先更新 ADR 或本文的实施索引，再开始编码。

## 14. 本地凭据与可视化切换实施说明（P8.5-MR7）

本切片补齐以下产品链路：

```text
Web Settings 输入 token
  → API host-owned CredentialVault
  → .data/credentials.secrets.json（原子写入）
  → ProviderProfile + opaque credentialRef
  → /v1/models 立即构造并绑定新 route
  → SQLite model_routes + provider-profiles.json
  → API 重启后恢复 metadata、profile 和 secret material
```

实现对照与边界：

- DSH 参考 `D:/Develop/deepseek-harness-fork/packages/client/connection/src/index.ts` 的 `credentials.describe/set/unset` 特权边界，以及 `packages/llm/llm-pi-ai/tests/loader-composition.spec.ts` 中 `.credentials.yaml`、`0600` 文件权限和 host-owned provider；本项目自行实现 `apps/api/src/credentials.ts:LocalFileSecretProvider`，不复制 DSH 代码。
- Claude Code 参考 `D:/Develop/claude-code/src/utils/auth.ts` 的 keychain→文件 fallback、缓存失效后重新解析和 401 后清缓存行为；本项目当前使用 host-owned 本地文件，不把 secret 放入浏览器 state、EventStore、SSE、ProviderProfile 或 `.env`。
- `apps/api/src/provider-profiles.ts:LocalProviderProfileStore` 只持久化自定义 ProviderProfile 元数据和 opaque credential reference；`apps/api/src/server.ts:createApiServer` 在 SQLite host 默认启用两个本地文件，并在无远程认证时限定 `local` scope。
- `apps/web/index.html:renderSettings` 新增 password token 输入、header 名称/前缀、凭据状态和 Provider credential 下拉选择；保存后刷新 credential catalog，后续 Provider/Model 选择立即使用新版本。

验收与回滚：

- 单元：本地 secret 文件重启读取、原子更新、删除和 malformed fail-closed；
- API：无认证本地 host 创建 credential→创建 Provider→选择 Model→关闭并重启→恢复 route/profile/credential；认证 tenant 仍保持原有隔离；
- Web：Settings 可输入 token、显示 active/version 状态、选择 Provider/Model，公开响应只显示 configured/version；
- 验证命令：`pnpm typecheck`、API credential/server 定向测试、Web 全量测试、`pnpm build:web`、`pnpm test:phase8:settings`、`git diff --check`；
- 回滚：回滚本切片 checkpoint 即可恢复进程内 host-only secret provider 和原有认证凭据 API；SQLite metadata、model route 和事件格式保持向后兼容。
