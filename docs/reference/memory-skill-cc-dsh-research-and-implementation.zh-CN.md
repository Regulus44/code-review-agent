# Memory 与 Skill：Claude Code / DSH 对照调研与分阶段实施方案

状态：`research`（调研与实施建议，不直接改变已接受的架构决策）  
日期：2026-09-01  
范围：

- 本仓库：`D:/Develop/code-review-agent`
- Claude Code 参考快照：`D:/Develop/claude-code`
- DSH 参考仓库：`D:/Develop/deepseek-harness-fork`

## 0. 使用方式与结论边界

本文档采用“边调研、边落文档”的方式维护。每完成一个上游模块的代码阅读，就同步补充：

1. 上游程序、文件和代码入口；
2. 本仓库对应的程序、文件和代码入口；
3. 可直接复用的行为、需要自有实现的边界和不能复制的内容；
4. 事件、工具、Task、Permission、Workspace、存储、Web 和测试影响；
5. 可回滚的阶段切片与验收门禁。

本文档不把上游目录、类型或 prompt 当成本项目现成功能。最终是否实现，以本仓库的 EventStore 事实源、ToolRuntime 统一管线、workspace/permission 安全边界和真实验收场景为准。

## 1. 当前仓库基线（先固定事实）

### 1.1 当前产品状态

当前状态页把上下文与可靠性列为已实现能力，其中包含 tool-result artifact、microcompact、summary compact、session/project memory、context recovery 和 token diagnostics；同时把完整插件运行时列为尚未落地能力：[docs/status.zh-CN.md](../status.zh-CN.md)。

需要区分“包内实现”与“默认 Host 可用”：

- EventStore transcript、compact、summary、compact boundary、replay 和 diagnostics 已进入默认 Runtime 主路径；
- Session Memory 和 Project Memory 已有 Context/Runtime/Storage 契约与测试；M0 已冻结 adapter readiness，M1 已为 SQLite API Host 默认装配 bounded 文件 adapter 与受限 fallback extractor。裸 `AgentHost`/InMemory 仍需显式注入 host-owned adapter，避免低层 Runtime 擅自决定持久化目录；
- Skill 目前只有 capability guard、`skill` attachment 类型和 `capability_status` 只读观察入口；没有 `SKILL.md` loader、discovery、install、version 或 Web 管理面；
- `/v1/capabilities.plugins` 由 Runtime 明确返回 `deferred`，不能把 prompt catalog 或 attachment support 当作完整 Skill runtime。

### 1.2 本仓库与本次主题直接相关的入口

| 领域 | 本仓库程序/文件 | 关键入口 | 当前职责 |
|---|---|---|---|
| Host 主循环 | `packages/runtime/src/index.ts` | `AgentHost.runSteps()`、`assembleTurnContext()`、`compactTurnContext()` | 在模型请求前组装、压缩、恢复 model-visible context |
| Context | `packages/context/src` | `session-memory.ts`、`session-memory-compact.ts`、`project-memory.ts`、`summary-compact.ts`、`post-compact.ts` | Memory、compact、附件预算和重建的纯函数/接口 |
| 契约 | `packages/contracts/src/index.ts` | `AgentEventType`、`SessionProjection`、`ContextSessionMemoryProjection`、`ContextProjectMemoryProjection` | 事件、投影和回放边界 |
| 存储 | `packages/storage/src/index.ts` | `applyEvent()`、`replayProjection()` | InMemory/SQLite 共用 reducer，保存 bounded metadata |
| 工具与能力 | `packages/tools/src/capabilities.ts`、`builtin.ts` | `CapabilityRegistry`、`authorizeSkill()`、`capability_status` | 可选扩展的开关和安全上限 |
| API | `apps/api/src/server.ts` | `createApiServer()`、`GET /v1/capabilities` | Host 装配、能力投影和 Web API |
| Web | `apps/web/src/client/store.ts`、`src/presentation` | context diagnostics/replay presenters | 消费 projection；暂无 Memory/Skill 专用管理面 |

### 1.3 已有记忆机制的实现切片

#### Session Memory

- M06：已有 Session Memory 时进行无模型调用 compact；按已摘要消息边界保留窗口，保护 tool pair 和 streaming response；
- M11：增加 token/tool/natural-break 门控、每 session 串行后台 extractor、restricted capability、exact-path write guard、保存后幂等完成 receipt 和重启恢复；
- 正文由 host-owned `SessionMemoryStore` 保存，EventStore/SSE/projection 只保存 bounded metadata。

#### Project Memory

- M12：增加 bounded `MEMORY.md` index、safe link parser、user/feedback/project/reference taxonomy、最多 5 个 topic 召回和 stale validator；
- 由 workspace/tenant 派生 scope key；用户明确忽略或 adapter 读取失败时 fail closed；
- topic 正文只进入当前 model view，不进入 EventStore/SSE/projection。

#### Context 与恢复

- M07 Summary Compact：无工具摘要请求、媒体/旧 Skill attachment 清理、API-round PTL retry；
- M08/M10：compact boundary、preserved segment、transcript restore 和 post-compact attachments；
- M13：durable token diagnostics、compact 节省量和 recovery chain；
- M14：Context Collapse 只暴露 deferred capability，算法本身尚未实现。

### 1.4 已有 Skill 机制的实现切片

- `CapabilityRegistry` 默认关闭 `web/skill/subagent/workflow`，Skill 可配置 `maxBytes`；
- `authorizeSkill()` 只返回低优先级、不可覆盖安全基线的文本授权结果；
- post-compact attachment 支持 `kind: "skill"`，并对 Skill 设独立 token cap；
- `capability_status` 可读取能力开关和上限；
- 当前没有真实 Skill 内容来源、解析器、安装器、版本选择器、激活生命周期、持久化事件或 Web 管理面。

### 1.5 当前验证基线

本次调研开始前已验证：

- `pnpm typecheck`：通过；
- `pnpm test`：通过；
- Context memory、Runtime M06/M11/M12、Storage replay、CapabilityRegistry 相关定向测试：通过。

## 2. 调研方法与后续章节结构

后续章节按以下顺序增量补齐：

1. Claude Code Memory：Session Memory、Project Memory/memdir、transcript/restore、compact/recovery；
2. Claude Code Skill：Skill discovery、loader、prompt composition、权限/生命周期和 UI/CLI 入口；
3. DSH Memory：如有对应实现则映射其 store、session/context 和持久化边界；
4. DSH Skill/Plugin：`packages/skill/tool-skill` 及相关 registry、tool、prompt、Web 设置入口；
5. 三方能力矩阵与差距分级；
6. 本仓库按模块的改造点、文件级变更、契约影响和分阶段实施计划；
7. 测试、迁移、禁用、回滚和“不应实现”的边界。

## 3. Claude Code 参考实现

### 3.1 Memory：两层文件化记忆 + transcript/compact 协同

Claude Code 将“会话内可持续摘要”和“项目级长期事实”分开。两者都落在 Markdown 文件中，模型只在需要时看到正文；会话 transcript 仍然承担完整交互历史，不由 Memory 文件替代。

| 模块 | Claude Code 程序/文件/入口 | 行为与边界 | 本仓库对应入口/差距 |
|---|---|---|---|
| Session Memory 配置与门控 | `D:/Develop/claude-code/src/services/SessionMemory/sessionMemoryUtils.ts`：`DEFAULT_SESSION_MEMORY_CONFIG`、`shouldExtractMemory()` | 首次约 10k token 才初始化；后续需增长约 5k token；还需满足 3 次 tool call 或自然 assistant break；token 阈值始终必需 | `D:/Develop/code-review-agent/packages/context/src/session-memory.ts` 已有同类阈值、natural break、tool-call 门控；需要把 adapter 接到默认 Host |
| Session Memory 文件创建 | `src/services/SessionMemory/sessionMemory.ts`：`setupSessionMemoryFile()` | 创建目录/文件、读取模板；文件是 extractor 与 compact 的持久边界 | `packages/context/src/session-memory.ts` 定义 `SessionMemoryStore`/抽取契约，`packages/storage/src/index.ts` 只保留 bounded metadata；默认 `createApiServer()` 尚未注入 store |
| 自动抽取调度 | `sessionMemory.ts`、`src/context.ts`：post-sampling hook、`sequential()`、`createSubagentContext()`、`runForkedAgent()` | 仅 `querySource === 'repl_main_thread'` 主线程触发；每个 session 串行化，后台 extractor 不阻塞主 turn；支持手工 `/summary` | `packages/runtime/src/index.ts`：`scheduleSessionMemoryExtraction()` / `executeSessionMemoryExtraction()` 已有 seam；需实现 Host 默认 scheduler、重启恢复和可观察状态 |
| 精确写入权限 | `src/utils/permissions/filesystem.ts`：`createMemoryFileCanUseTool(memoryPath)` | extractor 仅可对精确 memory path 使用 Edit；其它工具、其它路径全部拒绝 | 本仓库已有 `authorizeSkill()` 和 memory write guard，但需要把 Session Memory writer 作为独立 capability 接入统一 `discover → validate → policy → approval → execute → event` 管线 |
| 边界幂等与 streaming 保护 | `sessionMemory.ts`：`updateLastSummarizedMessageIdIfSafe()` | 最后 assistant 仍有 tool call 时不推进边界，避免摘要落在未闭合 tool pair；提取结果有幂等边界 | `packages/context/src/session-memory-compact.ts` 已有 tool pair / response stream 保护；应增加 durable receipt 的重放和重复批准测试 |
| 无模型 compact | `src/services/compact/sessionMemoryCompact.ts`：`truncateSessionMemoryForCompact()` | compact 时按 section 截断，`MAX_SECTION_LENGTH = 2000`，总上限 `MAX_TOTAL_SESSION_MEMORY_TOKENS = 12000`；保留固定 section header/description | `packages/context/src/session-memory-compact.ts` 已实现 bounded compact；需把压缩结果与 Runtime compact boundary、token diagnostics 联动 |
| 多 store 扩展 | `src/services/SessionMemory/multiStore.ts` | `~/.claude/local-memory/<store>/<key>.md`；store/key 路径校验、单值 1MB、atomic temp-file + rename、bounded list/read、archive store | 本仓库暂无通用多 store；只在有明确产品场景时复用其“原子文件 + bounded 读取”行为，不直接引入 CC 的目录约定 |
| Project Memory 路径 | `src/memdir/paths.ts`、`memdir.ts`、`teamMemPaths.ts` | 默认 `~/.claude/projects/<sanitized-git-root>/memory/`；支持 worktree 共享 canonical Git root；可用 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 覆盖 | `packages/context/src/project-memory.ts` 已用 workspace/tenant 派生 scope key；需要 filesystem adapter、路径策略和迁移脚本 |
| Project Memory index | `src/memdir/memdir.ts`、`memoryTypes.ts` | `MEMORY.md` 约 200 行/25,000 bytes；超限截断并附 warning；topic frontmatter 含 `name/description/type` | `packages/context/src/project-memory.ts` 已有 bounded index、4 类 taxonomy（user/feedback/project/reference）、最多 5 topic、safe link parser；缺默认持久化和写入 UI |
| 相关性召回 | `src/memdir/findRelevantMemories.ts` | 扫描 frontmatter manifest，再用轻量 `sideQuery()` + JSON schema 选择最多 5 条；支持 `recentTools` 去噪和 `alreadySurfaced` 去重 | `project-memory.ts` 已有 relevance、stale validator；需要确定本项目是否允许模型辅助召回，先提供 deterministic lexical/metadata fallback |
| Memory prompt 组装 | `src/context.ts`、`src/memdir/memdir.ts` | 自动 memory、team memory、KAIROS daily log 以 system section + user context 注入；memory 是历史 claim，不是新指令 | `packages/runtime/src/index.ts` 的 `assembleTurnContext()` 已有 project/session context 入口；必须显式标注 provenance，并要求路径/符号/flag 重新验证 |
| Team/KAIROS 扩展 | `src/services/teamMemorySync/`、`src/services/autoDream/`、`src/skills/bundled/dream.ts` | 团队同步、secret scanner、watcher；daily log 由 `/dream` 蒸馏 topic 和 `MEMORY.md` | 本仓库没有对应产品边界；建议作为后续可选模块，禁止在核心 Memory MVP 中引入远程同步或夜间自动写入 |

Claude Code 的 Memory 关键经验是“正文文件与会话事件分离”：文件适合长期事实和摘要，事件日志适合恢复、审计和 replay。Memory 文件不能改变事件事实源，也不能携带越权指令。

### 3.2 Skill：发现、摘要、按需加载和双执行路径

#### 3.2.1 Skill 来源与加载链

Claude Code 的主 loader 是 `D:/Develop/claude-code/src/skills/loadSkillsDir.ts`，入口 `getSkillDirCommands(cwd)`。它将 managed、user、project、`--add-dir`、legacy `/commands`、plugin、bundled 和 MCP 来源合并为 `Command`。

| 能力 | Claude Code 参考入口 | 关键实现 | 对本仓库的启示 |
|---|---|---|---|
| 本地发现 | `src/skills/loadSkillsDir.ts`：`loadSkillsFromSkillsDir()`、`getSkillDirCommands()` | 目录格式仅识别 `<name>/SKILL.md`；legacy `/commands` 兼容单 `.md`；并行扫描 managed/user/project/additional roots | 新建 `packages/skills` loader，优先支持 `<name>/SKILL.md`；legacy 只做显式迁移，不让旧格式污染核心 contract |
| 去重与优先级 | `getFileIdentity()`、`realpath()`、`seenFileIds` | 解析符号链接后的规范路径去重；先到先得，加载顺序由 managed → user → project 等来源决定 | 采用 DSH 的 rank/provider 合并模型，避免只靠路径字符串；所有 symlink、重复 root 和跨平台大小写行为写安全测试 |
| frontmatter | `parseSkillFrontmatterFields()`、`createSkillCommand()` | 解析 `name`、`description`、`when_to_use`、`allowed-tools`、`argument-hint`、`arguments`、`model`、`effort`、`context`、`agent`、`hooks`、`paths`、`version`、`user-invocable`、`disable-model-invocation`、`shell` 等 | 本仓库先定义最小稳定字段：`name/description/whenToUse/modelInvocable/userInvocable/allowedTools/context/version`；扩展字段必须经 schema、权限和 ADR 审核 |
| prompt 延迟加载 | `createSkillCommand().getPromptForCommand()` | 列表只含摘要；调用时才读正文，替换 `$ARGUMENTS`、`${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}`；本地 Skill 可执行 prompt shell | 本仓库应保持“摘要进入 catalog，正文按需加载”；默认禁止 prompt 内联 shell，脚本必须走受管工具和 workspace policy |
| MCP Skill 安全 | `createSkillCommand()` 中 `loadedFrom !== 'mcp'` 守卫；`src/skills/mcpSkills.ts` | 远程/MCP Markdown 不执行 `!` shell，不做本地目录替换；MCP 资源变化触发缓存失效 | MCP Skill 必须作为不可信来源，禁止把远程正文直接提升为 allowed tool；统一经过 schema、来源信任和 approval |
| 动态路径发现 | `discoverSkillDirsForPaths()`、`addSkillDirectories()`、`activateConditionalSkillsForPaths()` | 文件操作后从目标路径向上找 `.claude/skills`；`paths` frontmatter 用 gitignore 规则匹配；深层目录优先；gitignored 目录跳过 | 可在 `ToolRuntime` 的 file read/write/edit 成功后发 `skills/change`/invalidate；不得在 Web 侧自行猜测当前 skill 目录 |
| Prompt catalog 预算 | `packages/builtin-tools/src/tools/SkillTool/prompt.ts`：`formatCommandsWithinBudget()` | 约 context window 的 1% 预算；单描述 250 字符；bundled 描述不截断；预算不足先截断描述，最后只保留名称 | 本仓库应在 `packages/context` 建 `skill-catalog` projector，预算、排序、digest 可回放；catalog 不含正文/绝对路径 |

#### 3.2.2 SkillTool 执行与权限

核心入口为 `D:/Develop/claude-code/packages/builtin-tools/src/tools/SkillTool/SkillTool.ts`：

1. `inputSchema` 只接受 `skill` 名称和可选 `args`；`validateInput()` 规范化前导 `/`、确认存在、拒绝 `disable-model-invocation` Skill，并对远程 canonical skill 做 feature-gate 检查。
2. `checkPermissions()` 先处理 deny，再处理显式 allow，再按 `SAFE_SKILL_PROPERTIES` 做正向白名单；未知或新增的有意义属性默认需要用户确认，并给出精确规则和 `name:*` 前缀规则建议。
3. `call()` 根据 `context === 'fork'` 分成 inline/fork；inline 通过 `processPromptSlashCommand()` 注入 user message 和 `contextModifier`；fork 通过 `prepareForkedCommandContext()`、`runAgent()` 运行隔离子 Agent，利用 `onProgress` 返回进度并清理子 Agent 消息。
4. `executeRemoteSkill()` 对远程 canonical skill 重新取 URL、缓存加载、限制协议和正文替换；远程 Skill 不走 `$ARGUMENTS`/`!command` 展开，并在 compact 后保留 invoked-skill 状态。

该实现将“Skill 是 prompt/工作流声明”与“Tool 是执行原语”分开，但 Skill 仍必须进入统一权限、workspace、取消和事件管线。`allowed-tools` 不能绕过 deny、workspace 或审批。

#### 3.2.3 Plugin 与 Skill 的装配

插件相关入口位于 `D:/Develop/claude-code/src/utils/plugins/` 与 `src/services/plugins/`：

- `schemas.ts`：`PluginManifestSchema`、`PluginMarketplaceSchema`、路径和官方名称校验；拒绝 `..`、路径分隔符、官方市场冒用和非 ASCII 同形攻击。
- `validatePlugin.ts`：开发期 manifest/marketplace/skill 校验、路径穿越错误和 warning。
- `pluginLoader.ts`：发现、加载、缓存、启用/禁用和错误收集；`loadPluginCommands.ts` 将插件 `commands/`、`skills/` 转成统一 `Command`，插件 Skill 名称含 `plugin:skill` namespace。
- `pluginDirectories.ts`：插件 cache/data 目录、seed 目录、`${CLAUDE_PLUGIN_DATA}` 持久数据目录；版本更新与插件安装缓存分离。
- `pluginVersioning.ts`、`reconciler.ts`、`marketplaceManager.ts`、`PluginInstallationManager.ts`：marketplace reconcile、安装、更新、失败恢复和 `/reload-plugins` 刷新。
- `pluginPolicy.ts`、`pluginFlagging.ts`、`pluginBlocklist.ts`：策略源、feature gate、blocklist 和受管环境限制。

本仓库只应吸收“manifest schema + 可回滚安装缓存 + enable/disable + reconcile 状态机”的结构，不能复制 Claude Code 的账户、商业 marketplace、遥测或官方服务。

#### 3.2.4 Skill UI、搜索和测试参考

- SkillTool 的工具行、权限请求和菜单入口分散于 `packages/builtin-tools/src/tools/SkillTool/UI.tsx`、`commands.ts`、`prompt.ts`、`src/utils/permissions/permissions.ts`、`src/utils/plugins/pluginIdentifier.ts`、`src/components/skills/SkillsMenu.tsx`、`src/components/permissions/SkillPermissionRequest/SkillPermissionRequest.tsx`。
- `src/utils/skills/skillChangeDetector.ts` 与 `src/hooks/useSkillsChange.ts` 负责目录变化后的刷新；`src/services/skillSearch/` 是实验性本地/远程语义搜索，当前快照中多为 stub，不能当作成熟核心能力。
- `docs/extensibility/skills.mdx`、`docs/features/mcp-skills.md`、`docs/features/experimental-skill-search.md` 是行为说明；后两者明确 MCP Skill fetcher 和实验性搜索仍有 stub，不应在本项目计划中标为“已验证上游功能”。

## 4. DSH 参考实现

### 4.1 Memory：DSH 提供事件、投影和 compaction 基础，不提供 CC 式语义记忆

DSH 没有与 Claude Code `SessionMemory`/`memdir` 等价的内置语义记忆目录。它把以下能力视为事实基础：

| DSH 基础 | 程序/文件/入口 | 可借用设计 | 与本仓库 Memory 的关系 |
|---|---|---|---|
| 事件事实源 | `D:/Develop/deepseek-harness-fork/packages/core/session/src/types.ts`、`index.ts`、`surface.ts` | append-only `SessionEvent`；`deriveMessages()` 从事件派生 LLM history；fork/resume/replay/persistence 共用同一日志 | 本仓库已有 EventStore/SessionProjection；Session/Project Memory 正文应继续保持外部 adapter，事件只记录 bounded metadata |
| 请求可重建 | `packages/core/session/src/request-header.ts`、`docs/subsystems/session.md` | `request/header`、`request/context` 是下一次请求的完整快照；重启时从日志恢复，而非依赖内存状态 | 可把 Memory adapter 状态、last extracted boundary、catalog digest 作为可选 projection/receipt，不能只存在进程内 |
| compaction seam | `packages/compaction/compaction/src/index.ts`、`compaction-basic/src/index.ts`、`region.ts`、`summarizer.ts` | `ctx.compaction` seam；`compaction/start` → `summary` → replacement `user/message` → `end`；失败和取消也落事件；tool pair 边界受保护 | 本仓库已有 M06/M07/M08/M10/M13 compact/replay；应参考 DSH 的生命周期、失败分类、surface boundary 和 recovery 测试 |
| tool-result pruner | `packages/compaction/compaction-tool-result-pruner/src/index.ts`、`types.ts` | 先做无模型 text-bearing tool result 替换，再按 token meter 重新选择摘要区间 | 对本仓库的 Skill/Memory 价值在于：长 Skill 输出先做可回放的结构化裁剪，不能静默覆盖原始事件 |
| Agent Note | `.agents/notes/` | 作为开发治理和知识记录 | 不能当作面向用户或项目的 Memory；仅可作为文档/决策来源 |

DSH 的关键启示是：语义 Memory 可以作为领域 provider，但其生命周期、恢复和 UI 必须锚定 Session Event/Projection；不能另造第二套“事实来源”。

### 4.2 DSH Skill：分层 registry + provider + 按需 body + durable catalog

#### 4.2.1 Service Definition 与 Provider

核心实现：`D:/Develop/deepseek-harness-fork/packages/skill/skill/src/index.ts`。

- `SkillSummary` 只含 `name/description/whenToUse/invocation/source/provider/resourceBase`；不含正文和绝对路径的模型 catalog。
- `SkillCandidate` 增加 `rank/locator/path/metadata`；registry 只保存 provider-owned opaque locator，调用胜出 provider 的 `get()` 时才加载正文。
- `SkillDefinition` 是完整正文；`SkillInvocationPolicy` 明确 `modelInvocable` 与 `userInvocable` 两个独立布尔值。
- `SkillProvider.list({cwd, signal})` 支持 workspace-sensitive、可取消发现；可返回 `{candidates, complete:false}`，不完整结果不进入缓存。
- `SkillRegistry` 使用宿主 + scope 分层；最近 scope 覆盖远层，同层按 rank、provider order、local order 决定重名；缓存 key 包含 cwd、scope chain、revision；注册/dispose/invalidate 会发 `skills/change`。
- `ctx.skills.get(name, options)` 每次按 candidate 重新读取正文，验证名称、描述、policy 和 provider；正文改动无需改写旧目录消息，下一次调用得到新定义。

#### 4.2.2 Filesystem Provider

核心实现：`packages/skill/skill-filesystem/src/index.ts`。

默认 rank：`project-dsh=100`、`project-agents=200`、`custom=300`、`user-dsh=400`、`user-agents=500`、`bundled=600`。项目根由最近 `.git` 祖先确定；默认根包括 `<project>/.dsh/skills`、`<project>/.agents/skills`、`$DSH_HOME/skills`、`$DSH_AGENTS_HOME/skills` 和可选 bundled root。

provider 解析目录包 `<name>/SKILL.md` 与扁平 `<name>.md`，校验 kebab-case 名称和 frontmatter 的 `disable-model-invocation`/`user-invocable`，通过 `ctx.fs` 读取。`SkillWatchManager` 使用 Chokidar 监视直属目录、缺失祖先和项目容量，文件变更只做 registry invalidation；watcher 失败返回可用候选但标记 `complete:false`。

#### 4.2.3 Model tool、用户手势与 catalog

核心实现：`packages/skill/tool-skill/src/index.ts`。

- `apply(ctx)` 注册 `skill` tool；名称必须 kebab-case；先 `ctx.skills.list()` 找摘要，再检查 `isModelInvocable()`，最后 `ctx.skills.get()` 读取完整正文。
- 工具结果由 `renderSkillContent()` 统一渲染为 `<skill_content><skill_resources><skill_instructions>`；`resourceBase` 只给出按需解析资源的指引。
- `agent/pre-step` 扫描真实 `source.kind === 'user'` 消息中的 `/name` 手势，对 `userInvocable` Skill 注入 `skill-invocation` instructions；模型不可见 Skill 不进入 catalog，只能由用户显式调用。
- 同一插件维护 durable `skill-catalog` user message：首次发布、digest 变化时追加完整替换；不完整 snapshot 保留上一份可用目录；压缩隐藏历史后会重建，空目录会显式替换为空。

这是一种比 Claude Code 更偏“事件可回放”的实现：目录消息本身是 session history 的 durable source metadata，工具输出和用户注入都使用同一 canonical renderer。

#### 4.2.4 Host API、Web UI 与测试

- `packages/host/apiproxy/src/api/skills.ts`、`skills.schema.ts`、`apiproxy.ts` 暴露 `skill.list`，按 session header 的 cwd 和 agent scope 返回用户可调用目录；调用仍走 `session.prompt`，没有第二套 invocation wire。
- `packages/client/ui-skill/src/client/SkillRow.tsx` 将冻结的 tool call/result slice 渲染成 replay-stable 工具行；`packages/client/ui-skill/README.zh.md` 记录 slash source、cache、catalog 与已知限制。
- `packages/client/ui-settings-plugin-inventory`、`packages/host/plugin-inventory/src/index.ts` 提供只读 Loader inventory；插件生命周期直接读取 Cordis Loader fiber 状态，避免再造缓存事实源。
- 关键 e2e：`apps/web/tests/skill-tool-row.e2e.ts`、`skill-user-invoke.e2e.ts`、`skill-invocation-policy.e2e.ts`、`agent-preset-selection.e2e.ts`、`scaffold-hermetic.e2e.ts`；覆盖 replay、用户显式调用、四象限 invocation policy、scope/preset 隔离和 ambient root 隔离。

### 4.3 DSH Plugin/Cordis 结构

DSH 通过 Cordis Loader 将插件作为 service definition/provider/consumer 组合。Skill registry、filesystem provider、tool-skill、API gateway、client UI 都是可独立装配和 dispose 的包；插件设置和 inventory 通过 Typert Remote 只读投影，插件状态由 Loader fiber 维护。对本仓库应借用“包边界 + 显式 inject + disposer + capability absence”，不要照搬 Cordis 框架本身或 DSH 的全部插件生态。

## 5. 三方能力矩阵与本仓库差距

| 模块 | 本仓库现状 | Claude Code | DSH | 差距判定 |
|---|---|---|---|---|
| Session Memory 存储 | adapter 契约、bounded compact、metadata projection；M1 已由 SQLite API Host 默认装配 `FileSessionMemoryStore` | Markdown 文件 + post-sampling forked extractor + exact-path write guard | 无语义 Memory；以 Session Event/compaction 为基础 | M1 已完成；后续补 model-backed extractor、读写/观测 API |
| Project Memory | bounded `MEMORY.md`/topic taxonomy、relevance/stale 纯函数；无默认 filesystem adapter | memdir 文件树、topic frontmatter、最多 5 条轻量召回、team/KAIROS 扩展 | 无等价实现 | P1：filesystem adapter、trust、recall API |
| Transcript/Replay | EventStore + replay + compact boundary 已进入主路径 | transcript 与 Memory 分离，compact 时保护 tool pair | append-only event + `deriveMessages()` + lifecycle event | 已具备；以 DSH 作为恢复验收基线 |
| Skill discovery | 无 `SKILL.md` loader；仅 attachment/capability | managed/user/project/add-dir/plugin/bundled/MCP；dynamic path activation | provider registry、scope、rank、watcher、incomplete snapshot | P0：定义 contract + loader/provider |
| Skill catalog | 无独立 catalog projection | prompt budget 约 1%，描述截断/降级 | durable `skill-catalog` message + digest replacement | P1：事件化 catalog，预算可配置 |
| Skill invocation | 无 SkillTool；`authorizeSkill()` 只是 guard | SkillTool validate/permission/call，inline/fork | `skill` tool + user `/name` pre-step injection | P0：统一 ToolRuntime 管线和两种入口 |
| Skill policy | optional capability 默认关闭；不可覆盖 safety | deny/allow + safe properties 正向白名单 | model/user 双布尔 policy，边界重复校验 | P0：将 model/user policy 设为显式 contract |
| MCP/远程 Skill | 未实现完整 runtime | MCP skill feature gate；远程 canonical skill 实验能力 | provider 可扩展 URL/opaque resourceBase，但无 CC marketplace | P2：先本地，后 MCP provider；远程默认 fail closed |
| Plugin install/version | `plugins` capability 明确 deferred | manifest、marketplace、cache、reconcile、install/update | Cordis Loader/package plugins、只读 inventory | P2：最小本地 bundle/registry，暂不做商业 marketplace |
| Web/API | 无 Memory/Skill 专用面 | CLI/TUI 菜单、权限请求、技能变化 hook | `skill.list` RPC、SkillRow、settings inventory、e2e | P1：catalog API + tool row + settings 只读面 |
| 观测/恢复 | Memory metadata、token diagnostics 已有；Skill 无事件 | telemetry/usage ranking/feature gates | `skills/change`、session source metadata、完整 replay | P1：事件、digest、incomplete、恢复和审计 |

## 6. 本仓库模块化改造点

以下改造遵循本仓库事件唯一事实源和统一工具管线。每一项都说明了本仓库入口、上游参照、契约影响和验收方式。

### 6.1 Memory 改造模块

| 模块 | 本仓库需要改造的程序/文件/入口 | 参照 Claude Code / DSH | 主要改造点 | 契约、测试、回滚 |
|---|---|---|---|---|
| M-A Host durable Session Memory | `apps/api/src/server.ts:createApiServer()`、`packages/runtime/src/index.ts:AgentHost` | CC `SessionMemory/sessionMemory.ts`、`sessionMemoryUtils.ts`；DSH `core/session` 的恢复和 event boundary | 新增 `ApiServerOptions.sessionMemory`、`sessionMemoryExtractor`；默认使用本地 bounded adapter；每 session 单飞/串行；启动时恢复 last boundary；Extractor 结果写 receipt metadata | Event 增加 bounded `session_memory/*` metadata 或 projection；单元/重复请求/重启/取消/tool pair 测试；禁用时 adapter=null，回滚仅关闭默认注入 |
| M-B Session Memory writer/policy | `packages/context/src/session-memory.ts`、`session-memory-compact.ts`、`packages/tools/src/capabilities.ts` | CC `createMemoryFileCanUseTool()`、`updateLastSummarizedMessageIdIfSafe()` | 把 writer 作为受限 capability；精确路径、大小、原子写、版本/etag、审计；extractor 只能编辑 memory file，不得调用其它工具 | Permission/Workspace contract；路径穿越、symlink、并发写、重复批准、崩溃恢复；保留旧 adapter API 作为兼容层 |
| M-C Project Memory filesystem adapter | `packages/context/src/project-memory.ts`、新增 `packages/context/src/project-memory-fs.ts`；`apps/api/src/server.ts` scope 派生 | CC `memdir/paths.ts`、`memdir.ts`、`memoryScan.ts`；DSH `skill-filesystem` 的 cwd/git-root/provider 方式 | 实现 workspace/tenant scope → bounded memory dir；`MEMORY.md` 200 行/25KB；topic frontmatter、safe links、atomic rename、stale validator；worktree canonical root | Storage contract + migration from adapter-only data；safe path、gitignored、tenant isolation；feature flag 关闭可回到空 adapter |
| M-D Memory recall/index | `packages/runtime/src/index.ts:projectMemoryContext()`、`packages/context/src/project-memory.ts` | CC `findRelevantMemories.ts`、`context.ts`；DSH `SkillRegistry.snapshot()` 的 incomplete/cache 语义 | 先 deterministic manifest/lexical recall，后可插入受限 `sideQuery`；最多 5 topic；`alreadySurfaced` 去重；不完整扫描保留 last-good | Context contract 增加 `complete/asOf`；召回排序、stale、取消、模型失败 fallback；关闭 recall 不影响正文存储 |
| M-E Memory compact/recovery | `packages/runtime/src/index.ts:compactTurnContext()`、`packages/context/src/session-memory-compact.ts`、`packages/storage/src/index.ts` | CC `sessionMemoryCompact.ts`；DSH `compaction-basic`、`tool-result-pruner` | 将 Memory section truncation、tool-result pruning、summary boundary 统一到 compact lifecycle；保留原始事件/metadata；恢复后重建同一 prompt | compact lifecycle/replay contract；断线、重启、半写文件、摘要失败、persistence failure；回滚可仅停用自动 compact |
| M-F Memory Web/API | `apps/web/src/client/store.ts`、`src/presentation`、`apps/api/src/server.ts` | DSH `session-projection`、`skill.list`/UI tool row；CC memory commands/UI behavior | 增加只读 Memory summary、source/type/stale/last-updated；正文默认折叠；写操作必须走 API/permission/event，Web 不做事实源 | 新 projection/schema + SSE replay；刷新/回放一致；无后端支持时显示 unavailable，不伪造成功 |

### 6.2 Skill 改造模块

| 模块 | 本仓库需要改造的程序/文件/入口 | 参照 Claude Code / DSH | 主要改造点 | 契约、测试、回滚 |
|---|---|---|---|---|
| S-A Skill contract/registry | 新增 `packages/skills`（或 `packages/tools` 下独立目录）；`packages/contracts/src/index.ts` 注册 summary/candidate/definition/policy | CC `loadSkillsDir.ts`/`SkillTool.ts`；DSH `packages/skill/skill/src/index.ts` | 采用 `SkillSummary/Candidate/Definition`、`modelInvocable/userInvocable`、provider/rank/locator、`snapshot.complete`；scope/cwd/signal 进入查找 API | 新公共 contract/ADR；schema、重名、scope shadow、incomplete cache、abort 测试；未启用时 registry capability absent |
| S-B Filesystem loader | 新增 `packages/skills-filesystem/src/index.ts`；在 `apps/api/src/server.ts` 或 Host composition 装配 | CC `loadSkillsFromSkillsDir()`、`getSkillDirCommands()`、`discoverSkillDirsForPaths()`；DSH `skill-filesystem/src/index.ts` | 扫描 `.agents/skills`、`.dsh/skills`、用户/项目/自定义根；支持 `<name>/SKILL.md`，解析最小 frontmatter；realpath 去重；可选 watcher/invalidate | Workspace contract、symlink/gitignore/路径穿越/大小上限；loader 单测 + hermetic e2e；关闭 watcher 仍可手动刷新 |
| S-C Skill catalog projector | `packages/runtime/src/index.ts:assembleTurnContext()`；`packages/contracts` event/projection；`apps/web/store.ts` | CC `SkillTool/prompt.ts:formatCommandsWithinBudget()`；DSH `tool-skill` catalog digest/replacement | 只将排序后的 name/description/whenToUse 注入；约 context window 1% 上限、description cap、digest；正文和绝对路径不进 catalog | 增加 `skill-catalog` source/event；replay、compact 后重建、删除全量替换、incomplete last-good；预算与 provider 变化测试 |
| S-D SkillTool invocation | 新增 `packages/tools/src/skill.ts` 或 `builtin-skill.ts`，注册到 `CapabilityRegistry`/ToolRuntime | CC `SkillTool.validateInput/checkPermissions/call()`；DSH `tool-skill` | 输入 schema、名称校验、摘要→正文二次校验；返回 canonical `<skill_content>`；inline 注入或 fork 到内部 Subagent；结果带 structured metadata | Tool contract、Permission contract、Task/Subagent mapping；单测/合同/恢复/e2e；回滚只隐藏 tool，不删除已落事件 |
| S-E User slash invocation | `apps/api/src/server.ts` turn ingress、`packages/runtime/src/index.ts` pre-step；Web composer source | DSH `tool-skill` `agent/pre-step` 与 `ui-skill`；CC slash command/SkillTool | 只认真实 user message 的 `/kebab-name`；用户可调用但 model-hidden 的 Skill 进入 instructions injection；命令 namespace 冲突有确定优先级 | Event source `skill-invocation`；注入与普通 prompt replay 相同；伪造 external source、路径 `/usr/bin`、重复 token、取消测试 |
| S-F Permission/trust policy | `packages/tools/src/capabilities.ts`、新增 skill policy module、`apps/api/src/server.ts /v1/capabilities` | CC `SAFE_SKILL_PROPERTIES`、deny/allow suggestions、MCP untrusted shell guard；DSH `isModelInvocable/isUserInvocable` | 正向 allowlist；未知 frontmatter 属性默认 ask；Skill allowedTools 只能缩小权限；source trust（bundled/local/remote）不能提升安全基线 | Permission/audit event；deny/allow/approval replay；默认关闭 optional Skill；回滚保留 capability_status |
| S-G Dynamic invalidation | `packages/tools/src/builtin.ts` file read/write/edit 成功路径、`packages/runtime` cache | CC `activateConditionalSkillsForPaths()`、`addSkillDirectories()`；DSH watcher + `skills/change` | 文件变更后让 registry/catalog cache 失效；支持 `paths` 条件激活的最小子集；不完整 watcher 保留 last-good | change event/replay；并发变更、gitignored、scope 隔离；可关闭 watcher，改为 turn 边界刷新 |
| S-H Plugin/bundle adapter | 新增 `packages/skills-plugin`、`packages/plugin-runtime`（按需）；`packages/runtime/src/index.ts:pluginsSettings()` 替换 deferred | CC `schemas.ts`、`validatePlugin.ts`、`pluginLoader.ts`、`reconciler.ts`；DSH Cordis Loader/inventory | 先支持本地 bundled/manifest、enable/disable、版本 pin、原子 cache、reconcile 状态；插件贡献 Skill provider/tool/prompt；不做商业 marketplace | Plugin manifest/installation contract、inventory projection、失败/回滚/卸载测试；feature flag 默认关闭，安装缓存可删除重建 |
| S-I MCP Skill provider | 新增 `packages/skills-mcp`，接入现有 MCP seam（当前仓库尚无完整 MCP runtime） | CC `mcpSkills.ts`、`mcpSkillBuilders.ts`、`docs/features/mcp-skills.md`；DSH provider URL/opaque `resourceBase` | 仅在显式 feature gate 开启；资源 schema、URL allowlist、大小/超时/缓存；远程正文禁止 shell expansion；失败返回 incomplete | MCP contract、取消、缓存失效、远程内容注入安全；默认不装配，stub 不标成功 |
| S-J Skill Web/API | 新增 `/v1/skills` 或扩展 capabilities；`apps/web/src/client/store.ts`、presentation、composer、tool row | DSH `skills.ts`/schema、`SkillRow.tsx`、`ui-skill` e2e；CC `SkillsMenu.tsx`、permission UI | 目录列表、来源/策略状态、加载工具行、用户-only marker、变化刷新；渲染只读 durable call/result slice | Wire schema、SSE/replay、浏览器 e2e；后端能力缺失显示 unavailable；UI 可独立禁用 |

## 7. 分阶段实施路线

阶段顺序按“先契约和默认装配，再本地文件能力，再远程/插件扩展”安排。每阶段都应创建可回滚 Git checkpoint，并同步 `docs/status.zh-CN.md`；若改变公共 Event/Tool/Permission/Workspace contract，先更新 ADR 和契约文档。

### M0：契约与 Host 装配基线

状态：`implemented`（2026-09-01，checkpoint `a2f8d71`）

- **范围**：确认 Session Memory/Project Memory adapter 的默认实现、scope key、错误和 disabled 语义；补 `ApiServerOptions` 注入参数；为 Memory metadata 定义事件/Projection 形状。
- **入口**：`apps/api/src/server.ts`、`packages/runtime/src/index.ts`、`packages/contracts/src/index.ts`、`packages/storage/src/index.ts`、`docs/event-contract.md`、`docs/tool-contract.md`。
- **参照**：CC `sessionMemoryUtils.ts` 的门控；DSH `SessionEventMap`、`ProjectionDefinition`、`SkillCatalogSource` 的 source metadata。
- **验收**：默认 Host 启动后可读空 Memory、adapter 明确 `disabled/unavailable`；InMemory/SQLite replay 相同；`pnpm typecheck`、`pnpm test`。
- **禁用/回滚**：保留可选 adapter 注入；通过配置关闭自动抽取，不改变既有 compact/replay。

M0 实际结果：`MemoryCapability`/adapter readiness 已进入 Runtime/API capability projection；未配置 adapter 为 `unavailable`，显式关闭为 `disabled`，没有引入 no-op adapter，也没有把 Memory 正文写入 EventStore/SSE/projection。

### M1：默认 durable Session Memory

状态：`implemented`（2026-09-01，checkpoint `da5c7a7`）

- **范围**：本地 bounded Markdown/SQLite adapter（二选一，推荐先文件 adapter + metadata receipt）；threshold、串行 extractor、exact-path writer、重启恢复。
- **入口**：`packages/context/src/session-memory.ts`、`session-memory-compact.ts`、`packages/runtime/src/index.ts` 的 `scheduleSessionMemoryExtraction()` / `executeSessionMemoryExtraction()`、`apps/api/src/server.ts`。
- **参照**：CC `SessionMemory/sessionMemory.ts`、`prompts.ts`、`filesystem.ts`；DSH `session` event log 和 compaction lifecycle。
- **验收**：首次/后续阈值、自然断点、tool pair 未闭合保护、重复 extraction 幂等、崩溃后 receipt 恢复、取消不污染主 turn；安全测试覆盖路径穿越/symlink/并发写。
- **禁用/回滚**：feature flag 关闭 scheduler，保留已写文件只读；发生 schema 迁移问题可回退到 adapter-only 模式。

M1 实际结果：`packages/context/src/session-memory-file.ts` 提供 frontmatter + etag、字符/UTF-8 bytes bound、临时文件 `fsync` + 同目录 rename、session id/path/symlink fail-closed 和单 session 串行写；`apps/api/src/server.ts:createApiServer()` 对 SQLite 默认按数据库绝对路径 hash 隔离目录，并支持 `sessionMemoryRootDir` 覆盖。无模型 fallback extractor 只读取 user/assistant transcript，固定 restricted capabilities；runtime 已覆盖取消、主 turn 隔离、保存后幂等 receipt 和重启恢复。M1 不提供 Project Memory 默认 adapter、Memory 读写/召回 API 或 Web 管理面。

### M2：Project Memory filesystem 与 writer policy

状态：`implemented`（2026-09-01，checkpoint `736efea`）

- **范围**：scope → memory directory、`MEMORY.md`/topic 文件、frontmatter taxonomy、safe link、atomic write、stale validator。
- **入口**：`packages/context/src/project-memory.ts`（必要时拆分 `project-memory-fs.ts`）、`packages/runtime/src/index.ts:projectMemoryContext()`、`apps/api/src/server.ts`。
- **参照**：CC `memdir/paths.ts`、`memoryScan.ts`、`findRelevantMemories.ts`；DSH `skill-filesystem` 的 git-root/cwd/provider 解析。
- **验收**：不同 tenant/workspace/worktree 隔离；200 行/25KB bound；超限 warning；broken link/stale topic；无权限或读取失败 fail closed；旧 adapter 数据可迁移且可回滚。
- **禁用/回滚**：配置 `projectMemory.enabled=false` 时不读写文件；scope key 迁移失败时继续使用旧 adapter，不清理原数据。

M2 实际结果：新增 `FileProjectMemoryStore` 与 `ProjectMemoryWriterPolicy`。SQLite API Host 默认将其装配到数据库同级 `project-memory/<db-hash>/`（可通过 `projectMemoryRootDir` 覆盖），每个 Host 派生的 scopeKey 独立目录；`MEMORY.md` 与 `topics/<id>.md` 使用受限 frontmatter、四类 taxonomy、bounded 内容和 references。扫描对 malformed/incomplete、symlink、路径穿越和超限文件 fail closed/跳过；写入使用受限临时文件、`fsync` 和 rename，并在 Windows 已存在目标时受控替换。Project Memory 正文仍只存在 host-owned filesystem，EventStore/SSE/projection 仅保留既有 bounded metadata。`projectMemoryEnabled=false` 可关闭默认装配并保留文件；旧自定义 adapter 仍可显式注入。

### M3：Memory 召回、观测和 Web

状态：`implemented`（2026-09-01，M3）

- **范围**：manifest/lexical recall、最多 5 topic、`alreadySurfaced` 去重、last-good incomplete、Memory projection/API/Web 只读面。
- **入口**：`packages/context/src/project-memory.ts`、`packages/runtime/src/index.ts:assembleTurnContext()`、`packages/contracts/src/index.ts`、`apps/web/src/client/store.ts`、`src/presentation`、`apps/api/src/server.ts`。
- **参照**：CC `findRelevantMemories.ts` 与 memory trust 规则；DSH `session-projection`、`skill-catalog` digest/replay。
- **验收**：模型不可用时 deterministic fallback；刷新、SSE 重连、从日志回放的 Memory 状态一致；Web 不显示未落盘成功的写入；敏感正文默认不进入 SSE。
- **禁用/回滚**：关闭 recall 仍保留可手工查看的 bounded index；Web capability 缺失显示 unavailable。

M3 实际结果：`packages/context/src/project-memory.ts` 增加安全 manifest 交集和 deterministic lexical recall；`ProjectMemoryStore.scanTopics()` 可报告 incomplete/last-good，文件 adapter 对损坏 topic、symlink 和超限扫描保留最近成功的 bounded headers，没有可用快照时 fail closed。Runtime 在 `assembleTurnContext()` 中复用一次扫描结果，按 turn 去重 `alreadySurfacedIds`，最多注入 5 个 topic，并通过 `context/project_memory_incomplete` 记录有限失败元数据。Context Project Memory projection 增加 `scanStatus`、`usingLastGood`、`failedTopicIds` 和 incomplete 状态，正文仍只存在当前 model view。

API 新增 `GET /v1/sessions/:id/memory`，仅返回 capability 与 Session/Project bounded projection；Web `SessionStore` 支持 live/SSE/replay 折叠，`presentMemoryInspector` 展示可用、禁用、不可用和 last-good/incomplete 状态，不显示未落盘正文或 optimistic 写入。无模型时保持标题/描述/路径词法 fallback；adapter/scan 失败均不阻塞主 turn且不注入不可信正文。

### S0：Skill contract、registry 和安全模型

- **范围**：建立 `SkillSummary/Candidate/Definition/InvocationPolicy/Provider`、rank/scope/cwd/signal、`skills/change`、source trust 和正向 permission。
- **入口**：新增 `packages/skills` 与 `packages/contracts` 类型；扩展 `packages/tools/src/capabilities.ts`、`apps/api/src/server.ts:/v1/capabilities`。
- **参照**：DSH `packages/skill/skill/src/index.ts` 是主要骨架；CC `SkillTool.checkPermissions()` 是行为参考。
- **验收**：重名 shadow、scope chain、provider failure/incomplete、abort、unknown property ask、model/user 四象限；无 provider 时 capability absent/deferred。
- **禁用/回滚**：registry 可装配但默认不暴露模型工具；不修改现有 attachment `kind:'skill'` 语义。

### S1：本地 SKILL.md loader/provider

- **范围**：项目/用户/自定义/bundled 根、frontmatter schema、realpath 去重、大小和深度限制、手动 refresh；watcher 作为可选项。
- **入口**：新增 `packages/skills-filesystem/src/index.ts`；在 Runtime composition/`apps/api/src/server.ts` 注册 provider。
- **参照**：CC `loadSkillsDir.ts` 的来源与动态目录；DSH `skill-filesystem/src/index.ts` 的 rank、watcher、incomplete observation。
- **验收**：hermetic workspace、symlink/duplicate roots、gitignore、malformed frontmatter、跨平台路径、watcher 失败 last-good；`SKILL.md` 正文按需读。
- **禁用/回滚**：只读扫描模式；watcher 关闭后在 turn 边界重新 list；loader 失败不阻塞普通 Agent turn。

### S2：Skill catalog + SkillTool + 用户 `/name`

- **范围**：catalog budget/digest、摘要→正文二次校验、canonical renderer、inline/fork、用户-only injection、ToolRuntime/approval/event。
- **入口**：`packages/runtime/src/index.ts:assembleTurnContext()`、新增 `packages/tools/src/skill.ts`、`packages/contracts/src/index.ts`、`apps/api/src/server.ts` turn ingress、`apps/web/src/client/store.ts`。
- **参照**：CC `SkillTool.ts` 的 validate/permission/call 和 `prompt.ts` 预算；DSH `tool-skill/src/index.ts` 的 durable catalog/source、pre-step user gesture、renderSkillContent。
- **验收**：模型自动调用、用户-only Skill、inline/fork 隔离、工具结果 replay、compact 后 catalog 重建、重复 `/name`、Skill 名与命令冲突、取消/approval replay。
- **禁用/回滚**：只关闭 model-facing catalog/tool；用户显式调用可单独保留；已写事件仍由通用 renderer 回放。

### S3：动态 invalidation、path 条件和 Web presenter

- **范围**：文件工具变更触发 registry invalidation；`paths` 条件激活；`/v1/skills` 列表、composer suggestions、dedicated Skill tool row。
- **入口**：`packages/tools/src/builtin.ts` 文件工具成功分支、`packages/runtime` cache、`apps/api/src/server.ts`、`apps/web/src/client/store.ts`/presentation。
- **参照**：CC `discoverSkillDirsForPaths()`/`activateConditionalSkillsForPaths()`/`useSkillsChange.ts`；DSH `skills/change`、`SkillRow.tsx`、`skill.list` RPC。
- **验收**：文件变更后下一步 catalog 正确替换；不完整扫描保留 last-good；UI 只读 durable slice；浏览器 e2e 覆盖 list、user-only marker、tool row、replay。
- **禁用/回滚**：先使用手动/turn-boundary refresh；UI 独立 feature gate。

### S4：本地 Bundle/Plugin 最小运行时

- **范围**：manifest schema、bundle 安装缓存、版本 pin、enable/disable、reconcile、inventory；插件贡献 Skill provider/tool/prompt，但不允许绕过权限和 workspace。
- **入口**：替换 `packages/runtime/src/index.ts:pluginsSettings()` deferred；新增 `packages/plugin-runtime`、`packages/skills-plugin`；API/Web settings 只读 inventory。
- **参照**：CC `schemas.ts`、`validatePlugin.ts`、`pluginLoader.ts`、`reconciler.ts`；DSH Cordis Loader、`plugin-inventory`、settings UI。
- **验收**：恶意 manifest/path traversal、失败安装、半更新、回滚到上个版本、dispose 清理、inventory 与实际 Loader 状态一致；安装缓存可重建。
- **禁用/回滚**：默认关闭 plugin capability；保留 `deferred` 返回；仅允许本地显式 bundle，暂不接 marketplace。

### S5：MCP/远程 Skill 与可选搜索

- **范围**：显式 feature gate 的 MCP `skill://` provider、URL/大小/超时/缓存、远程正文 trust；本地/远程语义搜索仅在有验收场景后实现。
- **入口**：新增 `packages/skills-mcp`、MCP adapter；必要时扩展 `apps/api` capability；不把当前 `packages/context` attachment 当成远程 loader。
- **参照**：CC `mcpSkills.ts`、`mcpSkillBuilders.ts`、`SkillTool.executeRemoteSkill()`；实验搜索只参考其 feature-gate/stub 边界；DSH provider 的 URL/opaque resourceBase。
- **验收**：远程 shell 注入、URL SSRF、超大正文、断线取消、缓存失效、MCP resources/list_changed；默认关闭且失败不影响本地 Skill。
- **禁用/回滚**：feature flag 关闭即不加载模块；搜索 stub 继续标记 deferred，不宣称已实现。

## 8. 测试、迁移、运维与“不应实现”的边界

### 8.1 最低测试门禁

每个 Memory/Skill 阶段至少覆盖以下四层：

1. **单元**：frontmatter/schema、名称和路径、rank/shadow、threshold、budget、digest、policy、safe link、stale、token accounting。
2. **合同**：EventStore/replay、SSE projection、Tool schema/structured result、provider incomplete/abort、MCP/插件 manifest（启用后）。
3. **恢复与安全**：断线、重启、重复请求/批准、取消、半写文件、symlink/path traversal、gitignored/tenant 越界、远程正文 shell/SSRF。
4. **e2e/回放**：默认 API Host 的 Memory 注入；Skill catalog→tool call→结果行；用户-only `/name`；compact 后重建；Web 刷新和 hermetic workspace。

可直接借用的上游验收形状：CC 的 session memory threshold/permission tests、DSH `apps/web/tests/skill-tool-row.e2e.ts`、`skill-user-invoke.e2e.ts`、`skill-invocation-policy.e2e.ts`、`scaffold-hermetic.e2e.ts` 和 compaction lifecycle tests。

### 8.2 迁移与回滚策略

- Memory：先以 adapter 读旧格式，成功写入新 bounded format 后再切换默认；迁移脚本必须 dry-run、逐 scope 记录 receipt、保留原文件；失败时继续使用旧 adapter。
- Skill：先只读发现和 capability status，再打开模型调用；catalog/source schema 增加版本号，未知版本 fail closed；插件安装使用版本目录 + 原子 rename，保留上一个可用版本。
- Event/Projection：新增事件标记为可识别/可忽略时必须符合 `docs/event-contract.md`；projection stateVersion 变更时丢弃旧缓存并从事件回放，不做不安全前向合并。
- Web：能力不存在、扫描不完整、正文读取失败都显示明确状态；禁止把 optimistic UI 当作成功事实。

### 8.3 不应实现的内容

- 不恢复旧 Python Runtime 作为新后端底座。
- 不把 Memory 正文写进 EventStore/SSE，也不让 Memory 文本成为越权系统指令。
- 不让 Skill `allowed-tools` 绕过统一 permission/workspace/audit/cancel 管线。
- 不复制 Claude Code 账户、商业 marketplace、遥测、官方远程服务或 DSH 全部 Cordis/插件平台。
- 不在没有真实验收场景时实现实验性 Skill Search、团队 Memory 同步、KAIROS/auto-dream 或 A2A Skill 远程互操作。
- 不把 DSH Agent Note 当作用户 Memory；不让 Web 自己成为 Skill/Memory 事实源。

## 9. 当前结论与下一步

M0–M3 已完成 Memory readiness、默认 Session/Project Memory 持久化、bounded recall 和只读观察面。当前缺口集中在可替换的 model-backed Session extractor、Memory 正文编辑 API（仍需独立权限/审计契约）和更完整的自动 stale/观测链路。Skill 仍处于 capability/attachment seam 阶段，尚未形成 loader、registry、catalog、SkillTool、permission 生命周期或 plugin runtime。

下一阶段应进入 **S0：Skill contract、registry 和安全模型**，同时保留 M2/M3 的 filesystem adapter、bounded recall 与只读 inspector 回滚路径。这样可以继续复用本项目 EventStore、projection、permission 和 workspace 安全边界，不引入第二套事实来源。
