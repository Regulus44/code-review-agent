# 2026-04-25 可观测性补齐开发日志

## 步骤 1：范围确认与基线检查

### 代码修改记录
- 修改文件：无
- 具体改了什么：先阅读现有 `runtime/harness/observability/web` 相关代码。
- 为什么这样改：先确认事件模型和调用链缺口，再决定改造路径。
- 想解决的问题：避免直接改代码导致模型层、存储层、前端联动失配。

### 调试/测试记录
- 运行命令：
  - `Get-Content -Raw src/code_review_agent/runtime/service.py`
  - `Get-Content -Raw src/code_review_agent/runtime/types.py`
  - `Get-Content -Raw src/code_review_agent/harness/agent.py`
  - `Get-Content -Raw src/code_review_agent/web/index.html`
- 观察现象：
  - `observability` 仅占位。
  - `RunEvent` 结构较薄，没有 trace/span/duration/status。
  - `AgentStep` 无耗时信息，无法构建稳定诊断摘要。
- 问题判断：
  - 先改 `AgentStep` + `RunEvent`，再改 runtime 发事件和 UI 展示，风险最小。
- 下一步准备：
  - 增加统一事件字段与诊断类型，接入 runtime 事件发射和日志。

---

## 步骤 2：后端可观测性模型与埋点实现

### 代码修改记录
- 修改文件：
  - `src/code_review_agent/harness/types.py`
  - `src/code_review_agent/harness/agent.py`
  - `src/code_review_agent/runtime/types.py`
  - `src/code_review_agent/observability/__init__.py`
  - `src/code_review_agent/observability/events.py`（新增）
  - `src/code_review_agent/runtime/service.py`（重构）
  - `src/code_review_agent/runtime/__init__.py`
  - `src/code_review_agent/storage/sqlite_store.py`
  - `src/code_review_agent/apps/repo_analyst/types.py`
  - `src/code_review_agent/apps/repo_analyst/service.py`

### 具体改了什么
- `AgentStep` 新增：
  - `iteration`
  - `started_at`
  - `finished_at`
  - `duration_ms`
  - `metadata`
- `Agent.run()` 新增：
  - 模型调用耗时采集（含 provider/model metadata）
  - 工具调用耗时采集（含 tool_name metadata）
- `RunEvent` 扩展：
  - `event_type`
  - `payload`
  - `trace_id`
  - `span_id`
  - `parent_span_id`
  - `status`
  - `duration_ms`
  - `failure_reason`
- 新增 `RunDiagnostics` / `RunStepTiming` 并挂载到 `RunRecord.diagnostics`。
- 新增 `observability/events.py`：
  - `new_trace_id/new_span_id`
  - `make_run_event`
  - `log_structured_event`
- runtime 重构：
  - 生命周期事件：`run.queued/run.started/run.completed/run.failed/run.timeout/run.rejected`
  - 迭代事件：`agent.iteration.started/finished`
  - 模型事件：`model.request/model.response`
  - 工具事件：`tool.started/tool.finished`
  - 自动汇总 `RunDiagnostics`（总耗时、模型调用数、工具调用数、事件数、token、最慢步骤）
- SQLite 持久化增强：
  - `run_events.data_json` 从仅存 `data` 改为存完整事件扩展字段。
  - 读取时兼容旧结构（只有 `data`）和新结构（含 trace/span 等）。
- Repo Analyst 返回新增 `diagnostics` 字段透传。

### 为什么要这样改
- 目标是“本地可定位问题”，不是先上完整 OTel。
- 必须保证存储层能保存扩展事件，否则前端无法复盘。
- 保留旧 `type` 字段以兼容已有代码与历史数据。

### 这次修改解决什么问题
- 从“事件可看”提升到“链路可诊断”。
- 失败/慢点能直接映射到模型、工具或运行控制阶段。

---

## 步骤 3：前端诊断摘要与时间线

### 代码修改记录
- 修改文件：
  - `src/code_review_agent/web/index.html`

### 具体改了什么
- i18n 新增：
  - `diagnostics`
  - `timeline`
  - `total_duration`
  - `model_calls`
  - `tool_calls`
  - `event_count`
  - `token_usage`
  - `slowest_steps`
  - `no_diagnostics`
- 新增辅助函数：
  - `durationText()`
  - `eventTypeText()`
- 详情页新增区块：
  - 运行诊断摘要（模型/工具调用数、总耗时、token、最慢步骤）
  - 执行时间线（event_type + timestamp + duration）
- 原“运行事件”区块保留，但输出结构升级：
  - status/duration/failure_reason/payload/trace_id/span_id/parent_span_id

### 为什么要这样改
- 先看摘要，再看时间线，最后看原始事件，定位速度更快。

### 这次修改解决什么问题
- 之前必须手工读 raw JSON 才能判断卡在哪里；现在可直接定位关键步骤。

---

## 步骤 4：测试与验证

### 调试/测试记录
- 运行命令：
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest tests/test_runtime.py tests/test_api.py tests/test_repo_analyst.py tests/test_sqlite_store.py`
  - `$env:PYTHONPATH='src'; conda run -n dl python -m pytest`
  - `$env:PYTHONPATH='src'; conda run -n dl python -m compileall src tests`
- 观察现象：
  - 定向测试：`30 passed`
  - 全量测试：`73 passed`
  - 编译检查通过
  - FastAPI `on_event` deprecation warning 仍存在
- 问题判断：
  - 本次改造未引入回归，核心功能和回包结构都正常。
  - warning 属于既有技术债，不影响当前功能正确性。
- 接下来准备怎么改：
  - 后续单独做 lifespan 迁移，去掉 `on_event` 弃用告警。

---

## 方案调整记录

- 原方案：
  - 继续使用粗粒度 `status_change/model_response/tool_call`。
- 放弃原因：
  - 无法表达 request/response 边界、迭代边界、trace/span 关系。
- 新方案：
  - 保留旧 `type` 兼容字段，同时增加结构化 `event_type/payload/trace/span/duration/status`。
- 新旧方案区别：
  - 新方案可直接支持诊断摘要、前端时间线和后续 SSE/OTel。

---

## 阶段总结

- 已完成内容：
  - 统一事件模型与结构化日志。
  - runtime/agent 埋点接通。
  - 运行诊断摘要（含最慢步骤）。
  - Repo Analyst 透传诊断字段。
  - 前端新增诊断与时间线视图。
  - 全量测试通过（`73 passed`）。

- 遗留问题：
  - FastAPI `on_event` deprecation warning。
  - 目前是“运行后可观测”，尚未做实时流式事件推送。

- 后续建议：
  1. 先迁移 FastAPI lifecycle 到 lifespan。
  2. 再做 SSE 事件推送，把当前事件模型实时化。
  3. 然后评估是否接入 OTel（不破坏现有事件协议）。
