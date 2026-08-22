# Phase 3B：Coding Agent 工具池与工具 Prompt 强化

状态：in_progress（2026-08-22；3B.0–3B.5 已有实现，3B.2 patch/diff 闭环继续开发）

本计划承接已完成的 Phase 1A 与 Phase 3。Phase 1A 已证明模型可以完成 read → edit → approve → test → summary；Phase 3 已提供统一的 ToolRegistry、ToolRuntime、PermissionPolicy、WorkspaceResolver、取消、输出预算和事件审计。本阶段重点把现有工具提升为可组合、可解释、可恢复的 Coding Agent 工具池。

核心参考是本地 DeepSeek Harness（以下简称 DSH）的 TypeScript 实现。DSH 的代码只作为行为、契约和测试结构参考；本项目继续使用自己的 contracts、事件、权限、workspace 和 API，不建立对 DSH 内部包的运行时依赖。

## 1. 目标与边界

### 1.1 用户目标

完成本阶段后，用户提出“查看仓库、定位实现、修改文件、运行检查、处理失败、继续任务”时，Agent 应当：

- 主动使用可用的文件、搜索、Git 和命令工具获取事实，不要求用户手工执行可由工具完成的命令；
- 根据工具的前置条件、风险和结果选择调用顺序；
- 在调用过程中显示进度、调用摘要、权限状态和结果摘要；
- 编辑前读取当前内容，保留用户已有修改，并在写入前形成可审阅 diff；
- 区分命令失败、超时、取消、权限拒绝、工作区越界和工具自身错误；
- 失败后根据结构化 remedy 调整下一步，不盲目重复危险调用；
- 对长任务使用持久 Terminal 或 background job，并能继续查询结果；
- 用 Plan/Todo/Goal 记录多步骤目标，使刷新、重连和恢复后的行为一致；
- 在工具被策略过滤或尚未实现时，明确说明真实限制，不虚构能力。

### 1.2 工程目标

- 引入独立的 ToolPromptRegistry，把工具级指导从一行 description 扩展为可测试的结构化 prompt spec；
- 让 schema、prompt、权限、执行模式、结构化结果和 Web presentation 保持同一份能力事实；
- 让内置工具、未来 MCP 工具和未来 Subagent 工具复用同一套 prompt/权限/事件入口；
- 参考 DSH 的模块化 system-prompt section、tool schema、presentCall/presentResult、output schema、background job 和失败分类；
- 为后续 LSP、Web、Skills、Subagent 和 Workflow 留出稳定扩展边界。

### 1.3 明确不包含

- 不恢复旧 Python 工具或 Python Runtime；
- 不把 DSH 的 Cordis、插件系统或完整前端复制进本项目；
- 不在本阶段实现完整 Subagent、A2A、Code Mode、Worktree、账户、遥测或商业 provider；
- 不把任意网络访问、任意 shell 字符串执行或任意代码执行加入默认权限；
- 不用 prompt 文本替代 schema、workspace、PermissionPolicy 或事件审计；
- 外部 Web、数据库、Issue、云服务能力仍优先通过 MCP。

## 2. 当前基线与差距

### 2.1 当前工具

实现入口：

- packages/tools/src/builtin.ts：内置工具 schema、执行和结果；
- packages/tools/src/runtime.ts：校验、workspace/policy、审批、执行、取消、超时、输出预算和事件；
- packages/tools/src/registry.ts：注册、禁用、发现和 schema 校验；
- packages/tools/src/permissions.ts：permission preset 和策略；
- packages/runtime/src/system-prompt.ts：全局 Coding Agent system prompt；
- packages/contracts/src/index.ts：ToolDefinition、ToolResult 和事件 contract。

| 工具组 | 当前工具 | 当前能力 | 本阶段差距 |
|---|---|---|---|
| 文件读取 | read_file | workspace 内 UTF-8 读取、大小上限、结构化输出 | 行号/上下文约定、二进制/图片分流、继续读取规则 |
| 文件发现 | glob、grep | workspace 限制、结果上限、取消和输出预算 | 搜索策略、截断解释、glob→grep→read 组合规则 |
| 文件修改 | edit_file、write_file、delete_file | 精确替换、覆盖控制、diff、trash、审批 | stale/version、多段编辑、冲突恢复、patch 合同 |
| Git | git_status、git_diff、git_log、git_show | workspace cwd、结构化读取和预算 | status→diff 顺序、用户修改保护和结果解释 |
| 一次性命令 | run_command、run_tests | allowlist argv、cwd、超时、输出限制、进程树终止 | Bash/PowerShell 语义、后台策略、失败分类和 prompt |
| 持久终端 | terminal_open/send/read/signal/close/list | Session/workspace 隔离、增量读取、恢复元数据 | 交互式任务协议、前台/后台选择和 presentation |
| 计划与交互 | plan、todo_write、ask_user | projection、暂停/恢复、Web 控件 | 何时使用、更新粒度、问题最小化和完成收束 |

当前 ToolDefinition 已有 name、description、inputSchema、executionMode、riskLevel、approvalMode、interruptBehavior 和 execute，缺少独立的工具使用规则、前置条件、组合顺序、结果解释、失败恢复和“何时不要调用”信息。

### 2.2 DSH 的差距模型

DSH 的工具通常由五层共同组成：

1. 工具 schema：输入、必填字段、默认值、部署能力开关和输出 schema；
2. 工具 description：单次调用的语义、cwd、超时、长输出和权限边界；
3. system-prompt section：跨调用规则，例如退出码、Bash fresh shell、sandbox denial 后的重试策略和工具组合；
4. runtime：执行、取消、超时、后台 job、权限提升和结构化错误；
5. presentation：presentCall/presentResult 投影为 terminal、read、search、diff、todo 等 UI card。

本项目已有第 1、部分第 2 和第 4 层，Phase 3B 补齐第 3、完整第 5 和对应 fixture。

## 3. DSH 具体参考入口

| 本项目能力 | DSH 参考入口 | 吸收方式 |
|---|---|---|
| Prompt registry | packages/core/system-prompt/src/index.ts | 有序 section、动态 context、变量、tool provider、确定性排序；改为本项目 builder 和 registry |
| Agent loop | packages/core/agent-loop/src/agent.ts、tool-calls.ts | parallel/exclusive、abort、结果顺序；继续使用本项目 EventStore、Turn、SSE |
| Tool contract | packages/core/tools/src/types.ts、schema.ts、presentation.ts | schema、structured result、model view、presentation 分离 |
| 文件工具 | packages/fs/tool-fs/src/read.ts、write.ts、edit.ts、diff.ts | 目标解析、变更前后 diff、错误分类、预算和图片分流 |
| 结构化编辑 | packages/fs/tool-str-replace-editor/src/index.ts | 唯一匹配、明确 command、结构化错误；先兼容现有 edit_file |
| 搜索 | packages/fs/tool-fs-search/src/glob.ts、grep.ts、search-core.ts、presentation.ts | ripgrep 边界、结果/行/字节上限、spill、超时和 search card |
| Bash | packages/shell/tool-bash/src/index.ts、render.ts、background.ts | description、workdir、timeout、background、exit marker、sandbox denial 和结果呈现 |
| PowerShell | packages/shell/tool-pwsh/src/index.ts、render.ts | Windows 一等工具、native path、$env:、ConstrainedLanguage 和 kill 语义 |
| Terminal | packages/terminal/terminal/src/index.ts、types.ts | 长生命周期、增量输出、输入、signal、cwd 和 owner |
| Plan/Todo/交互 | packages/plan/plan-mode、packages/todo/tool-todo、packages/interaction/commands | 状态 projection、用户决策和恢复 |
| Goal | packages/goal/tool-goal/src/authority.ts、wrapup.ts | Goal 创建/更新/收束、完成条件和权限边界 |
| Session query | packages/session-query/tool-session-query/src/operations.ts、presentation.ts | 受 scope 限制的历史查询和结构化展示 |
| LSP | packages/lsp/lsp、packages/lsp/lsp-stdio | server 生命周期、stdio、取消和 workspace root |
| Web | packages/web/tool-web/src/search.ts、fetch.ts | 网络边界、HTML→Markdown、spill 和错误分类 |
| Subagent | packages/subagent/subagent/src/child-agent.ts、lifecycle.ts、continuation.ts | parent/child、depth、budget、report 和取消 |
| Workflow/Ralph | packages/workflow/tool-workflow、tool-ralph | 可恢复步骤、停止条件、重试和报告 |

所有直接复用或大量改编的代码必须先更新 docs/source-reuse-register.md 并保留许可证信息。

## 4. ToolPromptRegistry 设计

### 4.1 类型

~~~ts
export interface ToolPromptSpec {
  readonly name: string;
  readonly purpose: string;
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly prerequisites: readonly string[];
  readonly inputRules: readonly string[];
  readonly sequencingRules: readonly string[];
  readonly resultInterpretation: readonly string[];
  readonly failureRecovery: readonly string[];
  readonly safetyRules: readonly string[];
  readonly promptOrder?: number;
}
~~~

registry 负责注册、名称唯一校验、按可见工具过滤、确定性排序和长度预算。缺少本地 spec 的 MCP 工具使用短 fallback；远程 description 不能成为高优先级系统指令。spec 不得包含凭据、未实现能力或绕过安全策略的文字。

### 4.2 固定 prompt 结构

每个内置工具至少包含 Purpose、When to use、When not to use、Prerequisites、Input rules、Sequencing、Result interpretation、Failure recovery、Safety 九段。schema description 只保留单次调用说明；跨调用规则放入 registry section，参考 DSH Bash 对 fresh shell、退出码、workdir、background job 和 sandbox denial 的组合说明。

### 4.3 边界

- 全局 system prompt 定义身份、任务循环、workspace、信任、权限和验证；
- 工具 prompt 定义单工具语义、组合、输入、结果和恢复；
- schema 是机器校验事实，prompt 不能放宽 schema；
- PermissionPolicy、WorkspaceResolver、ToolRuntime 是执行事实，prompt 不能授权自己；
- 工具被 permission preset 过滤后，不在 prompt 中泄露不可调用工具；
- assembly 必须 deterministic、可快照测试并受上下文预算限制。

## 5. P0：现有工具成熟化

### 5.0 Registry 与工具目录

新增 ToolPromptRegistry、prompt spec 校验、可见工具过滤、prompt order、长度预算和 catalog fixture；把 registry 与 ToolRegistry.list()、permission preset、MCP bridge 对齐。验收要求：同一工具集合和 context 在不同进程、不同平台产生相同 prompt；read-only 模式不出现写/执行 guidance。

### 5.1 文件、搜索和 Git

工具：read_file、glob、grep、git_status、git_diff、git_log、git_show。

- read_file 增加稳定行号/范围、编码和二进制识别、截断标记及继续读取规则；
- glob 明确 pattern 根、忽略目录、排序、结果上限和过量结果的下一步；
- grep 明确 literal/regex、大小写、路径过滤、上下文行、截断和取消；
- 固化 glob → grep → read_file → git_diff 的推荐组合；
- Git 先 status 再 diff，保留用户未提交修改；
- 完整输出进入审计/事件，model view 只保留有界摘要。

DSH 对照：tool-fs 的 read target/render/error，tool-fs-search 的 ripgrep caps/search-core/presentation。

### 5.2 编辑、写入、删除和 diff/patch

工具：edit_file、write_file、delete_file、git_diff。

- 保留现有 edit_file 输入，增加 stale file/version 检测；
- 增加多段结构化 edit，返回每段状态；
- 错误包含 path、行号/上下文、匹配数量和 remedy；
- 编辑前后返回摘要和 unified diff，写入前允许 Web 预览；
- 将 DSH str_replace_editor 的唯一匹配、command 和错误语义转为本项目 contract；
- write_file 明确 create/overwrite/append；覆盖和删除继续审批；
- 冲突时停止并重新读取，不覆盖用户修改；
- 所有变更生成 diff/preview 和 tool/result 事件。

### 5.3 Shell、PowerShell、测试和 Terminal

工具：run_command、run_tests、terminal_*；新增受策略控制的 bash/pwsh 一等能力。

- 短、无状态检查使用一次性命令；需要 stdin/cwd/长状态使用 Terminal；长任务使用 job；
- Windows 提供 native path、$env:NAME、exit code、ConstrainedLanguage 和 kill 语义；
- Bash 明确 fresh shell、workdir、stdout/stderr、非零退出、timeout 和截断；
- 保留 executable/argv 或显式 shell policy，不把任意字符串执行变成默认行为；
- 失败分类至少包括 COMMAND_NOT_FOUND、WORKDIR_INVALID、TIMEOUT、CANCELLED、NON_ZERO_EXIT、POLICY_DENIED、OUTPUT_TRUNCATED；
- denial 只能按真实执行结果处理，升级必须进入本项目 approval；
- Terminal/job 状态进入事件，重启后只恢复元数据。

DSH 对照：tool-bash 的 description 与跨调用 prompt、tool-pwsh 的 Windows 语义、render 的 exit/status presentation、background 的 job outcome。

### 5.4 Plan、Todo、Ask User

- 多文件、跨步骤或需要决策的任务使用 plan；简单问答不创建空计划；
- Todo 只记录可验证工作项，状态更新必须幂等；
- ask_user 只询问阻塞决策，问题包含上下文、影响和选项；
- 结果明确区分 pending、resolved、cancelled、expired；
- 完成前关闭 todo/plan 并汇报未完成项；
- 状态由事件和 projection 产生，prompt 不直接声称状态已更新。

## 6. P1：成熟 Coding Agent 体验

### 6.1 Goal

新增 get_goal、create_goal、update_goal，定义 Goal 与 Session/Turn/Todo 的关系、完成/阻塞/取消、预算和恢复。参考 DSH packages/goal/tool-goal；结果必须结构化。

### 6.2 Background jobs

新增 job_output、job_kill、job_list 或等价工具，补齐 owner、workspace、session、状态、完成通知、spill、取消和重启恢复。参考 DSH Bash/Pwsh background adapter 与 jobs runtime；后台工具必须使用相同权限和审计。

### 6.3 Session query

新增受 scope 限制的 session query，支持按 session、时间、事件类型、文本和状态查询；只读取 projection/公开事件视图，不暴露任意 SQL。参考 packages/session-query/tool-session-query/src/operations.ts 和 presentation.ts。

### 6.4 read_image

参考 DSH packages/fs/tool-fs/src/read-image.ts 与 read-target.ts。媒体类型和大小先由目标解析判断；无视觉模型时不展示该工具；图片通过受控 artifact/vision input 传递。

### 6.5 LSP 只读闭包

先实现 diagnostics、definition、references，再评估 code action。参考 DSH packages/lsp/lsp 与 lsp-stdio；生命周期、取消、预算和崩溃恢复进入事件，写入仍回到 edit/patch/permission。

### 6.6 Diff、patch 和变更预览

支持多文件、hunk、统计、冲突、stale base、apply/reject、回滚和审计。模型生成的 patch 必须经过 parser、workspace check、permission 和事件。

## 7. P2：扩展 Agent 能力

- Web search/fetch：参考 packages/web/tool-web，增加 network risk、域名/响应大小/超时/HTML→Markdown/来源展示，默认关闭；
- Skills：参考 packages/skill/tool-skill，技能只能追加低优先级规则，不能覆盖安全基线；
- Subagent：增加 spawn_subagent、send_message、interrupt_agent、wait_agent、report_agent，参考 child-agent/lifecycle/continuation/depth，设工具白名单、预算和深度上限；
- Workflow/Ralph：参考 tool-workflow、tool-ralph，定义可恢复步骤、retry/backoff、最大迭代数、停止条件和人工确认。

## 8. 统一结果、事件与 Web presentation

所有工具继续经过：

~~~text
discover → schema validate → workspace/policy check → approval
        → execute → progress → structured result → presentation → event append
~~~

结果至少能表达 ok、稳定 error.code、remedy、call/session/turn 关联、时间、取消/超时、截断/spill/artifact、diff/patch、exit code、signal、job id 和 permission 状态。完整审计视图与有界 model view 分离。

P0 工具需要稳定的 call/result presentation：read/search card、diff/file mutation card、Git card、Terminal card、Terminal/Job card、Plan/Todo/Question card。工具事件必须在执行过程中追加并由 SSE reducer 消费，不能等最终助手文本生成后再补到消息尾部。

## 9. 测试和验收门禁

### 9.1 单元/合同

- prompt spec 字段完整性、名称唯一、确定性排序、长度预算；
- schema 与 prompt 的参数/能力一致性；
- permission 过滤后的 prompt 只含可见工具；
- structured result、error code、remedy、modelView 和 presentation；
- stale/conflict、多段 patch、diff parser、输出摘要；
- Bash/Pwsh cwd、argv、exit/timeout/cancel/background；
- Terminal/job/Goal/Session query/LSP 状态机、取消和恢复。

### 9.2 安全

- 路径穿越、符号链接、workspace 外 cwd、绝对路径和用户修改保护；
- 命令注入、shell policy 绕过、环境变量泄露、进程树逃逸；
- 文件、命令输出、MCP description 和 Skill 内容不能覆盖 system/tool prompt；
- deny/ask/approve/expire/cancel/restart 幂等；
- network、LSP、background、Subagent 不能绕过 ToolRuntime；
- API key、Authorization、cookie、private key 不进入事件、diff、model view 或 Web 日志。

### 9.3 浏览器/真实模型

固定四条场景：

1. Repository read：选择 workspace，Agent 自动使用 glob/grep/read/git，返回功能和证据；
2. Edit：读取文件、生成 diff、请求审批、应用修改并展示中间工具卡片；
3. Test：选择 Bash/Pwsh/一次性命令或 Terminal，展示 stdout/stderr/exit code，并在失败后继续修复；
4. Long task：创建 plan/todo/goal，启动 background job，刷新页面后查询状态并收束。

每条场景验证真实 DeepSeek tool call、SSE 中间事件顺序、断线 replay、权限恢复、最终摘要和长输出滚动。

## 10. Checkpoint 与回滚

| checkpoint | 交付 | 门禁 | 回滚 |
|---|---|---|---|
| 3B.0 | 审计、DSH 对照、PromptRegistry contract | 文档和类型评审 | 仅回滚文档 |
| 3B.1 | Registry、P0 prompt、catalog fixture | prompt/schema/catalog 单测 | 关闭 registry flag，回退旧 description |
| 3B.2 | structured edit、diff/patch、stale/conflict | edit/diff/security/replay | 禁用 structured edit，保留旧 edit |
| 3B.3 | Bash/Pwsh/Terminal/job 基础语义 | Windows/Bash/timeout/cancel smoke | 按工具名禁用新增 shell/job |
| 3B.4 | Goal、Session query、read_image、LSP read-only | contract/recovery/browser smoke | capability flag 关闭新增工具 |
| 3B.5 | Web/Skill/Subagent/Workflow 设计或切片 | network/subagent/workflow 安全门禁 | capability registry 禁用 |
| 3B.final | P0/P1 真实 Coding Agent 验收 | typecheck、test、diff check、browser、DeepSeek smoke | 保留上一通过 checkpoint |

每个 checkpoint 必须独立 commit。建议提交信息：

~~~text
docs(phase-3b): plan tool hardening and prompt alignment
feat(tools): add tool prompt registry
feat(tools): harden structured edit and diff
feat(shell): add policy-bound bash and pwsh semantics
~~~

## 11. 进入、退出与下一步

### 进入条件

- Phase 1A 真实 read → edit → approve → test 已通过；
- Phase 3 ToolRuntime、PermissionPolicy、WorkspaceResolver 和 EventStore 已稳定；
- DSH 参考路径和许可证边界已登记；
- 本计划、phase-status 和开发日志已同步并提交。

### P0 退出条件

- P0 工具均有独立 prompt spec，schema/result/presentation 对齐测试通过；
- 文件编辑具备 stale/conflict/diff 预览，Shell 具备 cwd/timeout/cancel/输出语义；
- Agent 自动完成 Repository read、Edit、Test，不再要求用户手工执行可用工具能完成的命令；
- 工具过程以中间事件和 Web card 呈现。

### P1 退出条件

- Goal/Background/Session query/read_image/LSP read-only contract 有恢复和权限测试；
- 长任务刷新、断线和重启后可继续，job/goal 状态不依赖进程内存；
- 至少一条真实 DeepSeek long-task smoke 通过。

### 下一步执行顺序

1. 提交本计划及索引/状态同步；
2. 完成 3B.0：冻结 ToolPromptSpec、assembly、catalog fixture 和 DSH 对照测试；
3. 完成 3B.1：为现有 P0/P1 工具补齐 prompt，不先改变执行语义；
4. 完成 3B.2：强化 edit/diff/patch 和 stale/conflict；
5. 完成 3B.3：强化 Bash/Pwsh/Terminal/job 和 Windows 工作区语义；
6. 完成 patch/diff parser、apply/reject/rollback 的事件与恢复边界；
7. 补齐 LSP 生命周期/取消/崩溃恢复和 background job spill/恢复；
8. 用真实 DeepSeek 做新增能力隔离 smoke，再进入最终验收；
9. 每个 checkpoint 更新 phase-status 和对应开发日志并立即 commit。
