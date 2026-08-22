# Phase 3：工具运行时与权限开发日志

## 2026-08-22：建立 Phase 3B 工具强化计划

Phase 3 的基础 ToolRuntime、权限和审计 checkpoint 已完成。对当前工具池和本地 DSH 参考实现复核后，确认下一阶段的主要缺口集中在工具级 Prompt、编辑质量、Shell/PowerShell/Terminal 语义、结构化 presentation、Goal/后台任务/Session query/LSP 等 Coding Agent 能力。因此新增独立计划 [Phase 3B：Coding Agent 工具池与工具 Prompt 强化](../phase-plans/phase-3b-tool-hardening.zh-CN.md)。

计划分为：

- P0：ToolPromptRegistry、现有文件/搜索/Git 工具 prompt、stale/conflict/diff/patch、Bash/Pwsh/Terminal/job 基础语义、Plan/Todo/AskUser 规则；
- P1：Goal、background jobs、Session query、read_image、LSP 只读诊断和变更预览；
- P2：Web search/fetch、Skills、Subagent 消息控制、Workflow/Ralph。

本次只更新执行计划和阶段索引，不改变现有工具运行时；后续每个 3B checkpoint 都必须有独立 commit、测试门禁和回滚点。

状态：`in_progress`。原先的 `3B.final` 结论仅视为阶段性验收记录，后续审计发现 patch/diff、LSP 生命周期和 job spill 尚未完全闭合。

## 2026-08-22：Phase 3B 继续开发——多文件 patch/diff checkpoint

### 变更范围

- 新增 `packages/tools/src/patch.ts`：解析 workspace-bound unified patch，支持多文件 create/update/delete、hunk 上下文校验、stale base、冲突诊断和原子失败回滚；
- 新增 `apply_patch`、`reject_patch`、`rollback_patch`，继续走 schema、WorkspaceResolver、ToolRuntime、写权限审批、结构化结果、diff presentation 和事件审计；
- patch before/after snapshot 持久化到 `.agent-artifacts/patches/<patchId>.json`，新 host 可按 patchId 恢复 rollback；reject/rollback 成功后清理 snapshot，事件历史保留；
- 新增 `patch/preview`、`patch/applied`、`patch/rejected`、`patch/rolled_back` 事件；
- 工具 Prompt catalog 增加 patch 的预览→审批→应用/拒绝→回滚顺序和安全边界；
- 以 DSH diff/write/edit 行为作为主要参考，未复制代码、未引入 DSH 依赖；Claude Code 仍只作为 prompt/UX 补充参考。

### 验证

- `pnpm typecheck` 通过；
- 新增 `packages/tools/src/patch.test.ts`：3 项通过，覆盖多文件 patch、create/update/delete、stale/conflict、审批、reject、apply、rollback 和审计事件；
- `packages/tools/src/prompt.test.ts`：4 项通过；
- `git diff --check` 通过。

### 当前未闭合项

- LSP 尚缺生命周期事件、取消请求、server crash/restart recovery、stderr/output budget 和 fixture 状态机；
- background job 尚缺 durable spill artifact、bounded event chunk 和更完整的重启/取消状态测试；
- 因此 Phase 3B 仍保持 `in_progress`，不重复执行普通基线测试。

## 2026-08-22：Phase 3B LSP 只读闭包与 job spill checkpoint

### 变更范围

- LSP manager 按 `serverId + workspace` 复用 transport，增加 `lsp/server`、`lsp/request` 生命周期/请求事件；
- LSP request 统一使用 `AbortSignal`，取消时发送 `$/cancelRequest`，并区分 cancelled、timeout、protocol、server error 和 crash；
- stdio framing 增加 header/message/document/stderr 边界；server crash 后下一次只自动重建一次 transport，host 配置仍是唯一 executable 来源；
- background job 将完整 stdout/stderr 写入 `.agent-artifacts/jobs/<jobId>.log`，`job/output` 事件只保留有界 live chunk，`job_output` 支持 spill 增量读取；
- 重启恢复优先读取 durable artifact，缺失时保留 bounded event fallback，并继续将失去子进程附着的 job 标记为 `orphaned`。

### 验证

- `pnpm typecheck` 通过；
- `lsp.test.ts`：3 项通过，覆盖 lifecycle/request event、transport reuse、crash restart、cancel、document bound 和 fixture server；
- `jobs.test.ts`：4 项通过，覆盖启动、owner kill、durable artifact recovery、bounded event output 和完整 spill 读取；
- `git diff --check` 待本 checkpoint 提交前执行。

### 当前未闭合项

- 尚未重复执行普通基线测试，也未进行真实 DeepSeek 网络 smoke；
- Web 已补 patch preview/apply/reject 与 LSP server/request 的 SSE 订阅和 transcript row；专用 patch 操作仍复用通用 ToolRuntime approval/execute contract，不在浏览器侧直写文件；
- Phase 3B 继续保持 `in_progress`。

## 2026-08-22：Phase 3B.0 ToolPromptRegistry checkpoint

### 变更范围

- 新增独立 `ToolPromptRegistry` 和 `ToolPromptSpec`，固定 Purpose、When to use、When not to use、Prerequisites、Input rules、Sequencing、Result interpretation、Failure recovery、Safety 九段；
- assembly 只接收当前 permission-filtered 可见工具，按 prompt order/name 做平台无关的确定性排序，并执行上下文长度预算；
- 为当前内置 TypeScript 工具池建立本地 prompt catalog；未知 MCP 工具只使用短 fallback，不把远程 description 提升为系统规则；
- AgentHost 将工具 guidance 注入现有分层 system prompt，未改变 ToolRuntime 的执行、权限、workspace 或事件语义；
- 登记 DSH system-prompt/tools 的行为参考和 Claude Code 的工具 prompt/Todo 行为参考。

### 验证

- `pnpm typecheck` 通过；
- `pnpm --filter @code-review-agent/tools test`：27 项通过；
- `pnpm --filter @code-review-agent/runtime test`：12 项通过；
- `git diff --check` 通过。

### 下一步

进入 3B.1：补齐 P0 工具的 schema/prompt/result/presentation 对齐合同，随后强化 read/search/Git 组合和编辑 stale/conflict/diff 语义。

## 2026-08-22：Phase 3B.1 P0 文件、搜索和结果 presentation checkpoint

### 变更范围

- `read_file` 增加 1-based `offset`/`limit`，返回稳定行号、总行数、截断标记和 `nextOffset`；识别二进制目标并提供结构化 remedy；
- `glob` 支持确定性排序、`**`/`*`/`?` 路径模式、结果上限和过量结果下一步；
- `grep` 增加 literal/regex、大小写、上下文行、路径约束、二进制跳过、结果截断和结构化 match；
- `git_diff` 支持限定路径；命令结果区分 `WORKDIR_INVALID`、`COMMAND_NOT_FOUND`、`NON_ZERO_EXIT`、`COMMAND_CANCELLED` 和 `OUTPUT_TRUNCATED`；
- `ToolRuntime` 为每次 `tool/call` 追加稳定 call presentation，并使用工具 `presentResult` 或结构化结果生成 result presentation；错误统一携带可行动 remedy。

### 验证

- `pnpm typecheck` 通过；
- `pnpm --filter @code-review-agent/tools test`：29 项通过，覆盖行范围读取、glob/grep 结构化结果、presentation 和既有安全回归。

### 下一步

进入 3B.2：实现结构化多段编辑、stale/version 检测、冲突停止与重新读取、unified diff/patch parser 和 apply/reject 审计。

## 2026-08-22：Phase 3B.2 结构化编辑与 stale/conflict checkpoint

### 变更范围

- `edit_file` 保留旧的 `path/oldText/newText` 输入，并增加 `edits[]` 多段唯一替换和 `expectedHash`；
- 编辑在写入前再次读取并比较 hash；当前内容不匹配返回 `EDIT_STALE`，读取后发生变化返回 `EDIT_CONFLICT`，两种情况都停止写入；
- 错误包含 path、匹配数量和有限上下文，成功结果包含操作状态、before/after hash 和 unified diff；
- `write_file` 增加 `create`、`overwrite`、`append` 三种模式，继续兼容 `overwrite=true`，并统一返回 diff/preview；
- 更新 `docs/tool-contract.md`，明确编辑、写入、presentation 和 audit/modelView 边界。

### 验证

- `pnpm typecheck` 通过；
- `pnpm --filter @code-review-agent/tools test`：32 项通过，覆盖多段编辑、stale、append、diff 和既有权限/恢复回归；
- `pnpm --filter @code-review-agent/api test`：13 项通过，验证结构化 read result 的 API 兼容更新。

### 下一步

进入 3B.3：补齐 Bash/PowerShell 一等语义、短命令与持久 Terminal/job 选择、Windows cwd/环境/退出码/取消和长任务 presentation。

## 2026-08-22：Phase 3B.3 Bash/Pwsh/Background Job 基础 checkpoint

### 变更范围

- 新增显式 `bash` 和 `pwsh` 工具；每次前台调用使用 fresh shell、workspace-bound `workdir`、stdout/stderr、timeout、cancel、exit code 和 output truncation 语义；
- 新增 `JobManager` 以及 `job_output`、`job_kill`、`job_list`，job 记录 session/workspace owner、cwd、command、状态、exit/signal、增量输出和截断元数据；
- background job 通过 `job/started`、`job/output`、`job/ended` 事件进入统一审计管线，shell 字符串只存在于显式 bash/pwsh 工具，不改变 `run_command` 的 argv 安全边界；
- AgentHost 默认内置工具池共享 TerminalManager 和 JobManager；prompt catalog 增加 shell/job 的跨调用规则；
- 同步 `docs/tool-contract.md` 与 `docs/event-contract.md`。

### 验证

- `pnpm typecheck` 通过；
- `pnpm --filter @code-review-agent/tools test`：34 项通过，含 JobManager 启动、输出、owner 隔离和 kill 测试；
- `pnpm --filter @code-review-agent/runtime test`：12 项通过。

### 下一步

继续 3B.3 的 Windows/Bash smoke 与 Terminal/job presentation 收口，然后进入 3B.4 的 Goal、Session query、read_image、LSP read-only contract。

## 2026-08-22：Phase 3B.4 Goal/Session query/read_image/LSP read-only checkpoint

- contracts 与 SQLite/InMemory projection 新增 Goal 生命周期：`goal/created`、`goal/updated`、`goal/ended`，支持 active/completed/blocked/cancelled、success criteria、budget/result/reason；
- 新增 `create_goal`、`update_goal`、`get_goal` 和 `session_query`，查询只读取当前 session 的公开事件，支持 sequence/time/type/text/status 过滤和结果上限；
- `JobManager` 支持从 `job/*` 事件恢复完成任务元数据和增量输出；重启后仍在运行的 job 标记为 `orphaned`，不虚构可恢复的子进程；
- 新增能力开关控制的 `read_image`，先做 workspace、大小、媒体类型和 PNG/JPEG/GIF 尺寸检查；未启用 vision 时不将工具加入可见目录；
- 新增 host 配置的只读 LSP JSON-RPC 客户端与 `lsp_diagnostics`、`lsp_definition`、`lsp_references`；工具输入不能指定任意 server executable，写入仍必须回到 edit/patch/permission；
- 3B.4 针对性验证：`pnpm exec tsc -b --force`、tools 38 tests、storage 8 tests、runtime 12 tests；Windows `pwsh` smoke 在可用时验证输出，不可用时验证 `COMMAND_NOT_FOUND` 分类。

继续 3B.5：只实现 Web/Skill/Subagent/Workflow 的安全边界和可验证最小切片，不引入任意网络、任意代码执行或未审计的子代理运行时。

## 2026-08-22：Phase 3B.5 capability-gated extension slice

- 新增 `CapabilityRegistry` 和 `capability_status`，Web、Skill、Subagent、Workflow 四类扩展默认 disabled；只有 host 显式配置后才会进入 capability 判断；
- Web gate 只接受 HTTP(S) 和 host allowlist；Skill 内容有字节上限并固定为 low priority、`mayOverrideSafety: false`；
- Subagent gate 固定最大 depth、工具白名单和预算；Workflow gate 固定最大 iteration，超过上限返回稳定错误；
- 本 checkpoint 不添加绕过 ToolRuntime 的网络请求、任意 Skill loader、子 Agent 进程或 Ralph executor；扩展能力必须在后续阶段通过相同 permission/event/presentation 管线实现；
- 针对性验证覆盖默认关闭、URL/host policy、Skill 优先级、Subagent depth/allowlist、Workflow stop limit。

下一步进入 3B.final：完成真实 read/edit/test/long-task 验收，补齐 Web/Job/SSE presentation 和文档收口。

## 2026-08-22：Phase 3B.final 阶段性验收记录（后续审计修正）

- Web 工作台补齐 `goal/*`、`job/*`、`terminal/session` 的历史回放和 SSE 监听；工具结果继续只渲染有界 `modelView`，完整 audit 不进入 UI；
- 完成 Goal/Job/Session query/read_image/LSP/capability 文档、工具表、事件契约和 source reuse register 收口；DSH 作为主行为参考，Claude Code 仅作 prompt/UX 补充，没有引入外部运行时依赖；
- 验收命令：`pnpm typecheck`、`pnpm test`、`git diff --check`；全仓测试通过，tools 41 tests、storage 8、runtime 12、MCP 5、API 13，Windows `pwsh` smoke 和 job recovery smoke 通过；
- 浏览器本地 Web smoke 确认页面 Connected、工具卡片、Goal/Job/Terminal 事件订阅字符串和现有 SSE replay 路径可见；
- 真实 DeepSeek `read → edit → approve → test → summary` 既有 Phase 1A/Phase 7 证据继续作为模型链路门禁，本 checkpoint 未重复消耗 baseline 网络调用；本次新增能力均通过本地结构化 contract/recovery/policy 验证；
- 3B 回滚点：`17a1038`（3B.5）和本 final checkpoint；后续 Web provider、Skill loader、Subagent lifecycle、Workflow executor 仍须经过各自 Phase 4/5/后续 capability 与 ToolRuntime 门禁。

阶段计划：[phase-3-tools-permissions.zh-CN.md](../phase-plans/phase-3-tools-permissions.zh-CN.md)

## 2026-08-21：阶段启动

### 基线

- Phase 2 已完成，当前基线为 `9e716eb`；
- `pnpm typecheck`、`pnpm test` 已通过；
- 新后端继续使用 TypeScript/Node.js，旧 Python Runtime 不进入依赖图；
- 事件日志、SQLite projection、SSE replay 和 command 幂等契约已稳定，可作为工具运行时的事实来源。

### 本阶段目标

- 建立统一 `ToolRegistry`、schema validation、风险级别和 execution mode；
- 建立 `PermissionPolicy`、approval request/resolved、取消和审计事件；
- 先实现本地安全基元：workspace 文件读取/搜索/编辑、受控进程和 Git 只读信息；
- 让工具调用、进度、结果、diff 和权限状态都能从事件恢复；
- 保持 MCP、Subagent、A2A 和 Code Mode 在本阶段之外。

### 当前决策

- 工具不直接写 Session projection，统一通过 AgentHost/EventStore 追加事件；
- `read` 默认自动批准，`write`/`execute` 默认需要审批，`network` 默认拒绝；
- 所有路径经过 WorkspaceResolver；命令使用 argv，不接受任意 shell 字符串；
- 结果分为完整审计结果和受预算限制的 presentation/model view；
- 工具按能力逐个注册，可从 Registry 禁用而不影响既有 Session 和事件回放。

### 下一步

1. 冻结 Tool/Permission contract 和事件类型；
2. 实现 ToolRegistry、schema validator、PermissionPolicy 和统一执行器；
3. 实现首批 read-only 工具，再接 write/execute 工具；
4. 接入 Runtime/API/Web 并完成安全与恢复验收。

## 后续记录

后续每个里程碑追加：变更范围、相关提交、失败/修复、验证命令、风险和下一步。阶段完成时在此记录最终 checkpoint 和退出条件逐项证据。

## 2026-08-21：Tool Runtime 与首批本地工具

### 变更范围

- 新增 `packages/tools`：`ToolRegistry`、轻量 JSON Schema 校验、`PermissionPolicy` 和统一 `ToolRuntime`；
- 工具调用统一追加 `tool/call`、`tool/progress`、`tool/result`，审批追加 `permission/requested`、`permission/resolved`，编辑追加 `diff/preview`；
- 增加 parallel/exclusive 调度、AbortSignal 取消、超时、输出预算和 pending permission 恢复；
- 注册 `read_file`、`glob`、`grep`、`edit_file`、`write_file`、`git_status`、`git_diff`、`run_command`、`run_tests`；
- `run_command`/`run_tests` 只接受 argv 和显式可执行文件白名单，不执行任意 shell 字符串；
- AgentHost 注入 ToolRuntime，API 增加 `/v1/tools`、`POST /v1/sessions/:id/tools`、`POST /v1/sessions/:id/permissions/:permissionId`；
- Web 增加工具调用、进度、结果、审批卡片和批准/拒绝交互；
- P1/P2 开发日志已补录，根 `AGENTS.md` 未被阶段性细节改写。

### 失败与修复

- 首次 workspace 符号链接测试在 Windows 无开发者模式下因 `EPERM` 无法创建链接，测试改为在 Windows 能力缺失时跳过，Linux/macOS 仍执行越界校验；
- 首次审批回放发现 `permission/requested` 事件使用了 `id` 而 projection 读取 `permissionId`，已统一事件字段并补 API Edit 场景测试；
- `write_file` 先做 workspace 语法边界校验，再创建缺失父目录并重新执行真实路径检查；
- exclusive 队列清理和运行中取消控制器已修正，避免会话级队列残留。

### 验证

```text
pnpm typecheck
pnpm test
```

结果：TypeScript 编译通过；contracts、llm、storage、workspace、tools、runtime、api 测试全部通过（workspace 符号链接测试在当前 Windows 能力限制下跳过 1 项）。

### 风险与下一步

- 当前工具仍是本地内置工具，不包含 MCP、Subagent、A2A、Code Mode；
- 进程终止目前是单子进程 `kill`，尚未实现跨平台进程树终止；
- 下一步补充工具恢复/取消/超时/输出截断的专门测试，并完成 Read/Edit/Test 浏览器 smoke，再决定 Phase 3 checkpoint。

## 2026-08-21：安全与恢复测试补齐

### 变更范围

- `packages/tools/src/index.test.ts` 增加 schema 额外字段、路径穿越、权限恢复、超时、外部取消、输出预算和命令白名单测试；
- API 测试覆盖工具发现、read_file 自动批准、edit_file pending approval、批准后写入和结果返回；
- ToolRuntime 对 timeout 与用户取消区分 `TOOL_TIMEOUT` / `TOOL_CANCELLED`，并在执行前后检查 AbortSignal；
- 进程工具增加输出上限和 usage.truncated，保持 argv + `shell:false`。

### 验证

```text
pnpm typecheck
pnpm test
```

结果：全部通过；tools 测试 6 项，runtime 测试 5 项，API 测试 5 项。当前 Windows 环境因无法创建符号链接，workspace 符号链接测试跳过 1 项，其余 workspace 测试通过。

### 下一步

- 做一次真实 API/浏览器 Read → Edit → Test smoke；
- 评估跨平台进程树终止、工具结果完整审计视图与 presentation view 的进一步拆分；
- smoke 通过后更新 Phase 3 状态并创建 checkpoint 提交。

## 2026-08-21：API 与网页 Read/Edit/Test smoke

### 验证过程

- 启动 `@code-review-agent/api`，通过网页加载本地会话并刷新恢复事件；
- 通过 API 触发 `read_file(package.json)`，网页展示 tool call、progress、structured result；
- 通过 API 触发 `edit_file(apps/web/index.html)`，网页展示 pending approval，点击网页 `Approve` 后写入成功并展示 diff/preview；
- 通过 API 触发 `run_tests(node --version)`，网页审批卡片批准后展示终端输出；
- 刷新网页后，已解决的 permission 不再显示为 pending，工具/结果/diff 事件仍可从 SSE replay 恢复。

### 结果与风险

- Read、Edit、Test 三个场景均完成事件恢复和网页展示验收；
- smoke 中故意使用了一个非唯一的 edit 匹配，工具正确返回 `TEXT_NOT_UNIQUE`，随后改用唯一片段成功完成 Edit，证明失败结果也会进入审计事件；
- 本地开发 API 已停止，未留下运行中的服务进程。

### Phase 3 checkpoint 前结论

阶段核心退出条件已满足：所有内置工具均经过统一 ToolRuntime，路径/命令/权限边界有测试，Read/Edit/Test 可从事件恢复。跨平台进程树终止和更细粒度 presentation/model view 预算仍列为后续增强项，不阻塞当前 checkpoint。

## 2026-08-21：Phase 3 安全与恢复硬化

### 审计结论

继续审计 `5003dbd` 后发现，上一 checkpoint 仍有四项与阶段计划不完全一致：`write_file` 可隐式覆盖、取消只终止顶层进程、完整审计结果与展示视图未分离、审批过期/取消和 Registry 禁用缺少完整测试。因此 Phase 3 继续推进，不把旧 checkpoint 当作最终退出点。

### 变更范围

- `write_file` 默认拒绝已有目标，只有显式 `overwrite=true` 才覆盖，并生成 diff；
- read/glob/grep 增加文件大小、结果数量和默认输出边界；
- 进程工具使用 argv + `shell:false`，取消时按平台终止进程树；完整 audit 分离记录 stdout、stderr、exitCode、signal；
- ToolResult 保留完整 `audit/output`，另生成受预算限制的 `modelView`，Web 不再渲染完整 audit；
- ToolRegistry 增加 enable/disable；ToolRuntime 增加 parallel/exclusive 验证和批量兄弟失败取消；
- tool/permission 事件增加 caller、workspaceRoot，审批增加 expiresAt；过期审批返回 `PERMISSION_EXPIRED`；
- pending permission 取消会追加 `permission/resolved` 与 terminal `tool/result`；重复审批和取消保持幂等；
- API 增加 `POST /v1/sessions/:id/tools/:toolCallId/cancel`，并增加 SQLite API 重启后恢复 pending permission 的测试；
- Windows 使用 directory junction 完成 symlink escape 测试，不再跳过该安全门禁；
- Web 审批卡片显示 caller/workspace/expiry，并提供 Approve、Deny、Cancel。

### 自动化验证

```text
pnpm typecheck
pnpm test
```

当前结果：contracts、llm、storage、workspace、tools、runtime、api 全部通过；workspace 4/4、storage 6 项、tools 16 项、API 6 项。网页 Cancel 与刷新恢复 smoke 已在下方完成，下一步生成新的 Phase 3 checkpoint。

### 网页 Cancel 与恢复 smoke

- 创建以 `packages/tools` 为 workspace 的 Session，触发显式覆盖 `write_file(package.json)`；
- 网页正确显示 caller、workspace、expiresAt 和 Approve/Deny/Cancel；
- 点击 Cancel 后产生 `permission/resolved(cancelled)` 与 terminal `tool/result(PERMISSION_CANCELLED)`；
- 刷新页面后 pending 卡片不再出现，取消结果仍从事件回放；
- 随后通过 `read_file(package.json)` 验证内容仍为 `@code-review-agent/tools`，确认取消没有文件副作用；
- 本地 API 已停止，没有留下运行中的开发服务。

## 2026-08-21：最终 checkpoint

- 实现 checkpoint：`e1d3172 feat: harden phase three tools and permissions`；
- 自动化门禁：`pnpm typecheck`、`pnpm test`、`git diff --check` 全部通过；
- 测试证据：workspace 4/4、storage 6、tools 16、runtime 5、API 6；
- Read-only：read_file、glob、grep、git_status、git_diff 经过 workspace、预算和事件管线；
- Edit：edit_file 与显式 overwrite write_file 经过审批、diff、取消和刷新回放；
- Test：run_tests/run_command 经过 argv 白名单、审批、timeout、输出截断和进程树终止；
- Permission：approve/deny/cancel/expire/repeat/restart recovery 均有事件和测试；
- 审计：tool caller、workspace、输入、完整 audit、modelView、结果和副作用均能从事件解释；
- 本阶段没有引入 MCP、Subagent、A2A、Code Mode 或旧 Python Runtime 依赖。

Phase 3 退出条件至此满足；后续工具扩展必须继续复用本阶段 ToolRegistry、PermissionPolicy、WorkspaceResolver 和 EventStore 管线。
