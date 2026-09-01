# Coding Agent 评测指南

当前执行标准已简化为真实 Agent 会话评测，详见 [`coding-agent-simple-evaluation-plan.zh-CN.md`](coding-agent-simple-evaluation-plan.zh-CN.md) 和 [正常 Web Agent 评测执行基线](normal-web-agent-evaluation-baseline-2026-08-30.zh-CN.md)。

## 当前唯一流程

1. 从干净 base commit 准备独立 workspace。
2. 使用日常配置的 provider/model，授予该 workspace `workspace-full-access`。
3. 在 Web Agent 会话中发送固定评测 Prompt，只替换任务描述和 workspace 路径。
4. 让 Agent 自主读取、编辑、运行测试和安装依赖。
5. 运行期间只通过前端会话状态和同一会话事件流观察，不启动外部 shell 轮询。
6. Agent 结束后保存会话记录、事件轨迹和代码差异。
7. 按仓库原生入口做一次人工/脚本验证，并记录结果。

## 结果分类

- `solved`：修改有效，原生验证通过。
- `unsolved`：Agent 正常结束，但问题仍未解决。
- `environment_blocked`：依赖、版本或平台导致无法可靠验证。
- `interrupted`：人工停止、进程异常或系统故障。

## 运行入口

正式入口是日常 Web Agent 会话，不是仓库内的 Runner 脚本。

`../../scripts/eval-mvp/run-agent-task.ts` 和 `../../scripts/eval-mvp/run-pilot.ps1` 仅作为历史兼容入口保留，不得用于后续正式评测。独立 Grader 也不再参与结果判定。

`events.jsonl`（如会话持久化该文件）是原始事件流。轨迹只用于复核执行过程、Session/workspace 一致性和越界情况，不限制 Agent 的 step、命令、依赖安装或测试选择。
