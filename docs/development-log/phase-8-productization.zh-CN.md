# Phase 8 开发日志

## 2026-08-24：8.3 LSP/Code Mode 有界退出审计

本次 checkpoint 属于 Phase 8.3 安全退出审计，固化当前可证明的边界和残余风险。A2A 保持 `deferred`。

### 已完成

- 新增 `scripts/phase8-lsp-codemode-exit-gate.mjs`，审计 workspace/process boundary、网络 deny-by-default、OS-required fail-closed、代码/运行时/输出预算、LSP restart/timeout/cancel 和 Web host-backed surface；
- gate 读取实现源码、单元 fixture、现有 LSP/Code Mode gate、Settings presenter 和构建后的 browser bundle，避免仅凭文案判定安全能力；
- 审计结果显式输出 `status: partial`，保留 OS-level network isolation adapter 和部署级证据两项 residual risk，不把 process-policy 宣称为 OS 隔离。

### 验证

```text
pnpm test:phase8:lsp:exit ✓
  lsp-codemode-bounded-exit-audit: passed, status=partial
```

### 尚未关闭

8.3 仍需 host-specific OS isolation assessment 与部署级安全证据；8.4 跨场景 browser recovery matrix 和 8.5 产品化也未完成。

## 2026-08-24：8.0 响应式视觉基线与 Plugins 状态收口

本次 checkpoint 属于 Phase 8.0 Web 对齐，完成真实 Web fixture 的响应式视觉基线门禁，并补齐 Settings 的 Plugins 分区状态。A2A 保持 `deferred`，不进入本次实现。

### 已完成

- 使用真实 SQLite/API/AgentHost Web fixture 生成 Shell 与 Settings 的 600×800、900×800、1024×800 截图；文件统一为可校验的 JPEG，manifest 记录页面 surface、尺寸和 fixture 来源；
- 新增 `scripts/phase8-visual-gate.mjs` 与 `pnpm test:phase8:visual`，检查六个基线文件存在、PNG/JPEG 格式、真实像素尺寸、Shell/Settings 分离，以及 Settings 中 Plugins 的 `deferred` 说明；
- Runtime/API 新增 host-backed `pluginsSettings()` / `/v1/capabilities` 的 `plugins` 字段，当前明确返回 `deferred`，说明插件运行时等待 Phase 8.5 产品化需求；
- Settings presenter、Web Settings modal、API server test、presenter test 和 aggregate parity gate 均覆盖 Plugins，不把未实现插件能力显示为可用。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/web test -- --run src/presentation/settings-presenter.test.ts ✓ (3 tests)
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓ (28 tests)
pnpm build:web                                      ✓
pnpm test:phase8:visual                             ✓
pnpm test:phase8:parity                             ✓
git diff --check                                     ✓
```

### 尚未关闭

8.0 的完整响应式/可访问性 browser 矩阵和更多真实交互场景仍需继续扩展；8.3 完整退出审计、8.4 跨场景 browser recovery matrix 与 8.5 产品化也未完成。

## 2026-08-24：8.3 Code Mode 网络边界元数据与 fail-closed

本次 checkpoint 继续 Phase 8.3 的安全退出审计，明确 Code Mode 当前可证明的网络边界。A2A 保持 deferred。

### 已完成

- `CodeModePolicySnapshot` 和 `/v1/capabilities` 暴露 `networkEnforcement`、`network` 和 `osNetworkIsolation` 元数据；默认策略是进程级 deny-by-default，当前 host 明确报告没有 OS 级网络隔离；
- `os-required` 策略在执行前返回 `CODE_MODE_OS_ISOLATION_UNAVAILABLE`，在没有 OS 隔离适配器时 fail closed；
- Settings、LSP/Code Mode gate 和 Web replay gate 均检查该边界，避免把进程内入口拦截描述成 OS 级隔离；
- Settings fixture 补齐 network metadata，保持旧 host 数据缺失时显示 `Network enforcement metadata is unavailable`。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/tools test -- --run src/code-mode.test.ts ✓ (5 tests)
pnpm --filter @code-review-agent/web test -- --run src/presentation/settings-presenter.test.ts ✓ (3 tests)
pnpm test:phase8:lsp                                ✓
pnpm test:phase8:lsp:web                            ✓
pnpm test:phase8:parity                             ✓
pnpm build:web                                      ✓
git diff --check                                     ✓
```

### 尚未关闭

当前 host 仍未提供 OS-level network isolation；8.3 还需要完成退出审计和必要的更强隔离评估。8.0 visual baseline、8.4 跨场景 browser recovery matrix 与 8.5 产品化仍未完成。

## 2026-08-24：8.4 Job Center 真实 fixture 与重启恢复

8.4 的真实 Job Center action slice 和 API restart/recovery slice 已分别通过 `pnpm test:phase8:jobs` 与 `pnpm test:phase8:job-recovery`。前者覆盖 running/failed job、Cancel/Retry、spill metadata、lifecycle replay、diagnostics、session export 和重复 action 幂等；后者覆盖 seed 后关闭 API/SQLite、fresh AgentHost/API reopen、orphaned/completed job、interrupted session、terminal recovery、SSE replay、`after_sequence` tail cursor、diagnostics 和 export。

### 尚未关闭

更广泛的跨场景长任务 browser recovery matrix 仍需继续扩展，不能由这两个 slice 代替完整 8.4 退出条件。

## 2026-08-24：8.0 Aggregate Web parity contract gate

本次 checkpoint 收口 Phase 8.0 的静态 Web parity 合同门禁，继续从现有实现和事件投影验证 DSH 对齐能力；A2A 保持 `deferred`，不进入本次实现。

### 已完成

- 新增 `scripts/phase8-parity-gate.mjs`，检查 Goal/Plan/Question、Workspace Tree/Flat 与排序、Job Cancel/Retry、LSP details、Settings provider failure/retry、Produced Files、Tasks/child agents 以及 typed browser presenters；
- 门禁同时检查 600/900 响应式断点、`aria-live`、browser bundle focus trap 和既有 presenter symbol，避免只检查旧 HTML 文案；
- `package.json` 新增 `pnpm test:phase8:parity`，作为 8.0 aggregate contract 的可重复入口。

### 验证

```text
pnpm test:phase8:parity  ✓
  aggregate-web-parity-contract: passed
git diff --check         ✓
```

### 尚未关闭

该门禁不替代视觉截图基线和真实交互证据。8.0 仍需 600/900/1024 视觉矩阵和完整 Settings section（含 Plugins 的明确状态）；真实 Job action/replay fixture 与 provider failure/retry fixture 已由后续 checkpoint 关闭。8.3 完整审计、8.4 browser recovery matrix 与 8.5 产品化也未完成。

## 2026-08-24：8.0 Workspace Browser 导航 parity 收口

本次工作属于 Phase 8.0 Web 对齐，目标是补齐 Workspace Browser 的视图与排序入口，并验证其与现有 Session 回放、搜索和归档状态保持一致。A2A 保持 `deferred`，不进入本次实现。

### 已完成

- `navigation-presenter.ts` 增加 Tree/Flat 视图模型；Flat 模式展平父子 Session，保留 workspace 和 lineage 元数据；
- 增加 Recent/Name/Path 确定性排序，避免不同刷新顺序造成导航漂移；
- `apps/web/index.html` 暴露 Workspace view/sort 控件并接入 typed navigation model；
- 增加 presenter 单元测试，覆盖 Flat 展平和三种排序；
- 真实页面回归覆盖 Tree/Flat、Recent/Name/Path、搜索、Archived 切换和状态恢复。

### 验证

```text
pnpm typecheck                              ✓
pnpm --filter @code-review-agent/web test   ✓ (101 tests)
pnpm build:web                               ✓
pnpm test:phase8:web                         ✓
pnpm test:phase8:reliability                 ✓
git diff --check                             ✓
```

### 尚未关闭

8.0 的真实 provider failure fixture、visual baseline 和总 parity gate 仍待补齐；8.3 完整退出审计、8.4 browser recovery matrix 与 8.5 产品化也未完成。

## 2026-08-24：8.0 Settings provider/model failure surface

本次工作继续 Phase 8.0 Web 对齐，目标是让 provider/model catalog 的加载、失败、重试和选择结果在 Settings 中保持可解释且可恢复。

### 已完成

- `presentSettings` 增加 model loading/ready/error 状态、错误详情和 selection receipt；
- Web boot 将 model catalog 失败从全局 boot failure 中隔离，Settings 显示 `Catalog status`、provider failure 文案和 `Retry model catalog`；
- 模型切换成功后展示 host-backed `Selected <model>` receipt，失败后保留错误状态并允许再次重试；
- Phase 8 Web gate 增加 Workspace view/sort 与 Settings retry surface 静态门禁。

### 验证

```text
pnpm typecheck                              ✓
pnpm --filter @code-review-agent/web test   ✓ (102 tests)
pnpm test:phase8:web                         ✓
pnpm build:web                               ✓
git diff --check                             ✓
```

### 尚未关闭

仍需 visual baseline 和总 Web parity gate；8.3 完整退出审计、8.4 browser recovery matrix 与 8.5 产品化也未完成。

## 2026-08-24：8.0 provider failure fixture 与真实页面回归

### 已完成

- API 增加受控 `modelCatalogFailures` fixture hook，只用于测试/部署 smoke，不改变默认 provider 行为；
- `scripts/phase8-settings-gate.mjs` 覆盖首次 503、Retry 后 200、Session 数据仍可加载；
- 真实 Web 页面验证 Settings 显示 `Catalog status: error`、provider failure 文案和 `Retry model catalog`，点击后恢复 `ready` 与 `fixture-model`。

### 尚未关闭

8.0 仍需 visual baseline、总 Web parity gate 和更完整的响应式/section 矩阵。

## 2026-08-24：8.4 Reliability 第一阶段收口

本次工作属于 Phase 8.4，目标是让后台 Job、Session export/replay、诊断和 Web Job center 具备可恢复的可靠性边界。A2A 保持 `deferred`，不进入本次实现。

### 已完成

- `JobManager` 持久化 executable/args、attempt/deadline 元数据，支持显式 bounded retry、deadline 失败原因、调用方取消原因和 graceful shutdown；retry 创建新的 durable attempt，原失败保留在事件审计中；
- `AgentHost` 增加 job list/retry/kill、session export/replay、structured diagnostics 和 shutdown；
- API 增加 `/v1/sessions/:id/jobs`、`/retry`、`/cancel`、`/export` 与 `/v1/diagnostics`；Web API client 与 Job center 增加 Cancel/Retry 操作；
- 新增 `scripts/phase8-reliability-gate.mjs`，覆盖 retry、deadline、shutdown、session export 和 diagnostics 的真实运行路径。
- Reliability gate 增加 Web Job Center recovery surface 检查，确认 Cancel/Retry/diagnostics 文案和 typed browser action symbols 随构建产物存在；真实 Job action/replay fixture 已由后续 `pnpm test:phase8:jobs` checkpoint 关闭。
- 修复 API restart recovery race：shutdown 只取消普通 active turn，保留等待 durable user interaction 的 turn，让下一次 AgentHost 从 pending interaction 恢复；同时避免 SQLite close 后异步 `finishTurnAfterError` 写入失败。

### 验证

```text
pnpm typecheck                              ✓
pnpm --filter @code-review-agent/tools test  ✓ (58 tests)
pnpm --filter @code-review-agent/api test    ✓ (31 tests)
pnpm --filter @code-review-agent/web test    ✓ (100 tests)
pnpm build:web                               ✓
pnpm test:phase8:reliability                 ✓
git diff --check                             ✓
```

### 尚未关闭

8.4 的 model fallback、基础 metrics 和 turn trace propagation 已补齐；仍需更完整的 browser recovery matrix。8.0 parity gaps、8.3 完整退出审计和 8.5 产品化也仍未完成。

## 2026-08-24：8.3 LSP/Code Mode 第一阶段收口

本次工作属于 Phase 8.3，补齐受控 Code Mode、LSP Web source-location surface 和 capability metadata。A2A 保持 deferred。

### 已完成

- 新增 `CodeModeSandbox`：独立子进程、无 shell、Node permission 文件范围、最小环境、`node` 命令 allowlist、网络禁用、代码/运行时/输出预算和 AbortSignal 取消；
- `createBuiltinTools` 和 `AgentHost` 支持通过显式 `codeMode` 配置暴露 `code_mode`，默认不启用；
- 新增 Code Mode prompt contract、disabled/路径穿越/网络模块/恶意 executable/超时/输出上限/取消测试；
- 新增 `presentLspTool`，把 diagnostics、definition、references、source location、server restart/crash 和失败原因投影为 bounded Web render intent；
- Web Details 增加 LSP diagnostics & source locations surface；Settings capabilities 公开 Code Mode 与 LSP 的真实 host 状态；
- 新增 `scripts/phase8-lsp-codemode-gate.mjs`，覆盖 Code Mode 成功、网络越权、输出预算、LSP diagnostics/definition、server crash restart 和 cancellation。
- LSP/Code Mode gate 增加 Web LSP details/source-location 静态 surface 检查；Code Mode 网络拒绝模式补充 `globalThis.fetch`、`globalThis.WebSocket` 与 `process.getBuiltinModule` 入口测试。

### 验证

```text
pnpm typecheck                                      ✓
pnpm --filter @code-review-agent/tools test         ✓ (56 tests)
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓ (27 tests)
pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts ✓ (25 tests)
pnpm --filter @code-review-agent/web test           ✓ (100 tests)
pnpm build:web                                      ✓
pnpm test:phase8:lsp                                ✓
git diff --check                                     ✓
```

### 尚未关闭

8.3 仍需完成完整退出审计和更强 OS 级隔离评估；当前 host 只有 process-policy，`os-required` 会 fail closed。真实 LSP/Code Mode Web replay 已由 `pnpm test:phase8:lsp:web` 覆盖，但这不替代完整 browser/安全审计矩阵。

## 2026-08-24：8.2 Worktree 收口

本次工作属于 Phase 8.2，解决 Workspace/Worktree runtime、事件回放、安全和 Web 诊断问题。A2A 保持 deferred，不在本次范围内。

### 已完成

- `GitWorktreeManager` 支持主仓库和 linked worktree 识别；所有 Git 调用使用无 shell 的 `execFile`；
- Worktree create、attach、switch、cleanup 通过 `worktree/*` 事件进入 EventStore，并投影到 Session；
- active worktree 的路径进入工具执行、权限请求和 system prompt；主 Session `workspaceRoot` 不被覆盖；
- 增加每个 Session 的 Worktree operation lock，避免并发创建相同路径或分支；
- pending create 在 Git side effect 已发生但事件尚未追加时可以恢复并补写事件；
- dirty/conflicted cleanup 默认拒绝，主仓库永远不能 cleanup，重复路径返回 `WORKTREE_EXISTS`；
- Web API、SSE、SessionStore、Worktree presenter 和 Details panel 已接入；
- 新增 linked worktree、SQLite reopen/replay、并发创建、pending recovery、API client 和 presenter 测试；
- 新增 `scripts/phase8-worktree-gate.mjs` 与 `pnpm test:phase8:worktree`，覆盖真实 API、临时 Git 仓库、SQLite 重启、dirty protection、强制清理和 Web bundle。

### 验证

```text
pnpm typecheck                         ✓
pnpm --filter @code-review-agent/workspace test  ✓ (6 tests)
pnpm --filter @code-review-agent/runtime test    ✓ (24 tests)
pnpm --filter @code-review-agent/storage test    ✓ (12 tests)
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓ (26 tests)
pnpm --filter @code-review-agent/web test        ✓ (98 tests)
pnpm build:web                          ✓
pnpm test:phase7:browser                ✓
pnpm test:phase8:worktree               ✓
git diff --check                        ✓
```

### 尚未关闭

本记录对应的代码已建立独立的 Phase 8.2 Git checkpoint；Phase 8.1 Compaction 已完成，8.0 Web parity、8.3 LSP/Code Mode、8.4 可靠性和 8.5 产品化仍未完成。

## 2026-08-24：8.1 Context Compaction 收口

### 已完成

- API capabilities 返回 host-backed context compaction enabled/configured/budget metadata；Web Settings 和 ContextMeter 显示真实配置，未配置 provider budget 时保持 `unknown`；
- Context projection 保留 summary、dropped message、protected tool 和 truncated tool result 计数；
- 增加 compaction failure continuation 测试，压缩失败时保留原上下文并继续完成 turn；
- 增加真实 API 长上下文 fixture、SQLite restart/replay 和 Web bundle gate。

### 验证

```text
pnpm typecheck
pnpm --filter @code-review-agent/runtime test        ✓ (25 tests)
pnpm --filter @code-review-agent/storage test        ✓ (12 tests)
pnpm --filter @code-review-agent/api test -- --run src/server.test.ts ✓ (27 tests)
pnpm --filter @code-review-agent/web test             ✓ (98 tests)
pnpm test:phase8:compaction                           ✓
git diff --check                                      ✓
```

本记录对应的代码已建立独立 Phase 8.1 Git checkpoint；8.0 Web parity、8.3 LSP/Code Mode、8.4 可靠性和 8.5 产品化仍未完成。
