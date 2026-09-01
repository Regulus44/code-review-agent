# Windows 工具执行环境不匹配调研与改造指导

状态：阶段 1–6 已实施并完成验收（2026-08-28）。本轮实现只改动平台 shell 组装、PowerShell 路径解析、合同测试和工具契约文档；未修改 EventStore、AgentHost 生产逻辑或 Web。

调研仓库：

- 当前仓库：`D:\Develop\coding-agent`
- DSH 参考仓库：`D:\Develop\deepseek-harness-fork`
- 调研日期：2026-08-28

## 1. 任务定位

1. **Phase**：Phase 3B 工具与权限硬化，具体属于 Windows shell/tool execution parity。
2. **问题类型**：工具执行环境与宿主平台不匹配；同时涉及 Agent 的工具可见性、执行器选择和错误分类。
3. **当前是否改变契约**：本轮不改 Event、Tool、Task、Permission 或 Workspace contract；平台选择只通过内置工具组装完成，继续使用现有公共类型和事件。
4. **DSH 参考入口**：`packages/shell/shell/src/index.ts`、`packages/shell/bash-local/src/index.ts`、`packages/shell/pwsh-local/src/index.ts`、`packages/shell/tool-bash/src/index.ts`、`packages/shell/tool-pwsh/src/index.ts`、`packages/bundle/base/cordis.patch.yml`、`apps/cli/src/profile-boot.ts`、`apps/cli/tests/windows-shell.spec.ts`。
5. **上游来源**：本轮只做行为和结构调研，不复制 DSH 代码；无需登记代码复用。若后续复制或大量改编，先更新 `docs/../source-reuse-register.md` 并保留 DSH 的 MIT 许可证信息。
6. **验收场景**：Windows 无可用 WSL `/bin/bash` 时，Agent 不应选择或暴露 `bash`，而应使用可用的 `pwsh`；POSIX 主机仍使用 `bash`。
7. **回滚/禁用**：后续实现应以独立 checkpoint 提交；出现回归时禁用平台 shell roster/feature flag，恢复当前 `createBuiltinTools()` 注册方式，不影响 EventStore、Session 和已有历史。

## 2. 结论摘要

当前仓库已经实现了 `bash` 和 `pwsh` 两个显式工具，但工具注册和 Agent 的可见工具列表没有按平台收敛：

- `packages/tools/src/builtin.ts:369` 无条件注册 `bash`；
- `packages/tools/src/builtin.ts:373` 无条件注册 `pwsh`；
- `packages/tools/src/runtime.ts:118-121` 的 `listTools()` 只按权限和 tenant 过滤，不检查 `process.platform`；
- `packages/runtime/src/index.ts:2956` 对模型使用 `toolChoice: "auto"`，因此模型可以从同时可见的 `bash`/`pwsh` 中自行选择；
- `packages/tools/src/builtin.ts:546-549` 将 `bash` 固定为 `bash -lc`，Windows 上不会自动切换到 PowerShell；
- `packages/tools/src/builtin.ts:549` 只为 `pwsh` 在 Windows 使用 `CODING_AGENT_PWSH` 或裸 `pwsh`，没有对 bash 做可执行文件探测或路径配置。

因此问题根因是“平台不兼容的工具仍对 Agent 可见”，不是 WSL 错误没有被捕获。Windows 的 `bash.exe` 应用执行别名可能存在，但它实际转发到 WSL；别名存在不能证明 `/bin/bash` 可运行。

本项目按 DSH 的平台组合方式改造：**工具发现/组合阶段只暴露当前平台的 shell 工具；执行阶段继续保留 fail-closed 的可执行文件检查**。Windows 默认 shell 固定为 `pwsh`；POSIX 默认 shell 固定为 `bash`。本项不引入 `cmd`，也不把 Bash 命令字符串转换为 PowerShell。

## 3. 当前仓库实现与复现证据

### 3.1 Agent 与工具调用入口

| 层次 | 当前入口 | 作用 |
|---|---|---|
| HTTP/API 宿主 | `apps/api/src/server.ts:105` | 创建 `AgentHost`；`apps/api/src/server.ts:1203` 允许直接执行工具 |
| Agent Runtime | `packages/runtime/src/index.ts` | `AgentHost`、`runSteps()`、`collectModelResponse()`、`executeModelToolCall()` |
| 模型工具发现 | `packages/runtime/src/index.ts:2929` | `modelTools()` 将 `ToolRuntime.listTools()` 转换为模型 schema |
| 模型工具调用 | `packages/runtime/src/index.ts:3025` | 解析 JSON arguments 后调用 `ToolRuntime.execute()` |
| 工具注册 | `packages/tools/src/builtin.ts:273` | `createBuiltinTools()` 创建内置工具定义 |
| 工具执行管线 | `packages/tools/src/runtime.ts:82` | schema、permission、执行、结果和事件追加 |
| shell 执行 | `packages/tools/src/builtin.ts:532` | `executeShellCommand()` 校验 cwd，调用 `shellLaunch()` 和 `spawn()` |

当前 Agent 的 `system-prompt` 只会列出可见工具元数据（`packages/runtime/src/system-prompt.ts:82`、`:92`），没有将 Windows 平台事实映射为“只能使用 pwsh”的硬约束。Prompt 可以提供指导，但不能代替工具发现层的能力过滤。

### 3.2 复现

宿主检查：

```text
bash: C:\Users\12294\AppData\Local\Microsoft\WindowsApps\bash.exe
pwsh: C:\Users\12294\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe
```

直接执行 `bash -lc "pwd"` 的结果：

```text
<3>WSL (10 - Relay) ERROR: CreateProcessCommon:818: execvpe(/bin/bash) failed: No such file or directory
exit=1
```

通过当前已构建的 `bash` 工具执行 `pwd`，得到结构化但语义不够精确的结果：

```json
{
  "ok": false,
  "audit": {
    "shell": "bash",
    "exitCode": 1,
    "stderr": "<3>WSL ... execvpe(/bin/bash) failed ..."
  },
  "error": { "code": "NON_ZERO_EXIT" }
}
```

这里的 `NON_ZERO_EXIT` 会把“shell runner 不可用”伪装成“命令本身返回非零”。

同一环境执行当前 `pwsh` 工具的 `Get-Location` 返回 `exitCode: 0`，cwd 为 `D:\Develop\coding-agent`。这证明 Windows 默认执行器应优先使用 PowerShell，而不是依赖 WSL alias。

### 3.3 当前代码的关键缺口

1. **可见性缺口**：`bash`/`pwsh` 同时进入 registry 和模型 schema；没有平台或 capability 过滤。
2. **启动器缺口**：`shellLaunch("bash")` 固定 `{ executable: "bash", args: ["-lc", command] }`，没有 `bashPath`、WSL distro 检查或 `where.exe`/`Get-Command` 探测。
3. **错误分类缺口**：`ENOENT` 才映射为 `COMMAND_NOT_FOUND`；WSL alias 存在但内部 runner 缺失时只得到 `NON_ZERO_EXIT`。
4. **Prompt 缺口**：`ToolPromptRegistry` 已有 bash/pwsh 说明，但没有将“Windows 不要调用 bash”作为平台事实注入。
5. **测试缺口**：已有 `pwsh` smoke（`packages/tools/src/p1.test.ts:47`）和 Windows job 测试，但没有“Windows bash alias 指向不可用 WSL 时不应暴露/应分类为 unsupported”合同测试。

## 4. DSH 的实现方法

### 4.1 分层 seam：工具不直接决定进程细节

DSH 把 shell 分成三层：

1. `packages/shell/shell/src/index.ts`
   - 定义 `ShellExecutor` 抽象服务和 `ctx.shell` seam；
   - `resolve()` 负责补齐 cwd/timeout 等执行规格；
   - `run()`/`start()` 负责前台和后台生命周期；
   - 进程树、输出 spill、kill 和 dispose 由 `ctx.subprocess` 承担。
2. `packages/shell/bash-local/src/index.ts`
   - `LocalBashExecutor` 通过 `ctx.subprocess` 启动 `['bash', '-c', command]`；
   - README 明确声明 Bash 仅支持 POSIX，二进制名称是硬编码的；
   - 它不尝试把 Bash 命令改写成其他方言。
3. `packages/shell/pwsh-local/src/index.ts` 和 `src/resolve.ts`
   - `PwshLocalExecutor` 启动 `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>`；
   - `resolvePwshPath()` 优先使用显式配置，然后在 Windows 依次探测 PowerShell 7 安装目录、PATH 条目（包括 Microsoft Store alias）和 Windows PowerShell 5.1；
   - `candidatePwshPaths()`/`resolvePwshPath()` 是无副作用纯函数，测试可以注入 env 和 platform。

### 4.2 模型侧工具与执行器解耦

- `packages/shell/tool-bash/src/index.ts` 是模型侧 Bash 工具，消费 `ctx.shell`，负责 schema、description、跨调用 prompt、permission/sandbox 升权、background job 注册和 presenter。
- `packages/shell/tool-pwsh/src/index.ts` 与 Bash 工具逐调用对齐，但明确教授 PowerShell 方言、原生 Windows 路径、`$env:NAME`、Windows exit 1 中断语义。
- 两个工具都要求已挂载的执行器 provider；工具层不直接 `spawn()`。

这意味着 AgentLoop 不需要自行判断“调用哪一个二进制”。AgentLoop 只消费当前 composition 提供的工具 schema；平台选择由 composition 和 capability provider 决定。

### 4.3 DSH 的平台门控

`packages/bundle/base/cordis.patch.yml` 在同一份 patch 中按 `process.platform` 门控 shell stack：

```yaml
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: !!js process.platform === 'win32'

- id: pwsh-sandbox
  name: '@deepseek-ai/dsh-pwsh-sandbox'
  disabled: !!js process.platform !== 'win32'

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
```

因此：

- POSIX 组合暴露 Bash；
- Windows 组合暴露 PowerShell；
- 权限、sandbox-policy、approval、jobs 等公共层保持不变；
- 不会让 Windows Agent 看到一个需要 WSL 的 Bash 工具。

`apps/cli/src/profile-boot.ts` 的 `composeProfile()`/`runProfile()` 负责加载 bundle patch、profile patch、home patch 和 overlay；平台表达式在启动组合阶段求值。`apps/cli/src/bin.ts` 是 CLI 进程入口，`profile` 模式最终进入 `runProfile()`。

DSH 还在 `apps/cli/tests/windows-shell.spec.ts` 中验证同一份 patch 在 `win32` 与 `linux` 上得到相反的 shell roster，并验证权限相关行仍启用。这是本项目应直接借鉴的合同测试形态。

### 4.4 DSH 对“显式 Bash 配置”的边界

DSH 的本地 Bash executor 没有 Windows fallback；若部署确实需要 Bash，需提供能运行 Bash 的 executor/provider（例如 Git Bash、容器或其他 sandbox runner），然后在 composition 中显式启用对应 row。DSH 不把 PowerShell 文本翻译成 Bash，也不把 Bash 文本翻译成 PowerShell。

## 5. 对照 DSH 的实施改造与文件清单（当前不编码）

本项目直接采用 DSH 的“一个宿主只组装一个默认 shell stack”规则：Windows 只组装 `pwsh`，POSIX 只组装 `bash`。下面每一项同时规定本仓库的改动、禁止改动、DSH 学习入口和验收方式；实施时不得在这些边界之外自行扩展。

实施顺序固定为以下阶段；前一阶段的文件和测试完成后才能进入下一阶段，不跨阶段混入其他 Runtime、协议或 Web 改动：

| 阶段 | 模块与唯一目标 | 当前仓库操作 | DSH 对照入口 | 阶段完成标志 |
|---|---|---|---|---|
| 1 | 平台工具 roster | 修改 `packages/tools/src/builtin.ts`，注入 `platform`，按平台只注册一个 shell tool | `packages/bundle/base/cordis.patch.yml`、`apps/cli/tests/windows-shell.spec.ts` | win32 仅有 `pwsh`，POSIX 仅有 `bash`；未注册工具返回 `TOOL_NOT_FOUND` |
| 2 | PowerShell executable 解析 | 新增 `packages/tools/src/pwsh-path.ts`，并在 `builtin.ts` 接入解析结果 | `packages/shell/pwsh-local/src/resolve.ts`、`packages/shell/pwsh-local/src/index.ts` | 显式配置、默认安装目录、PATH 和 Windows PowerShell 的解析顺序有纯函数测试 |
| 3 | Shell 执行适配 | 只在 `packages/tools/src/builtin.ts` 调整 argv/启动参数；保留 cwd、timeout、cancel、job、audit 和 `shell:false` | `packages/shell/shell/src/index.ts`、`packages/shell/bash-local/src/index.ts`、`packages/shell/pwsh-local/src/index.ts`、`packages/subprocess/subprocess-local/src/spawn.ts` | pwsh/bash 的命令方言不转换，前台和后台生命周期语义保持不变 |
| 4 | Agent 可见性与 Prompt 校验 | 不修改 `packages/runtime/src/index.ts`；验证现有 `modelTools()` 链路只发布过滤后的 roster；不修改 `packages/tools/src/prompt-catalog.ts` | `packages/core/agent-loop/src/index.ts`、`packages/core/agent-loop/src/tool-calls.ts`、`packages/shell/tool-bash/src/index.ts`、`packages/shell/tool-pwsh/src/index.ts` | 模型 schema 和 prompt 只包含当前平台 shell，AgentHost 不新增平台分支 |
| 5 | 合同、恢复与安全测试 | 修改/新增 `packages/tools/src/p1.test.ts`、`packages/tools/src/index.test.ts`、`packages/tools/src/jobs.test.ts`、`packages/tools/src/pwsh-path.test.ts`、`packages/runtime/src/index.test.ts`；修改 `docs/tool-contract.md` | `apps/cli/tests/windows-shell.spec.ts`、`packages/shell/pwsh-local/tests/executor.spec.ts`、`packages/shell/tool-pwsh/tests/tools.spec.ts`、`packages/core/agent-loop/tests/tool-calls.spec.ts` | roster、路径解析、前后台执行、权限、`TOOL_NOT_FOUND`、事件回放测试全部通过 |
| 6 | 阶段验收与 checkpoint | 运行 `pnpm typecheck`、`pnpm test` 和新增合同测试；只提交本阶段文件 | DSH Windows shell 合同测试的 win32/linux 双平台断言 | 通过第 5.9 节矩阵并创建独立 Git checkpoint，才允许进入后续阶段 |

### 5.1 工具组装与平台 roster：必须修改 `packages/tools/src/builtin.ts`

1. 在 `createBuiltinTools()` 的 options 中增加 `platform?: NodeJS.Platform`，默认值为 `process.platform`；该参数只用于宿主组合和测试，不进入公共 `ToolDefinition` contract。
2. 将当前 `name: "bash"` 和 `name: "pwsh"` 两个定义拆成独立 factory。`platform === "win32"` 时只把 `pwsh` factory 加入 tools 数组；`platform !== "win32"` 时只把 `bash` factory 加入 tools 数组。
3. 保留其他内置工具的注册顺序、schema、permission、executionMode 和事件语义。
4. 让 `shellLaunch()` 接收已选择的平台和 shell kind；Windows `pwsh` 使用 PowerShell argv，POSIX `bash` 使用 `bash -lc`。禁止在运行时把 Bash 文本静默改写成 PowerShell 或 `cmd.exe`。
5. 直接调用未注册的跨平台 shell 必须沿用现有 registry `TOOL_NOT_FOUND` 的 fail-closed 语义，不自动切换到另一种 shell。

DSH 学习入口：

- `packages/bundle/base/cordis.patch.yml`：`bash-sandbox`/`tool-bash` 与 `pwsh-sandbox`/`tool-pwsh` 的 `process.platform` 门控；
- `packages/shell/tool-bash/src/index.ts:apply()`、`packages/shell/tool-pwsh/src/index.ts:apply()`：模型侧工具只消费当前 `ctx.shell` provider；
- `apps/cli/tests/windows-shell.spec.ts`：同一份 composition 在 `win32`/`linux` 上形成相反 roster 的合同测试。

### 5.2 PowerShell executable 解析：新增 `packages/tools/src/pwsh-path.ts`，并修改 `builtin.ts`

1. 新增无副作用的 `candidatePwshPaths(env, platform)` 与 `resolvePwshPath(configured, env, platform)`；`platform !== "win32"` 时返回裸 `pwsh`，`win32` 时按固定顺序探测：显式 `CODING_AGENT_PWSH` → PowerShell 7 默认安装目录 → PATH 中的 `pwsh.exe` → Windows PowerShell 5.1。
2. `builtin.ts:shellLaunch("pwsh", ...)` 只调用该解析函数并把结果作为 `spawn()` 的 executable；继续使用 `{ shell: false, windowsHide: true }`。
3. 不把 `WindowsApps\\bash.exe` 的存在当成 WSL 可用性证明；本次默认 Windows roster 不注册 Bash，因此不增加 WSL 探测或 Bash 自动 fallback。

DSH 学习入口：`packages/shell/pwsh-local/src/resolve.ts` 的 `candidatePwshPaths()`、`resolvePwshPath()`，以及 `packages/shell/pwsh-local/src/index.ts:PwshLocalExecutor.argv()`。

### 5.3 执行生命周期：只修改 `builtin.ts` 中的 shell 适配，不改变统一工具管线

保留 `executeShellCommand()` 对 workspace cwd、timeout、取消、输出预算、background job、permission 和审计事件的现有责任。不得把执行器选择放入 `AgentHost`，不得绕过 `ToolRuntime`，不得修改 `shell: false` 为 true。

DSH 学习入口：

- `packages/shell/shell/src/index.ts:ShellExecutor`：`resolve()`、`run()`、`start()` 的 seam 边界；
- `packages/shell/bash-local/src/index.ts:LocalBashExecutor.resolve/run/start`：Bash fresh process、输出预算、deadline 和后台句柄；
- `packages/shell/pwsh-local/src/index.ts:PwshLocalExecutor.resolve/run/start`：PowerShell 非交互启动、编码和 Windows 路径语义；
- `packages/subprocess/subprocess-local/src/spawn.ts`：输出收集、spill、进程树终止和 Windows `taskkill`。

### 5.4 AgentHost 与模型可见性：生产代码不修改，测试必须覆盖

保留 `packages/runtime/src/index.ts` 当前构造链：`createBuiltinTools()` → `ToolRegistry` → `ToolRuntime.listTools()` → `modelTools()` → `collectModelResponse()`。不在 `AgentHost` 或 `runSteps()` 中新增第二套平台判断。

必须补充的测试位于 `packages/runtime/src/index.test.ts`：使用注入了 `createBuiltinTools({ platform })` 的 registry 和 scripted model，验证 win32 请求只包含 `pwsh` schema、POSIX 请求只包含 `bash` schema；验证未注册跨平台 tool 返回 `TOOL_NOT_FOUND`，且既有 `tool/call`/`tool/result` 回放语义不变。

DSH 学习入口：`packages/core/agent-loop/src/index.ts` 的 AgentLoop service、`packages/core/agent-loop/src/tool-calls.ts:executeToolCalls()` 的工具调度边界。DSH 的原则是 AgentLoop 读取 composition 已经决定的工具，不在 loop 内解释操作系统。

### 5.5 Prompt：本轮只验证，不修改 `packages/tools/src/prompt-catalog.ts`

`ToolPromptRegistry.assemble()` 已按传入的可见工具过滤 prompt，因此平台 roster 完成后，Windows 不会组装 `bash` guidance，POSIX 不会组装 `pwsh` guidance。本轮不修改 `packages/tools/src/prompt-catalog.ts`、`packages/runtime/src/system-prompt.ts` 或 `packages/tools/src/prompt.ts`；测试只验证现有方言说明与实际可见工具一致。

DSH 学习入口：`packages/shell/tool-bash/src/index.ts` 的 `tool:bash` system-prompt section、`packages/shell/tool-pwsh/src/index.ts` 的 `tool:pwsh` section，以及两个工具的 description/README 对方言、cwd、exit marker 和 background 语义的说明。

### 5.6 测试文件：逐项修改并绑定 DSH 测试

| 当前仓库文件 | 必须增加的测试 | DSH 对照 |
|---|---|---|
| `packages/tools/src/p1.test.ts` | `resolvePwshPath`/候选路径纯函数、win32 roster、真实 `pwsh` 前台 smoke | `packages/shell/pwsh-local/tests/executor.spec.ts` |
| `packages/tools/src/index.test.ts` | 注入 `platform=win32/linux` 的工具目录；未注册跨平台 shell 的 `TOOL_NOT_FOUND` | `apps/cli/tests/windows-shell.spec.ts` |
| `packages/tools/src/jobs.test.ts` | Windows `pwsh` background job 的 cwd、输出、取消、结束和恢复 | `packages/shell/tool-pwsh/tests/tools.spec.ts`、`packages/subprocess/subprocess-local/tests/spawn.spec.ts` |
| `packages/runtime/src/index.test.ts` | scripted model 的可见 schema、工具调用链和 tool/result replay | `packages/core/agent-loop/tests/tool-calls.spec.ts` |
| `packages/tools/src/pwsh-path.test.ts`（新增） | 注入 env/platform 的路径解析顺序、无候选时裸 `pwsh` 回退 | `packages/shell/pwsh-local/tests/executor.spec.ts` |

### 5.7 文档和明确不修改项

必须修改 `docs/tool-contract.md`，写明默认 roster：Windows=`pwsh`、POSIX=`bash`，以及未注册跨平台 shell 的 `TOOL_NOT_FOUND` 行为；文案依据 `packages/shell/tool-bash/README.zh.md` 和 `packages/shell/tool-pwsh/README.zh.md`。

本项明确不修改：`packages/contracts/src/index.ts`、`packages/tools/src/registry.ts`、`packages/tools/src/runtime.ts`、`packages/runtime/src/system-prompt.ts`、`apps/api/src/server.ts`、`docs/event-contract.md`。原因是平台选择在内置工具组装阶段完成，现有 registry、runtime、AgentHost 和 API 已经消费该 roster；没有新增事件或公共字段。

### 5.8 程序入口和代码学习顺序

本项目实施时按以下调用链阅读和验证：

```text
apps/api/src/server.ts:105
  → new AgentHost()
  → packages/runtime/src/index.ts:292
  → createBuiltinTools({ platform })
  → packages/runtime/src/index.ts:modelTools()
  → packages/tools/src/runtime.ts:listTools()/execute()
  → packages/tools/src/builtin.ts:executeShellCommand()
  → shellLaunch() / spawn()
```

DSH 对应链路：

```text
apps/cli/src/bin.ts
  → apps/cli/src/profile-boot.ts:runProfile()
  → packages/bundle/base/cordis.patch.yml 的 process.platform 门控 row
  → packages/shell/pwsh-sandbox/src/index.ts 或 bash-sandbox/src/index.ts
  → packages/shell/tool-pwsh/src/index.ts:apply() 或 tool-bash/src/index.ts:apply()
  → packages/shell/*-local/src/index.ts
  → packages/subprocess/subprocess-local/src/spawn.ts
```

必须学习的责任顺序是：先由 composition/provider 决定平台工具 roster，再由 AgentLoop 消费可见 schema，最后由 shell executor 负责 argv、进程生命周期和结果分类。当前项目只吸收该边界，不复制 Cordis composition。

### 5.9 验收测试矩阵

最小验证矩阵：

| 场景 | 预期 |
|---|---|
| win32 + 无 `/bin/bash` + 默认 roster | `bash` 不在 `ToolRegistry`、模型 schema 和工具 prompt；`pwsh` 可见 |
| win32 + 显式调用 `bash` | registry 返回 `TOOL_NOT_FOUND`；不自动改用 pwsh |
| win32 + `CODING_AGENT_PWSH` 有效 | `pwsh` 前台和 background job 成功，cwd/exit/audit 正确 |
| linux/macOS | `bash` roster 和现有语义保持；`pwsh` 不注册 |
| Agent 重启/SSE replay | platform visibility 不改变历史 tool/result 事件；projection 可回放 |
| 权限 preset | 平台过滤先于模型可见性，不能借平台切换绕过 permission/approval |

提交前应运行与改动范围匹配的 `pnpm typecheck`、`pnpm test`，以及新增的 tools/runtime 合同测试。Windows 上无需安装或配置 WSL；默认 roster 测试必须证明无论 `WindowsApps\\bash.exe` 是否存在，Agent 都不会看到或调用 `bash`。

### 5.10 阶段 5–6 实施与验收结果

阶段 5 已按上表逐项完成：

- `packages/tools/src/index.test.ts` 增加 win32/linux roster 和未注册 shell 的 `ToolNotFoundError`/`TOOL_NOT_FOUND` 合同测试；
- `packages/tools/src/jobs.test.ts` 增加 Windows `pwsh` background job 的 workspace cwd、stdout、`job/started`/`job/output`/`job/ended`、durable event recovery、spill 读取和取消终态测试；
- `packages/tools/src/pwsh-path.test.ts`、`packages/tools/src/p1.test.ts` 覆盖路径解析、前台 PowerShell smoke、环境变量、argv、cwd、exit/audit；
- `packages/runtime/src/index.test.ts` 覆盖 AgentHost 模型请求中的平台 shell schema 和 prompt guidance，验证平台过滤发生在模型可见性之前；
- `docs/tool-contract.md` 固化 Windows=`pwsh`、POSIX=`bash` 的 roster、未注册工具错误码和不做 shell 方言转换的边界。

阶段 6 验收命令及结果：

```text
pnpm --filter @coding-agent/tools test   ✓ 9 files / 68 tests
pnpm --filter @coding-agent/runtime test ✓ 1 file / 56 tests
pnpm typecheck                                ✓
pnpm test                                      ✓ workspace 全部通过
git diff --check                               ✓
```

当前 Windows 主机的 `pwsh` 前台和后台 fixture 均通过；未访问 WSL `/bin/bash`。阶段 5–6 的独立 Git checkpoint 记录在本次提交中；回滚只涉及本节列出的测试、shell roster/path 实现和工具契约，不改变公共 Event/Tool/Task/Permission/Workspace contract。

## 6. 不属于本轮的内容

- 不恢复旧 Python Runtime 作为执行底座；
- 不把 DSH Cordis、插件系统或品牌资源复制进当前仓库；
- 不在本轮修改 `AGENTS.md`、EventStore 或 Web UI；
- 不把 `cmd.exe`、PowerShell 和 Bash 合并为一个没有方言声明的通用字符串工具；
- 不通过关闭 `shell=false`、放宽 workspace 或绕过 approval 来“修复”执行失败。

## 7. 结论

本项目按 DSH 直接落地“平台感知工具 roster + Windows 默认 `pwsh` + POSIX 默认 `bash`”。平台选择在内置工具组装阶段完成，AgentLoop 只消费已经筛选的工具 schema；执行器继续保留 workspace、permission、timeout、cancel、output budget 和 audit 语义，事件事实来源不变。
