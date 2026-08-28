# Windows 工具执行环境不匹配调研与改造指导

状态：调研完成，当前只新增文档，未修改运行时代码。

调研仓库：

- 当前仓库：`D:\Develop\code-review-agent`
- DSH 参考仓库：`D:\Develop\deepseek-harness-fork`
- 调研日期：2026-08-28

## 1. 任务定位

1. **Phase**：Phase 3B 工具与权限硬化，具体属于 Windows shell/tool execution parity。
2. **问题类型**：工具执行环境与宿主平台不匹配；同时涉及 Agent 的工具可见性、执行器选择和错误分类。
3. **当前是否改变契约**：本轮不改 Event、Tool、Task、Permission 或 Workspace contract；平台选择只通过内置工具组装完成，继续使用现有公共类型和事件。
4. **DSH 参考入口**：`packages/shell/shell/src/index.ts`、`packages/shell/bash-local/src/index.ts`、`packages/shell/pwsh-local/src/index.ts`、`packages/shell/tool-bash/src/index.ts`、`packages/shell/tool-pwsh/src/index.ts`、`packages/bundle/base/cordis.patch.yml`、`apps/cli/src/profile-boot.ts`、`apps/cli/tests/windows-shell.spec.ts`。
5. **上游来源**：本轮只做行为和结构调研，不复制 DSH 代码；无需登记代码复用。若后续复制或大量改编，先更新 `docs/source-reuse-register.md` 并保留 DSH 的 MIT 许可证信息。
6. **验收场景**：Windows 无可用 WSL `/bin/bash` 时，Agent 不应选择或暴露 `bash`，而应使用可用的 `pwsh`；POSIX 主机仍使用 `bash`。
7. **回滚/禁用**：后续实现应以独立 checkpoint 提交；出现回归时禁用平台 shell roster/feature flag，恢复当前 `createBuiltinTools()` 注册方式，不影响 EventStore、Session 和已有历史。

## 2. 结论摘要

当前仓库已经实现了 `bash` 和 `pwsh` 两个显式工具，但工具注册和 Agent 的可见工具列表没有按平台收敛：

- `packages/tools/src/builtin.ts:369` 无条件注册 `bash`；
- `packages/tools/src/builtin.ts:373` 无条件注册 `pwsh`；
- `packages/tools/src/runtime.ts:118-121` 的 `listTools()` 只按权限和 tenant 过滤，不检查 `process.platform`；
- `packages/runtime/src/index.ts:2956` 对模型使用 `toolChoice: "auto"`，因此模型可以从同时可见的 `bash`/`pwsh` 中自行选择；
- `packages/tools/src/builtin.ts:546-549` 将 `bash` 固定为 `bash -lc`，Windows 上不会自动切换到 PowerShell；
- `packages/tools/src/builtin.ts:549` 只为 `pwsh` 在 Windows 使用 `CODE_REVIEW_AGENT_PWSH` 或裸 `pwsh`，没有对 bash 做可执行文件探测或路径配置。

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

同一环境执行当前 `pwsh` 工具的 `Get-Location` 返回 `exitCode: 0`，cwd 为 `D:\Develop\code-review-agent`。这证明 Windows 默认执行器应优先使用 PowerShell，而不是依赖 WSL alias。

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

## 5. 对照 DSH 的改造方案（当前不编码）

本项目采用与 DSH 相同的“一个宿主只组装一个默认 shell stack”规则：Windows 组装 `pwsh` 工具和 PowerShell 执行器；POSIX 组装 `bash` 工具和 Bash 执行器。平台不匹配的工具不注册到 `ToolRegistry`，因此不会进入 `ToolRuntime.listTools()`、`AgentHost.modelTools()`、模型 schema 或系统提示词中的可见工具目录。

本次改造的目标状态如下：

```text
Windows
  createBuiltinTools(platform=win32)
    → 注册 pwsh
    → 不注册 bash
    → AgentHost.modelTools() 仅输出 pwsh schema
    → pwsh -NoLogo -NoProfile -NonInteractive -Command <command>

POSIX
  createBuiltinTools(platform=linux|darwin)
    → 注册 bash
    → 不注册 pwsh
    → AgentHost.modelTools() 仅输出 bash schema
    → bash -lc <command>
```

实施步骤固定如下：

1. 在 `packages/tools/src/builtin.ts` 的 `createBuiltinTools()` 引入仅供宿主和测试使用的 `platform` 参数，默认值为 `process.platform`。
2. 将现有 `bash` 与 `pwsh` 定义拆成独立的 factory，并由 `platform` 决定只加入其中一个定义：`win32` 加入 `pwsh`，其他受支持平台加入 `bash`。`ToolDefinition`、`packages/contracts` 和 `ToolRegistry` 的公共接口保持不变。
3. 将 PowerShell executable 解析从现有 `shellLaunch()` 中抽出为纯函数，按 DSH `resolvePwshPath()` 的顺序处理：显式 `CODE_REVIEW_AGENT_PWSH` → PowerShell 7 默认安装目录 → PATH 中的 `pwsh.exe` → Windows PowerShell 5.1。解析结果继续以 `spawn(..., { shell: false })` 执行。
4. 保留 `executeShellCommand()` 对 workspace cwd、timeout、取消、输出预算、background job、permission 和审计事件的现有责任；不在 `shellLaunch()` 中把 Bash 方言命令替换为 PowerShell，也不经 `cmd.exe` 中转。
5. 通过 `packages/runtime/src/index.ts` 已有的 `modelTools() → ToolRuntime.listTools()` 链路发布过滤后的 roster。Runtime 不新增另一套平台判断，避免模型可见性和执行器选择分叉。
6. 只为实际可见的工具保留对应的 `ToolPromptRegistry` 指引：Windows 请求只接收 `pwsh` 的 PowerShell 方言说明，POSIX 请求只接收 `bash` 的 Bash 方言说明。
7. 直接 API 调用一个未注册的跨平台 shell 时，沿用 registry 的 `TOOL_NOT_FOUND` fail-closed 语义。该行为与 DSH 的 composition gating 一致；不得改用另一种 shell 代为执行。

Windows 若将来需要 Git Bash、WSL 或容器 Bash，必须新增一个独立的、显式配置的 Bash executor/provider 和对应工具注册 row，再按 DSH 的 composition 规则替换 `pwsh` stack；它不属于本次默认 Windows 执行环境改造。

## 6. 后续实现需要修改/参照的文件

### 6.1 当前仓库：修改点与 DSH 学习点

| 文件 | 实现职责 | 需要参照的 DSH 文件 |
|---|---|---|
| `packages/tools/src/builtin.ts` | 为 `createBuiltinTools()` 增加可注入 `platform`；拆出 Bash/Pwsh tool factory；按平台注册单一 shell tool；实现 PowerShell executable 纯解析函数；保留 `shell=false`、cwd、超时、取消和审计 | `packages/shell/bash-local/src/index.ts`、`packages/shell/pwsh-local/src/index.ts`、`packages/shell/pwsh-local/src/resolve.ts` |
| `packages/tools/src/prompt-catalog.ts` | 将 Bash/Pwsh 指引与实际注册的 tool factory 对齐；Windows 只提供 PowerShell 方言语义 | `packages/shell/tool-bash/src/index.ts`、`packages/shell/tool-pwsh/src/index.ts` 的 description 和 system-prompt section |
| `packages/runtime/src/index.ts` | 验证构造 `AgentHost` 时只把过滤后的 builtin roster 注入 `ToolRegistry`；保持 `modelTools()` 只转换 `ToolRuntime.listTools()` 的结果 | `packages/core/agent-loop/src/index.ts`、`packages/core/agent-loop/src/tool-calls.ts` |
| `packages/tools/src/p1.test.ts` | 添加 PowerShell path resolution、win32 roster 和前台 `pwsh` smoke | `packages/shell/pwsh-local/tests/executor.spec.ts` |
| `packages/tools/src/index.test.ts` | 添加 win32/linux 工具目录、模型可见性前置条件和未注册跨平台 tool 的 fail-closed 测试 | `apps/cli/tests/windows-shell.spec.ts` |
| `packages/tools/src/jobs.test.ts` | 验证 Windows `pwsh` background job 仍保留 cwd、输出、取消和恢复语义 | `packages/shell/tool-pwsh/tests/tools.spec.ts`、`packages/subprocess/subprocess-local/tests/spawn.spec.ts` |
| `packages/runtime/src/index.test.ts` | 使用 scripted model 验证 Windows 模型请求 schema 仅含 `pwsh`、POSIX 仅含 `bash`，并验证 tool/result 事件回放不变 | `packages/core/agent-loop/tests/tool-calls.spec.ts`、`apps/cli/tests/windows-shell.spec.ts` |
| `docs/tool-contract.md` | 记录默认 shell roster：Windows=`pwsh`，POSIX=`bash`，以及未注册 tool 的 fail-closed 行为 | `packages/shell/tool-bash/README.zh.md`、`packages/shell/tool-pwsh/README.zh.md` |

本实现不修改 `packages/contracts/src/index.ts`、`packages/tools/src/registry.ts`、`packages/tools/src/runtime.ts`、`packages/runtime/src/system-prompt.ts` 或 `apps/api/src/server.ts`：平台选择在内置工具组装时完成；现有 registry、runtime、modelTools 和 API 会自然消费单一 roster。只有在后续引入可插拔的多 shell provider 时，才新建独立 executor seam；届时再通过 ADR 定义公共 contract，不在本项提前扩张 Runtime 边界。

### 6.2 程序和代码入口顺序

后续编码应按以下调用链定位和验证：

```text
apps/api/src/server.ts
  → new AgentHost()
  → packages/runtime/src/index.ts:runSteps()
  → modelTools() / collectModelResponse()
  → packages/tools/src/runtime.ts:listTools()/execute()
  → packages/tools/src/builtin.ts:executeShellCommand()
  → shellLaunch() / spawn()
```

DSH 的对应启动链路为：`apps/cli/src/bin.ts` → `apps/cli/src/profile-boot.ts:runProfile()` → `packages/bundle/base/cordis.patch.yml` 的平台门控 row → `packages/shell/pwsh-sandbox/src/index.ts` 或 `packages/shell/bash-sandbox/src/index.ts` → `packages/shell/tool-pwsh/src/index.ts` 或 `packages/shell/tool-bash/src/index.ts`。本项目不复制 Cordis composition，但应学习其“先完成平台 roster，再让 AgentLoop 读取可见工具”的责任顺序。

### 6.3 测试入口

最小验证矩阵：

| 场景 | 预期 |
|---|---|
| win32 + 无 `/bin/bash` + 默认 roster | `bash` 不在 `ToolRegistry`、模型 schema 和工具 prompt；`pwsh` 可见 |
| win32 + 显式调用 `bash` | registry 返回 `TOOL_NOT_FOUND`；不自动改用 pwsh |
| win32 + `CODE_REVIEW_AGENT_PWSH` 有效 | `pwsh` 前台和 background job 成功，cwd/exit/audit 正确 |
| linux/macOS | `bash` roster 和现有语义保持；`pwsh` 不注册 |
| Agent 重启/SSE replay | platform visibility 不改变历史 tool/result 事件；projection 可回放 |
| 权限 preset | 平台过滤先于模型可见性，不能借平台切换绕过 permission/approval |

提交前应运行与改动范围匹配的 `pnpm typecheck`、`pnpm test`，以及新增的 tools/runtime 合同测试。Windows 上无需安装或配置 WSL；默认 roster 测试必须证明无论 `WindowsApps\\bash.exe` 是否存在，Agent 都不会看到或调用 `bash`。

## 7. 不属于本轮的内容

- 不恢复旧 Python Runtime 作为执行底座；
- 不把 DSH Cordis、插件系统或品牌资源复制进当前仓库；
- 不在本轮修改 `AGENTS.md`、EventStore 或 Web UI；
- 不把 `cmd.exe`、PowerShell 和 Bash 合并为一个没有方言声明的通用字符串工具；
- 不通过关闭 `shell=false`、放宽 workspace 或绕过 approval 来“修复”执行失败。

## 8. 结论

本项目按 DSH 直接落地“平台感知工具 roster + Windows 默认 `pwsh` + POSIX 默认 `bash`”。平台选择在内置工具组装阶段完成，AgentLoop 只消费已经筛选的工具 schema；执行器继续保留 workspace、permission、timeout、cancel、output budget 和 audit 语义，事件事实来源不变。
