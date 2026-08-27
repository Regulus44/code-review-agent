# DSH Web 端 Provider / Model 切换实现调研与对照草案

> 调研日期：2026-08-27  
> 调研范围：`D:/Develop/deepseek-harness-fork` 的 Web 模型选择、Provider 设置和 Host API；本仓库现有 Web 入口与 Provider/Model routing 实现。  
> 文档性质：实现前的对照基线。本文记录行为、数据流和源码入口，不在本轮直接改造前端。

## 1. 结论先行

DSH 的 Web 端并不是先显示一个独立的 Provider 下拉框，再显示一个独立的 Model 下拉框。它把一次选择建模为完整的会话级组合：

```ts
type ModelSelection = {
  provider: string
  model: string
  reasoningEffort?: string
}
```

Provider 在模型选择菜单中以分组标题出现，用户最终提交的是 `provider + model (+ reasoningEffort)`。这样可以避免不同 Provider 使用相同模型 ID 时产生歧义，也让 Host 能在一次选择中完成路由、凭据和模型能力校验。

DSH 有两个面向当前 Session 的入口，但两个入口共享同一个会话级目录和当前值：

1. Composer 输入栏中的模型按钮（`conversation.input.model` seat）；
2. `/model` 命令打开的 `popupSelect` 菜单。

两个入口都读取 `session.models`，都通过 `session.selectModel` 提交。因此在任一入口完成切换后，另一个入口会显示同一个 Host 返回的选择。Settings 中的 Models 页面负责配置 Provider、Base URL、模型发现和凭据；它不是当前 Session 快速切换的主入口。

本仓库目前已经有 `#model-trigger`、`#model-popover`、Provider 表单和 Session 级模型 API，但 Composer 菜单的主要请求仍走全局 `/v1/models`，显示文案只有 `Model · 当前模型`，Provider 列表被扁平化，且没有 DSH 的 `/model` 命令入口。因此“功能存在”与“用户能明显感知并使用 Provider/Model 切换”之间仍有差距。

后续实现建议沿用 DSH 的职责分层：

```text
Host / Session model contract
        ↓
per-session ModelDirectory（一个事实来源）
        ↓                         ↓
Composer ModelSelect              /model popupSelect
        ↓                         ↓
当前 Session 的 provider/model/reasoning 选择

Settings Models 页面 → Provider 配置、凭据写入、模型发现和状态管理
```

## 2. 本任务治理七问

| 问题 | 本调研的回答 |
|---|---|
| 属于哪个 Phase？ | Phase 8.5 Provider/model routing 的 Web 入口收敛；依赖已完成的 Phase 7 Web Shell 和 P8.5-MR0–MR6。 |
| 解决什么问题？ | 主要是 Web UI 与 Session model routing 的信息架构、状态同步和可发现性问题；同时补齐 Provider 配置与当前 Session 选择之间的边界。 |
| 是否改变 Event/Tool/Task/Permission/Workspace contract？ | 目标实现应复用现有 `ModelSelection`、`session/model_selected`、`GET/POST /v1/sessions/:id/model` 和 Provider/Credential contract；除非后续发现缺失，不新增 Tool/Task/Permission/Workspace contract。 |
| 参考 DSH 或 Claude Code 的哪里？ | 主骨架参考 DSH `ui-model-selection`、`ui-commands`、`ui-settings-models` 和 Host `sessions` API；Claude Code 只作为“一个 query/turn 固定已选模型、错误不泄露凭据”的行为补充参考。 |
| 是否需要登记上游代码来源或许可证？ | 本轮只记录结构和行为，不复制代码。若后续直接改编 DSH MIT 代码，必须保留许可证和版权声明，并登记 `docs/source-reuse-register.md`；Claude Code 当前快照按结构参考自行实现。 |
| 验收场景是什么？ | 打开当前 Session 的模型菜单，按 Provider 分组选择模型，切换 reasoning effort，立即发送下一 Turn；从 `/model` 入口切换后 Composer 显示相同结果；刷新/重启后仍恢复；Provider 目录局部失败时其他 Provider 仍可选；设置页输入凭据后可发现并使用该 Provider。 |
| 如何回滚或禁用？ | UI 切片应独立提交；可回滚到现有 `#model-trigger` 和 `/v1/models` 流程，不删除 Session model event、Provider profile、Credential 或 ModelRoute 数据。 |

## 3. DSH 的页面信息架构

### 3.1 Composer 模型按钮

DSH 在输入栏工具条中放置模型按钮，位置接近发送按钮。触发器显示当前模型，并在存在模型级 reasoning 能力时显示当前 effort。打开后是一个小型两级菜单：

```text
ModelSelect trigger
└─ 根菜单
   ├─ Model · <当前模型>
   └─ Effort · <当前档位>       （仅当前模型声明 reasoning 能力时出现）

Model 页
└─ Provider A
   ├─ model-a
   └─ model-b
└─ Provider B
   └─ model-c

Effort 页
└─ Provider default / low / medium / high ...
```

关键行为：

- Provider 作为分组标题和选择身份的一部分呈现，不只显示一个扁平模型名；
- 当前项按 `provider === current.provider && model === current.model` 判断；
- effort 选项来自当前模型的 Adapter 元数据，不由前端写死一套全局枚举；
- 目录加载失败时保留上一次可用目录，并在菜单中提供重试/错误提示；
- 选择请求进行中时禁用菜单项，失败时保留旧选择；
- 正在运行的 Turn 使用已经组装好的旧路由，新选择只影响后续 Turn；
- addressed Subagent Session 不显示模型选择入口，避免让子 Agent 的模型/权限边界被父级 UI 误导。

源码入口：

| DSH 文件 | 重点符号/职责 |
|---|---|
| `D:/Develop/deepseek-harness-fork/packages/client/ui-model-selection/src/client/ModelSelect.tsx` | Composer 模型菜单；Model/Effort 两级导航、Provider 分组、当前项和选择失败提示。 |
| `D:/Develop/deepseek-harness-fork/packages/client/ui-model-selection/src/client/slots.ts` | `conversation.input.model` seat 的注入面。 |
| `D:/Develop/deepseek-harness-fork/packages/client/ui-model-selection/src/client/directory.ts` | Composer 与 `/model` 共用的 `ModelDirectory` 状态和操作。 |

### 3.2 `/model` 命令

DSH 通过 `ui-model-selection/src/client/index.ts` 注册名为 `model` 的 `popupSelect` command。用户可以从 slash command 或命令菜单进入，统一的 `PopupSelectView` 负责弹层和交互。

```text
/model
  ↓
popupSelect command
  ↓
PopupSelectController / PopupSelectView
  ├─ 加载当前 Session 的 ModelDirectory
  ├─ 本地搜索
  ├─ 键盘上下移动
  ├─ Enter 选择
  ├─ Escape 关闭
  └─ 加载失败时重试
```

该入口不是另一套业务逻辑：选项由同一个目录生成，选中后仍调用 `directory.select()`，最终进入 `session.selectModel`。Popup 层只负责搜索、焦点和呈现，不负责判断 Provider 是否可用。

源码入口：

| DSH 文件 | 重点符号/职责 |
|---|---|
| `D:/Develop/deepseek-harness-fork/packages/client/ui-model-selection/src/client/index.ts` | 注册 `popupSelect` 的 `model` command；把 Provider/Model 目录映射为 popup rows；把 row id 解析回 `ModelSelection`。 |
| `D:/Develop/deepseek-harness-fork/packages/client/ui-commands/src/client/PopupSelectView.tsx` | 通用 popup shell；搜索输入、焦点保持、选中态、空态和错误/重试表面。 |
| `D:/Develop/deepseek-harness-fork/packages/client/ui-commands/src/client/popup.ts` | Popup controller、过滤和选择状态。 |
| `D:/Develop/deepseek-harness-fork/packages/client/ui-model-selection/tests/model-select.client.spec.tsx` | Composer 入口的交互和状态测试。 |
| `D:/Develop/deepseek-harness-fork/packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts` | Plugin 注册和浏览器侧组合测试。 |

### 3.3 Settings 中的 Provider 配置

DSH 把 Provider 配置放在独立的 Settings Models 页面。页面职责是：

- 展示已声明/已发现的 Provider 行；
- 展示凭据是否已配置，但不把 secret 回填到浏览器；
- 编辑 API key、Base URL、协议、模型目录和 Provider 显示名；
- 通过 `credentials.set`、Settings mutation 和模型 discovery API 写入；
- Provider 目录失败时只标记该 Provider，不隐藏其他 Provider；
- 删除 Provider 前确认，并按安全顺序清理受管凭据和设置引用；
- 一次展开一个编辑卡片，避免多个草稿互相覆盖。

Settings 页面不承担“当前 Session 下一 Turn 使用哪个模型”的快速选择。用户配置完 Provider 后，回到 Composer 的 ModelSelect 或 `/model` 命令进行会话级选择。

源码入口：

| DSH 文件 | 重点符号/职责 |
|---|---|
| `D:/Develop/deepseek-harness-fork/packages/client/ui-settings-models/src/client/ModelsSection.tsx` | Provider 行、状态聚合、凭据状态、编辑卡片和删除确认。 |
| `D:/Develop/deepseek-harness-fork/packages/client/ui-settings-models/src/client/ProviderEditor.tsx` | 单个 Provider 的 API key、Base URL、协议和模型字段；secret 只写入 credentials wire。 |
| `D:/Develop/deepseek-harness-fork/packages/client/ui-settings-general/src/client/SettingsRoot.tsx` | Settings 弹窗、导航和页面挂载。 |
| `D:/Develop/deepseek-harness-fork/packages/client/ui-settings-general/src/client/index.ts` | Settings plugin 注册。 |

DSH Web bundle 明确加载了 `ui-settings`、`ui-settings-general`、`ui-settings-models`、`ui-conversation`、`ui-commands` 和 `ui-model-selection`。参考：`D:/Develop/deepseek-harness-fork/packages/bundle/web-app/cordis.patch.yml` 的 Web plugin composition 段（约 192–251 行）。

## 4. DSH 的数据与状态模型

### 4.1 选择对象和目录对象

DSH 选择对象包含路由身份和模型能力选择：

```ts
interface ModelSelection {
  provider: string       // 注册的 Provider route id
  model: string          // Provider-owned model id
  reasoningEffort?: string
}
```

目录对象则是一个 Session 的 advisory snapshot：

```ts
interface ModelDirectoryState {
  current: ModelSelection | null
  routable: boolean | null
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}
```

其中：

- `current` 是 Host 对“下一次组装 Turn 的选择”的报告；
- `groups` 是 Provider 目录，属于 advisory catalog，不等同于可路由性；
- `routable` 单独表示当前 Provider 是否真的能服务请求；
- `failures` 按 Provider 记录目录失败，成功的 Provider 继续可用；
- `status/error` 只描述目录或选择操作，不取代 Host 的事实状态。

### 4.2 `ModelDirectory.load()`

`ModelDirectory.load()` 调用 Session 级 `session.models`：

1. 清理/递增 generation，保证旧请求不能覆盖新结果；
2. 设置 `loading`；
3. 从 Host 读取 `current`、`routable`、`groups` 和 `failures`；
4. 成功后发布 `ready`；
5. 失败时保留最近一次成功的 groups/current，并发布可重试的错误；
6. 连接重置时清空目录，重新从 Host 拉取。

Composer 和 `/model` 都从同一个 `ModelDirectory` 读取，不能各自维护一份 `currentModel` 或 Provider 列表。

### 4.3 `ModelDirectory.select()`

`select(selection)` 的边界是完整的 `provider + model + reasoningEffort`：

1. 校验当前 Session 是否允许选择（普通 Session；addressed Subagent 拒绝）；
2. 设置 `selecting` 并递增 generation；
3. 调用 `session.selectModel`；
4. Host 成功校验并返回 `selected` 后更新 `current` 和 `routable=true`；
5. Host 拒绝时保留旧 `current`，写入错误并让入口显示重试/提示；
6. 选择成功只影响后续组装的 Turn，不改变已经开始的 Turn。

### 4.4 Host API

DSH Host 的 Session API 语义如下：

```text
GET  /v1/sessions/:sessionId/models
     → current, routable, provider groups, provider-local failures

POST /v1/sessions/:sessionId/model
     body: { provider, model, reasoningEffort? }
     → { selected }
```

`packages/host/apiproxy/src/api/sessions.ts` 定义 `ModelSelection`、`ModelProviderGroup`、`SessionModels` 和 `selectModel` RPC；`packages/host/apiproxy/src/api-proxy.ts` 负责把目录构建、精确模型解析和 Session selection 投影到 Agent。

### 4.5 运行中 Turn 与重启

DSH 的模型选择与 Agent loop 的边界是：

```text
用户选择
  → Host 校验并持久化 Session model selection
  → 下一 Turn 开始时 resolve/prepare route snapshot
  → Turn 运行期间只使用这个 snapshot
  → 重启后从 Session event/log 恢复，而非只读取创建时 header
```

这与 Claude Code 的“一次 query 固定 model 和 API route”行为一致。切换按钮不应该修改正在执行的请求，也不应该只更新浏览器内存。

## 5. 当前仓库对照

### 5.1 已有能力

当前仓库已经具备以下基础：

- `apps/web/index.html:740` 有 `#model-trigger`；
- `apps/web/index.html:744` 有 `#model-popover`；
- `apps/web/index.html:2579-2615` 有两级模型菜单的初版；
- `apps/web/index.html:2714-2719` 绑定按钮点击和 overlay；
- `apps/web/index.html:1776-1860` 有 Settings 中的 Model、Credential 和 Provider 表单；
- `apps/web/src/client/api.ts:506-547` 有全局模型、Provider、Session models 和 Credential client 方法；
- `apps/api/src/server.ts:573-641` 已有 `GET/POST /v1/sessions/:id/models|model`；
- `apps/api/src/server.ts:643-660` 保留全局 `/v1/models` 兼容接口；
- `packages/contracts` 已有 `ModelSelection`、Provider catalog、ModelRoute 和 Credential reference contract。

### 5.2 为什么入口不明显

| 对照项 | DSH | 当前仓库 | 影响 |
|---|---|---|---|
| 按钮文案 | 显示当前模型，并能体现模型级 effort；Provider 由菜单分组明确表达 | `Model · 当前模型`，不显示当前 Provider | 用户容易把它理解为“只能换模型”，看不出第三方 Provider 已接入 |
| 菜单结构 | Provider 分组，每组列出模型 | 虽然读取 `providers`，但 `flatMap` 后把条目扁平化 | 多 Provider 同名模型时辨识度差 |
| 当前项判断 | `provider + model` 双键匹配 | 主要按 `model === currentModel()` | 相同模型 ID 跨 Provider 时可能出现多个选中项/错误高亮 |
| 主请求范围 | Session 级 `session.models` / `session.selectModel` | Composer 主要调用全局 `GET/POST /v1/models` | 当前 Session 选择与全局默认/tenant route 的语义容易混淆 |
| 第二入口 | `/model` popupSelect，支持搜索、键盘和统一命令菜单 | 没有 DSH 风格 `/model` 命令 | 熟悉命令入口的用户找不到快速切换路径 |
| 共享状态 | 一个 Session 一个 `ModelDirectory` | 页面状态集中在 `index.html` 的 `state.models` | 未来增加第二入口时容易产生两份 current/catalog 状态 |
| Settings 职责 | Provider 设置与 Session 切换分离 | Provider、Credential、当前模型和目录摘要压在一个手写 section | 配置 Provider 后缺少“回到当前 Session 选择模型”的明确路径 |
| 失败语义 | Provider-local failure；可用组继续展示；选择失败保留旧值 | 有错误状态，但 UI 仍以扁平列表和全局请求为主 | 局部失败和选择失败的边界不够清晰 |

### 5.3 当前实现的关键代码位置

以下位置是后续改造的直接落点：

- `apps/web/index.html:2578`：旧的 `renderModels` 直接遍历 `payload.models`；
- `apps/web/index.html:2595-2605`：Provider catalog 被转换成扁平 `catalogModels`；
- `apps/web/index.html:2598`：当前项主要用模型字符串比较；
- `apps/web/index.html:2601`：选择请求调用 `/v1/models`，没有优先使用 Session endpoint；
- `apps/web/index.html:2610-2614`：根菜单只有一个 `Model` 行，没有单独的 Provider/当前路由摘要；
- `apps/web/src/client/api.ts:522-527`：已有 `listSessionModels()`，但 `selectModel()` 当前封装仍指向全局 `/v1/models`；
- `apps/api/src/server.ts:573-641`：后端 Session 级 API 已可作为前端主流程；
- `apps/web/index.html:1776-1860`：Settings 中已有凭据和 Provider 写入表单，可继续拆出 Provider editor/card 结构。

## 6. 后续实施切片草案

以下切片按“一个目录、两个入口、一个设置页、最后补门禁”的顺序排列。每个切片实施时应独立提交 checkpoint，并在提交说明中标明 Phase 8.5、变更范围和验证结果。

### UI-M0：确认契约与入口边界

目标：不改变公共事件语义，明确 Session 选择是 Web 主流程，全局 `/v1/models` 只保留兼容/管理用途。

参考 DSH：

- `packages/host/apiproxy/src/api/sessions.ts` 的 `ModelSelection`、`SessionModels`、`models()`、`selectModel()`；
- `packages/host/apiproxy/src/api-proxy.ts` 的 `selectionFor()`、`buildModelCatalog()`；
- 本仓库 `apps/api/src/server.ts:573-641` 的 Session API。

建议动作：

- 在 `apps/web/src/client/api.ts` 增加/修正 `getSessionModelSelection()` 和 `selectSessionModel()`，请求体显式包含 `provider`、`model`、可选 `reasoningEffort`；
- 保留 `listModels()`/`selectModel()` 作为兼容接口，避免把 Settings 或旧调用一次性切断；
- 统一前端内部类型，使当前值始终是 `{ provider, model, reasoningEffort? }`，不要只存 model 字符串。

验收：浏览器切换 Session 后能读取不同 Session 的 selection；旧 `/v1/models` 调用仍可用；无 secret 出现在响应或日志。

### UI-M1：实现共享 `ModelDirectory`

目标：让 Composer 和未来 `/model` 使用同一个 Session 级目录快照。

参考 DSH：

- `packages/client/ui-model-selection/src/client/directory.ts` 的 `ModelDirectoryState`、`load()`、`select()`、`clear()`、generation 保护；
- `packages/client/ui-model-selection/src/client/service.ts` 的按 Session 生命周期缓存/释放。

建议动作：

- 在 `apps/web/src/` 新增小型 `model-directory.ts`（或放入现有 typed runtime service），以 SessionId 为 key；
- 目录状态至少包含 `current`、`routable`、`groups`、`failures`、`status`、`error`；
- `load()` 使用 `GET /v1/sessions/:id/models`；`select()` 使用 `POST /v1/sessions/:id/model`；
- 连接重置、Session 切换和旧请求覆盖保护沿用 generation 规则；
- 当前正在运行的 Turn 只读已组装 route，不被目录刷新或新选择改写。

验收：同一 Session 的两个渲染入口订阅同一快照；快速连续打开/关闭菜单不会出现旧请求覆盖新选择；Provider A 失败不清掉 Provider B。

### UI-M2：Composer Provider 分组选择器

目标：把现有 `#model-trigger`/`#model-popover` 收敛为 DSH 风格的清晰入口。

参考 DSH：

- `packages/client/ui-model-selection/src/client/ModelSelect.tsx` 的两级 Model/Effort pane、Provider group rendering、双键 selected 判断；
- `packages/client/ui-model-selection/src/client/slots.ts` 的 composer seat；
- DSH `tests/model-select.client.spec.tsx` 的交互断言。

建议动作：

- 触发器至少显示 `Provider · Model`，必要时追加 `· Effort`；
- Model pane 用 Provider heading 分组展示，保留 provider display name 和 route id 的可追溯信息；
- selected 判断固定使用 `provider + model`，effort 只在当前模型的 capability 下显示；
- 选择成功后更新共享目录、Composer label、Details/Settings 摘要；
- 选择失败保留旧 label，并显示可重试错误；
- addressed Subagent Session 禁用/隐藏此入口。

验收：两个 Provider 各有同名模型时只能有一个正确选中；Provider 分组可见；切换后下一条消息使用新 route；运行中的消息不变。

### UI-M3：`/model` popupSelect 命令入口

目标：提供可搜索、可键盘操作、可从命令菜单打开的第二入口。

参考 DSH：

- `packages/client/ui-model-selection/src/client/index.ts` 的 `popupSelect` 注册、row id 和 selection resolve；
- `packages/client/ui-commands/src/client/PopupSelectView.tsx` 和 `popup.ts` 的通用 shell/controller；
- DSH `tests/browser-plugin.client.spec.ts` 的 plugin 组合方式。

建议动作：

- 先复用现有 overlay 基础设施，再把业务选项与 popup controller 分开；
- row key 使用不透明的 `provider/model` 组合键或稳定编码，点击时通过目录反查，不从字符串猜 Provider；
- 支持搜索、ArrowUp/ArrowDown、Enter、Escape、加载失败重试；
- `/model` 和 Composer 选择必须写入同一个 `ModelDirectory`。

验收：输入 `/model` 或从命令菜单可打开；搜索模型名/Provider 名有效；切换后 Composer 同步；刷新后 current 由 Host 恢复。

### UI-M4：Settings Provider editor/card 收敛

目标：把“配置 Provider”与“切换当前 Session 模型”在视觉和职责上分开，同时保持前端输入凭据 → 本地持久化 → 立即可用 → 重启可恢复。

参考 DSH：

- `packages/client/ui-settings-models/src/client/ModelsSection.tsx` 的 Provider row、credential status、单卡展开和删除确认；
- `packages/client/ui-settings-models/src/client/ProviderEditor.tsx` 的 write-only key、Base URL、协议、模型发现和双层写入；
- 本仓库 `apps/web/index.html:1789-1860` 的 Credential/Provider 表单；
- 本仓库 `apps/api/src/server.ts:499-558` 的 Credential/Provider routes。

建议动作：

- Settings 页面显示 Provider 行、状态、模型数量和最近错误；
- secret 输入框始终 write-only，浏览器只收到 `configured/status/version` 等 metadata；
- 保存凭据后立即刷新 Provider discovery，并让 ModelDirectory 重新加载；
- Provider profile 只保存 opaque `credentialRef`，不把 token 放进 Provider profile、Session event、model route 或公开 projection；
- Provider 删除/凭据吊销遵循先解除引用、再删除的可重试顺序；
- Settings 成功后给出“返回当前 Session 选择模型”的明确操作路径。

验收：输入第三方凭据并保存后，Provider 出现在目录；无需重启即可在 ModelSelect 中选择；重启 API/Web 后 credential metadata、Provider profile 和 Session selection 仍恢复；公开 API 不返回 token。

### UI-M5：测试与可回滚门禁

目标：把 DSH 的交互约束转化为本仓库的单元、合同、恢复、安全和浏览器测试。

参考 DSH：

- `ui-model-selection/tests/model-select.client.spec.tsx`；
- `ui-model-selection/tests/browser-plugin.client.spec.ts`；
- `ui-commands` popup controller/view 测试；
- DSH Host `sessions.models/selectModel` 相关合同测试。

建议覆盖：

| 类别 | 最小场景 |
|---|---|
| 单元 | provider/model 双键 selected、row resolve、reasoning effort 映射、generation 防旧响应覆盖。 |
| 合同 | Session models/selectModel 请求体、Provider-local failure、credentialRef 只作为 opaque reference。 |
| 恢复 | Session selection 事件回放、API 重启、Web 刷新、SSE 重连后 current 一致。 |
| 安全 | secret 不出现在 JSON 响应、事件、错误、DOM 文本或日志；跨 tenant Provider/route 不可见。 |
| 浏览器 | Composer 切换、`/model` 切换、同名模型、搜索/键盘、Settings 保存后立即可用、运行中 Turn 不被切换影响。 |

回滚边界：每个 UI-M 切片独立提交；回滚 UI 不回滚已经持久化的 `session/model_selected` 或 Credential/Provider 数据。若新入口不可用，可暂时隐藏 `/model` 和 Provider 分组，保留现有模型按钮作为兼容路径。

## 7. 建议的最终用户流程

后续前端完成 UI-M0–M5 后，用户应能按下列路径操作：

```text
打开 Settings
  → Models / Providers
  → 输入 Provider 名称、协议、Base URL
  → 输入 API key（write-only）
  → Save
  → Host 保存 credential metadata + secret resolver material
  → Provider discovery 返回模型分组

回到当前 Session
  → 点击 Composer 的 “Provider · Model”
  → 或输入 /model
  → 选择 Provider 分组下的模型
  → 可选选择该模型支持的 reasoning effort
  → Host 持久化 session/model_selected
  → 下一 Turn 使用新 route
  → 刷新/重启后从 Host 恢复同一选择
```

这个流程把“Provider 配置”和“当前 Session 模型切换”分成两个明确动作，同时保持两者之间的即时联动。

## 8. 来源、许可证和使用边界

- DSH 根仓库为 MIT。本文引用的是文件路径、符号和行为摘要；后续若复制或大量改编 DSH 代码，必须保留其许可证/版权声明并更新 `docs/source-reuse-register.md`。
- 当前本地 Claude Code 快照未发现可直接复用的根许可证；本文只把其 query/turn 固定路由、错误分类和凭据不出请求体作为行为参考，后续实现应自行编写。
- 本文不引入 DSH 的 Cordis、插件发布、桌面端、账户体系或商业 Provider；只复用对本项目验收有帮助的模型目录、Session API、Popup 和 Settings 信息架构。
- 本仓库现有 Event、Tool、Task、Permission、Workspace 和 Credential 安全不变量优先级高于 UI 便利性；任何新入口都必须经过现有 Host API、权限和审计边界。

## 9. 调研后的执行建议

下一次真正编码时，建议从 UI-M0 和 UI-M1 开始，先让 Session 级 `ModelDirectory` 成为唯一事实来源，再实现 Composer 和 `/model` 两个表面。这样可以避免在现有单文件页面中继续堆叠第二套 Provider/model 状态，也能让 Settings 的凭据保存直接触发目录刷新。UI-M2–M4 完成后再执行 UI-M5 的浏览器和恢复门禁，并为每个切片创建独立 Git checkpoint。

