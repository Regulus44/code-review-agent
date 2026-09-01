# 正常 Web Agent 评测执行基线（2026-08-30）

## 目的

记录后续 Coding Agent 评测的唯一执行方式，避免再次使用已经验证为过重且不可靠的 Runner、Grader 和外部 shell 轮询流程。

## 正式执行方式

每条任务都通过与日常使用相同的 Web Agent 会话执行：

1. 从任务对应的干净 base commit 准备独立 workspace。
2. 使用当前实际 provider/model。
3. 授予 Agent `workspace-full-access`，完整权限仅针对当前 workspace。
4. 使用固定 Prompt，只替换任务描述和 workspace 路径。
5. 让 Agent 自主读取、编辑、运行仓库原生命令和安装依赖。
6. 运行期间通过前端会话状态和 Agent 自身事件流观察进展。
7. Agent 结束后检查会话记录、事件轨迹、Git diff，并使用仓库原生入口做结果验证。

## 明确禁止的评测操作

- 不通过 Runner 启动或编排评测任务；
- 不启动独立 Grader 等待“最终确认”；
- 不使用 `functions.exec`、PowerShell 或其他外部 shell 反复轮询 Agent 进程；
- 不在 Prompt 中人为加入 step 上限、测试超时、统一命令白名单或强制 pytest；
- 不把 Codex 桌面端 MCP 工具宿主的启动状态当作 Agent 工作状态。

## 运行跟踪原则

Agent 的命令子进程可以使用隐藏窗口运行，但“跟踪”不通过另起一个 cmd 窗口完成。正式观察来源按以下顺序使用：

1. Web Agent 前端显示的会话状态、工具调用和最终答复；
2. 同一会话产生的持久化事件流（如 `events.jsonl`）；
3. 任务结束后的统一结果检查。

如机器完全失去响应，由人工停止会话，并将任务记为 `interrupted`。不得为了查询状态而额外启动外部命令窗口。

## 为什么昨天 Runner 没有明显弹窗

昨天的批量 Runner 使用一次性隐藏子进程，并且运行期间没有频繁调用桌面端工具查询状态，因此没有反复触发 Codex 桌面端 MCP 启动器。此前看到的

```text
cmd.exe /d /s /c call ./scripts/launch_codex_app_tools_mcp.cmd ./server.mjs
```

属于 Codex 桌面端工具宿主，不是 Agent 任务命令。仓库内的 `windowsHide` 只能控制 Agent 自己的命令子进程，不能控制该桌面宿主。

## 结果判定

结果只依据 Agent 的实际修改和仓库原生验证：

- `solved`：修改有效，原生验证通过；
- `unsolved`：Agent 正常结束，但问题未解决；
- `environment_blocked`：环境导致无法可靠验证；
- `interrupted`：人工停止、进程异常或系统故障。

事件轨迹用于确认执行过程和 workspace 边界，不作为额外的 Agent step 或超时限制。该基线自本文日期起生效，后续评测文档和操作均以此为准。
