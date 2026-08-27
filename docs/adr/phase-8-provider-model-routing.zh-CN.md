# ADR：Phase 8 Provider/Model Routing 边界

状态：`accepted`

日期：2026-08-27

实施切片：`P8.5-MR0`

## 背景

当前 Host 已有 Echo 与 DeepSeek（OpenAI-compatible）模型路径，以及 tenant-scoped
`ModelRouteRecord`。模型构造和 API Host 仍存在 provider-specific bootstrap，无法安全地
为第三方 Token Plan 增加原生 Anthropic Messages 协议，也无法在后续支持多个同协议
provider 时保持 Session 恢复与凭据隔离。

本决定先固定类型与职责边界。它不改变现有运行时行为，也不把第三方 token、base URL
或请求正文写入公共契约。

## 决策

### 1. Provider、protocol 和 model 是独立标识

- provider ID 标识一个可配置服务端，例如 `deepseek` 或未来的第三方 provider；
- protocol ID 标识 wire adapter，例如 `openai-chat-completions` 或未来的
  `anthropic-messages`；
- model ID 标识该 provider 下的模型。

三者不得互相推导或以一个 `MODEL_PROVIDER` 枚举代替。MR1 仅以 registry 连接 protocol
和 adapter；ProviderProfile 的 `protocol`、`baseUrl`、credential reference、catalog 与启用
状态在 MR2 才持久化。

### 2. 公共契约采用兼容追加

`@code-review-agent/contracts` 新增以下没有 secret 的类型：

- `ModelSelection`：会话或默认路由的 provider/model/reasoning 选择；
- `ModelCatalogEntry`：展示与能力提示使用的 advisory catalog 条目；
- `ResolvedModelInfo`：provider/protocol/model 的精确解析结果；
- `PreparedModelRoute`：Turn 开始前组装的执行期不可变快照。

`PreparedModelRoute.model` 是进程内 `ChatModel`，可能间接持有 credential material；它
不是可持久化或可传输 DTO，不能进入 EventStore、SQLite、SSE、Web、日志或 model-visible
context。已有 `ModelRouteRecord` 继续作为旧 tenant route 的兼容记录，不改字段或 schema。

### 3. Catalog 仅提供建议，精确解析负责可路由性

Provider catalog 用于模型选择界面、显示名和 capability 提示。一个模型未列在 catalog 中
不得自动拒绝路由；adapter/profile 的精确 resolve 才能决定请求是否可服务。MR1 保留当前
`/v1/models` 行为以避免扩大 API 变更，MR5 再将 catalog/selection UI 与 advisory 语义完整
收敛。

### 4. Session selection 和 Turn 路由分开持久化

未来 Session 选择先追加 `session/model_selected` 事件，再更新 projection。每个 Turn 在
`turn/started` 前通过 Profile、credential reference 与精确 resolve 准备一个
`PreparedModelRoute`；该 snapshot 在途不可变，后续配置或选择修改只影响新的 Turn。MR0
不新增事件类型或投影字段，确保旧事件和数据库可读。

### 5. 凭据和协议实现保持延后

MR0/MR1 不读取第三方凭据、不持久化 ProviderProfile、不新增 HTTP 协议，也不改变
AgentHost、EventStore 或工具权限管线。第三方 Anthropic Messages 调用留在 MR3，并采用
本地 secret 的最小受控 smoke；credential metadata/material 分离留在 MR2。

## 参考、许可证与实现映射

| 后续切片 | 本项目入口 | 参考入口 | 采用内容 |
|---|---|---|---|
| MR0 | `packages/contracts/src/index.ts`、`docs/event-contract.md` | `D:/Develop/deepseek-harness-fork/packages/llm/llm/src/types.ts`：`GenerateOptions`、`LlmResolvedModelInfo`、`StreamChunk`；`packages/host/apiproxy/src/api/sessions.ts`：`ModelSelection`、`SessionModels` | provider-neutral route、选择与 catalog 的职责划分 |
| MR1 | `packages/llm/src/registry.ts`、`packages/llm/src/index.ts`、`apps/api/src/server.ts` | `D:/Develop/deepseek-harness-fork/packages/llm/llm/src/index.ts`：`LlmAdapter`、`registerAdapter()`、`AdapterRegistrationHandle.replace()`、`prepareRoutes()`、`commitRoutes()` | protocol registry、重复注册保护、原子替换边界 |
| MR2 | contracts/storage/API credential resolver | `D:/Develop/deepseek-harness-fork/packages/llm/llm-pi-ai/src/config.ts`：`PiAiProviderProfile`、`assertServiceable()`、`resolveProfiles()`；`provider.ts`：`PROTOCOLS`、`supportedProtocols()` | Profile validation、serviceability、credential 解析边界 |
| MR3 | `packages/llm/src/providers/anthropic-messages/` | DSH `llm-pi-ai/src/provider.ts`、`adapter.ts`、`stream.ts`、`context.ts`；Claude Code `D:/Develop/claude-code/src/services/api/claude.ts` | Anthropic Messages request/stream/tool JSON/usage/stop 行为 |
| MR4 | contracts/storage/runtime/API session routes | DSH `packages/host/apiproxy/src/api-proxy.ts`：`selectionFor()`、`sessions.models()`、`sessions.selectModel()`；`packages/llm/llm/src/index.ts:prepareCall()` | event-first Session selection 与不可变 Turn route snapshot |
| MR5 | `packages/llm/src/catalog.ts`、`apps/api/src/server.ts`、`apps/web/src/client/api.ts`、Settings/model picker | DSH `packages/llm/llm/src/index.ts:listModels()/resolveModelInfo()`、`packages/host/apiproxy/src/api/sessions.ts:SessionModels`、`packages/client/ui-model-selection/src/client/directory.ts:ModelDirectory` | provider 分组、局部 discovery failure、advisory catalog、custom profile 与 Web 选择 |
| MR6 | `packages/llm/src/failures.ts`、provider adapters、`packages/runtime/src/index.ts:collectModelResponse()`、M09 recovery | DSH `packages/llm/llm/src/index.ts:LlmError`、`adapterFailureChunk()`、provider retry policy；Claude Code `src/services/api/withRetry.ts`、`src/services/api/errors.ts` | 统一 failure taxonomy、bounded retry-after/backoff、partial-output fallback gate、主/辅助请求预算与脱敏诊断 |

DSH 根仓库为 MIT。本 ADR 仅记录结构与行为参考，未复制或改编 DSH 源码，因此此切片不需要
新增 source-reuse register 条目。Claude Code 本地快照没有明确兼容根许可；仅在 MR3 参考
wire 行为，自行实现，不复制其源码、账户、遥测或商业 provider 代码。

## 影响

- 后续 adapter 不再需要把 provider 选择写死在 API Host；
- 第三方 Token Plan 可在 MR2/MR3 通过独立 Profile 与 protocol adapter 接入；
- 现有 Echo、DeepSeek、`ModelRouteRecord`、SQLite 数据和 Session 事件保持兼容；
- API/Web 在 MR4/MR5 前不暴露尚未具备事实来源的 Session model picker。

## 验收与回滚

MR0 验收：`pnpm typecheck`、`pnpm test:contracts`、`git diff --check` 通过；公共类型不包含
credential material；不新增 EventStore schema 或事件类型。

MR0 回滚：移除本 ADR 和兼容追加类型；保留既有 `ModelRouteRecord`、ChatModel、EventStore
与 API 路径。凭据忽略规则可独立保留，以确保本地 Token Plan 不被误提交。
