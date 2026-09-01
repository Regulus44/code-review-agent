# WorkspaceCommandGuard 实施日志

日期：2026-08-30  
方案文档：`docs/operations/workspace-command-guard-plan.zh-CN.md`
实现提交：`df7c6ce feat(tools): guard workspace-scoped commands`  
实现前基线：`fd426ad docs(eval): plan workspace command guard`

## 背景与目标

最近一次 Easy v4flash 评测中，`mwaskom__seaborn-2848` 曾通过 PowerShell 使用绝对路径枚举数据集目录，并读取任务元数据和测试列表。`workspace-full-access` 和 Prompt 已明确 workspace 边界，但任意命令仍需要在进程启动前增加应用层检查。

本阶段实现 `WorkspaceCommandGuard`，针对遵守工具契约但可能误用绝对路径、父目录、环境目录或外部参考源码的正常 Agent。它不宣称抵御 Agent 在 workspace 内故意编写恶意程序后动态读取外部文件。

## 核心实现

新增 `packages/tools/src/workspace-command-guard.ts`：

- `inspectCommand()` 只检查输入，不执行进程、不读取目标文件内容；
- 工作目录必须解析到 active workspace 内；
- Windows/POSIX 绝对路径、UNC、`file://` 和 `..` 路径经过统一检查；
- 对已存在路径执行 `realpath()`，拒绝指向 workspace 外的符号链接或 junction；
- 拒绝用户目录、HOME、TEMP 等动态外部路径；
- 拒绝环境/盘符枚举、内联 Python/Node、嵌套 shell、`Start-Process` 和 `Invoke-Expression`；
- 环境变量输入被拒绝时只记录变量名，不记录变量值；
- `workspaceCommandDeniedResult()` 生成统一的 `WORKSPACE_COMMAND_DENIED` 结果和恢复提示。

正常允许的代表性命令：

- `python -m pytest ...`；
- `python tests/runtests.py ...`；
- `python -m pip install -e .`；
- `pnpm test`；
- workspace 内相对或绝对路径的 PowerShell 命令。

## Runtime 与工具链接入

`packages/contracts/src/index.ts` 的 `ToolContext` 新增当前 Session 的 `permissionPreset`。`packages/tools/src/runtime.ts` 在执行工具时传入真实 preset，Guard 只在 `workspace-full-access` 下启用，其他历史权限模式行为保持不变。

接入入口：

- `run_command`、`run_tests`：检查 executable、argv 和路径；
- `pwsh`/`bash`：在创建前台或后台进程前检查 shell command 与 workdir；
- `TerminalManager.open()`：检查 cwd、显式 executable、argv 和 Agent 提供的 env；
- `TerminalManager.send()`：guarded terminal 会先缓冲完整命令行，检查通过后才写入 stdin；
- `JobManager.start()`：在创建 spill artifact 和 spawn 前检查；
- `JobManager.retry()`：持久保存 `workspaceGuarded`，重试继续执行同一检查；
- Terminal/Job 的 durable event 保存 guard 状态，恢复后不会静默降级。

Git 结构化工具继续使用现有 `WorkspaceResolver`。LSP server 属于宿主预配置进程，Code Mode 已有独立 workspace/no-secret sandbox，本阶段没有把它们当作 Agent 任意命令入口重复改造。

## 失败事件

被拒绝的调用继续走已有事件链：

```text
tool/call
→ tool/progress(started)
→ tool/result(failed, WORKSPACE_COMMAND_DENIED)
```

结果保存：

- `reason`：例如 `external_absolute_path`、`path_traversal`、`symlink_escape`；
- `workspaceRoot`；
- 截断后的 offending path/argument；
- workspace 相对路径恢复提示。

Guard 不读取外部文件内容，也不会在被拒绝前创建目标进程。Agent 提供的环境变量值不会复制进拒绝事件。

## 测试覆盖

`packages/tools/src/workspace-command-guard.test.ts` 包含 17 项专用测试：

- workspace 内相对/绝对路径；
- Python、Django、pip、pnpm 正常命令；
- 父目录、外部盘符、UNC、HOME/USERPROFILE；
- 环境和盘符枚举；
- inline Python/Node、嵌套 cmd/pwsh、动态进程；
- 外部 workdir；
- junction/symlink 逃逸；
- 环境变量拒绝信息脱敏。

集成测试覆盖：

- 外部 Python 脚本在执行前被拒绝，marker 文件没有产生；
- 原 seaborn 风格数据集绝对路径枚举被拒绝；
- 正常 `workspace-full-access` PowerShell 命令无需审批并成功执行；
- guarded persistent terminal 的外部命令在 stdin 写入前被拒绝；
- guarded background job 在创建 job/spill 前被拒绝；
- guarded Job retry 保留约束。

## 验证结果

```text
pnpm --filter @code-review-agent/tools test
11 files passed，97 tests passed

pnpm --filter @code-review-agent/runtime test
4 files passed，78 tests passed

pnpm --filter @code-review-agent/api test
7 files passed，55 tests passed

pnpm typecheck
通过

git diff --check
通过
```

尚未在本次实现过程中消耗真实模型 token 重跑 Easy 任务。真实 Agent smoke 将和下一次 Easy 重跑一起执行；届时应先验证一条正常修复，并检查 `events.jsonl` 中不存在 workspace 外路径。

## 当前边界

- 该 Guard 防止当前 Agent 的显式或误操作命令外溢；
- 不解析或证明 workspace 内任意程序的运行时行为；
- `danger-full-access` 为兼容旧 Session 保持原行为；
- `workspace-full-access` 同时依赖 Prompt、Guard 和运行后事件审计；
- 命中未知绕过或实际外部读取时，该次评测仍标记为 `contaminated`。

## 回滚

回退 `df7c6ce` 可整体移除 Guard、ToolContext preset 传递、Terminal/Job guard 状态和相关测试，并恢复到方案文档提交 `fd426ad`。`workspace-full-access` 权限预设本身位于更早的 `09aacbb`，不会随本阶段回退而消失。
