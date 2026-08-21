# Phase 3：工具运行时与权限开发日志

状态：`in_progress`

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
