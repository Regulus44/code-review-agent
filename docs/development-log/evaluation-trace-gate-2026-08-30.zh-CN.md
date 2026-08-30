# Coding Agent 评测轨迹门禁实施日志

日期：2026-08-30  
相关方案：[`coding-agent-simple-evaluation-plan.zh-CN.md`](../coding-agent-simple-evaluation-plan.zh-CN.md)、[`workspace-command-guard-plan.zh-CN.md`](../workspace-command-guard-plan.zh-CN.md)

## 目标

在不恢复独立 Grader、不增加 Agent step/超时限制、不改变 `workspace-full-access` 使用方式的前提下，保证每次评测都留下可复核的 Agent 执行轨迹，并能从轨迹中判断 workspace 越界是否被拦截。

## 实现内容

### 轨迹判定入口

新增 `scripts/eval-mvp/trace-gate.ts`，导出 `validateTrace()`。该模块只读取已经持久化的事件，不启动命令、不执行仓库测试，也不修改 workspace。

检查项目：

1. 事件序号从 1 开始并连续；
2. `tool/call` 与 `tool/result` 一一配对，检测重复、孤立和未完成调用；
3. `session/created` 与工具事件的 `workspaceRoot` 必须等于当前任务 workspace；
4. 所有事件的 `sessionId` 必须属于当前任务 Session；
5. 已结束 turn 必须包含 `turn/ended`；
6. 对命令、终端和常见文件工具输入复用 `WorkspaceCommandGuard`，区分已拦截外部引用和未拦截外部引用。

判定结果包括：

- `status`：`complete`、`partial` 或 `missing`；
- `boundaryStatus`：`clean`、`blocked`、`contaminated` 或 `unknown`；
- 调用/结果数量、缺失 ID、Guard 拒绝原因、越界参数和问题代码。

### 单任务入口

修改 `scripts/eval-mvp/run-agent-task.ts`：

- 在 `finally` 中从 SQLite 事件存储导出 `events.jsonl`，覆盖 Agent 成功、失败和异常路径；
- 调用 `validateTrace()` 并写入 `trace.json`；
- 在 `result.json` 增加 `traceStatus`、`boundaryStatus`、`evaluationStatus` 和 `trace` 明细；
- 轨迹导出失败或报告写入失败也会被记录，不静默当作正常运行。

### 批量入口

修改 `scripts/eval-mvp/run-pilot.ps1`：

- 每条任务读取轨迹门禁结果；
- 汇总无效轨迹、污染运行和已拦截越界次数；
- `traceStatus` 不是 `complete` 时记为 `invalid_trace`；
- `boundaryStatus=contaminated` 时记为 `contaminated`；
- 批次仍不调用、不等待独立 Grader，只在证据不完整或污染时以非零状态结束，提醒评测人员复核。

## 产物约定

每个运行目录必须包含：

- `events.jsonl`：原始事件流；
- `trace.json`：轨迹门禁报告；
- `result.json`：运行状态和门禁摘要；
- `agent.diff`、`git-status.json`：代码结果和文件范围。

其中，`invalid_trace` 和 `contaminated` 不能计入 Agent 能力解决率；`blocked` 只表示越界尝试已被 Guard 拦截，不代表代码任务失败。

## 验证记录

### 自动化测试

```text
pnpm exec vitest run scripts/eval-mvp/trace-gate.test.ts
6 tests passed

pnpm test
全部 workspace 测试通过

pnpm typecheck
通过

git diff --check
通过
```

轨迹门禁单测覆盖：正常完整轨迹、已拦截外部命令、未拦截外部命令、序号/调用不完整、空导出和跨 Session 事件。

### 真实 smoke

使用 Echo provider 执行 `pallets__flask-4045`，结果目录位于仓库外：

`D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01\results\trace-gate-smoke-0830\pallets__flask-4045\trace-20260830071636601`

观测结果：

- 事件数：107；
- `traceStatus=complete`；
- `boundaryStatus=clean`；
- `sequence` 为 1～107 连续；
- 该 Echo smoke 未产生工具调用和代码差异，属于轨迹导出链路验证，不作为 Agent 修复能力成绩。

## 当前边界

轨迹门禁可以证明“已记录的工具调用是否完整，以及显式外部路径是否被 Guard 拦截”，不能证明 workspace 内任意恶意程序的运行时行为，也不是操作系统级隔离。当前方案继续以 Prompt、`WorkspaceCommandGuard` 和事后轨迹审计应对正常 Agent 的误操作风险。

## 后续使用

后续 Easy/Medium 批次沿用同一入口。查看批次结果时先检查 `traceStatus` 和 `boundaryStatus`，再根据 `agent.diff`、Agent 最终说明和仓库原生测试判断 `solved`/`unsolved`/`environment_blocked`/`interrupted`。
