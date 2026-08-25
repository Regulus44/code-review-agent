# Coding Agent 前端改造方案：DSH 风格工作台

## 1. 文档目的

本文定义当前 Coding Agent Web 前端向“DeepSeek Harness 类工作台”收敛的产品、交互、视觉和实现方案。

这里的“DSH 风格”指信息架构和交互方式：工作区/会话导航、对话主舞台、内嵌工具活动、按需查看轨迹、底部 Composer 和弱化运行指标。不会复制任何第三方品牌标识、Logo 或产品文案。

本次改造属于 Phase 8 的 Web 收敛与产品化工作，重点解决信息密度、状态可读性和 Coding Agent 操作效率问题。事件、工具、任务、权限和 workspace 仍以现有 TypeScript contracts、Event Store 和 API projection 为事实来源。

### 1.1 本次交付状态

下表区分本次已经落地的能力与后续收敛项，避免把设计建议误读为已经存在的独立模块：

| 能力 | 当前状态 | 实现位置/说明 |
|---|---|---|
| 两栏 Shell、默认关闭 Details 抽屉 | 已落地 | `apps/web/src/shell/*` 与 `apps/web/index.html` |
| 左侧宽度拖拽、键盘调整、持久化 | 已落地 | Shell layout state；默认 252px，范围 220–360px |
| Send / Stop / Stopping 状态机 | 已落地 | Composer 根据 durable turn projection 和 `turn/ended` 渲染 |
| 模型切换与 reasoning effort | 已落地 | `/v1/models` capability；仅对后续 turn 生效 |
| Composer 下方 usage 条 | 已落地 | 读取事件中 host/provider 报告的 usage；未知值显示 `—` |
| 独立 `composer-presenter.ts` / `usage-presenter.ts` | 后续收敛 | 当前逻辑仍集中在 `apps/web/index.html`，后续可拆分为可测试 presenter |
| 完整 Usage drawer、TTFT、tok/s、cache hit 百分比 | 后续收敛 | 需要更完整的 projection 字段和 provider 数据 |

## 2. 参考材料与边界

### 2.1 用户提供的视觉参考

以下图片只作为视觉参考，图片中的文字、数字和红框不构成额外开发指令。

![参考图一：发送中显示停止按钮](C:/Users/12294/AppData/Local/Temp/codex-clipboard-36419c00-ef56-4283-9101-59cde47bf5cb.png)

![参考图二：模型与推理强度选择](C:/Users/12294/AppData/Local/Temp/codex-clipboard-64c8f7ae-7141-4454-8e8b-07009802d4ec.png)

![参考图三：Composer 下方显示运行指标](C:/Users/12294/AppData/Local/Temp/codex-clipboard-15c4701d-5769-454b-a42e-bba7eecb3067.png)

### 2.2 当前前端证据

当前 Web 壳层位于 [apps/web/index.html](../apps/web/index.html)，现状包括：

- CSS 使用 `--sidebar-width: 300px`、`--details-width: 300px`，默认三栏布局；
- 左侧同时放置 Workspace、Session、MCP servers、Child agents 和设置入口；
- 右侧 Details panel 汇总大量 Goal、Plan、Todo、Task、Trajectory、MCP、LSP、Job 等信息；
- Composer 已有 Attach、Plan、权限 Mode、Model、Context meter、Steer 和 Send 控件；
- `/v1/sessions/:id/cancel` 已存在，Runtime 也有 `turn/ended` 的 `stopped` 状态；
- `/v1/models` 已支持模型目录和模型切换；当前缺少独立的“推理强度/工作强度”契约；
- `context-presenter.ts` 目前只把上下文预算投影成简短的 `Context · used/budget` 文本。

当前运行截图（用于改造前基线）：

![当前前端基线](../.data/frontend-review-main.png)

### 2.3 不改变的治理边界

- 不修改根目录 `AGENTS.md`；
- 不恢复旧 Python Runtime；
- Web 不直接读取 Event Store，也不根据本地临时状态伪造 turn、tool、task 或 permission 状态；
- 没有后端事件和能力声明支持的 UI 先显示 `未配置`、`不可用` 或 `deferred`，不显示虚假的成功状态；
- 任何直接复用上游代码必须登记来源和许可证。本方案只参考行为和信息架构，不要求复制上游实现。

## 3. 改造目标

### 3.1 用户目标

用户打开页面后，应能在三秒内回答以下问题：

1. 我当前在哪个 workspace、哪个 session？
2. Agent 是否仍在工作？如果在工作，点击哪里可以停止？
3. 当前使用哪个 provider/model，推理强度是什么？
4. 这次运行消耗了多少 token、花了多少时间、调用了多少工具？
5. 如果发生错误，下一步是重试、停止、换模型，还是查看技术详情？

### 3.2 产品目标

- 将默认视图从“三栏监控台”改成“两栏对话工作台”；
- 让主对话区拥有足够宽度，工具活动成为对话中的轻量行；
- 将内部事件流、原始 JSON 和调试信息移入按需打开的轨迹/详情抽屉；
- 让发送按钮成为单一、明确的 turn 控制器：空闲时发送，运行时停止；
- 把模型选择、推理强度和权限模式拆成三个不同概念；
- 在 Composer 下方提供稳定的运行指标条；
- 保留刷新、断线重连、SSE replay 和 SQLite recovery 后的一致状态。

## 4. 目标信息架构

### 4.1 两栏主壳层

```text
┌──────────────────────┬─────────────────────────────────────────────────────┐
│ Workspace / Sessions  │ Session title       对话 | 轨迹       Session log  │
│                      ├─────────────────────────────────────────────────────┤
│  + New session        │                                                     │
│  Search               │                 Conversation                         │
│  Recent               │   用户消息                                          │
│  Pinned               │   Agent 回复                                         │
│  Archived             │   Read · README.md                                   │
│                      │   Think · 分析依赖                                  │
│  workspace tree       │   Pwsh · pnpm test                                  │
│   └ sessions          │   任务 1 进行中 · 5 待处理                          │
│                      │                                                     │
│  Settings             ├─────────────────────────────────────────────────────┤
│                      │ Composer                                             │
└──────────────────────┴─────────────────────────────────────────────────────┘
```

默认不显示常驻右侧详情栏。点击“轨迹”、工具行或顶部 Session log 后，打开右侧抽屉；抽屉关闭后对话区恢复原宽度。

### 4.2 响应式规则

| 视口宽度 | 默认布局 | 说明 |
|---|---|---|
| `>= 1280px` | 左侧 240–280px + 主区 | 左侧可拖拽，主区至少 760px |
| `1024–1279px` | 左侧 220–260px + 主区 | 详情只用抽屉，不占常驻列 |
| `768–1023px` | 可收起左侧 + 主区 | 左侧转为 overlay，保留拖拽但限制最大宽度 |
| `< 768px` | 单列 | Workspace/Session 通过抽屉进入；Composer 固定底部 |

## 5. 具体需求设计

### 5.1 左侧内容区可拖拽调整

#### 交互

- 左侧主导航宽度范围：`220px–360px`，默认 `252px`；
- 左侧与主区之间放置 4px 宽的 invisible hit area，视觉上只显示 1px 分隔线；
- 鼠标拖拽、触摸拖拽和键盘调整均可用；键盘支持 `ArrowLeft/ArrowRight` 每次调整 8px，`Home/End` 跳到最小/最大值；
- 拖拽期间显示宽度 guide，不重排 Session 内容；
- 宽度写入浏览器 UI 偏好，仅影响布局，不写入 Event Store；
- 在窗口变窄时自动 clamp，不能挤压主对话区到小于 `minmax(0, 760px)`；
- 侧栏折叠仍保留，折叠后恢复到用户上次宽度。

#### 实现建议

新增 `ResizableSidebar` 交互层，状态放在 Shell UI state：

```ts
type SidebarLayoutState = {
  mode: "expanded" | "collapsed";
  widthPx: number;
  isResizing: boolean;
};
```

CSS 从固定三栏改为：

```css
.app-shell {
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
}
.sidebar-resizer {
  width: 4px;
  cursor: col-resize;
}
```

建议修改位置：

- [apps/web/index.html](../apps/web/index.html)：Shell DOM、CSS variables、resizer hit area；
- [apps/web/src/shell/layout.ts](../apps/web/src/shell/layout.ts)：增加宽度、clamp、键盘调整和持久化策略；
- [apps/web/src/shell/app-frame.ts](../apps/web/src/shell/app-frame.ts)：挂载 resizer 和 `aria-valuenow`；
- `apps/web/src/shell/*.test.ts`：增加边界和键盘可访问性测试。

### 5.2 发送按钮：发送态与停止态统一

#### 目标状态

| 当前可操作状态 | 按钮图标 | 文案/ARIA | 点击行为 |
|---|---|---|---|
| 输入为空、turn 空闲 | 上箭头 | `发送消息` | disabled |
| 有输入、turn 空闲 | 上箭头 | `发送消息` | POST send message |
| turn `queued` | 方形停止 | `停止排队中的 turn` | 取消当前 turn 或从队列移除 |
| turn `running` | 方形停止 | `停止正在运行的 turn` | POST cancel，等待 stopped 事件 |
| turn `stopped/failed/completed` | 上箭头 | `发送消息` | 恢复发送态 |
| cancel 请求已发出 | 旋转/禁用 | `正在停止` | 防止重复 cancel |

发送按钮不能仅通过前端点击瞬间变更为“已停止”。正确流程是：

```text
turn/started 或 turn/queued
        ↓
按钮显示 stop
        ↓ 用户点击
POST /v1/sessions/:id/cancel
        ↓
turn/ended { status: "stopped" }
        ↓
按钮恢复 send
```

状态来源优先级：`SessionProjection.turns` → 当前 turn 的 `TurnProjection.status` → Composer presenter。禁止用“最后一次点击时间”推断运行状态。

#### 失败与竞态

- 如果 cancel API 返回成功但 SSE 尚未收到 `turn/ended`，显示 `正在停止`，不能立即显示“完成”；
- 如果 turn 已经 completed，cancel 返回幂等成功或 terminal receipt，按钮保持发送态；
- 如果断线，按钮根据最后一次 durable projection 保持 stop/send，并在连接恢复后 replay；
- 如果存在 queued follow-up，按钮停止的是明确标记的 active turn，并在队列条中保留其它消息。

### 5.3 模型与推理强度

#### 概念拆分

Composer 中需要并排展示三个独立控件：

1. `权限模式`：Read only、Ask before changes、Workspace write、Full access；
2. `模型`：provider + model，例如 `DeepSeek · V4 Flash`；
3. `推理强度`：Low、Medium、High、Max，或 provider 能力返回的自定义档位。

当前 `mode-trigger` 对应权限 preset，不能直接改名为 Reasoning。否则会让用户误以为“High”代表高权限。

#### 推理强度契约

建议在 contracts 中新增 host-backed 能力声明，示意如下：

```ts
type ReasoningEffort = "low" | "medium" | "high" | "max";

interface ModelCapability {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEfforts: readonly ReasoningEffort[];
  readonly defaultReasoningEffort?: ReasoningEffort;
}
```

每次 turn 开始时，将实际生效的 `model` 和 `reasoningEffort` 写入 `turn/started` payload，确保轨迹和恢复可以回答“这次运行使用了什么设置”。如果 provider 不支持推理强度，返回 `unsupported`，前端显示禁用态，而不是伪造可切换选项。

建议 API 形态：

- `GET /v1/models`：返回当前模型、可用模型和每个模型的 capabilities；
- `POST /v1/models`：切换后续 turn 使用的模型；
- `GET /v1/settings/agent` 或扩展现有 capability endpoint：返回当前 reasoning effort；
- `POST /v1/settings/agent`：更新后续 turn 的 effort，返回 durable receipt。

切换规则：运行中的 turn 不被静默改写；控件提示“对下一次 turn 生效”。若产品未来支持中途 steering，应单独设计，不复用模型设置 mutation。

#### Composer 展示

```text
[＋] [🔒 Ask before changes ▾]                    [DeepSeek V4 Flash ▾] [High ▾] [■/↑]
```

在窄屏下，模型和推理强度合并成一个 `Model · High` 菜单，权限模式仍单独保留。

### 5.4 Composer 下方运行指标

指标条应位于 Composer 卡片下方、主内容居中容器内，视觉弱化为一行灰色文本。运行中实时更新，turn 结束后保留最终值。

#### 第一版指标

| 指标 | 含义 | 无数据时 |
|---|---|---|
| 轮次 | 当前 Session 的 turn 数，或本次 turn 的 step 数，必须明确标签 | `轮次 —` |
| LLM 时间 | 模型请求累计耗时 | `LLM —` |
| 工具调用 | 工具累计耗时与调用次数 | `工具 —` |
| 首 token | TTFT 或首个 assistant chunk 延迟 | `首 token —` |
| 生成速度 | output tokens / 秒 | `tok/s —` |
| 缓存命中 | provider 返回的 cache hit 比例 | `缓存 —` |
| 输入/输出 token | input、output、total 分开记录 | `输入 — · 输出 —` |

推荐文案：

```text
5 步 · LLM 12.4s · 工具 3 次 / 8.1s · 首 token 1.2s · 42 tok/s · 缓存 97% · 输入 18.4k · 输出 2.1k
```

不建议把所有字段永远铺满。默认显示 5–7 个最有价值字段，点击指标条展开完整 Usage drawer；移动端只显示 `LLM 12.4s · 2.1k tok`。

#### 数据来源要求

指标必须来自模型 adapter、tool lifecycle 和 Event Store projection。当前 `Trajectory` 已有 Usage/Timing inspector 的兼容入口，但 `TurnProjection` 尚未有标准化 usage 字段，因此实施时应：

1. 先扩展事件 payload/contract，定义 input/output/total、TTFT、duration、tool duration；
2. 再在 storage projection 中聚合；
3. 最后由 `usage-presenter.ts` 输出 UI render intent；
4. 缺少 provider 数据时显示 `unknown`，不根据字符数冒充真实 token。

### 5.5 工具活动与任务条

主对话只显示摘要行，默认不显示嵌套 JSON：

```text
⌕  Glob · **/*                                  0.4s
◇  Think · 规划测试策略                         1.1s
▣  Read · packages/runtime/src/index.ts         0.8s
▸  任务 1 进行中 · 5 待处理                         展开
```

点击后在当前行下方展开 bounded detail；原始事件、source、request、response、schema 等放到轨迹抽屉。错误行提供 `重试`、`停止`、`技术详情` 三个动作，但动作可用性必须由 host capability 和当前状态决定。

### 5.6 对话 / 轨迹 Tab

- `对话`：面向工作结果，显示 user/assistant、工具摘要、权限请求、任务折叠条；
- `轨迹`：面向诊断，显示 turn → step → tool → permission → task 的时间线；
- `Session log`：导出或查看完整日志，默认不在主对话中展开；
- Tab 切换是可丢弃的 UI 状态，不追加事件；
- 轨迹继续使用现有 `trajectory-presenter.ts` 的脱敏、bounded JSON 和 unknown 字段策略。

## 6. 状态模型与投影规则

### 6.1 Composer View Model

建议在 `apps/web/src/presentation/composer-presenter.ts` 中集中生成：

```ts
interface ComposerView {
  readonly submit: {
    readonly mode: "send" | "stop" | "stopping";
    readonly disabled: boolean;
    readonly ariaLabel: string;
  };
  readonly permission: PermissionPreset;
  readonly model: { readonly provider: string; readonly name: string };
  readonly reasoning: {
    readonly status: "available" | "unsupported" | "unknown";
    readonly current?: string;
    readonly options: readonly string[];
  };
  readonly usage: UsageSummary;
}
```

所有按钮和标签从该 view model 渲染，避免 `index.html` 内散落多个 `if (running)` 判断。

### 6.2 运行状态优先级

```text
Event Store
   ↓ replay / SSE
SessionStoreSnapshot
   ↓ projection
TurnProjection + ToolProjection + UsageProjection
   ↓ presenter
Conversation / Composer / Usage bar / Details drawer
```

冲突时采用以下规则：

- `turn/ended` 是 turn terminal 状态的最终事实；
- `step/started` 不能单独把整个 Session 标成 running；
- connection `Connected` 只描述 SSE 连接，不代表 turn 成功；
- tool `running` 不能覆盖 turn `failed` 或 `stopped`；
- queue 数量来自 durable queue projection，不从 DOM 数量推断。

## 7. 组件与代码改造清单

### P0：壳层和 Composer

1. `apps/web/index.html`
   - 两栏 grid；
   - 可拖拽 sidebar resizer；
   - 默认关闭 details，改为抽屉；
   - Composer 加入 stop icon、reasoning trigger、usage strip。
2. `apps/web/src/shell/layout.ts`
   - `widthPx`、clamp、折叠和 viewport 规则。
3. `apps/web/src/shell/app-frame.ts`
   - resizer、抽屉、focus restore、ARIA。
4. `apps/web/src/presentation/composer-presenter.ts`
   - 集中生成 send/stop/stopping、权限、模型、推理强度和 usage view。
5. `apps/web/src/presentation/usage-presenter.ts`
   - 格式化 token、duration、TTFT、tok/s、cache hit。

### P1：信息架构

1. `navigation-presenter.ts`：Recent/Pinned/Archived 分组、可读 Session 标题、搜索结果；
2. `conversation.ts` / `tool-call-tree.ts`：工具摘要行、任务折叠条、错误操作；
3. `trajectory-presenter.ts`：对话/轨迹双 Tab 和抽屉入口；
4. `details-panel`：从常驻列改为 overlay drawer，保留现有 details sections。

### P2：能力和契约

1. `packages/contracts/src/index.ts`：ModelCapability、ReasoningEffort、UsageProjection；
2. `packages/runtime/src/index.ts`：为后续 turn 固化模型/推理强度，turn start 写入实际设置；
3. `apps/api/src/server.ts`：模型 capability、effort 设置和 receipt API；
4. storage projection：重启、回放和 SSE replay 保持 usage/setting 一致。

## 8. 分阶段实施计划

| 阶段 | 交付物 | 验收重点 | 回滚边界 |
|---|---|---|---|
| A. Shell | 两栏、抽屉、可拖拽左栏、响应式 | 600/768/1024/1280 宽度 | 仅回滚 Web shell/CSS |
| B. Turn control | send/stop/stopping 状态 | running、queued、cancel、断线恢复 | 保留原 cancel API |
| C. Composer | 权限/模型/推理强度三层控件 | 不支持时明确 disabled；下一 turn 生效 | effort UI 可 feature flag 关闭 |
| D. Usage | Composer 下方指标条 | provider 有数据/无数据/重启 replay | 仅隐藏 usage projection，不影响 turn |
| E. Conversation | 工具行、任务条、错误卡片 | tool/permission/task/trajectory 回放 | 保留 details inspector |
| F. Visual polish | token、图标、间距、无障碍 | keyboard、focus、contrast、reduced motion | 仅回滚视觉变量 |

每个阶段都应建立独立 Git checkpoint，并运行与改动范围匹配的 typecheck、unit、contract、replay 和 browser 测试。跨 Event/Tool/Task/Permission contract 的变更必须同步契约文档和测试。

## 9. 视觉规范建议

### 9.1 布局与间距

- 主体背景：`#ffffff`；导航背景：`#f7f8fa`；
- 主区最大内容宽度：`840px`，Composer 最大宽度：`860px`；
- 正文 `14–15px`，辅助信息 `12–13px`，禁止把核心状态压到 `9–10px`；
- 默认使用 8px spacing scale：`8 / 12 / 16 / 24 / 32`；
- 边框只用于 Composer、抽屉、权限请求和错误状态；工具摘要行优先使用 hover background，不使用层层卡片。

### 9.2 颜色语义

| 语义 | 颜色 | 用途 |
|---|---|---|
| Primary | `#2563eb` | active tab、send、链接 |
| Running | `#2563eb` | 运行中、进度 |
| Success | `#16a34a` | completed |
| Warning | `#d97706` | permission、queued |
| Danger | `#dc2626` | failed、stop、deny |
| Muted | `#6b7280` | usage、时间、路径 |

### 9.3 图标

将当前大量 Unicode 图标逐步替换为统一 SVG icon set。停止按钮使用方形 stop glyph，发送按钮使用 upward arrow；图标必须有 aria-label，不依赖颜色单独表达状态。

## 10. 验收场景

### 10.1 功能验收

- 拖拽左栏到 220、252、360px，刷新后宽度保持；窗口缩小不会遮挡 Composer；
- 输入消息后发送，turn running 时按钮变为 stop；点击后出现 stopping，收到 stopped 事件后恢复 send；
- queued turn、permission pending、tool running、turn failed 均不产生状态冲突；
- 切换模型和推理强度后，新 turn 的轨迹显示实际生效设置；当前 turn 不被静默改写；
- provider 未返回 reasoning capability 时，控件显示不支持并可继续发送；
- Usage 有完整数据、部分数据、无数据、上下文压缩和 API 重启 replay 时均能安全显示；
- 关闭/打开详情抽屉、切换对话/轨迹、断线重连后，事实和状态一致；
- 600px、768px、1024px、1280px viewport 下键盘操作和焦点恢复通过。

### 10.2 自动化建议

```text
pnpm typecheck
pnpm test
pnpm build:web
pnpm test:phase8:visual
pnpm test:phase8:parity
pnpm test:phase8:browser:evidence
git diff --check
```

新增测试至少包括：

- `layout-resizer.test.ts`：clamp、键盘、持久化；
- `composer-presenter.test.ts`：send/stop/stopping 状态矩阵；
- `usage-presenter.test.ts`：token、duration、unknown、redaction；
- `reasoning-capability.test.ts`：provider 能力、unsupported、receipt；
- browser e2e：真实 turn cancel、reload replay、model/effort selection、responsive drawer。

## 11. 风险与处理

### 风险一：把权限模式和推理强度混为一谈

处理：保留 `mode-trigger` 为权限控件，新增独立 reasoning trigger；文案、icon 和 API 字段均分离。

### 风险二：token 指标看起来精确但没有 provider 事实来源

处理：Usage contract 先定义来源和 unknown 语义；字符数只能作为明确标记的 estimate，不能显示成真实 token。

### 风险三：停止按钮前端先变更造成假状态

处理：按钮可在 cancel 请求期间显示 `stopping`，最终状态只由 `turn/ended` 或恢复投影决定。

### 风险四：为追求 DSH 外观过早引入未完成能力

处理：先做 shell、turn control 和 projection；MCP、Subagent、LSP、Worktree 继续消费现有 host-backed presenter，不增加绕过权限和事件的快捷路径。

### 风险五：三栏移除后调试能力丢失

处理：将右侧详情改为可发现的抽屉，并在轨迹 Tab、工具行和错误卡片上提供入口；不删除现有 inspector 能力。

## 12. 推荐实施顺序

第一步先完成 A+B：两栏 shell、可拖拽左栏、详情抽屉和 send/stop 状态。这一批能立刻改善“杂乱”和操作不直观的问题，而且不需要新增 Event contract。

第二步完成 C+D：把权限、模型、推理强度拆开，并建立真实 Usage projection。这里需要先确认各 provider 是否支持 effort 参数，再决定映射到 OpenAI-compatible、DeepSeek 或自定义 adapter 的字段。

第三步完成 E+F：工具摘要、任务条、对话/轨迹 Tab、错误操作和视觉 token 收敛。最后再扩展更完整的 mobile/responsive browser matrix。

最终目标不是把页面做成静态“漂亮壳子”，而是让每一个可见状态都能从 durable event/replay 得到解释：用户看到的 stop、High、2.1k tokens、工具失败和重连后的恢复，都应该对应真实的 runtime 事实。
