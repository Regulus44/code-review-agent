# Coding Agent 评测执行环境、Grader 与 DSH 实现调研

> 调研日期：2026-08-29  
> 调研范围：`D:\\Develop\\code-review-agent`、`D:\\Develop\\coding-agent-test`、`D:\\Develop\\deepseek-harness-fork`  
> 本文用途：为后续 Coding Agent 评测执行环境、依赖安装、Full Access、环境变量、Grader 和诊断链路的改造提供可追溯依据。  
> 本轮状态：只读调研并形成文档；没有修改 TypeScript/PowerShell 代码，没有重跑评测，没有删除或覆盖已有结果。

## 1. 先给结论

当前评测失败不能简单归因于“大模型能力不足”。现有执行链中至少有四类彼此独立的问题：

1. **运行环境选择**：Grader 可以按任务创建任务级 Python 虚拟环境，但这不是用户手工创建的环境；它位于评测数据集的 `runtime/venvs/<task-id>` 下，并通过 `python -m venv --system-site-packages` 创建。当前 Runner 仍然把“是否使用任务级环境”和“是否安装依赖”做成 Grader 侧开关，尚未完全体现“优先使用当前 base 环境、必要时才隔离”的策略。
2. **命令执行限制**：当前 Agent 使用 `danger-full-access` 时，文件/网络/写入权限策略会放开，但 `run_command` 和 `run_tests` 仍受 `packages/tools/src/builtin.ts` 中的 `ALLOWED_EXECUTABLES` 白名单约束。Full Access 与“任意命令可执行”是两个独立维度，不能把前者误认为后者。
3. **环境变量与 Windows shell**：当前命令执行通过 Node `spawn` 和 PowerShell 路径解析完成；需要确保 cwd、PATH、虚拟环境、Python 模块路径和编码在每个任务中显式传递。DSH 的做法是显式 argv/cwd/env/timeout，并用 `pwsh -NoLogo -NoProfile -NonInteractive -Command ...`，避免多层 shell quoting。
4. **Grader 错误分类**：当前 Grader 已能记录若干失败类别，但导入/收集失败、依赖缺失、构建失败、Grader 自身异常和 Agent 步数耗尽仍可能在同一条链路中被粗略归并。若不区分，改进方向会被错误数据带偏。

因此，后续改造应按“执行环境、命令执行、权限、环境变量、Agent Loop、事件日志、Grader 适配器、错误分类、验收门禁”分模块推进，而不是按优先级标签推进。

## 2. 仓库与评测数据的边界

### 2.1 当前 Coding Agent 仓库

仓库根目录：`D:\\Develop\\code-review-agent`

核心目录：

| 区域 | 入口/文件 | 责任 |
|---|---|---|
| 评测 Runner | `scripts/eval-mvp/run-pilot.ps1` | 读取 manifest、串行启动任务、调用 Agent Runner 与 Grader、汇总结果 |
| 单任务 Agent Runner | `scripts/eval-mvp/run-agent-task.ts` | 创建任务 workspace/API/Session，提交 Agent turn，记录事件和 diff |
| Grader | `scripts/eval-mvp/grade-agent-run.ps1` | 创建 clean copy、应用 Agent diff 与 hidden patch、执行仓库原生测试、生成 grader 结果 |
| 范围审计 | `scripts/eval-mvp/scope-audit.ts`、`scope-audit-cli.ts` | 比对 Git 变更、允许路径、禁止路径和运行产物 |
| Agent Host/Loop | `packages/runtime/src/index.ts` | Session、turn、step、工具调度、取消、错误和持久化 |
| 系统提示 | `packages/runtime/src/system-prompt.ts` | 向 Agent 注入工具规则、步数/任务约束等 |
| 工具运行时 | `packages/tools/src/runtime.ts`、`permissions.ts` | 权限判断、工具调用、取消、超时、结构化结果 |
| 内建工具 | `packages/tools/src/builtin.ts` | 文件、Git、命令、测试、终端和后台 Job 工具 |
| PowerShell 路径 | `packages/tools/src/pwsh-path.ts` | Windows `pwsh.exe`/PowerShell 解析 |
| API 装配 | `apps/api/src/server.ts` | SQLite、凭据、provider profile、AgentHost、ToolRuntime 与 HTTP API 的装配 |

### 2.2 评测数据隔离

评测数据根目录：`D:\\Develop\\coding-agent-test\\datasets\\swebench-lite\\pilot-01`

当前结构：

```text
pilot-01/
  public/
    manifest.json
    tasks/<task-id>/task.json
  private/
    source/
    gold-patches/
    test-patches/
  runtime/
    workspaces/<task-id>/
    venvs/<task-id>/
  results/
  deprecated/
```

Agent 只应看到一个物化后的 `runtime/workspaces/<task-id>`；gold patch、hidden test patch 和其他任务资料必须留在 `private` 或 workspace 之外。当前 manifest 明确记录了这一隔离策略，并记录 `maxSteps=32`、`Resolved@1`、过程指标和任务清单。

## 3. 当前评测执行链路

### 3.1 `run-pilot.ps1`

入口：`D:\\Develop\\code-review-agent\\scripts\\eval-mvp\\run-pilot.ps1:6,110-149,155-256`

主要逻辑：

1. 读取 `public/manifest.json`，取得任务 ID 列表。
2. 为批次创建日志目录和 `summary.json`/`summary.md`。
3. 按任务串行调用 `run-agent-task.ts`。
4. 通过 `grade-agent-run.ps1` 对每个任务做 clean-copy Grader。
5. 按任务结果汇总 provider/model、步数、通过率、回归率、范围违规率、耗时和工具调用数。

当前默认参数包括 `MaxSteps=32` 和测试超时 `300000ms`。步数是 Agent Host 的单 turn 硬上限，同时会重复写入任务 prompt；它不是 SWE-bench 数据集本身的限制。

### 3.2 `run-agent-task.ts`

入口：`D:\\Develop\\code-review-agent\\scripts\\eval-mvp\\run-agent-task.ts:7,84-172,196-292`

主要逻辑：

- 从 `public/tasks/<task-id>/task.json` 读取任务元数据。
- 以任务 base source 创建一次性 workspace，并为任务创建独立 SQLite、事件流、diff 和范围审计文件。
- 调用 `createConfiguredApiServer()` 装配 API；当前默认传入 `permissionPreset: "danger-full-access"`。
- 读取持久化 provider/credential 配置。相关来源是：
  - `D:\\Develop\\code-review-agent\\apps\\api\\.data\\provider-profiles.json`
  - `D:\\Develop\\code-review-agent\\apps\\api\\.data\\credentials.secrets.json`
  - `D:\\Develop\\code-review-agent\\apps\\api\\.data\\code-review-agent.sqlite`
- 将允许路径、禁止路径、步数和原生测试要求注入 Agent prompt。
- 收集 `agent/status`、turn/step、tool call、权限、Git diff、scope audit 和结果文件。

### 3.3 `grade-agent-run.ps1`

入口：`D:\\Develop\\code-review-agent\\scripts\\eval-mvp\\grade-agent-run.ps1:2-10,143-225,258-463`

主要逻辑：

1. 在 Agent workspace 外创建 clean copy。
2. 应用 Agent diff。
3. 应用私有 hidden test patch。
4. 根据任务仓库适配器执行 FAIL_TO_PASS 和 PASS_TO_PASS。
5. 检查范围审计和安全违规。
6. 输出测试日志、`grader-result.json` 和批次汇总。

当前已经对 Django 使用 `tests/runtests.py`，其他任务默认使用 pytest；这说明 Grader 已开始引入仓库级测试适配器，但适配器还没有覆盖所有语言/构建系统，也没有把“收集失败”和“测试断言失败”完全拆开。

## 4. Base 环境、任务级虚拟环境与依赖安装

### 4.1 任务级虚拟环境从哪里来

这些环境由 Grader 创建，并非用户手工创建。创建入口在：

`D:\\Develop\\code-review-agent\\scripts\\eval-mvp\\grade-agent-run.ps1:158-187`

核心命令是：

```powershell
python -m venv --system-site-packages D:\\Develop\\coding-agent-test\\datasets\\swebench-lite\\pilot-01\\runtime\\venvs\\<task-id>
```

上一批任务可见的环境版本包括 Python 3.13.7、NumPy 2.5.1。历史 SWE-bench 任务较旧时，容易出现以下兼容性问题：

- Astropy 4.3 与当前 Python/依赖不兼容；
- Requests 2.4 依赖已移除的 `cgi`；
- Xarray 0.12 使用在 NumPy 2.x 中移除的 `np.unicode_`；
- 旧版 Matplotlib/scikit-learn 需要本地原生编译；
- 某些 pytest 源码环境缺少 `_pytest._version`。

### 4.2 当前策略的缺口

当前 `-InstallDependencies` 是 Grader 的显式开关：只有传入该开关才创建/使用任务级 venv 并安装任务依赖。它解决了“Grader 没有依赖”的一部分问题，但与当前产品目标仍有差距：

- Agent 在 Full Access 下不一定能自行调用 `pip`/`uv`/`poetry`/`npm install`，因为命令仍受可执行文件白名单影响；
- Grader 与 Agent 可能使用不同的 Python/Node 环境；
- base 环境可用时，强制创建 venv 会增加安装时间和兼容变量；
- 依赖安装失败目前没有独立、清晰的结果类别。

### 4.3 建议的环境决策契约

后续实现应把环境决策显式记录为任务级事实：

```text
environment.mode = base | task-venv | task-runtime
environment.python = absolute executable path
environment.node = absolute executable path (if applicable)
environment.cwd = clean-copy or agent-workspace path
environment.env = explicit overrides (PATH/PYTHONPATH/DJANGO_SETTINGS_MODULE/etc.)
environment.install = not-requested | agent-installed | runner-installed | failed
```

建议顺序：先探测 base 环境是否能导入和收集测试；只有不满足任务要求时才建立隔离环境。无论哪种模式，Agent 都应在任务 workspace 内拥有用户要求的 Full Access，并在 prompt 中明确“可以安装依赖、安装失败要记录并继续诊断”。

## 5. 当前 Full Access、命令白名单与环境变量

### 5.1 Full Access 的实际含义

`run-agent-task.ts:110-114,140` 将权限 preset 设为 `danger-full-access`。`packages/tools/src/permissions.ts:13,61` 将该 preset 解析为自动允许网络、写入和执行。

但 `packages/tools/src/builtin.ts:23` 仍定义：

```text
git, node, npm, pnpm, python, vitest
```

`run_command`/`run_tests` 在 `builtin.ts:385-389` 声明为 allowlisted executable；`runArgv()` 在 `builtin.ts:823-867` 使用 `spawn(..., shell:false)` 执行，并由 `isAllowedExecutable()` 做白名单校验。PowerShell shell 工具在 `builtin.ts:577-588` 通过 `resolvePwshPath()` 启动。

因此当前有两个独立层面：

| 层面 | 当前入口 | 影响 |
|---|---|---|
| 权限 preset | `packages/tools/src/permissions.ts`、`run-agent-task.ts` | 是否需要用户批准、是否允许写入/网络/执行 |
| 可执行文件选择 | `packages/tools/src/builtin.ts` | 即使 Full Access，也可能因命令不在白名单而不能执行 |

后续不能只修改权限 preset 就宣称“完全放行”。需要在评测模式下允许任务 workspace 内的依赖安装和仓库原生命令，同时保留 workspace 外路径保护与可审计日志。

### 5.2 环境变量与 cwd

当前 Agent 命令大多从 `process.env` 合并少量任务变量，cwd 由任务 workspace/clean copy 传入。风险点包括：

- 运行命令时 PATH 未包含任务 venv 的 `Scripts`/`bin`；
- Python 模块导入路径与 clean copy 不一致；
- Django 的 `DJANGO_SETTINGS_MODULE`、locale、数据库路径未显式记录；
- Windows PowerShell 的编码、profile 和 pager 影响输出；
- Agent workspace 和 Grader clean copy 的 cwd 不一致导致“本地成功、Grader 失败”。

环境变量应在日志中保留经过脱敏的键名和来源，不记录 secret 值。

## 6. 当前 Grader 错误链路与需要保留的事实

当前 Grader 在 `grade-agent-run.ps1:403-429` 根据阶段和退出状态归类 `timeout`、`scope_violation`、`security_violation`、`test_failed`、`grader_failed` 和 `infra_error`。这比完全统一为 `test_failed` 好，但仍不够细。

建议保留以下链路事实，而不是只保留最终状态：

```text
agent_start
  -> agent_turn/step/tool events
  -> agent_end (completed | stopped | cancelled | max_steps | provider_error)
  -> scope_audit
  -> clean_copy
  -> apply_agent_patch
  -> apply_hidden_patch
  -> dependency_probe/install
  -> test_discovery/collection
  -> fail_to_pass
  -> pass_to_pass
  -> result_finalize
```

推荐的最小 failureClass：

| 类别 | 判定依据 |
|---|---|
| `agent_step_limit` | Agent 抛出 `MAX_AGENT_STEPS_EXCEEDED`，或 turn 以步数耗尽结束 |
| `agent_cancelled` | Agent/用户取消，且没有后续 Grader 异常覆盖该事实 |
| `provider_error` | 模型请求、流式响应或重试链失败 |
| `command_not_found` | 可执行文件解析或 spawn 失败 |
| `dependency_install_error` | 安装命令失败 |
| `environment_error` | Python/Node 版本、导入、运行时初始化失败 |
| `collection_error` | 测试框架能启动，但测试收集阶段失败 |
| `test_failed` | 测试已收集并执行，断言或运行时失败 |
| `build_error` | 构建/类型检查失败 |
| `scope_violation` | 变更超出允许范围或运行产物未配置 |
| `security_violation` | 读取 hidden/private/secret 或破坏隔离 |
| `grader_error` | Grader 自身路径、patch、解析或脚本异常 |

当前已知的 Grader 风险：

- `Assert-SamePathSet` 对空数组处理不稳定，可能把“无修改”误判为 scope violation；
- Django 测试生成 SQLite 文件时，若 `runtimeArtifactPaths` 未配置，可能被误判为越界；
- Agent `cancelled_by_user` 状态可能被后续范围检查异常覆盖；
- 导入/收集失败目前可能被粗略记为 `test_failed`。

## 7. DSH 的参考实现：执行环境与命令执行

DSH 仓库：`D:\\Develop\\deepseek-harness-fork`

### 7.1 PowerShell 入口

文件：

- `D:\\Develop\\deepseek-harness-fork\\packages\\shell\\pwsh-local\\src\\index.ts`
- `D:\\Develop\\deepseek-harness-fork\\packages\\shell\\pwsh-local\\src\\resolve.ts`

关键入口与逻辑：

- `candidatePwshPaths()`/`resolvePwshPath()`：按显式配置、已知安装目录、PATH 解析 `pwsh.exe`，并把解析作为可测试的纯函数（`resolve.ts:21-78`）。
- `resolvedSpec()`：为每次调用显式解析 `workdir`、timeout、env（`index.ts:186-205`）。
- `argv()`：固定使用 `[pwsh, -NoLogo, -NoProfile, -NonInteractive, -Command, command]`，命令作为一个 argv 元素传入（`index.ts:212-218`）。
- `spawnSpec()`：显式传入 cwd、stdio、环境覆盖和超时（`index.ts:221-240`）。
- 前台/后台执行分别处理 deadline、取消、stderr 尾部、spill file 和 spawn failure（`index.ts:261-336`）。

可借鉴点：不要把 PowerShell 命令拼成多层 `cmd /c powershell -Command "..."`；应直接以 argv 调用，并统一记录 cwd、env 来源、退出码、signal、timeout 和 stderr。

### 7.2 Subprocess 入口

文件：

- `D:\\Develop\\deepseek-harness-fork\\packages\\subprocess\\subprocess\\src\\types.ts`
- `D:\\Develop\\deepseek-harness-fork\\packages\\subprocess\\subprocess-local\\src\\spawn.ts`
- `D:\\Develop\\deepseek-harness-fork\\packages\\subprocess\\subprocess-local\\src\\index.ts`

关键逻辑：

- `SubprocessSpawnSpec` 要求调用方显式给出 argv、cwd、stdio、grace、signal 和 env（`types.ts:70-108`）。
- `childEnv()` 先清理继承环境，再合并显式环境；Windows 对 PATH/PATHEXT 使用大小写不敏感处理（`spawn.ts:30-40`、`index.ts:187-194`）。
- `spawnSubprocess()` 永远不经过 shell，负责收集 stdout/stderr、限制尾部大小和记录 spillPath（`spawn.ts:320-377`）。
- Windows 使用 `taskkill /PID /T /F` 终止整个进程树（`spawn.ts:257-281`）。
- `done` 只报告退出事实；timeout/cancel 原因由上层根据 deadline/signal 分类，不由底层猜测（`spawn.ts:459`、`types.ts:178`）。

可借鉴点：当前 `builtin.ts` 已使用 `shell:false`，但环境构造、输出契约和 Grader 侧原因分类还应向 DSH 的“事实与解释分层”靠拢。

## 8. DSH 的参考实现：权限、Sandbox 与 Full Access

文件：

- `D:\\Develop\\deepseek-harness-fork\\packages\\interaction\\permission-presets\\src\\index.ts`
- `D:\\Develop\\deepseek-harness-fork\\packages\\interaction\\user-approval\\src\\index.ts`
- `D:\\Develop\\deepseek-harness-fork\\packages\\sandbox\\sandbox-policy\\src\\index.ts`

关键设计：

1. permission preset 同时组合 sandbox mode 与 approval policy；`danger-full-access` 表示 sandbox 为 `danger-full-access`、approval 为 `never`。
2. `PermissionPresetService` 只负责通过 canonical setter 写入策略，不直接执行工具。
3. `ApprovalService.request()` 返回封闭结果：`allowed-once`、`rejected`、`cancelled`、`unavailable`；缺少审批通道或异常时 fail closed。
4. `SandboxPolicyService.resolve()` 根据显式批准模式、Session 事件和部署默认值解析 cwd/root。
5. DSH 明确区分 sandbox mode 与 process/network policy；放开 workspace 写入不等于无边界读取宿主机或无审计执行任意进程。

对本仓库的含义：评测时可以给 Agent workspace Full Access，但仍应把“workspace root、private root、secret root、命令环境、事件审计”作为独立事实记录，不能用一个布尔值代替整套策略。

## 9. DSH 的参考实现：Agent Loop 与工具调度

文件：

- `D:\\Develop\\deepseek-harness-fork\\packages\\core\\agent-loop\\src\\agent.ts`
- `D:\\Develop\\deepseek-harness-fork\\packages\\core\\agent-loop\\src\\tool-calls.ts`
- `D:\\Develop\\deepseek-harness-fork\\packages\\core\\tools\\src\\index.ts`

关键逻辑：

- `agent.ts` 在 turn/step 边界追加 `turn/start`、`step/start`、`step/end`、`turn/end`；模型请求、流式输出、max-tokens、tool call、retry、cancel 和 errorChain 都在同一状态机中闭合（`agent.ts:255-319,279-313,341-396`）。
- `tool-calls.ts` 将模型工具调用按 `parallel`/`exclusive` 分组；exclusive 调用形成顺序屏障，取消时为未派发调用补写确定性的 aborted 结果（`tool-calls.ts:41-70,133-173,226-285`）。
- `tools/src/index.ts` 把工具执行拆成 `prepare -> dispatch -> finalize/finish`，并通过 `tools/pre-execute`、`tools/execute`、`tools/post-execute` 处理权限、超时、重试、规范化和观测（`index.ts:144-189,452-459`）。

对本仓库的含义：当前 `packages/runtime/src/index.ts` 已有 step 上限、step 事件和取消，但需要确保“步数耗尽”“模型输出达到 max tokens”“工具取消”“Grader 后处理异常”不会互相覆盖；每个阶段都要保留原始事件和分类原因。

## 10. DSH 的参考实现：Session、Projection、Storage 与诊断

文件：

- `D:\\Develop\\deepseek-harness-fork\\packages\\core\\session\\src\\types.ts`
- `D:\\Develop\\deepseek-harness-fork\\packages\\session\\session-projection\\src\\index.ts`
- `D:\\Develop\\deepseek-harness-fork\\packages\\session\\session-stats\\src\\index.ts`
- `D:\\Develop\\deepseek-harness-fork\\packages\\storage\\storage\\src\\index.ts`

关键设计：

- Session 是 append-only typed event log；模型上下文和 UI 投影都从事件派生。
- Projection 使用纯 `init/apply/view`，支持 snapshot、checkpoint、tail replay 和 state version。
- Stats 从完整事件日志折叠，不依赖 history 分页，避免“显示结果”和“统计结果”不一致。
- Storage 明确区分持久化后端、读取/写入错误和恢复边界。

对本仓库的含义：评测结果不应只保存一个 `status` 字符串；应保存 Agent 原始结果、Grader 阶段事件、环境探测、测试 stdout/stderr 尾部、spill 文件、分类后的 failureClass 和最终可判分状态。

## 10.1 DSH 文档级依据

代码入口之外，以下 DSH 文档对实施边界和语义有直接说明，后续改造应与这些文档逐项对照：

| DSH 文档 | 可作为本仓库的依据 |
|---|---|
| `D:\\Develop\\deepseek-harness-fork\\docs\\subsystems\\shell.md` | shell request 与 resolved spec 分离；前台/后台命令、timeout/abort、spawn failure、stdout/stderr 和 sandbox 能力边界 |
| `D:\\Develop\\deepseek-harness-fork\\docs\\subsystems\\subprocess.md` | argv/cwd/env 完整 spawn spec；bounded collector、spill file、进程树终止；底层只报告退出事实 |
| `D:\\Develop\\deepseek-harness-fork\\docs\\subsystems\\terminal.md` | 持久终端的 readiness、wait reason、session exit、取消和清理边界 |
| `D:\\Develop\\deepseek-harness-fork\\docs\\tool-execution-pipeline.md` | `pre-execute -> execute -> post-execute -> normalize/finalize -> result` 的阶段化工具执行管线 |

这些文档不是要原样复制到当前仓库，而是用于校准术语、状态边界和验收断言。尤其需要保留 DSH 的两个原则：

- 底层执行器只记录可观测事实，上层根据 deadline、signal 和阶段解释原因；
- sandbox、process/network policy、approval 和 workspace scope 是不同维度，必须分别记录。

## 11. 当前仓库与 DSH 的逐模块映射

| 模块 | 当前仓库入口 | 当前逻辑/缺口 | DSH 参考实现 |
|---|---|---|---|
| 执行环境与 workspace | `run-agent-task.ts`、`run-pilot.ps1`、`grade-agent-run.ps1` | workspace 与 clean copy 已隔离；base/venv 选择未形成统一事实契约 | `subprocess/src/types.ts`、`subprocess-local/src/spawn.ts` |
| 命令与依赖安装 | `packages/tools/src/builtin.ts` | `shell:false` 已有；白名单阻断安装命令，env/输出/进程树契约不完整 | `pwsh-local/src/index.ts`、`subprocess-local/src/spawn.ts` |
| Full Access | `packages/tools/src/permissions.ts`、`run-agent-task.ts` | preset 已设为 danger-full-access，但不等于取消 executable allowlist | `permission-presets/src/index.ts`、`sandbox-policy/src/index.ts` |
| PowerShell/cwd/env | `pwsh-path.ts`、`builtin.ts` | 有路径解析和 Windows 隐藏窗口；需统一显式 cwd/env/编码/超时 | `pwsh-local/src/resolve.ts`、`pwsh-local/src/index.ts` |
| Agent Loop/步数 | `packages/runtime/src/index.ts` | 默认 maxSteps=32，step 事件和 MAX_AGENT_STEPS_EXCEEDED 已有；需强化终态不覆盖 | `agent-loop/src/agent.ts` |
| 工具调度 | `packages/runtime/src/tool-call-scheduler.ts`、`packages/tools/src/runtime.ts` | 已有权限/取消/结果事件；需要阶段化执行事实 | `agent-loop/src/tool-calls.ts`、`core/tools/src/index.ts` |
| Session/日志 | `packages/storage/src/index.ts`、`packages/contracts/src/index.ts`、runtime 事件 | SQLite 和事件已存在；需要 Grader 事件与诊断统一写入 | `session-projection`、`session-stats`、`storage` |
| Grader 适配器 | `grade-agent-run.ps1` | Django 已有原生入口，其他任务默认 pytest；分类仍偏粗 | DSH 的事实/原因分离、测试契约可作为结构参考 |
| 范围/安全 | `scope-audit.ts`、`grade-agent-run.ps1` | 有 allowed/forbidden/runtimeArtifact；空集合和运行产物边界有风险 | `sandbox-policy` 的 root/cwd 解析与审计思想 |

## 12. 分模块、分阶段实施方案

以下阶段按实施模块组织，不使用优先级标签。每个阶段均限定改造边界，并给出 DSH 对照入口。

### 阶段一：执行环境与 workspace 事实契约

**当前仓库需要改的入口**

- `scripts/eval-mvp/run-agent-task.ts`
- `scripts/eval-mvp/run-pilot.ps1`
- `scripts/eval-mvp/grade-agent-run.ps1`
- `scripts/eval-mvp/verify-grader.ps1`

**当前逻辑**：Runner 创建任务 workspace，Grader 创建 clean copy；venv 由 Grader 的 `-InstallDependencies` 分支决定。

**参照 DSH**

- `packages/subprocess/subprocess/src/types.ts` 的 `SubprocessSpawnSpec`：所有 cwd、env、stdio、signal 必须显式。
- `packages/subprocess/subprocess-local/src/spawn.ts` 的 `childEnv()` 与 spawn 事实记录。

**拟采用的适配逻辑**

1. 在任务开始时探测 base runtime，并将探测结果写入 `environment.json`。
2. 只有 base 环境无法导入/收集时才创建 `runtime/venvs/<task-id>`。
3. Agent workspace、clean copy、private root、runtime artifact root 都生成绝对路径并写入结果。
4. 明确 Agent 与 Grader 的 cwd 和 runtime 选择是否一致。

**验收产物**：`environment.json`、脱敏 env 摘要、spawn 记录、clean-copy 路径记录。  
**不包含**：不在此阶段修改模型、任务文本或 SWE-bench 数据。

### 阶段二：命令执行与依赖安装

**当前仓库需要改的入口**

- `packages/tools/src/builtin.ts` 的 `ALLOWED_EXECUTABLES`、`run_command`、`run_tests`、`runArgv()`、PowerShell shell 工具。
- `packages/tools/src/runtime.ts` 的 ToolRuntime 执行和结果规范化。
- `scripts/eval-mvp/grade-agent-run.ps1` 的 dependency probe/install。

**参照 DSH**

- `packages/shell/pwsh-local/src/index.ts` 的显式 argv/cwd/env/timeout/输出逻辑。
- `packages/subprocess/subprocess-local/src/spawn.ts` 的 scrubbed env、进程树终止、bounded tail/spill。

**拟采用的适配逻辑**

1. 评测模式下允许 Agent 在 workspace 内使用任务所需的包管理器和测试命令；路径保护仍由 workspace root 和 scope audit 负责。
2. 将“命令不可执行”“依赖安装失败”“测试收集失败”分别编码。
3. 记录安装命令 argv、cwd、脱敏 env、退出码、stdout/stderr tail 和 spillPath。
4. 对 Python、Node、Django、pytest 等仓库使用任务声明的原生命令，不强制统一 pytest。

**验收命令**：在一个无依赖任务和一个需要安装依赖的任务中分别验证 Agent 安装、Grader 复用和失败分类。  
**不包含**：不为单个历史任务永久修改源码或锁文件。

### 阶段三：Full Access、sandbox 与权限策略

**当前仓库需要改的入口**

- `packages/tools/src/permissions.ts`
- `packages/runtime/src/index.ts` 的 Session permission preset 装配、权限等待和取消。
- `apps/api/src/server.ts` 的 `permissionPreset` 解析与 Session API。
- `scripts/eval-mvp/run-agent-task.ts` 的评测 preset 注入。

**参照 DSH**

- `packages/interaction/permission-presets/src/index.ts`：preset 组合 sandbox 与 approval。
- `packages/interaction/user-approval/src/index.ts`：封闭审批结果和 fail-closed。
- `packages/sandbox/sandbox-policy/src/index.ts`：根据 Session/部署状态解析 cwd/root。

**拟采用的适配逻辑**

1. 正常使用和评测使用同一套权限语义；评测只把 Session 设为 `danger-full-access`，不另造第二套 Agent 行为。
2. 明确 Full Access 的范围是当前 workspace、任务依赖安装和原生命令；private/secret 根目录仍不可见。
3. 记录权限 preset、workspace root、approval policy 和每次权限决定。
4. 取消、拒绝、审批通道不可用必须产生互不混淆的结果。

**验收产物**：Session permission 事件、命令执行审计、取消后无后续副作用的测试。  
**不包含**：不引入 DSH 的完整 CLI/桌面权限 UI。

### 阶段四：环境变量、cwd 与 PowerShell 适配

**当前仓库需要改的入口**

- `packages/tools/src/pwsh-path.ts`
- `packages/tools/src/builtin.ts` 的 `runShellForeground()` 与 shell 启动参数。
- `scripts/eval-mvp/run-agent-task.ts`、`grade-agent-run.ps1` 的 runtime env 组装。

**参照 DSH**

- `packages/shell/pwsh-local/src/resolve.ts`：显式 pwsh 路径解析。
- `packages/shell/pwsh-local/src/index.ts:186-240`：显式 cwd/env/timeout、UTF-8、NoProfile/NonInteractive。
- `packages/subprocess/subprocess-local/src/spawn.ts:30-40`：环境清理和 Windows 大小写语义。

**拟采用的适配逻辑**

1. 所有 shell/argv 命令都显式传入绝对 cwd。
2. 为任务 venv 或 Node runtime 生成 PATH 前缀，且在日志中写明来源。
3. PowerShell 固定 `-NoLogo -NoProfile -NonInteractive`，关闭颜色/pager，并统一 UTF-8。
4. 对 Django、locale、数据库和测试框架需要的变量提供任务级声明。

**验收命令**：用 Django 任务验证 `tests/runtests.py`，用 Python 包任务验证 import/collection，检查 Agent workspace 与 clean copy 的 env/cwd 摘要一致。  
**不包含**：不把宿主机全部环境变量原样写入日志。

### 阶段五：Agent Loop、步数、max tokens 与取消

**当前仓库需要改的入口**

- `packages/runtime/src/index.ts` 的 `maxSteps`、step 循环、`step/started`/`step/ended`、`MAX_AGENT_STEPS_EXCEEDED`、取消与错误收尾。
- `packages/runtime/src/system-prompt.ts` 的有限步数提示。
- `scripts/eval-mvp/run-pilot.ps1`、`run-agent-task.ts` 的步数传递。

**参照 DSH**

- `packages/core/agent-loop/src/agent.ts:255-319`：turn/step 边界和终态闭合。
- `packages/core/agent-loop/src/agent.ts:279-313`：max-tokens 粘滞、errorChain 和 turn end。
- `packages/core/agent-loop/src/tool-calls.ts:226-285`：取消时补写确定性工具结果。

**拟采用的适配逻辑**

1. 在用户提示和事件中同时记录 maxSteps、单次模型输出上限和测试超时。
2. 区分 `agent_step_limit`、`provider_max_tokens`、`agent_cancelled` 和 `timeout`。
3. 任何 Grader 后处理错误不得覆盖 Agent 已经形成的终态。
4. 每一步都保留开始、结束、工具调用数、输出 token（若 provider 可提供）和结束原因。

**验收产物**：步数耗尽、max tokens、取消、重试和恢复的最小回归测试。  
**不包含**：不在本阶段改变模型上下文窗口或模型能力。

### 阶段六：事件、Session、日志和诊断

**当前仓库需要改的入口**

- `packages/contracts/src/index.ts`
- `packages/storage/src/index.ts`
- `packages/runtime/src/index.ts`
- `scripts/eval-mvp/run-agent-task.ts`
- `scripts/eval-mvp/grade-agent-run.ps1`

**参照 DSH**

- `packages/core/session/src/types.ts`：typed append-only event vocabulary。
- `packages/session/session-projection/src/index.ts`：init/apply/view、snapshot/checkpoint/replay。
- `packages/session/session-stats/src/index.ts`：从全量日志折叠统计。
- `packages/storage/storage/src/index.ts`：持久化后端和错误边界。

**拟采用的适配逻辑**

1. 将 Grader 的每个阶段写入结构化事件，而不是只输出 PowerShell 文本。
2. 保存命令 argv、cwd、环境摘要、退出事实、stderr 尾部、spillPath、测试框架和测试目标。
3. summary 从事件/结果投影生成，支持在不重跑任务的情况下重新分析失败。
4. 原始日志、诊断摘要和最终判分结果分层保存。

**验收产物**：单任务事件流、`grader-result.json`、`summary.json`、中文 `summary.md`、错误链路报告。  
**不包含**：不引入 DSH 的完整发布系统或桌面 UI。

### 阶段七：Grader 测试适配器

**当前仓库需要改的入口**

- `scripts/eval-mvp/grade-agent-run.ps1` 的测试命令选择、参数规范化和结果解析。
- `public/tasks/<task-id>/task.json` 的 repository/test adapter 字段。
- `scripts/eval-mvp/verify-grader.ps1` 的适配器回归验证。

**参照 DSH**

- 直接参考 DSH 的 subprocess “退出事实与原因分类分离”设计，而不是照搬某个 Python 测试实现。
- 使用 DSH tool pipeline 的阶段化思想，将 probe、collect、execute、finalize 分开记录。

**拟采用的适配逻辑**

1. 任务声明 `testAdapter`：`pytest`、`django-runtests`、`node`、`custom` 等。
2. 适配器必须分别报告 probe、collection、FAIL_TO_PASS、PASS_TO_PASS、build/typecheck。
3. Django 继续使用 `tests/runtests.py`；非 Python 仓库不得被强制调用 pytest。
4. 适配器生成统一的 `testPhase` 和 `failureClass`，保留原始 stdout/stderr。

**验收命令**：至少跑通一条 Django 任务、一条普通 pytest 任务，并分别注入 collection error、依赖缺失和断言失败验证分类。  
**不包含**：不为历史任务改造其源代码以适配当前 Python 版本。

### 阶段八：错误分类与结果汇总

**当前仓库需要改的入口**

- `scripts/eval-mvp/grade-agent-run.ps1`
- `scripts/eval-mvp/run-pilot.ps1`
- `scripts/eval-mvp/run-agent-task.ts`
- `scripts/eval-mvp/scope-audit.ts`

**参照 DSH**

- `agent-loop/src/agent.ts` 的 `errorChain`、请求错误和重试边界。
- `subprocess/src/types.ts` 的“只报告退出事实，上层解释原因”。
- `core/tools/src/index.ts` 的规范化结果与最终通知。

**拟采用的适配逻辑**

1. 先记录事实，再由单一分类器给出 failureClass；禁止不同阶段随意覆盖已有终态。
2. 将 `grader_error` 与 `infra_error` 分开：前者是 Grader 逻辑/输入异常，后者是机器/进程/服务不可用。
3. 汇总中分别统计 agent、environment、grader、test、scope 五类失败率。
4. 中文报告中展示“失败阶段、原始原因、分类原因、建议下一步”，但不把建议写成优先级标签。

### 阶段九：评测验收与回归门禁

**当前仓库需要改的入口**

- `scripts/eval-mvp/verify-grader.ps1`
- `scripts/eval-mvp/scope-audit.test.ts`
- `scripts/eval-mvp/scope-audit-fixture.ps1`
- `scripts/eval-mvp/scope-audit-grader-fixture.ps1`

**参照 DSH**

- `packages/core/agent-loop/tests/cancel.spec.ts`
- `packages/core/agent-loop/tests/request-error.spec.ts`
- `packages/core/agent-loop/tests/resume.spec.ts`
- `packages/core/tools/tests/execution-mode.spec.ts`
- `packages/core/tools/tests/tools.spec.ts`

**拟采用的适配逻辑**

建立最小回归门禁：

- base 环境可用时不强制创建 venv；
- Agent 可在 workspace 内安装依赖并留下审计；
- Full Access 不会误解为可读取 private/secret；
- PowerShell/cwd/env 可复现；
- 取消、步数耗尽、provider error 不被 Grader 覆盖；
- collection error 与 test_failed 可区分；
- Django 运行产物不会误报 scope violation；
- summary 可从持久化事件重建。

## 13. 建议的实施顺序与每阶段留痕

建议按以下顺序逐阶段落地：

```text
执行环境事实契约
  -> 命令/依赖安装
  -> Full Access/权限
  -> cwd/env/PowerShell
  -> Agent Loop/步数/取消
  -> 事件/Session/日志
  -> Grader 适配器
  -> 错误分类/汇总
  -> 回归门禁
```

每个阶段应同时提交：

1. 代码入口和设计变更说明；
2. 最小自动化测试；
3. 一条成功样例和一条失败样例的原始日志；
4. `environment.json`、事件流、grader-result 和中文摘要；
5. 与 DSH 参考文件的对照记录；
6. 若复用 DSH 代码，登记 MIT 许可证和来源；若只参考行为，则明确“不复制代码”。

## 14. 不直接引入的内容

DSH 是完整 Harness，包含更多与当前评测目标无关的能力。当前不直接引入：

- 完整 Cordis 插件/服务体系；
- DSH CLI、桌面端、发布系统和插件市场；
- 与当前仓库无关的多 Agent 产品化层；
- Claude Code 本地快照中的未确认许可证代码。

Claude Code 可以作为行为参考，但文件、接口和代码不能在许可证未确认时直接复制。DSH 的 MIT 代码如需复制，也必须保留来源与许可证说明。

## 15. 当前结论与后续工作边界

本调研确认：

- 任务级 venv 是当前 Grader 在运行时创建的，不是用户手工创建；
- base 环境可以作为首选探测对象，当前实现尚未把它做成统一策略；
- Full Access 已注入评测 Session，但仍被 executable allowlist 独立限制；
- 依赖安装、环境变量、cwd、PowerShell 原生命令和 Grader 失败分类需要协同改造；
- DSH 已提供可直接对照的 shell、subprocess、permission、agent-loop、tool scheduler、session/projection/storage 入口；
- 本轮只形成调研文档，不实施上述代码改造，也不重跑整批评测。
