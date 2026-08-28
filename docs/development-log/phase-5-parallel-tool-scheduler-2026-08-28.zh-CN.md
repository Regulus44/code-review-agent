# 阶段 5：最多 10 个并行工具调用 Scheduler 实施日志（2026-08-28）

## 目标与边界

本阶段把 AgentHost 当前一次性 `Promise.all(response.toolCalls.map(...))` 调度改为 DSH 风格的统一 rolling pool。默认每个 assistant step 最多 `10` 个 parallel 工具调用同时 in-flight；Host 配置允许 `1–512`，`1` 表示串行，超过 `512` 在 Host/API 创建时拒绝。

parallel 调用按 rolling pool 分批启动；exclusive 调用前后形成 barrier；工具结果按模型声明顺序提交给下一次 model request；取消后停止补充新调用，等待已启动调用 drain，再为未启动调用追加结构化取消结果。权限、workspace、tenant、工具取消和审计仍全部经过 ToolRuntime。

本阶段没有修改 MCP、Subagent、A2A、工具权限策略或阶段 4 的工具结果聚合预算 contract。

## 直接修改的代码入口

- `packages/runtime/src/tool-call-scheduler.ts`
  - 新增 `scheduleToolCalls()`；
  - 新增 `DEFAULT_MAX_PARALLEL_TOOL_CALLS=10`、`MAX_PARALLEL_TOOL_CALLS=512` 和 `resolveMaxParallelToolCalls()`；
  - 实现 parallel rolling pool、exclusive barrier、动态读取未启动调用的 `executionMode`、模型顺序 commit、abort 停止补充和已启动调用 drain；
  - 为 abort 后的未启动调用提供 `skip` 回调，不调用工具执行体。
- `packages/runtime/src/index.ts`
  - `AgentHostOptions` 增加 `maxParallelToolCalls`；
  - 构造 Host 时校验 `1–512`；默认值为 `10`；
  - `runSteps()` 使用 scheduler 替换 `Promise.all`；
  - 调度前从 `ToolRuntime.registry.get(toolCall.name).executionMode` 重新读取模式；未知/禁用工具按 exclusive barrier 处理，具体失败仍由 ToolRuntime/Runtime 结构化记录；
  - abort 后追加 `TOOL_ABORTED_BEFORE_DISPATCH` 的 cancelled tool result，已启动调用结果 drain 后才结束 step；
  - 模型工具调用向 ToolRuntime 请求 `deferResultEvents`，由 scheduler 的 `commit` 回调调用 `commitDeferredResult()`，因此 `tool/result` 与 `diff/preview` 事件也按模型声明顺序落盘；合成失败/未派发调用保持即时落盘；
  - 增加 `toolExecutionSettings()`，供 API 投影实际 Host cap。
- `packages/tools/src/runtime.ts`
  - `ExecuteToolInput` 增加 scheduler 专用的 `deferResultEvents`；
  - 抽取 `commitDeferredResult()` 统一写入 `tool/result` 和 `diff/preview`，普通工具执行保持即时提交，scheduler 路径延迟到模型顺序 commit。
- `apps/api/src/server.ts`
  - `ApiServerOptions` 增加 `maxParallelToolCalls` 并传入 AgentHost；
  - `/v1/capabilities` 增加 `toolExecution.maxParallelToolCalls`；Web 不能直接修改运行中的 pool。
- `apps/web/src/client/api.ts`
  - 为 capabilities 增加 `toolExecution.maxParallelToolCalls` 类型。
- 测试文件：
  - `packages/runtime/src/tool-call-scheduler.test.ts`：rolling cap、exclusive barrier、模型顺序、abort drain/skip、动态重分类、配置校验；
  - `packages/runtime/src/index.test.ts`：Host cap、25 个 parallel 调用最多 10 个、模型顺序、turn cancellation drain；
  - `apps/api/src/server.test.ts`：Host cap 传递、capability 投影和非法上限拒绝。

## DSH 对照入口

- `D:/Develop/deepseek-harness-fork/packages/core/agent-loop/src/constants.ts`
  - `DEFAULT_MAX_PARALLEL_TOOL_CALLS=10`。
- `D:/Develop/deepseek-harness-fork/packages/core/agent-loop/src/index.ts`
  - `resolveMaxParallelToolCalls()` 的配置边界和 AgentLoop cap ownership；
  - 本项目将 Host 侧硬上限固定为 `512`，与本仓库统一 step hard cap 一致。
- `D:/Develop/deepseek-harness-fork/packages/core/agent-loop/src/tool-calls.ts`
  - `executeToolCalls()`：按首个调用分组；
  - `runGroup()`：parallel rolling pool、exclusive barrier、`fillPool()` 动态重分类、`commitReady()` 模型顺序提交、abort 后停止补充并 drain；
  - 本项目使用 `ChatModel`/`ToolRuntime`/EventStore 自有接口重写，未复制 Cordis、DSH Session 或 ToolRuntime 类型。
- `D:/Develop/deepseek-harness-fork/packages/core/agent-loop/tests/tool-calls.spec.ts`
  - 作为行为测试依据，覆盖 rolling cap、exclusive barrier、模型顺序、失败、permission/interaction pause 和 abort。

## 实现顺序

```text
assistant tool calls
  → scheduler 按 live executionMode 分组
  → parallel rolling pool（最多 10，Host cap 可降为 1）
  → exclusive barrier 单独执行
  → 已完成结果按模型声明顺序提交
  → 阶段 4 tool-result aggregate/replacement state
  → 下一次 model request
```

取消路径为：

```text
AbortSignal
  → 停止启动新的 tool call
  → ToolRuntime 取消已启动调用
  → 等待已启动 promise 全部 settle
  → 按模型顺序提交已启动结果
  → 对未启动调用追加 cancelled/TOOL_ABORTED_BEFORE_DISPATCH
  → step stopped，turn ended stopped
```

## 验收证据

- Scheduler 定向测试：6 项通过；
- Runtime 定向测试：69 项测试通过，本阶段新增 Host/scheduler 场景通过；
- API 定向测试：40 项通过；
- `pnpm typecheck`：通过；
- 阶段最终门禁：`pnpm test`、`pnpm typecheck`、`git diff --check`；
- 25 个 parallel tool call 的实测最大并发不超过 `10`，`tool/result` EventStore 事件和下一次 model request 中 tool message 均保持 assistant 声明顺序；
- exclusive 工具不会与前置或后置 parallel pool 重叠；
- turn cancellation 不再补充新工具调用，已启动调用会形成结果，未启动调用会形成结构化 cancelled 结果。

## 回滚与后续入口

配置回滚：将 `maxParallelToolCalls` 设为 `1` 即可退化为串行，不改变 EventStore、ToolRuntime、Permission 或 Workspace contract。

代码回滚：恢复 `runSteps()` 原有调用方式和移除 scheduler 文件；已经产生的 `tool/call`、`tool/progress`、`tool/result` 事件保留，不删除历史事件。阶段 4 的聚合预算和 replacement receipt 不随 scheduler 回滚。

阶段 6 入口是全链路恢复、安全、评测和文档门禁，重点验证并行 scheduler 与阶段 3/4 artifact、aggregate replacement、Windows PowerShell 和重启 replay 的组合行为。

## Checkpoint

- 代码与测试 checkpoint：`483f3ef feat(phase5): schedule parallel tool calls`；
- 本文档、阶段状态和实施基线在随后独立文档 checkpoint 中回填该提交号。
