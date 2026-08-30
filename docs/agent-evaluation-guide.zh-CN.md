# Coding Agent 评测指南

当前执行标准已简化为真实 Agent 会话评测，详见 [`coding-agent-simple-evaluation-plan.zh-CN.md`](coding-agent-simple-evaluation-plan.zh-CN.md)。

## 当前唯一流程

1. 从干净 base commit 准备独立 workspace。
2. 使用日常配置的 provider/model，授予该 workspace `workspace-full-access`。
3. 使用固定评测 Prompt 模板发送任务描述和 workspace 路径，不附加 step、超时、命令白名单或 Grader 条件。
4. 让 Agent 自主读取、编辑、运行测试和安装依赖。
5. Agent 结束后保存会话日志、`events.jsonl`、`trace.json`、`result.json` 和 `agent.diff`。
6. 检查轨迹门禁：`traceStatus` 必须为 `complete`，且不得存在未拦截的 workspace 外引用。
7. 按仓库原生入口做一次人工/脚本验证，并记录结果。

## 结果分类

- `solved`：修改有效，原生验证通过。
- `unsolved`：Agent 正常结束，但问题仍未解决。
- `environment_blocked`：依赖、版本或平台导致无法可靠验证。
- `interrupted`：人工停止、进程异常或系统故障。

## 运行入口

- 单条任务：`pnpm eval:mvp:run-agent -- <task-id>`
- 批量任务：`pnpm eval:mvp:run-pilot`

这两个入口只负责启动 Agent 和记录结果，不调用、不等待独立 Grader。历史 Runner/Grader 设计仅保留在开发日志中，不作为后续测试操作指南。

`events.jsonl` 是原始事件流，`trace.json` 是轻量门禁报告。门禁只审计事件完整性、Session/workspace 一致性和越界拦截情况，不限制 Agent 的 step、命令、依赖安装或测试选择。
