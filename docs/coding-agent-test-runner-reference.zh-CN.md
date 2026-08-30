# Coding Agent Runner 说明（简化版）

本文替代旧版 SWE-bench/DSH/Claude Code Runner-Grader 复杂设计。当前目标是观察 Agent 的实际工作能力，不构建额外的判分协议。

## 实际入口

`scripts/eval-mvp/run-agent-task.ts` 创建临时 API、Session 和独立 workspace，发送任务原文及固定的 workspace 边界说明，使用 `workspace-full-access` 自动批准当前 workspace 内的操作，等待 Agent turn 结束，并保存：

- `events.jsonl`：完整会话事件；
- `agent.diff`：工作区代码差异；
- `git-status.json`：结束时文件状态；
- `result.json`：provider/model、turn 状态、耗时和工具调用数。

`scripts/eval-mvp/run-pilot.ps1` 串行调用上述单任务入口，保存每条任务日志并生成 `summary.json`/`summary.md`。它不调用 Grader，也不等待隐藏测试确认。

## 运行约定

- workspace 外的数据集目录与任务之间严格隔离；
- 使用当前机器 base 环境，依赖由 Agent 按需安装；
- 不设置评测专用 `maxSteps`、任务超时、命令白名单或统一测试命令；
- 验证时使用每个仓库自己的测试入口；
- 结果由评测人员根据 diff、Agent 最终说明和原生测试输出记录。

## 历史参考

旧版 Grader、hidden patch、scope audit 和 SWE-bench clean-copy 流程已从运行入口移除。相关开发日志仅用于追溯历史，不得作为当前评测的执行步骤。
