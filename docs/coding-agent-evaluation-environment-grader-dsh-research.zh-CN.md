# Coding Agent 评测实现调研（当前简化方案）

本文是旧版 DSH/Claude Code/SWE-bench Grader 调研的简化替代。那些项目仍可作为背景参考，但不再决定本仓库的运行协议。

## 当前仓库实现

| 功能 | 文件/入口 | 逻辑 |
|---|---|---|
| 单任务运行 | `scripts/eval-mvp/run-agent-task.ts` | 准备隔离 workspace，创建 API Session，授予 Full Access，发送任务，等待终态，保存事件、diff、Git 状态和结果 |
| 批量运行 | `scripts/eval-mvp/run-pilot.ps1` | 串行启动单任务入口，保存日志并汇总完成率 |
| 配置 | `apps/api/.data/provider-profiles.json`、`credentials.secrets.json`、`code-review-agent.sqlite` | 沿用日常 provider/model 配置 |
| 数据集 | `D:/Develop/coding-agent-test` | 仓库外保存任务、workspace 和运行结果 |

## 当前不再存在的组件

独立 `grade-agent-run.ps1`、`verify-grader.ps1`、hidden patch、clean-copy 判分和 scope-audit 入口已移除。批次结果不再等待 Grader 确认。

## DSH/Claude Code/SWE-bench 的保留借鉴

- DSH：事件流和会话状态便于观察 Agent 过程；本仓库只保存原始事件，不引入 DSH 的统计/回放协议。
- Claude Code：工具调用、编辑、测试等行为可用于人工分析；本仓库保持真实会话，不注入额外预算提示。
- SWE-bench：任务描述和 base commit 仍可作为数据来源；不直接复制其 hidden test Grader 流程。

## 后续实施约束

任何新增评测代码都必须保持“真实 Agent + Full Access + 隔离 workspace + 原生验证”的最小流程。若需要更严格的自动判分，应另立设计和明确迁移，不得悄悄恢复旧 Grader 依赖。
