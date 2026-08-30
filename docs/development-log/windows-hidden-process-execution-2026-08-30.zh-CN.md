# Windows 隐式工具进程修复

日期：2026-08-30
范围：Phase 8 工具可靠性 follow-up

## 问题定位

Coding Agent 的 Web UI 只消费工具事件，不负责创建操作系统终端窗口。仓库侧的弹窗风险来自 `packages/tools/src/builtin.ts`：

- `terminal_open` 在缺少 `executable` 时读取 `ComSpec`，默认启动 `cmd.exe /d /q`；
- `TerminalManager.open()` 和 `runArgv()` 使用 `detached: true`；
- 最近的评测 Prompt 和 executable allowlist 又重新引导 Agent 使用 `cmd.exe /d /s /c`。

Codex 桌面端 MCP 宿主脚本属于外部宿主进程，不在本仓库 Agent 工具执行范围内，本次不修改。

## 修复

- 从 `run_command` / `run_tests` allowlist 移除 `cmd` 和 `cmd.exe`；
- `terminal_open` 的 schema 要求显式 `executable`，运行时也会拒绝缺失值，不再读取 `ComSpec`；
- 持久终端只允许通用 executable allowlist 和当前平台受控 shell 名称；
- 新增统一的 Agent-owned spawn policy：Windows 使用 `detached: false`、`shell: false`、`windowsHide: true`，POSIX 保留 detached process group 以支持进程树取消；
- 评测 Prompt 改为要求显式 terminal executable/argv，移除 `cmd.exe /d /s /c` 引导；
- 工具契约补充无默认 shell 和 Windows 隐藏进程约束。

## 验收

- `terminal_open` 无 executable 不创建进程并返回 `TERMINAL_EXECUTABLE_REQUIRED`；
- `cmd.exe` 经 `run_command` 审批后返回 `COMMAND_NOT_ALLOWED`；
- Windows spawn policy 单测验证 `detached: false`、`shell: false`、`windowsHide: true`；
- 既有 terminal/job、workspace guard 和 shell 工具行为保持原事件、权限、取消和审计管线。

## 回滚

回滚本次代码、测试和契约 checkpoint 即可恢复原行为；不涉及 Codex MCP 宿主脚本，也不修改用户现有评测文档。
