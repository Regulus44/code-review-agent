# Windows 工具执行环境改造结果说明

## 1. 文档范围

本文总结当前仓库针对“Windows 上 Agent 误调用 Bash，实际进入不可用 WSL `/bin/bash`”问题完成的改造。

本文中的“阶段 1–6”是 [Windows 工具执行环境不匹配调研与改造指导](dsh-windows-tool-execution-environment-research.zh-CN.md) 定义的实施阶段，属于本专题内部的实施拆分。历史阶段状态可在 [phase-status.zh-CN.md](../archive/phases/phase-status.zh-CN.md) 中追溯。

改造目标已经落地为：

- Windows 宿主只向 Agent 暴露 `pwsh`；
- Linux、macOS 及其他 POSIX 宿主只向 Agent 暴露 `bash`；
- Windows 不依赖 WSL `/bin/bash`，也不把 `WindowsApps\\bash.exe` 别名当作 Bash 可用性证明；
- Bash 和 PowerShell 命令不互相翻译，不自动切换为 `cmd.exe`；
- shell 的 cwd、权限、超时、取消、输出预算、后台任务、审计和事件恢复继续沿用现有统一工具管线。

## 2. 原问题与根因

原实现无条件注册 `bash` 和 `pwsh`。因此在 Windows 上：

1. 两个 shell 同时进入 `ToolRegistry`；
2. `ToolRuntime.listTools()` 将两个 shell 都提供给 AgentHost；
3. `AgentHost.modelTools()` 将两个 shell 都放入模型 schema；
4. 模型可能选择 `bash`；
5. Windows 的 `bash.exe` 应用别名将调用转发到 WSL，而 WSL 内没有 `/bin/bash` 时立即失败。

这类失败原先通常表现为命令返回非零，无法准确区分“命令失败”和“shell 执行环境不存在”。改造重点因此放在工具组装和工具可见性，而不是在运行时把 Bash 文本翻译成 PowerShell。

## 3. 当前实现结果

### 3.1 平台 shell roster

实现文件：[packages/tools/src/builtin.ts](../../packages/tools/src/builtin.ts)

`createBuiltinTools()` 新增 `platform?: NodeJS.Platform` 参数，默认取 `process.platform`。shell 定义由 `createShellTool()` 工厂创建：

| 宿主平台 | 注册的 shell | 模型可见的 shell | 启动参数 |
|---|---|---|---|
| `win32` | `pwsh` | 只有 `pwsh` | `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>` |
| `linux` / `darwin` / 其他 POSIX | `bash` | 只有 `bash` | `bash -lc <command>` |

其他内置工具的注册顺序、schema、风险级别、审批模式和执行模式保持不变。

未注册的 shell 不会被静默替换：直接查找 Windows roster 中的 `bash` 会由 `ToolRegistry` 抛出 `ToolNotFoundError`，稳定错误码为 `TOOL_NOT_FOUND`。AgentHost 的模型调用边界会把未知工具记录为失败的 `tool/result`，不会自动改用 `pwsh`。

### 3.2 PowerShell 可执行文件解析

实现文件：

- [packages/tools/src/pwsh-path.ts](../../packages/tools/src/pwsh-path.ts)
- [packages/tools/src/pwsh-path.test.ts](../../packages/tools/src/pwsh-path.test.ts)
- [packages/tools/src/index.ts](../../packages/tools/src/index.ts)

`resolvePwshPath()` 在 Windows 上按以下顺序解析：

1. 调用方传入的显式路径；
2. `CODE_REVIEW_AGENT_PWSH`；
3. `ProgramFiles\\PowerShell\\7\\pwsh.exe`；
4. `PATH`/`Path` 中各目录下的 `pwsh.exe`；
5. `SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`；
6. 没有可探测文件时返回裸 `pwsh`，交给系统 PATH 解析。

候选路径计算和实际文件探测分离，测试可以注入 platform、环境变量和临时安装目录。POSIX 平台不执行 Windows 路径探测，直接使用裸 `pwsh` 作为显式 PowerShell 工具的执行名。

### 3.3 Shell 执行语义

实现文件：[packages/tools/src/builtin.ts](../../packages/tools/src/builtin.ts)

- PowerShell 命令前置 UTF-8 输出初始化，并设置 `ConstrainedLanguage`；
- Bash 使用 `bash -lc`，保持 Bash 原生命令方言；
- 所有 shell 都使用 `shell: false`，由参数数组传递可执行文件和参数；
- `cwd` 先经过 `WorkspaceResolver`，越界或非目录路径被拒绝；
- 前台执行保留 timeout、AbortSignal、stdout/stderr 截断、exit code 和 audit；
- shell 环境注入受控的非交互变量：
  - Bash：`NO_COLOR=1`、`TERM=dumb`、`PAGER=cat`、`GIT_PAGER=cat`；
  - PowerShell：`NO_COLOR=1`、`PAGER=cat`、`GIT_PAGER=cat`；
- 未引入 `cmd.exe` fallback，也没有跨 shell 命令改写。

### 3.4 后台 Job、取消与恢复

实现文件：

- [packages/tools/src/jobs.ts](../../packages/tools/src/jobs.ts)
- [packages/tools/src/jobs.test.ts](../../packages/tools/src/jobs.test.ts)

后台 shell 通过 `JobManager` 执行：

- 返回 `jobId`，后续通过 `job_output`、`job_list`、`job_kill` 和 `job_retry` 操作；
- 输出写入 `.agent-artifacts/jobs/<jobId>.log`，并保留有界内存缓冲；
- 追加 `job/started`、`job/output`、`job/ended` 事件；
- `cwd`、executable、args、attempt、deadline 和状态进入 durable 事件；
- Windows 保持宿主进程内的 stdout/stderr 捕获，避免 detached PowerShell 丢失输出；
- Windows 通过 `taskkill /t /f` 终止进程树，POSIX 使用进程组终止；
- 新 `JobManager` 可以从 EventStore 重建已结束任务、读取 spill 输出，并将没有终态事件的任务标记为 `orphaned`；
- 调用方取消、deadline 超时和 host shutdown 在最终状态及错误码中保持可区分。

## 4. Agent 入口与实际调用链

### 4.1 当前仓库

```text
apps/api/src/server.ts
  → new AgentHost()
  → packages/runtime/src/index.ts
  → createBuiltinTools({ platform })
  → ToolRegistry
  → ToolRuntime.listTools()
  → AgentHost.modelTools()
  → 模型 tool schema / system prompt
  → ToolRuntime.execute()
  → packages/tools/src/builtin.ts: executeShellCommand()
  → shellLaunch() / JobManager / spawn()
```

平台选择发生在 `createBuiltinTools()` 的组装阶段。`AgentHost` 和 `runSteps()` 不再自行判断操作系统；它们只消费已经由 registry 决定的可见工具集合。Prompt 只描述当前可见工具，不能越过 registry 增加 `bash` 或 `pwsh`。

### 4.2 DSH 对照调用链

```text
apps/cli/src/bin.ts
  → apps/cli/src/profile-boot.ts:runProfile()
  → packages/bundle/base/cordis.patch.yml
       process.platform 门控 shell stack
  → bash-sandbox / pwsh-sandbox
  → tool-bash / tool-pwsh
  → bash-local / pwsh-local
  → subprocess-local/src/spawn.ts
```

DSH 的关键边界是“composition/provider 先决定平台工具 roster，AgentLoop 只消费可见 schema，shell executor 最后负责进程生命周期”。当前仓库采用同样的责任顺序，但继续使用自己的 `ToolRegistry`、`ToolRuntime`、`EventStore` 和 `AgentHost`。

## 5. 与 DSH 的对应关系

| 当前仓库实现 | DSH 对照文件 | 吸收的实现边界 |
|---|---|---|
| `createBuiltinTools({ platform })` | `packages/bundle/base/cordis.patch.yml` | 按 `process.platform` 启用单一 shell stack |
| `createShellTool()` | `packages/shell/tool-bash/src/index.ts`、`tool-pwsh/src/index.ts` | 模型工具定义与执行器解耦 |
| `shellLaunch()` | `packages/shell/bash-local/src/index.ts`、`pwsh-local/src/index.ts` | Bash/PowerShell 使用各自原生 argv，不做方言转换 |
| `resolvePwshPath()` | `packages/shell/pwsh-local/src/resolve.ts` | 可测试的 PowerShell 路径候选和 fallback 顺序 |
| `executeShellCommand()` | `packages/shell/shell/src/index.ts` | cwd、timeout、前后台和取消由统一 shell seam 管理 |
| `JobManager` | `packages/subprocess/subprocess-local/src/spawn.ts`、`packages/shell/tool-pwsh/tests/tools.spec.ts` | 输出捕获、spill、进程树终止和后台状态恢复 |
| `packages/runtime/src/index.test.ts` | `apps/cli/tests/windows-shell.spec.ts`、`packages/core/agent-loop/tests/tool-calls.spec.ts` | win32/POSIX roster 和模型工具可见性合同测试 |

本项目没有复制 DSH 的 Cordis composition、内部类型或品牌资源，也没有建立对 DSH 包的运行时依赖。本轮属于行为和结构对照；后续若直接复制或大量改编 DSH 代码，必须先更新 [../source-reuse-register.md](../source-reuse-register.md) 并保留 MIT 许可证信息。

## 6. 阶段 1–6 实际交付

| 阶段 | 实际交付 | 结果 |
|---|---|---|
| 1：平台 roster | `builtin.ts` 增加 platform 注入，Windows 只注册 `pwsh`，POSIX 只注册 `bash` | 完成 |
| 2：PowerShell 路径 | 新增 `pwsh-path.ts`、导出和路径解析测试 | 完成 |
| 3：执行适配 | PowerShell argv、UTF-8、ConstrainedLanguage、cwd、环境和 `shell:false` | 完成 |
| 4：Agent 可见性 | 保留现有 `AgentHost → ToolRuntime → modelTools` 链路，确认过滤后的 schema/prompt | 完成 |
| 5：合同与恢复测试 | roster、`TOOL_NOT_FOUND`、前后台 job、spill、取消、事件恢复、Agent schema/prompt 测试 | 完成 |
| 6：验收与 checkpoint | focused tests、全 workspace tests、typecheck、diff check、独立提交 | 完成 |

## 7. 验收证据

已执行并通过：

```text
pnpm --filter @code-review-agent/tools test   ✓ 9 个测试文件 / 68 tests
pnpm --filter @code-review-agent/runtime test ✓ 1 个测试文件 / 56 tests
pnpm typecheck                                ✓
pnpm test                                      ✓ 全 workspace 通过
git diff --check                               ✓
```

重点验收场景：

- Windows roster 不包含 `bash`，即使主机存在 `WindowsApps\\bash.exe` 也不会向 Agent 暴露；
- POSIX roster 不包含 `pwsh`；
- 显式调用未注册 shell 返回 `TOOL_NOT_FOUND`，不会自动切换执行器；
- Windows `pwsh` 前台命令可正确返回 cwd、stdout、exit code 和 audit；
- Windows `pwsh` 后台任务可捕获输出、写入 spill、追加 job 事件、取消并在新 JobManager 中恢复；
- AgentHost 的模型 schema 和 system prompt 只包含当前平台的 shell guidance；
- 平台过滤不改变既有 EventStore、Session、Permission、ToolResult 和 SSE replay 语义。

## 8. 变更文件与 checkpoint

本次相关实现分布在以下提交：

- `52ee190 feat(phase-3b): gate shell tools by host platform`
  - `packages/tools/src/builtin.ts`
  - `packages/tools/src/pwsh-path.ts`
  - `packages/tools/src/pwsh-path.test.ts`
  - `packages/tools/src/index.ts`
  - 初始 roster/path/smoke 测试
- `13171fd feat(phase-3b): align shell execution and tool visibility`
  - `packages/tools/src/builtin.ts`
  - `packages/tools/src/p1.test.ts`
  - `packages/runtime/src/index.test.ts`
  - UTF-8、非交互环境和 Agent 可见性合同
- `15b9223 test(phase-3b): close Windows shell acceptance gates`
  - `packages/tools/src/index.test.ts`
  - `packages/tools/src/jobs.test.ts`
  - `docs/tool-contract.md`
  - 本调研文档的实施验收记录和历史阶段状态更新

这些 checkpoint 没有修改 `packages/contracts`、`packages/tools/src/registry.ts`、`packages/tools/src/runtime.ts`、`packages/runtime/src/system-prompt.ts`、`apps/api/src/server.ts` 或 `docs/event-contract.md` 的生产契约。用户已有的其他工作树修改没有并入上述 checkpoint。

## 9. 当前使用边界与回滚

Windows 环境默认使用：

```text
pwsh → PowerShell 原生命令
```

如 PowerShell 7 不在默认目录或 PATH，可设置：

```text
CODE_REVIEW_AGENT_PWSH=C:\\Tools\\pwsh.exe
```

Linux/macOS 环境默认使用：

```text
bash → Bash 原生命令
```

本轮不提供以下行为：

- Windows Bash 自动回退到 PowerShell；
- Bash 命令自动翻译为 PowerShell；
- PowerShell 命令自动翻译为 Bash；
- 使用 `cmd.exe` 作为隐藏 fallback；
- 通过放宽 workspace、权限或 `shell:false` 绕过执行失败。

回滚边界是按提交回滚平台 roster/path、执行适配和相关测试/文档；不会删除既有 Session、EventStore 历史或公共 Event/Tool/Task/Permission/Workspace contract。

## 10. 结论

当前仓库已经完成与 DSH 对照的 Windows shell 执行环境改造。问题在工具组装阶段解决：Windows Agent 根本看不到依赖 WSL 的 `bash`，而使用可探测的 PowerShell；POSIX Agent 保持 Bash。执行阶段继续由统一 ToolRuntime 管理权限、workspace、取消、超时、审计、后台任务和事件恢复，因此该改造只收敛平台能力，不改变 Agent Runtime 的事实来源和公共协议边界。
