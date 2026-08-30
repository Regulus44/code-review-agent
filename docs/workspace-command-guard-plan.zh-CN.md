# WorkspaceCommandGuard 简要实施方案

> 状态：待实施  
> 适用范围：使用 `workspace-full-access` 的 Coding Agent 评测  
> 目标：阻止正常 Agent 通过命令或测试工具显式、误操作访问当前 workspace 外的文件。

## 1. 方案定位

`WorkspaceCommandGuard` 是进程启动前的应用层检查器：

```text
Agent 工具调用
  → 参数和 workspace 解析
  → WorkspaceCommandGuard
  → 允许：进入现有 spawn/terminal/job 链路
  → 拒绝：写入结构化 tool/result，不启动进程
```

本方案针对当前 Agent 的实际风险模型：Agent 会按 Prompt 和工具规则工作，但可能因绝对路径、父目录检索、外部解释器路径或诊断习惯误读评测数据。暂不防御 Agent 在 workspace 内故意编写恶意 Python/Node 程序，再由程序动态窃取宿主文件的场景；这类威胁需要 AppContainer、容器或独立操作系统账户。

## 2. 代码入口

新增：

- `packages/tools/src/workspace-command-guard.ts`
  - `inspectCommand()`：检查 executable、argv、shell command 和 workdir；
  - `WorkspaceCommandDecision`：返回允许或拒绝及原因；
  - 不执行进程，不修改文件。

接入现有入口：

- `packages/tools/src/builtin.ts`
  - `runArgv()`：覆盖 `run_command`、`run_tests` 和 Git 子进程；
  - `executeShellCommand()` / `runShellForeground()`：覆盖 `pwsh`/`bash`；
  - `TerminalManager.open()`：覆盖持久终端启动。
- `packages/tools/src/jobs.ts`
  - `JobManager.start()`：覆盖后台任务和重试。
- `packages/tools/src/runtime.ts`
  - 仅当 Session preset 为 `workspace-full-access` 时启用；
  - 拒绝结果仍进入正常 `tool/call`、`tool/result` 和审计事件链。

不新增 Runner 或 Grader 服务。

## 3. 第一版检查规则

### 3.1 工作目录

- 未提供 workdir 时固定使用 Session workspace；
- 提供的 workdir 经 `path.resolve()` 和 `realpath()` 后必须位于 workspace；
- 拒绝父目录、同级目录、其他盘符和 UNC 路径；
- 已存在的符号链接目标必须仍在 workspace 内。

### 3.2 命令和参数路径

- 识别 Windows 绝对路径、UNC 路径、POSIX 绝对路径和 `file://`；
- 所有文件参数解析后必须位于 workspace；
- 拒绝 `..` 路径穿越；
- 拒绝 `$HOME`、`~`、`$env:USERPROFILE`、`%USERPROFILE%` 等指向 workspace 外的动态路径；
- executable 可以由现有 allowlist 从 `PATH` 解析，但 Agent 不能自行指定 workspace 外的任意可执行文件路径。

### 3.3 高风险命令形式

第一版直接拒绝当前评测不需要、但容易绕过路径检查的形式：

- `python -c`、`node -e` 等内联代码；
- `pwsh -EncodedCommand`；
- 从 shell 再启动 `cmd`、`powershell`、`pwsh` 等嵌套 shell；
- 使用 `Start-Process` 启动未经过 Guard 的子进程；
- 枚举环境变量、盘符根目录、用户目录或 workspace 父目录。

正常使用继续允许：

- `python -m pytest ...`；
- `python tests/runtests.py ...`；
- `python -m pip install ...`；
- `npm test`、`pnpm test`、`vitest`；
- workspace 内的 PowerShell 文件读取、搜索、构建和测试命令。

## 4. 拒绝结果与轨迹

Guard 拒绝时返回统一错误：

```json
{
  "code": "WORKSPACE_COMMAND_DENIED",
  "reason": "external_absolute_path",
  "message": "Command references a path outside the active workspace.",
  "workspaceRoot": "<active workspace>",
  "offendingValue": "<被拒绝的路径或参数>"
}
```

要求：

- 不启动目标进程；
- `tool/result` 标记为 failed；
- 保留 tool name、workdir、拒绝原因和被拒绝参数；
- 不把文件内容或环境变量值写入日志；
- Agent 收到可恢复提示：改用 workspace 相对路径，或仅依据当前仓库继续任务。

现有 `events.jsonl` 继续作为评测轨迹。Guard 不替代运行后的污染检查；如果旧入口或未知形式仍造成 workspace 外访问，该次结果继续标记为 `contaminated`。

## 5. 实施顺序

### 阶段一：纯函数与单元测试

- 实现路径规范化、workspace 包含判断和命令风险分类；
- 不接入 Runtime；
- 覆盖 Windows 路径、UNC、`..`、引号、空格、环境变量和 workspace 内合法路径。

### 阶段二：前台命令

- 接入 `run_command`、`run_tests` 和 `pwsh`；
- 验证允许的 Django/pytest/npm 命令仍能运行；
- 验证数据集目录、用户目录和外部源码路径在 spawn 前被拒绝。

### 阶段三：Terminal 与 Job

- 接入 `TerminalManager.open()` 和 `JobManager.start()`；
- 重试不得绕过第一次拒绝；
- 恢复的 terminal/job 继续绑定原 Session workspace。

### 阶段四：评测 smoke

- 使用一条干净 Easy 任务运行；
- 人工要求 Agent 访问 workspace 外测试路径，确认被拒绝并留下事件；
- 再运行正常修复，确认读取、编辑、依赖安装和原生测试不受影响。

## 6. 测试清单

至少覆盖：

- workspace 内相对路径允许；
- workspace 内绝对路径允许；
- 父目录、同级目录、其他盘符、UNC 路径拒绝；
- 指向 workspace 外的符号链接拒绝；
- 数据集 `public/private/runtime/results` 路径拒绝；
- `python -m pytest`、Django `tests/runtests.py` 和包管理器命令允许；
- `python -c`、`node -e`、嵌套 shell 和 `Start-Process` 拒绝；
- 前台、后台、terminal 使用相同判断；
- 拒绝事件不包含凭据或外部文件内容。

## 7. 验收标准

- `workspace-full-access` 仍不需要逐次审批；
- 正常仓库读取、编辑、安装和测试流程可以完成；
- 之前 `seaborn-2848` 使用的外部数据集绝对路径在进程启动前被拒绝；
- 同一规则覆盖所有命令和测试入口；
- 每次拒绝均可从 `events.jsonl` 还原原因；
- `pnpm typecheck`、Tools/Runtime/API 定向测试和一条真实 Easy smoke 通过。

## 8. 工作量与边界

预计工作量为 1～2 个开发日，约 250～400 行实现和 15～25 项测试。

本方案是当前评测阶段的低成本防外溢措施，不宣称操作系统级隔离。若未来威胁模型变为恶意代码执行，再单独评估 Windows AppContainer；当前不引入 Docker、Windows Sandbox、专用账户、环境复制或 Grader。
