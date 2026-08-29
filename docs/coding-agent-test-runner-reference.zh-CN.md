# Coding Agent 测试 Runner 调研与实施指导

本文根据 SWE-bench、当前项目 DSH（Session/Event/Replay）实现以及 Claude Code 的本地行为研究，整理 Coding Agent 测试 Runner、数据集和 Grader 的实施参考。

本文的目标不是复制任何上游项目，而是提取可验证的工程模式，形成适合当前 Coding Agent 的测试基础设施方案。

> 实施优先级：第一阶段以 [`coding-agent-bench-mvp.zh-CN.md`](coding-agent-bench-mvp.zh-CN.md) 为准。本文是完整参考和后续扩展设计，不要求在 MVP 阶段一次性实现全部模块。

## 1. 结论摘要

三个参考来源分别解决不同问题：

| 来源 | 主要参考内容 | 在本项目中的角色 |
|---|---|---|
| SWE-bench | 任务格式、固定 commit、隔离 workspace、patch/hidden test、测试判分、运行报告 | E2E 任务 Runner 和 Grader 骨架 |
| DSH | Session/Turn/Step、事件存储、SSE replay、projection、恢复和审计 | Runner 的轨迹采集和过程指标层 |
| Claude Code | 权限边界、读写行为、工具失败恢复、长会话和上下文生命周期 | Agent 行为测试和安全约束来源 |

推荐的最终结构为：

```text
任务加载
→ workspace 准备
→ 通过当前 API 启动 Agent
→ 采集完整事件和 diff
→ 在干净副本中执行 hidden grader
→ 生成任务级和批次级报告
```

SWE-bench 的 Docker Harness 不应在第一版原样搬入。原因不仅是规模和资源成本，还包括评测契约不同：SWE-bench 主要接收模型生成的 patch，而当前项目需要验证 Session、ToolRuntime、permission、SSE、恢复和事件一致性。

## 2. 调研范围和来源快照

### 2.1 当前项目

仓库：`D:/Develop/code-review-agent`

关键入口：

- `packages/runtime/src/index.ts`
  - `AgentHost`
  - `createSession()`
  - `waitForTurn()`
  - `runSteps()`
  - turn/step、恢复和上下文事件追加
- `packages/contracts/src/index.ts`
  - `AgentEvent`
  - `SessionEventStore`
  - Session/Turn/Tool/Permission/Stats 公共类型
- `packages/storage/src/index.ts`
  - `InMemoryEventStore`
  - `SqliteEventStore`
  - `replayProjection()`
- `packages/tools/src/runtime.ts`
  - `ToolRuntime`
  - 工具执行、权限请求、取消、结果截断和审计事件
- `docs/event-contract.md`
  - 事件 envelope、sequence、tool/permission 配对、SSE replay 规则
- `docs/tool-contract.md`
  - workspace、permission 和工具执行约束

### 2.2 SWE-bench 快照

外部快照：

`D:/Develop/coding-agent-test/sources/upstream/swebench-repo-extract/SWE-bench-main`

关键代码和文档：

- `docs/guides/datasets.md`：数据集字段和变体
- `docs/guides/evaluation.md`：评测流程、预测格式和结果解释
- `docs/reference/harness.md`：Docker Harness、缓存、日志和并发参数
- `swebench/harness/run_evaluation.py`
  - `create_container()`
  - `run_instance()`
  - `run_instances()`
  - Docker 生命周期、patch 应用、测试执行和超时
- `swebench/harness/utils.py`
  - `load_swebench_dataset()`
  - `get_predictions_from_file()`
  - `make_test_spec()`
  - `run_threadpool()`
  - `FAIL_TO_PASS` / `PASS_TO_PASS` 解析
- `swebench/harness/grading.py`
  - 测试输出解析和 resolved 判断
- `swebench/harness/reporting.py`
  - `make_run_report()`
  - 任务分类、基础设施失败和批次汇总
- `swebench/collect/build_dataset.py`
- `swebench/collect/get_tasks_pipeline.py`
  - issue/PR 到任务实例的构建流程

当前 10 条试点数据集位于：

`D:/Develop/coding-agent-test/datasets/swebench-lite/pilot-01`

其中：

- `public/manifest.json` 和 `public/tasks/*/task.json` 是 Agent 可用的任务元数据；
- `private/source/selected-rows.json` 保存源数据选择结果；
- `private/test-patches/` 保存 hidden test patch；
- `private/gold-patches/` 保存标准修复 patch；
- `runtime/workspaces/` 保存物化后的任务 workspace；
- `results/` 保存评测结果。

这些目录必须继续与仓库隔离。

### 2.3 Claude Code 快照和研究资料

当前仓库保存的是行为级调研和适配记录，不把 Claude Code 的闭源实现编译进 Runner。

主要参考：

- `docs/claude-code-context-management-research.zh-CN.md`
- `docs/claude-code-context-m01-implementation.zh-CN.md` 至 `m14`
- `docs/system-prompt-design.zh-CN.md`
- `docs/tool-contract.md`

研究中记录的本地快照入口包括：

- `D:/Develop/claude-code/src/query.ts`
- `D:/Develop/claude-code/src/services/compact/`
- `D:/Develop/claude-code/src/utils/messages.ts`
- `D:/Develop/claude-code/src/services/tokenEstimation.ts`
- `D:/Develop/claude-code/src/services/SessionMemory/`
- `D:/Develop/claude-code/src/memdir/`

这些路径仅作为行为和边界参考，具体复用必须先确认许可证和版本。

## 3. SWE-bench：任务和 Grader 的参考

### 3.1 数据模型

SWE-bench 任务的核心字段包括：

```json
{
  "instance_id": "owner__repo-issue",
  "repo": "owner/repo",
  "base_commit": "commit hash",
  "problem_statement": "issue text",
  "patch": "gold patch",
  "test_patch": "hidden test patch",
  "FAIL_TO_PASS": "tests expected to start passing",
  "PASS_TO_PASS": "tests that must remain passing",
  "eval_script": "test command script"
}
```

其中 `patch` 和 `test_patch` 不应暴露给被测 Agent。`FAIL_TO_PASS` 用于验证问题是否解决，`PASS_TO_PASS` 用于检测回归。

当前项目对外任务格式已经做了脱敏和命名适配，例如使用 `baseCommit`、`problemStatement`、`failToPass`、`passToPass` 和 `graderMode`。

### 3.2 Harness 执行顺序

`run_evaluation.py` 展示了典型的任务级流程：

1. 根据任务找到测试环境；
2. 创建独立容器；
3. 应用预测 patch；
4. 写入评测脚本；
5. 运行测试并记录 stdout/stderr；
6. 解析测试结果；
7. 生成 `report.json`；
8. 汇总所有实例的 resolved/unresolved/error/infra failure。

对当前项目应改写为：

```text
固定 baseCommit
→ 创建一次性 Agent workspace
→ 通过 /v1/sessions 启动 Agent
→ 采集事件和最终 diff
→ 在 clean copy 应用 Agent diff
→ 应用 private test patch
→ 执行 failToPass/passToPass/build
→ 生成 result.json
```

### 3.3 值得直接借鉴的设计

- 每个任务使用固定 `baseCommit`，避免任务环境漂移；
- 一个任务对应一个 workspace、日志目录和结果文件；
- Runner 和 Grader 分离；
- 任务级报告和整批报告分离；
- 通过 `runId + taskId + agentVersion` 标识一次运行；
- 缓存键必须包含 Agent diff 或 diff hash，不能只使用任务 ID；
- 明确区分 patch 应用失败、测试失败、超时和基础设施失败；
- 支持 `maxWorkers`，但并发应受 CPU、内存和依赖环境约束。

### 3.4 不应直接复制的部分

- Docker 镜像分层和大规模镜像缓存；
- 只接收 `model_patch` 的预测接口；
- 直接将完整测试脚本和结果目录放进 Agent 容器可见范围；
- 把测试失败简单归类为模型失败；
- 使用 `run_id + instance_id` 作为唯一缓存键而忽略输入 diff。

第一版 10 条任务可以使用预先物化的 workspace。Runner 稳定后，再增加容器化以解决环境一致性问题。

### 3.5 SWE-bench 的数据制作入口

如果后续扩充试点集，优先从以下入口追溯数据，而不是手工复制 issue 文本或测试命令：

| 数据制作入口 | 作用 | 本项目使用规则 |
|---|---|---|
| `D:/Develop/coding-agent-test/sources/upstream/swebench-repo-extract/SWE-bench-main/docs/guides/datasets.md` | 数据集变体、字段定义和 Hugging Face 载入方式 | 记录数据集名称、split、版本和字段映射 |
| `D:/Develop/coding-agent-test/sources/upstream/swebench-repo-extract/SWE-bench-main/swebench/collect/get_tasks_pipeline.py` | 从 issue/PR 收集任务实例 | 新任务必须保留来源 URL、base commit 和生成时间 |
| `D:/Develop/coding-agent-test/sources/upstream/swebench-repo-extract/SWE-bench-main/swebench/collect/build_dataset.py` | 构建任务数据集和测试规格 | 生成任务时保留 `patch`、`test_patch`、`FAIL_TO_PASS`、`PASS_TO_PASS` 的 private 副本 |
| `D:/Develop/coding-agent-test/sources/upstream/swebench-repo-extract/SWE-bench-main/swebench/harness/utils.py:load_swebench_dataset()` | 从 HF、JSON、JSONL 或 Parquet 载入并筛选实例 | 先固定完整来源，再按明确规则选择 10/30/50 条 |
| `D:/Develop/coding-agent-test/tools/prepare-swebench-task.ps1` | 当前外部目录中的 workspace 物化脚本 | 只输出到 `D:/Develop/coding-agent-test/datasets/.../runtime/workspaces` |
| `D:/Develop/coding-agent-test/tools/validate-swebench-pilot.ps1` | public/private 隔离和试点完整性检查 | 每次改任务后先运行校验，再允许 Runner 使用 |

数据制作必须遵循“来源行 → 脱敏 public task → private grader artifact → 可物化 workspace”的单向流程。不得从已经运行过的结果反向修改 public prompt，也不得把 gold patch 或 hidden test 作为 Agent 上下文的一部分。

## 4. DSH：事件、轨迹和恢复的参考

### 4.1 事件是 Runner 的事实来源

当前项目的事件契约规定：

- `sequence` 在 Session 内严格单调递增；
- 事件先持久化，再推送 SSE；
- `tool/call` 必须与 `tool/result` 通过 `toolCallId` 关联；
- 需要审批的动作必须有 `permission/requested` 和 `permission/resolved`；
- `turn/started`、`step/started`、`step/ended`、`turn/ended` 构成执行边界；
- `traceId` 用于 turn、错误和恢复之间的关联；
- SSE 支持 `after_sequence` replay；
- projection 由事件回放产生，不能由 Runner 自行猜测状态。

因此 Runner 不应只保存最终 diff。至少还要保存完整事件流，才能回答：

- Agent 是否先读取再修改；
- 是否发生 permission 等待；
- 哪个工具失败、是否重试；
- 是否在修改后运行测试；
- turn 是 completed、failed、stopped 还是超时；
- 重启或断线后是否正确恢复。

### 4.2 代码入口和 Runner 对接点

| Runner 需求 | 当前项目入口 |
|---|---|
| 创建 Session | `AgentHost.createSession()` / `POST /v1/sessions` |
| 提交任务 | Session turn/message API |
| 等待结束 | `AgentHost.waitForTurn()` |
| 采集事件 | `GET /v1/sessions/{sessionId}/events` |
| 读取投影 | `SessionEventStore.project()` |
| 事件回放 | `replayProjection()` |
| 工具和权限审计 | `ToolRuntime` + `tool/*` / `permission/*` |
| 恢复验证 | `agent/status`、`agent/error`、`turn/ended` 和相关 recovery 事件 |

### 4.3 DSH 对过程指标的贡献

推荐从事件计算以下指标：

| 指标 | 事件判定方式 |
|---|---|
| Inspect-before-write | 首个写工具调用前存在 `read_file`、`glob`、`grep` 或等价只读调用 |
| Verify-after-write | 最后一次写调用后存在测试、构建、诊断或等价验证调用 |
| Recovery rate | 首次 `tool/result=failed` 或测试失败后仍继续，并最终通过 Grader |
| Permission correctness | 请求、等待、批准/拒绝、终态结果完整配对 |
| Event correctness | sequence 单调、tool pair 完整、turn 状态闭合 |
| Tool efficiency | 工具调用数量、重复调用率、单步耗时、总耗时 |

DSH 不负责判断代码是否正确。代码正确性仍由 clean Grader 和测试命令决定。

### 4.4 DSH 的具体代码入口

以下入口是“为什么 Runner 要保存完整事件、支持 replay、并把统计从历史窗口中分离出来”的直接依据：

| DSH 入口 | 可观察行为 | Runner 中的对应验证 |
|---|---|---|
| `D:/Develop/deepseek-harness-fork/packages/session/session-projection/src/index.ts` | Projection registry、snapshot/restore、state version | 同一事件流重放后，Session/Turn/Tool 投影与运行中快照一致 |
| `D:/Develop/deepseek-harness-fork/packages/session/session-projection-cache/src/index.ts` | checkpoint、revision 校验、tail replay | SSE 断线后从 `after_sequence` 补发，不重复或倒退事件 |
| `D:/Develop/deepseek-harness-fork/packages/session/session-stats/src/index.ts` | 全日志 turns、steps、timing、tokens 统计 | P50/P90、step/tool 数和耗时不受 history 分页影响 |
| `D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api-proxy.ts` | history tail 与 projection baseline/推送 | Runner 同时保存事件原文和 projection baseline |
| `D:/Develop/deepseek-harness-fork/apps/web/tests/stats-paged-history.e2e.ts` | 分页前后 stats 不变的 E2E 验收 | 增加 history prepend/replay 不改变统计的回归测试 |
| `D:/Develop/deepseek-harness-fork/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx` | 稳定 Session shell、scroll body、Composer seat | 长任务或 Trajectory 展示不应销毁 Session 事件/状态边界 |

DSH 入口给出的不是“代码是否修复”的答案，而是 Runner 的观测和回放约束。它们应进入 `event-collector.ts`、`event-metrics.ts` 和 replay fixture 的测试依据。

## 5. Claude Code：Agent 行为和边界的参考

### 5.1 可转化为测试的行为

Claude Code 研究资料中最适合转化为 Runner 断言的不是具体 UI，而是行为不变量：

| 行为面 | 测试要求 |
|---|---|
| workspace 边界 | 工具只能访问当前 workspace 和显式允许的路径 |
| 读写顺序 | 修改前应检索或读取相关上下文 |
| 修改后验证 | 编辑后应运行相关测试、构建或诊断 |
| 权限 | 高风险命令必须请求权限；deny 后不能偷偷执行 |
| 失败恢复 | 工具失败、命令失败或 provider 错误后按策略重试或总结失败 |
| 取消和暂停 | 取消后不应继续产生新的副作用；等待用户时状态可恢复 |
| 长任务 | 多 turn、压缩和恢复不能破坏 tool pair、permission 或 pending turn |
| 上下文安全 | 摘要/compact agent 不应获得普通写入工具权限 |

### 5.2 对 Runner 的具体影响

Runner 应保存并检查：

- permission 请求和 resolution 的完整链路；
- workspace 根目录和所有变更文件；
- 工具调用输入的路径、命令和 bounded 参数；
- 测试失败后的后续 turn/step；
- cancel、timeout、restart 后的 terminal 状态；
- context compact/recovery 的 receipt，而不是只看最终文本。

### 5.3 复用边界

Claude Code 的本地快照应登记为 `behavior-reference`。不要复制未确认许可的源码，也不要仅凭目录名称宣称某个能力已经实现。当前项目仍以自己的 EventStore、ToolRuntime、Permission 和 workspace contract 为事实来源。

### 5.4 Claude Code 的具体代码入口

| Claude Code 入口 | 参考行为 | 当前项目测试映射 |
|---|---|---|
| `D:/Develop/claude-code/src/query.ts:584-888` | 请求前的 query loop、snip/microcompact/autocompact 和 blocking/predictive gate | 验证每个 turn 的 step 顺序，以及请求前 context gate 是否可观测 |
| `D:/Develop/claude-code/src/query.ts:1349-1470` | prompt-too-long/413 的 reactive recovery、有限重试和失败暴露 | 构造 provider 错误 fixture，验证 recovery 不递归、不重复副作用 |
| `D:/Develop/claude-code/src/services/compact/autoCompact.ts:270-380` | 自动 compact、连续失败熔断和成功清零 | 验证单 turn retry 上限和 circuit breaker |
| `D:/Develop/claude-code/src/services/compact/compact.ts:1159-1450` | summary agent 的工具边界和摘要请求重试 | 验证 context summary purpose 不得调用 Bash/Edit/MCP |
| `D:/Develop/claude-code/src/utils/messages.ts:2292-2670` | API 消息规范化 | 验证发送给 provider 的消息与 EventStore transcript 分离 |
| `D:/Develop/claude-code/src/utils/messages.ts:5591-5947` | tool call/result pairing 修复 | 验证 orphan tool、缺失 result 和 streaming 边界的处理策略 |
| `D:/Develop/claude-code/src/services/sessionTranscript/`、`src/utils/sessionRestore.ts` | transcript 持久化、boundary 和 resume | 验证重启、SSE replay、重复恢复后的 model view 稳定性 |
| `D:/Develop/claude-code/src/components/TokenWarning.tsx`、`src/utils/analyzeContext.ts` | context diagnostics 和用户可见的预算状态 | 验证报告中的 context/recovery 指标来自 durable projection，而不是前端猜测 |

这些入口只能证明“应测试什么行为”，不能证明当前项目已经拥有同样实现；每项行为必须在本项目对应的 unit、contract、replay 或 E2E 测试中重新验收。

## 6. 当前项目推荐的混合 Runner

### 6.1 模块划分

建议新增 `packages/evals`，实际数据继续放在 `D:/Develop/coding-agent-test`：

```text
packages/evals/src/
  task-loader.ts        # 读取并校验 public manifest
  workspace-manager.ts  # 准备、清理和归档 workspace
  agent-runner.ts       # API 驱动 Session/turn
  event-collector.ts    # SSE/replay 和事件落盘
  diff-collector.ts     # git status/diff 和范围检查
  permission-broker.ts  # 按任务策略批准、拒绝或等待
  grader.ts             # clean copy + hidden tests
  event-metrics.ts      # 过程指标
  report.ts             # result.json 和 summary.json
```

### 6.2 单任务生命周期

```text
created
→ provisioning
→ ready
→ running
→ waiting_permission（可选）
→ turn_ended
→ collecting
→ grading
→ passed / failed / timeout / infra_error / security_violation
```

每个阶段都应记录开始时间、结束时间、错误分类和相关事件 sequence。

### 6.3 外部运行目录

```text
D:/Develop/coding-agent-test/runs/<run-id>/<task-id>/
  workspace/       # Agent 唯一可写目录
  events.jsonl     # 完整事件流
  agent.diff       # 最终 git diff
  git-status.json  # 变更范围快照
  grader.log       # hidden grader 输出
  result.json      # 单任务结果
```

Agent 进程的 cwd、workspace root 和允许路径都必须指向 `workspace/`。Agent 不应获得 `public/manifest.json`、`private/`、其他任务 workspace 或 `runs/` 根目录的读取权限。


### 6.4 Grader 顺序

Grader 必须在 Agent workspace 外的临时 clean copy 中运行：

```text
baseCommit
→ 应用 Agent diff
→ 应用 hidden test patch
→ 运行 failToPass
→ 运行 passToPass
→ 运行 build/typecheck/lint（如任务声明）
→ 检查禁止路径和安全违规
```

Grader 不应直接信任 Agent workspace 中的测试结果，因为 Agent 可能修改测试、生成本地文件或改变依赖。

## 7. 建议的数据和结果契约

### 7.1 任务元数据

```json
{
  "id": "pallets__flask-4045",
  "source": "SWE-bench/SWE-bench_Lite",
  "datasetVersion": "pilot-01",
  "repo": "pallets/flask",
  "baseCommit": "d8c37f...",
  "problemStatement": "...",
  "language": "python",
  "permissionPreset": "workspace-write",
  "timeoutMs": 600000,
  "allowedPaths": ["src/**", "tests/**"],
  "forbiddenPaths": ["grader/**", "hidden/**"],
  "failToPass": ["tests/test_x.py::test_y"],
  "passToPass": ["tests/test_basic.py::test_z"],
  "graderMode": "swebench_test_patch"
}
```

### 7.2 单任务结果

```json
{
  "schemaVersion": 1,
  "runId": "2026-08-26T120000Z-agent-v1",
  "taskId": "pallets__flask-4045",
  "datasetVersion": "pilot-01",
  "agentVersion": "git-sha",
  "modelConfigHash": "sha256:...",
  "status": "passed",
  "timing": {
    "provisionMs": 0,
    "agentMs": 0,
    "gradingMs": 0,
    "totalMs": 0
  },
  "events": {
    "path": "events.jsonl",
    "count": 0,
    "lastSequence": 0
  },
  "diff": {
    "path": "agent.diff",
    "changedFiles": [],
    "scopeViolation": false
  },
  "grader": {
    "failToPass": "passed",
    "passToPass": "passed",
    "build": "not_run",
    "exitCode": 0
  },
  "processMetrics": {
    "inspectBeforeWrite": true,
    "verifyAfterWrite": true,
    "recoveredAfterFailure": false,
    "permissionCorrect": true
  },
  "violations": []
}
```

### 7.3 失败分类

至少区分：

- `agent_failed`：Agent turn 失败、工具链失败或未完成任务；
- `grader_failed`：判分器自身异常；
- `test_failed`：测试运行完成但结果不通过；
- `infra_error`：依赖、workspace、进程、容器或网络环境问题；
- `timeout`：超过任务或测试 deadline；
- `security_violation`：越权访问、修改 hidden grader、删除测试或泄露敏感信息。

`security_violation` 是硬门槛，即使测试通过也应判定任务失败。

## 8. 指标和实验设计

### 8.1 主指标

```text
Resolved@1 = 一次运行完整通过的任务数 / 任务总数
```

完整通过必须同时满足：

- `failToPass` 全部通过；
- `passToPass` 没有回归；
- 声明的 build/typecheck/lint 通过；
- 没有安全违规和越权修改；
- Agent 正常结束 turn。

### 8.2 过程指标

建议保留：

- Inspect-before-write；
- Verify-after-write；
- Recovery rate；
- Permission correctness；
- Scope discipline；
- Event correctness；
- P50/P90 总耗时、step 数和工具调用数；
- 测试失败、权限失败、环境失败的分类占比。

可以使用以下综合分作为内部排序工具，但不替代主指标：

```text
AgentScore = 0.7 × Resolved@1 + 0.3 × ProcessScore
```

10 条任务中每条任务代表 10 个百分点，因此试点阶段应优先查看任务级轨迹和失败分类，不要过度解读总分。

### 8.3 两条测试轨道

为了尽量隔离模型因素，Runner 应同时支持：

1. `Agent Core Track`
   - 使用 scripted model 或录制的模型响应；
   - 固定工具调用序列；
   - 重点测试 Runtime、ToolRuntime、permission、取消、恢复和事件。

2. `Agent E2E Track`
   - 使用固定模型、参数、任务和权限策略；
   - 运行真实 Session/API 链路；
   - 记录端到端解决率，但明确其仍包含模型因素。

## 9. 10 条试点的实施顺序

### 阶段 A：先验证 Grader

- 使用 gold patch 运行每条任务；
- 确认 `failToPass` 能从失败变为通过；
- 确认 `passToPass` 能检测回归；
- 确认隐藏测试不在 Agent 可见目录；
- 确认错误可以区分测试失败和环境失败。

### 阶段 B：接入 Agent API

- Runner 创建 Session；
- 发送 `problemStatement`；
- 订阅 SSE 事件并落盘；
- 处理 allowlisted permission；
- 等待 `turn/ended` 或 timeout；
- 采集最终 diff。

### 阶段 C：接入过程评分

- 从事件计算读写顺序、验证、恢复和 permission 指标；
- 从 Git diff 检查允许路径和禁止路径；
- 检查 event sequence、tool pair 和 turn 状态闭合；
- 生成单任务 `result.json` 和批次 `summary.json`。

### 阶段 D：再考虑容器化

只有当本地 workspace Runner 已经稳定、且出现环境漂移或依赖冲突时，才引入 Docker。容器化时仍应保留当前 API 驱动和事件采集方式，不能退回成只接收 patch 的黑盒接口。

### 阶段 E：回归门禁和持续运行

- 用固定 `datasetVersion`、`agentVersion`、环境指纹和 `runId` 生成批次报告；
- 为 PR Smoke 运行少量稳定任务，为 Nightly Regression 运行完整试点集；
- 对新旧 Agent 版本使用相同任务、相同权限和相同环境做配对比较；
- 失败任务必须保留事件、diff、grader log 和错误分类，不能只保留一个总分。

## 9.4 实施阶段的证据矩阵

本节把前面的实施阶段分为三种证据等级，避免把设计推断误写成上游事实：

- `direct`：上游代码或文档中存在同名入口、字段或明确执行流程；
- `local-contract`：当前仓库已有的 Event、Runtime、Tool 或 API 契约；
- `adaptation`：将上游行为映射到当前项目后的工程决策，必须由本项目测试关闭。

### 来源快照

| 来源 | 快照位置 | 版本/识别信息 | 用途 |
|---|---|---|---|
| 当前 Coding Agent | `D:/Develop/code-review-agent` | 当前调研基线：`4aa55a6e06c15a392ca5b588c42fd9052a31ebc4` | 本项目实际 API、EventStore、ToolRuntime 和测试契约 |
| DSH | `D:/Develop/deepseek-harness-fork` | 本地快照 commit：`b1d511b88954cf4d2540d8355083ae947cf08b5f` | Projection、session stats、history/replay 和轨迹行为参考 |
| Claude Code | `D:/Develop/claude-code` | 本地快照 commit：`34b3dc99bf40c57c0b78f3b5b1d70471ebc2d06d` | query loop、compact/recovery、tool pairing 和行为边界参考 |
| SWE-bench | `D:/Develop/coding-agent-test/sources/upstream/swebench-repo-extract/SWE-bench-main` | 外部源码快照；以目录内文档和代码为准 | 任务字段、Harness、测试判分和报告参考 |

如果上游快照更新，必须新增版本记录，不得静默替换；任务结果中的 `datasetVersion`、Runner 变更说明和本表应同步更新。

### 阶段到入口的追溯表

| 实施阶段 | 上游/本地依据 | 具体入口 | 当前项目落点 | 关闭阶段的验收证据 |
|---|---|---|---|---|
| A. 先验证 Grader | `direct` SWE-bench | `swebench/harness/run_evaluation.py:run_instance()`；`swebench/harness/utils.py:make_test_spec()`；`swebench/harness/grading.py:get_eval_report()`；`swebench/harness/reporting.py:make_run_report()` | `packages/evals/grader.ts`；外部 `private/test-patches` 和 `private/gold-patches` | gold patch 全部通过；故意错误 patch 失败；`failToPass`/`passToPass`、build 和 scope 检查结果可复现 |
| B. 接入 Agent API | `local-contract` + `adaptation`；DSH 的事件事实来源；Claude Code `src/query.ts:584-888` 的 query loop | `AgentHost.createSession()`、`AgentHost.waitForTurn()`、`AgentHost.runSteps()`；`apps/api/src/server.ts:524`（创建 Session）、`:556`（事件页/SSE）、`:693`（resume）、`:700`（permission）、`:838`（cancel）、`:870` 附近（发送消息）；`POST /v1/sessions`；`POST/GET /v1/sessions/{id}`；`GET /v1/sessions/{id}/events` | `packages/evals/agent-runner.ts`、`event-collector.ts` | Agent 只能通过公开 API 运行；事件先落盘；SSE 断线后按 `after_sequence` replay，事件序列和最终 projection 一致 |
| C. 过程评分和安全 | `local-contract` + `adaptation`；DSH session stats；Claude Code tool/recovery 行为 | `docs/event-contract.md`；`packages/contracts/src/index.ts:reduceSessionStats()`；`packages/storage/src/index.ts:replayProjection()`；`packages/tools/src/runtime.ts:resolvePermission()`；Claude `src/query.ts:1349-1470`、`src/utils/messages.ts` tool pairing 入口 | `event-metrics.ts`、`permission-broker.ts`、`diff-collector.ts` | 自动计算 inspect/verify/recovery/permission/event correctness；越权路径、hidden 访问、测试删除和 secret 泄露触发硬失败 |
| D. 环境隔离和并发 | `direct` SWE-bench Harness；`local-contract` workspace 边界；Claude Code workspace/permission 行为参考 | `swebench/harness/run_evaluation.py:create_container()`、`run_instances()`；`docs/reference/harness.md` 的 `max_workers`、timeout、cache；本项目 `docs/tool-contract.md` | `workspace-manager.ts`；外部 `runtime/workspaces` 和 `runs/<run-id>` | Agent 看不到 `private/`、其他任务和仓库外未授权路径；相同输入重复运行结果一致；并发 1→2 不改变判分语义 |
| E. 报告和回归门禁 | `direct` SWE-bench reporting；DSH stats projection；Claude Code diagnostics 行为 | `make_run_report()`；DSH `packages/session/session-stats/src/index.ts`、`session-projection/src/index.ts`；Claude `src/components/TokenWarning.tsx`、`src/utils/analyzeContext.ts` | `report.ts`、`summary.json`、PR Smoke/Nightly job | 单任务结果和批次摘要可按 task/category/version 查询；P50/P90、Resolved@1、失败分类和安全违规率可复算 |

这里的关键边界是：SWE-bench 的 `run_instance()` 可以直接作为“任务级 Grader 流程”的依据；DSH 的 Projection/Stats 可以作为“事件和过程指标”的依据；Claude Code 的 query/recovery/tool pairing 可以作为“行为断言”的依据。三者映射到当前项目后，属于 `adaptation` 的部分必须由本项目自己的 contract、unit、replay 和 E2E 测试证明，不能仅凭参考路径视为已实现。

### 阶段退出条件和证据文件

每个阶段关闭时，Runner 应在外部运行目录写入一份 `stage-evidence.json`：

```json
{
  "stage": "B-agent-api",
  "datasetVersion": "pilot-01",
  "agentVersion": "git-sha",
  "sourceRefs": [
    "current:AgentHost.createSession",
    "current:AgentHost.waitForTurn",
    "current:docs/event-contract.md",
    "dsh:session-projection",
    "claude:src/query.ts:584-888"
  ],
  "checks": [
    { "name": "event_replay", "status": "passed", "artifact": "events-replay.json" },
    { "name": "turn_completion", "status": "passed", "artifact": "result.json" }
  ]
}
```

建议的最小退出条件：

| 阶段 | 必须通过的检查 |
|---|---|
| A | gold patch、negative patch、hidden test 隔离、clean-copy 判分 |
| B | API 驱动、完整事件、SSE replay、turn timeout/cancel |
| C | tool/permission 配对、读写顺序、验证动作、禁止路径和安全硬门槛 |
| D | workspace 隔离、重复运行、并发运行、环境错误分类 |
| E | 单任务/批次报告、版本主键、配对比较、PR Smoke/Nightly 可执行 |

## 9.5 防止任务和实现漂移的规则

后续每个 Runner、Grader 或数据集变更都必须回答以下问题，并把答案写入 PR 或 `stage-evidence.json`：

1. 该变更引用了哪个来源入口？是 `direct`、`local-contract` 还是 `adaptation`？
2. 它影响哪个固定阶段和哪个退出条件？
3. 是否改变了 public/private 隔离、workspace 边界或 hidden grader 可见性？
4. 是否改变了结果 schema、指标分母或失败分类？
5. 是否增加了一个可自动验证的测试或 replay fixture？

禁止以下做法：

- 只因为上游项目有某个目录或类名，就新增同名模块而没有行为测试；
- 只根据最终 patch 判断 Agent 成功，忽略事件、权限和安全轨迹；
- 为了让任务通过而修改 hidden test、删除原有测试或放宽路径策略；
- 更换数据集、依赖版本或模型配置后仍沿用旧的 `runId` 和报告；
- 把 Claude Code 的行为参考写成当前项目已经拥有的能力。

## 10. 验收标准

Runner 达到第一版可用状态，需要满足：

- 相同数据集、Agent 版本和环境可以重复运行；
- Agent 无法读取 hidden patch、gold patch 和其他任务目录；
- 每个任务有独立 workspace、事件、diff、grader log 和 result；
- Runner 通过公开 API 驱动 Session，不绕过 Runtime；
- Grader 在 clean copy 中执行；
- 能判定 `failToPass`、`passToPass`、构建和修改范围；
- 能区分 Agent、测试、Grader 和基础设施失败；
- 至少一个任务覆盖 permission 或失败恢复；
- 安全违规可以使任务直接失败；
- 批次报告包含任务级结果、类别统计、耗时和失败原因。

## 11. 许可和维护边界

- SWE-bench 的任务数据、仓库代码和测试 patch 需遵守其数据集及上游仓库许可；
- Claude Code 参考默认登记为行为参考，除非确认具体文件和版本的改编许可；
- 本仓库只保存 Runner 代码、测试契约和调研文档；
- hidden test、gold patch、任务 workspace 和运行结果继续保存在 `D:/Develop/coding-agent-test`；
- 每次数据集或 Runner 版本更新都要记录 `datasetVersion`、`agentVersion`、环境指纹和变更原因。

## 12. 推荐的后续实现任务

1. 在 `packages/evals` 建立任务加载和结果类型；
2. 实现外部 workspace manager；
3. 实现 API Session runner 和 SSE event collector；
4. 实现 clean-copy grader；
5. 用 gold patch 完成 Grader 自检；
6. 接入 10 条 SWE-bench Lite 试点；
7. 增加 5～10 条 Agent Core scripted tasks；
8. 建立 PR Smoke 和 Nightly Regression 两种运行模式。
