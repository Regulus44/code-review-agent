# Coding Agent Runner 说明（历史兼容）

本文保留旧 Runner 入口和产物说明，仅用于历史追溯和兼容旧链接，不是当前正式评测操作指南。当前正式流程以 [正常 Web Agent 评测执行基线](normal-web-agent-evaluation-baseline-2026-08-30.zh-CN.md) 为准：通过日常 Web Agent 会话执行，并通过前端和同一会话事件流观察，不使用 Runner 或外部 shell 轮询。

当前正式流程不应调用下列脚本：

- `../../scripts/eval-mvp/run-agent-task.ts`
- `../../scripts/eval-mvp/run-pilot.ps1`

## 实际入口

`../../scripts/eval-mvp/run-agent-task.ts` 创建临时 API、Session 和独立 workspace，发送任务原文及固定的 workspace 边界说明，使用 `workspace-full-access` 自动批准当前 workspace 内的操作，等待 Agent turn 结束，并保存：

- `events.jsonl`：完整会话事件；
- `trace.json`：事件连续性、工具调用配对和 workspace 边界门禁结果；
- `agent.diff`：工作区代码差异；
- `git-status.json`：结束时文件状态；
- `result.json`：provider/model、turn 状态、耗时、工具调用数以及 `traceStatus`、`boundaryStatus`、`evaluationStatus`。

`../../scripts/eval-mvp/run-pilot.ps1` 串行调用上述单任务入口，保存每条任务日志并生成 `summary.json`/`summary.md`。它不调用 Grader，也不等待隐藏测试确认。

评测 Prompt 的固定模板位于 `../../scripts/eval-mvp/evaluation-prompt.ts`。模板正文、权限语义和防污染规则固定不变；每条任务只替换任务描述和当前 workspace 绝对路径，避免不同批次因提示词漂移产生不可比结果。

Windows 进程均以隐藏窗口方式启动：前台命令、PowerShell、Terminal、后台 Job 和 Code Mode 使用 `windowsHide: true`，批量 Runner 使用 `UseShellExecute=false` 与 `CreateNoWindow=true`。这只控制窗口显示，不改变 Agent 的命令权限或执行结果。

## 运行约定

- workspace 外的数据集目录与任务之间严格隔离；
- 使用当前机器 base 环境，依赖由 Agent 按需安装；
- 不设置评测专用 `maxSteps`、任务超时、命令白名单或统一测试命令；
- 验证时使用每个仓库自己的测试入口；
- 结果由评测人员根据 diff、Agent 最终说明和原生测试输出记录；
- `traceStatus` 不是 Agent 能力分数，但 `partial/missing` 轨迹不能作为有效评测证据；`boundaryStatus=contaminated` 的运行必须单独剔除。

## 历史参考

旧版 Grader、hidden patch、scope audit 和 SWE-bench clean-copy 流程已从运行入口移除。相关开发日志仅用于追溯历史，不得作为当前评测的执行步骤。
