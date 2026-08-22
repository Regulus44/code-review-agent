# Phase 1A 工具迁移矩阵

本文是 Phase 1A.0 的可追溯清单。它把当前 TypeScript 工具与 DSH/Claude Code 中对应的行为模式对齐，但不建立对上游实现代码的依赖。具体上游来源和许可证边界见 [source-reuse-register.md](source-reuse-register.md)。

## 迁移边界

- 新工具实现位于 `packages/tools/src/builtin.ts`，统一经过 `ToolRegistry`、`ToolRuntime`、workspace resolver、permission policy、取消、输出预算和事件存储。
- 旧工具实现已从工作树移除；历史映射保留在本文件，便于理解行为来源和验收边界。
- DSH 主要提供 TypeScript Agent Loop、filesystem/shell/terminal/plan/todo/interaction 的行为参考；Claude Code 主要提供 Read/Edit/Write/Glob/Grep/Bash、审批和工具 UX 的行为参考。
- 未从 Claude Code 快照复制代码；DSH 只登记了信息架构和行为适配范围，若未来直接改编代码，必须先补许可证证据和独立 checkpoint。

## P0 工具矩阵

| 工具 | DSH 行为参考 | Claude Code 行为参考 | source | risk / mode | approval | workspace 与模型视图 | 行为 fixture / 安全覆盖 |
|---|---|---|---|---|---|---|---|
| `read_file` | fs read | Read | builtin | read / parallel | auto | `WorkspaceResolver`；UTF-8 文本和大小上限 | `packages/tools/src/index.test.ts`：读取、文件大小、路径越界 |
| `glob` | fs glob | Glob | builtin | read / parallel | auto | 只遍历 workspace，忽略 `.git`、`node_modules`、`.agent-trash`；限制结果数 | glob 结果数量和 workspace 遍历测试 |
| `grep` | fs search | Grep | builtin | read / parallel | auto | 正则、文件大小、结果数和取消信号受限 | 搜索 fixture、越界和输出预算测试 |
| `edit_file` | fs patch/edit | Edit | builtin | write / exclusive | ask | 精确 oldText、唯一性校验、diff preview | 文本不存在/不唯一、diff、审批测试 |
| `write_file` | fs write | Write | builtin | write / exclusive | ask | 新建默认安全；覆盖必须显式 `overwrite=true`，返回 diff | 覆盖拒绝、显式覆盖、路径越界测试 |
| `git_status` | shell git status | Git status | builtin | read / parallel | auto | 固定 workspace cwd，结构化 branch/entries，保留 audit | Git status 结构化输出测试 |
| `git_diff` | shell git diff | diff review | builtin | read / parallel | auto | 固定 workspace cwd，输出预算和审计 | diff 输出预算/路径安全测试 |
| `run_command` | shell argv/取消 | Bash | builtin | execute / exclusive | ask | allowlist、argv 优先、timeout、进程树终止、stdout/stderr/exitCode audit | 命令注入、超时、取消、输出预算测试 |
| `run_tests` | shell test runner | Bash/test command | builtin | execute / exclusive | ask | 复用 command allowlist、cwd 和取消管线 | exit code、取消和审批测试 |

## P1 工具矩阵

| 工具组 | 行为参考 | 当前 contract | 恢复边界 |
|---|---|---|---|
| `terminal_open/send/read/signal/close/list` | DSH terminal；Claude Code Bash/terminal UX | 独立 terminalId、cwd、环境、输出缓冲、增量读取和安全 signal | `terminal/session` 只回放元数据；重启后 running session 变为 `interrupted`，不伪造 child process |
| `delete_file` | filesystem delete/trash UX | 默认移入 `.agent-trash`，永久删除显式 opt-in 并审批 | 删除结果和 trash 路径进入 tool audit |
| `git_log` / `git_show` | Git inspection | 固定 cwd、ref/path 校验、结构化 log 和 bounded show | 只读，无额外恢复状态 |
| `ask_user` | interaction / approval UX | `interaction/requested/resolved`，暂停并恢复同一 turn | pending interaction 由事件回放；答案不写入工具权限 |
| `plan` / `todo_write` | plan/todo state | 全量 `plan/updated` / `todo/updated` projection | 刷新和重启从事件重建，不依赖内存 |

## 统一字段与模型可见性

每个工具都必须声明 `source`、`riskLevel`、`executionMode`、`approvalMode`、`interruptBehavior`、JSON Schema 和 `modelView`。`ToolRuntime.listTools()` 先按 permission preset 过滤 deny 工具，执行阶段再次评估 policy；MCP 工具使用同一套 contract，不得绕过本地 workspace、权限、取消和审计。

## 行为 fixture 与安全回归索引

当前 fixture 不是静态截图，而是可重复的 Vitest 场景：

- `packages/tools/src/index.test.ts`：P0 工具输入/输出、schema、diff、Git、命令、取消、输出预算和 P1 工具闭包；
- `packages/runtime/src/index.test.ts`：多 step tool continuation、permission pause/resume、cancel、重启后的 pending approval 和 terminal-independent recovery；
- `packages/storage/src/index.test.ts`：事件 replay、PermissionProjection.turnId、SQLite reopen/interrupted 标记；
- `apps/api/src/server.test.ts`：工具/权限/interaction API、SSE replay、SQLite restart 和幂等；
- `packages/mcp-client/src/index.test.ts`：MCP discovery、namespace、ToolRuntime approval/cancel、重连和 secret 脱敏。

每次新增工具必须至少补齐：workspace 越界、schema 拒绝、权限 deny/ask/approve、取消或超时、输出预算、事件 replay 和重复 command 幂等场景。
