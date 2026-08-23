# ADR：Phase 8 Web 与 DSH 前端行为对齐

状态：`accepted`

日期：2026-08-23

## 背景

Phase 7 已完成本项目定义的 Web 收敛验收，但当前 Web 仍与 DSH 前端存在明显深度差异：GoalBar、Plan/Todo、Question batch、Job actions、Trajectory Inspector、Settings 分区和 AppFrame slot 组件边界尚未达到 DSH 的行为与可维护性水平。

DSH 的参考证据来自本地快照 `D:/Develop/deepseek-harness-fork` 的 Web、client UI、类型和测试。当前 Windows 环境没有可复用的 DSH live page，因此视觉对齐需要在本项目中建立自有截图基线，不把实时页面结果冒充为 DSH 证据。

## 决策

### 1. 将 DSH Web 对齐纳入 Phase 8.0

Phase 8.0 专门处理 Web 行为、信息架构、组件边界和视觉/可访问性验收。Phase 7 的完成状态保持不变，Phase 8.0 作为后续增强阶段推进。

### 2. 采用行为参考，不复制 DSH runtime

采用 DSH 的以下行为和信息架构：

- AppFrame 三栏、Sidebar rail/drawer、Details identity；
- Workspace/Session Browser、排序、搜索和生命周期操作；
- Conversation snapshot、Composer state machine、Permission/Question；
- GoalBar、Plan/Todo、Queue、Job、MCP、Deliverables、Settings；
- Trajectory ledger/timeline/inspector；
- loading/error/reconnect/expired/recovered/blocked 状态；
- unit、contract、recovery、browser、visual 和 accessibility 测试方式。

本项目继续使用自己的 `packages/contracts`、EventStore、REST/SSE、PermissionPolicy、WorkspaceResolver、ToolRuntime 和 API projection。

### 3. 保留 REST + SSE 连接模型

DSH 的 WebSocket/mux 不是本阶段的强制目标。当前项目继续使用 typed REST API、SSE、generation guard、sequence replay、idempotency 和断线恢复。只有当实际产品需求要求多路双向 stream 时，才单独提交协议 ADR。

### 4. 以 typed boundary 拆分当前静态 Web

优先建立以下本项目边界：

```text
apps/web/src/
  shell/
  sidebar/
  conversation/
  composer/
  details/
  panels/
  trajectory/
```

`apps/web/index.html` 的 fallback 在迁移期间保留。新组件只消费 typed presenter/render intent，不直接读取 ToolRegistry、Agent live object 或 EventStore 内部对象。

### 5. 先补事实和 projection，再补 UI

Goal/Plan/Todo、Question batch、usage、reasoning metadata、Job action 和 Trajectory Inspector 字段若缺少后端事实，必须先更新 contract、projection、replay fixture 和安全测试。UI 使用 `unknown`、`unavailable` 或 `deferred` 表示缺失能力。

### 6. 来源与许可证

DSH 根仓库 MIT。只读行为参考记录在 `docs/phase-7-dsh-web-research.zh-CN.md`；直接复制或大量改编 DSH 文件时，必须在 `docs/source-reuse-register.md` 登记具体路径、MIT notice、改写范围和新增测试。Claude Code 仅作行为参考。

## 影响

### 正面影响

- 页面结构、状态和行为可以按能力独立测试和回滚；
- Goal/Plan/Todo、Trajectory 和 Settings 不再依赖单文件 DOM 临时状态；
- DSH 的交互经验可以转化为本项目自己的 contract 和 replay fixture；
- Phase 8 高级能力有稳定的 Web 展示和诊断入口。

### 成本与风险

- 迁移期会同时存在 typed bridge 和静态 fallback；
- 新增 projection/query DTO 需要维护向后兼容和回放测试；
- 没有 live DSH page 时，视觉比较需要依赖源码、测试和本项目截图基线；
- Goal/Plan/Todo 等能力可能暴露已有后端 contract 的字段缺口。

## 不包含

- 完整 DSH Cordis/plugin runtime；
- DSH 账户、桌面端、CLI、遥测、发布系统；
- 为了视觉相似而绕过 EventStore、Permission、Workspace 或审计；
- 没有后端事实支持的伪造状态；
- 跨产品 Agent 互操作协议实现。

## 验收门槛

在接受本 ADR 后，Phase 8.0 必须至少通过：

- `pnpm typecheck`；
- `pnpm test`；
- Phase 7 browser/replay gate；
- Goal/Plan/Question/Composer 新增 contract 和 recovery tests；
- 600/900/1024 viewport、keyboard、focus、aria 和 visual baseline；
- 1,250+ trajectory records、older page、redaction 和 unknown field tests；
- 工作树安全检查和独立 Git checkpoint。

## 回滚

Phase 8.0 的每个子工作流通过 feature flag 或 typed bridge 开启。失败时回退到 Phase 7 Shell、generic tool presenter、现有 Permission/Interaction card 和静态 fallback，不回滚已稳定的 EventStore 或 Runtime contract。
