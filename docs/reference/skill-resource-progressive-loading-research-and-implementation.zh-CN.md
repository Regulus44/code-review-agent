# Skill 资源包与渐进式加载：Claude Code / DSH 调研与实施方案

状态：`research + implementation-plan`（本轮只新增调研与方案，不改变运行时代码）  
日期：2026-09-03  
范围：

- 本仓库：`D:/Develop/code-review-agent`
- Claude Code 参考快照：`D:/Develop/claude-code`
- DSH 参考仓库：`D:/Develop/deepseek-harness-fork`

## 1. 目标与结论

目标是让模型在加载某个 `SKILL.md` 后，把该 Skill 目录视为一个资源包：模型只在正文引用到资源时，按需读取同一目录下的 `scripts/`、`references/`、`assets/` 等文件；读取结果通过正常的 ToolRuntime 结果进入下一次模型请求，形成后续步骤的实时上下文追加。

结论如下：

1. 本仓库已经支持“摘要 catalog → 调用时读取 `SKILL.md` 正文 → 工具结果进入下一模型步骤”的主链路，但没有 Skill 资源基址语义，也没有 Skill 专用资源读取接口。
2. Claude Code 和 DSH 的共同实现方式是保存 Skill 根目录，并在模型可见内容中注入“相对路径相对于该目录解析、资源仅按需加载”的提示。两者都主要依赖普通文件读取工具，没有发现自动递归加载整个 Skill 目录的核心 loader。
3. DSH 的 `SkillResourceBase`、canonical `<skill_content>` / `<skill_resources>` 渲染、provider-owned locator 和按调用重新读取正文的结构最贴近本项目，适合按 MIT 许可进行抽象级改编。
4. Claude Code 的 `baseDir` / `skillRoot`、`${CLAUDE_SKILL_DIR}` 替换、调用时重新读取正文和 Skill watcher 适合作为行为参考。该快照未发现根许可证，相关代码不能直接复制。
5. 仅把绝对目录路径写入当前 `read_file` 的 `workspaceRoot` 不能满足本项目安全边界：用户级或 bundled Skill 可能位于 workspace 外，当前 `read_file` 也只接受 workspace 内路径。因此推荐增加 `read_skill_resource`，输入 Skill 名称和 Skill 根目录下的相对路径，由 provider 负责解析、校验和读取。
6. 第一阶段不自动预加载整个目录，也不自动执行 `scripts/`。模型通过 `read_skill_resource` 明确发起读取；脚本执行以后续明确需求为前提，继续走 `run_command` / 专用脚本工具的权限、workspace、审计和取消管线。

推荐最终链路：

```text
Skill catalog（摘要）
  -> SkillTool(skill)
  -> SKILL.md + <skill_resources> 按需读取提示
  -> 模型发出 read_skill_resource(skill, relativePath)
  -> SkillRegistry 解析胜出 candidate
  -> provider 校验 Skill 根目录、相对路径、symlink、大小和租户边界
  -> ToolRuntime 返回 bounded modelView
  -> AgentHost.runSteps() 将 tool 结果追加到 messages
  -> 下一模型步骤看到资源正文
```

## 2. 成功验收场景

### 2.1 基本渐进式加载

Skill 目录如下：

```text
.claude/skills/review/
├── SKILL.md
├── references/
│   └── checklist.md
└── scripts/
    └── collect-diagnostics.ts
```

`SKILL.md` 只描述何时需要 `references/checklist.md` 或 `scripts/collect-diagnostics.ts`，不把两份文件正文预先拼入结果。模型先调用 `skill({skill: "review"})`，随后根据正文调用：

```json
{
  "skill": "review",
  "path": "references/checklist.md",
  "offset": 1,
  "limit": 200
}
```

`read_skill_resource` 返回受预算约束的行号文本。该结果由 `ToolRuntime` 写入 `tool/call`、`tool/progress`、`tool/result`，并由 `AgentHost.runSteps()` 追加为下一轮模型可见的 tool message。

### 2.2 真正按需

- Skill 没有引用资源时，不产生任何资源读取调用；上下文只增加 `SKILL.md` 正文。
- Skill 只引用一份资源时，只读取该资源；不枚举目录，不读取其它 sibling 文件。
- 资源超过大小或行数上限时返回截断提示和 `nextOffset`，模型可以继续按 offset 读取。

### 2.3 变更与后续步骤

- `SKILL.md` 被模型工具或外部编辑器修改后，下一模型步骤重新获取最新 definition；catalog 通过 `skills/change` 失效并在下一个 step boundary 刷新。
- `references/` 或 `scripts/` 内容变化不需要改写旧的 Skill catalog。下一次 `read_skill_resource` 读取当前文件；是否触发 watcher 事件按资源变化与 catalog 变化分离处理。
- 运行中的模型流不会被中途注入新文件内容；“实时追加”边界是一个 ToolResult 完成后到下一模型请求之前。

### 2.4 安全、恢复和多租户

- `../secret.txt`、绝对路径、盘符路径、NUL、Skill 根外 symlink、特殊文件和超限文件均拒绝。
- 同一 session、workspace、tenant 下的 Skill 资源才可读取；不能用 Skill 名称猜测另一个租户的资源。
- 断线、重启和 compact/replay 后，模型历史要么从 host-owned immutable artifact 恢复资源快照，要么明确显示资源不可恢复；不能静默伪造完整正文。

## 3. 本仓库当前实现审计

| 本仓库文件与入口 | 已有行为 | 与目标的差距 |
|---|---|---|
| `packages/contracts/src/index.ts:1386-1449`：`SkillResourceBase`、`SkillSummary`、`SkillCandidate`、`SkillDefinition`、`SkillProvider` | 已有 `directory` / `url` / `opaque` 三类资源基址；provider 有 `list()` / `get()` 和 `start()` 生命周期 | 没有 `readResource()` contract；`SkillSummary.resourceBase` 可携带目录路径，和“catalog 不含绝对路径”的注释不一致 |
| `packages/skills/src/index.ts:66-160`：`SkillRegistry.registerProvider()`、`snapshot()`、`get()` | provider 分层、scope chain、rank shadow、AbortSignal、incomplete observation、每次 `get()` 重新向胜出 provider 读取正文 | registry 没有按 Skill 名称解析并读取附属资源的 API；`locator` 只在 provider 内使用 |
| `packages/skills-filesystem/src/index.ts:29-75`、`:98-142` | 递归发现 `SKILL.md`，读取时做 size、realpath、symlink、gitignore、depth 和数量检查；candidate/definition 保存 `path` | `Entry` 没有 Skill 目录字段；`watch` 选项当前只保存控制接口，没有真正 watcher；资源文件没有读取入口 |
| `packages/context/src/skill-catalog.ts:16-42` | catalog 只渲染 name/description；`renderSkillContent()` 当前输出 `<skill>` 包裹的正文 | 没有 `<skill_resources>` 提示，也没有告诉模型使用 Skill 资源专用读取能力 |
| `packages/tools/src/skill.ts:19-52` | SkillTool 通过 registry 取 definition，做 model invocation、trust/unknown-property 审批，追加 `skill/invocation` / `skill/result`，返回正文 | 结果没有资源基址提示；正文中的相对路径对模型没有受控解析语义 |
| `packages/tools/src/builtin.ts:334-343`、`:743-849` | `read_file` / `glob` / `grep` 可读取 workspace 内文件，输出有界、可继续读取 | 这些工具以 `context.workspaceRoot` 为根，不能安全读取 workspace 外的 user/bundled Skill 资源；没有 Skill 名称到资源目录的绑定 |
| `packages/workspace/src/index.ts:14-66`：`WorkspaceResolver` | 对 workspace-relative 路径做 traversal、realpath 和 symlink containment 检查 | 不能直接用来解析位于 workspace 外的 Skill 根目录；需要 provider-owned 根目录检查 |
| `packages/runtime/src/index.ts:2097-2125`：`assembleTurnContext()` | 每个模型步骤重新组装 Skill catalog；catalog 变化可在 step boundary 反映 | 只注入 catalog，没有资源工具的可见性和资源读取结果 |
| `packages/runtime/src/index.ts:2767-2798`：`runSteps()` | assistant tool call 执行后，将 `modelToolResult(output)` 追加为 tool message，随后进入下一步 | 该 seam 已经足够承载“资源读取结果实时追加”；需补资源结果的 replay/persistence 语义 |
| `packages/tools/src/runtime.ts:223-270`、`:404-488` | 统一执行 schema、permission、取消、超时、progress、result、EventStore 管线；`commitDeferredResult()` 对 Skill output 做过有限脱敏 | 资源正文若落入 `modelView` 或 `tool/result`，仍需明确 host-owned artifact / replay 处理，不能依赖字段名猜测脱敏 |
| `apps/api/src/server.ts:799-815`：`GET /v1/skills` | 只读 catalog 与 suggestions | 直接展开 snapshot 时可能暴露 `resourceBase.path`；新的资源句柄不能进入公共 catalog |

当前结论：本仓库支持 Skill 正文按需加载和普通 workspace 文件读取，但尚不支持“同一 Skill 目录作为受控资源包”的完整能力。

## 4. Claude Code 调研

### 4.1 目录发现和资源基址

| Claude Code 入口 | 观察到的实现 | 对本仓库的启示 |
|---|---|---|
| `D:/Develop/claude-code/src/skills/loadSkillsDir.ts:270-401`：`createSkillCommand()` | `Command` 保存 `skillRoot: baseDir`；`getPromptForCommand()` 在正文前加入 `Base directory for this skill: ...`；本地正文支持 `${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}` 替换；MCP skill 禁止 inline shell 执行 | 需要把 Skill 根目录作为 provider-owned 资源身份，而不是把整个目录正文预加载；shell、参数和 session 变量必须继续经过本项目安全管线 |
| `.../loadSkillsDir.ts:407-475`：`loadSkillsFromSkillsDir()` | 仅发现 `<skill-name>/SKILL.md`；创建 command 时把 `skillDirPath` 传给 `baseDir` | 本仓库的 filesystem provider 已有相同目录形态，可补 `skillDirectory` 到 opaque locator |
| `.../src/types/command.ts:25-56`：`PromptCommand` | `skillRoot?: string`，并区分 `context: inline/fork`、`paths` 条件激活 | `resourceBase` 适合放在完整 definition，不应直接作为公共 catalog 的绝对路径 |
| `.../loadSkillsDir.ts:638-710`：`getSkillDirCommands()` | managed/user/project/additional roots 并行加载，并按来源合并 | 本仓库已有 provider/rank/scope 合并；资源读取必须沿用胜出 candidate，不能按用户输入路径重新搜索 |

### 4.2 SkillTool 和后续模型步骤

| Claude Code 入口 | 观察到的实现 | 对本仓库的启示 |
|---|---|---|
| `D:/Develop/claude-code/packages/builtin-tools/src/tools/SkillTool/SkillTool.ts:358-433`：`validateInput()` | 先规范化名称、确认 Skill 存在，再拒绝 `disable-model-invocation` 或非 prompt Skill | `read_skill_resource` 也应先确认 Skill 是当前模型可见且仍可加载的 candidate |
| `.../SkillTool.ts:436-581`：`checkPermissions()` | deny → allow → safe-property allowlist；新增有意义属性默认 ask | 资源读取可按 read/auto 暴露，但 Skill trust、租户和根目录检查不能被 Skill 自身 frontmatter 放宽 |
| `.../SkillTool.ts:584-780`：`call()` | inline Skill 通过处理后的消息继续当前 loop；fork Skill 走隔离子 Agent；工具结果只表示 Skill 已启动/完成 | 本仓库可以继续使用现有 `ToolRuntime`；资源正文应由后续独立工具调用进入下一 step |
| `D:/Develop/claude-code/src/utils/promptShellExecution.ts:59-120` | Skill 正文内的 shell block 在调用时执行，且由 shell tool 和 permission context 控制 | 第一阶段不引入自动 shell block；若未来支持脚本执行，必须复用 `run_command`/shell 的 allowlist、approval、取消和审计 |

### 4.3 Skill watcher

`D:/Develop/claude-code/src/utils/skills/skillChangeDetector.ts:90-140` 使用 Chokidar 监听 Skill/command 目录，`depth: 2` 覆盖 `skill-name/SKILL.md`，并在 `:247-278` 对批量变更 debounce 后清理 cache、触发 `skillsChanged`。这个深度和职责划分说明：目录增删、Skill 根和 `SKILL.md` 变化属于 catalog 变化；深层资源变化通常不需要重建摘要 catalog。

限制：该 watcher 只负责发现和失效，不负责把 `references/`、`scripts/` 全部读进上下文；`baseDir` 提示仍由模型决定何时读取资源。

### 4.4 复用判断

- 可复用行为：`baseDir/skillRoot`、调用时重新读取正文、相对路径提示、MCP 不执行 shell、watcher debounce。
- 不可直接复制：Claude Code 的账户、遥测、provider、完整 shell/permission runtime、商业服务和未确认许可的实现代码。
- 资源工具仍需本项目自有实现，因为 Claude Code 主要依靠普通 Read/Glob/Grep，不能直接映射到本仓库的 workspace resolver。

## 5. DSH 调研

### 5.1 `SkillResourceBase` 和 canonical renderer

| DSH 入口 | 观察到的实现 | 对本仓库的启示 |
|---|---|---|
| `D:/Develop/deepseek-harness-fork/packages/skill/skill/src/index.ts:41-70` | `SkillResourceBase` 是 `directory` / `url` / `opaque`；`SkillSummary` 携带可选 `resourceBase` | 本仓库已有同名抽象，类型层可以继续沿用，但公共 catalog 要剥离绝对目录 |
| `.../skill/src/index.ts:162-215`：`renderSkillContent()` | 统一输出 `<skill_content>`、`<skill_resources>`、`<skill_instructions>`；directory 提示“相对路径相对于 base directory，资源仅按需加载” | 这是最适合直接改编的模型提示格式；本仓库应把“使用 `read_skill_resource`”加入 directory hint |
| `.../skill/src/index.ts:482-517`：`SkillRegistry.snapshot()` / `get()` | summary discovery 与完整 definition 分离；`get()` 每次把 opaque candidate locator 交给胜出 provider | 本仓库可以在 registry 增加 `readResource(name, path, options)`，由同一 candidate/provider 负责资源读取 |
| `D:/Develop/deepseek-harness-fork/docs/subsystems/skills.md:190-195` | 完整 definition 不由 registry 缓存；正文改动影响下一次 get，不改写旧 catalog | 与“SKILL.md 每次调用重新读取、资源按次读取”一致 |

### 5.2 Filesystem provider 和 watcher

| DSH 入口 | 观察到的实现 | 对本仓库的启示 |
|---|---|---|
| `D:/Develop/deepseek-harness-fork/packages/skill/skill-filesystem/src/index.ts:206-221`：`FileSystemSkillProvider.get()` | 从 `LocalLocator` 取 `path` 和 `directory`，读取正文后返回 `resourceBase: { kind: 'directory', path: locator.directory }` | 本仓库的 locator 应从单一 canonical 文件路径升级为 `{ skillFilePath, skillDirectory, rootKind }` |
| `.../skill-filesystem/src/index.ts:719-744`：`discoverRoot()` | directory entry 产生 `{ path: SKILL.md, directory: skillDir }`；candidate 同时保存 locator 和 resourceBase | 适合改编为本仓库资源身份的最小实现 |
| `.../skill-filesystem/src/index.ts:283-350`：`SkillWatchManager` | 对 shared/project roots 做 bounded watcher 管理，失败时保留可读 candidate 并标记 incomplete | 可作为本仓库真实 watcher 的职责边界；不能把 watcher 失败当成 Skill 正文读取成功 |
| `.../skill-filesystem/src/index.ts:487-555`、`:658-684` | Chokidar depth 1 监听 Skill 根直属项，`isRelevantWatchEvent()` 只把根、`*.md` 和 `skill/SKILL.md` 视为 catalog 变化；深层资源不会触发 catalog invalidation | 资源内容变化和 catalog 变化解耦，减少无意义刷新 |

### 5.3 model-facing tool 和普通 filesystem read

| DSH 入口 | 观察到的实现 | 对本仓库的启示 |
|---|---|---|
| `D:/Develop/deepseek-harness-fork/packages/skill/tool-skill/src/index.ts:81-160` | `skill` tool 先 list summary、检查 model policy，再 get definition；输出值包含 `resourceBase` 和正文 | 校验顺序可以直接改编；本仓库输出应使用逻辑资源句柄，避免公共结果暴露绝对路径 |
| `.../tool-skill/src/index.ts:163-235` | `agent/pre-step` 在每个后续 step 刷新可见 catalog；digest 变化时追加完整替换；不完整 snapshot 保留 last-good | 本仓库 `assembleTurnContext()` 已有相近 step-boundary seam；可补资源工具可见性和 digest 规则 |
| `D:/Develop/deepseek-harness-fork/packages/fs/tool-fs/src/read-target.ts:19-33` | 先统一 resolve，再 stat，确认 regular file；缺失、非普通文件和取消使用结构化错误 | `read_skill_resource` 应有同样的 resolve → stat → bounded read 顺序 |
| `.../packages/fs/tool-fs/src/read.ts:136-180` | 大文件可 stream，生成 bounded line window；`presentationMeta` 让 UI replay-safe | 本仓库可以复用行为和测试思路，输出格式改为现有 `ToolResult` / `modelView` |
| `.../packages/fs/fs-local/src/index.ts:106-124` | 相对路径按调用方 cwd 解析，`contains()` 使用 canonical identity 检查包含关系 | 本仓库 provider 需把“Skill directory contains requested resource”作为独立 containment，而非放宽 workspace resolver |

### 5.4 DSH 文档给出的明确边界

`D:/Develop/deepseek-harness-fork/docs/subsystems/skills.md:229-235` 明确描述：catalog 不含正文和路径；SkillTool 返回 `<skill_content>`、`<skill_resources>`、`<skill_instructions>`；`resourceBase` 只用于显式引用的 scripts/references/assets 按需解析，加载结果不枚举 Skill 目录；正文只在下一次 tool call 变化时更新。这正是本次目标需要的行为基线。

### 5.5 复用判断

- DSH 根仓库 `D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT，可以在确认目标 package notice 后进行 `copy` 或 `adapt`，并保留版权/许可证声明。
- 推荐只改编抽象和流程：`SkillResourceBase`、locator.directory、canonical renderer、provider watcher 分层、read-target 的 resolve/stat/read 顺序。
- 不整体复制 DSH Cordis、filesystem backend、tool registry 或 AgentLoop；本项目的 EventStore、ToolRuntime、PermissionPolicy、WorkspaceResolver 和 tenant 逻辑继续作为事实边界。

## 6. 方案决策矩阵

| 设计点 | Claude Code | DSH | 本仓库决策 |
|---|---|---|---|
| Skill 根目录身份 | `baseDir` / `skillRoot` | `SkillResourceBase.directory` + locator.directory | 内部 definition 保留 `SkillResourceBase`；provider locator 保存 canonical Skill 文件和目录 |
| 模型提示 | `Base directory for this skill: ...` | `<skill_resources>` canonical block | 改编 DSH 标签和语义，使用逻辑 Skill 名称与 `read_skill_resource`，不把绝对路径放进公共 catalog |
| 附属资源读取 | 普通 Read/Glob/Grep/Bash | 普通 `fs.read`，resourceBase 只提供解析基址 | 新增 `read_skill_resource`，避免 workspace 外绝对路径绕过；必要时再把通用 read backend 抽成共享 resolver |
| 正文缓存 | command/catalog 有缓存，调用时处理正文 | registry 不缓存完整 definition | SkillTool 和 resource tool 每次按胜出 candidate 读取当前文件；只缓存有界 discovery |
| watcher | Chokidar + depth 2 + debounce | bounded `SkillWatchManager`，资源深层变化不使 catalog 失效 | 先补真实 watcher，再复用已有 `skills/change`；资源变化与 catalog 变化分离 |
| 脚本执行 | prompt shell，可走 permission | SkillTool 不自动执行资源脚本 | 第一阶段只读脚本文本；执行继续走受控 `run_command` 或未来专用工具 |
| 事件与回放 | 上游内部 transcript/hooks | DSH session/tool 体系 | 复用本项目 `tool/call` / `tool/progress` / `tool/result`；正文不直接进 EventStore，必要时使用 host-owned immutable artifact |

## 7. 分模块实施方案

以下模块按依赖顺序排列。每个模块都注明本仓库入口、CC/DSH 参考、复用方式、契约影响、测试和回滚。正式编码前，涉及公共契约的模块先补 ADR、`docs/event-contract.md`、`docs/tool-contract.md`、`docs/status.zh-CN.md`，并在 `docs/source-reuse-register.md` 登记 DSH 改编来源。

### M0：契约与资源身份

**价值**：为 Skill 附属资源建立稳定、provider-neutral、可回放的身份，避免后续工具直接拼接绝对路径。

**本仓库入口**：

- `packages/contracts/src/index.ts:1386-1449`：`SkillResourceBase`、`SkillSummary`、`SkillCandidate`、`SkillDefinition`、`SkillLookupOptions`、`SkillProvider`；
- `packages/skills/src/index.ts:152-160`：`get()` 当前的 candidate → provider 解析；
- `docs/event-contract.md:78`、`:148-163` 和 `docs/tool-contract.md:15-59`：事件事实源、工具结果和 Skill 正文脱敏不变量。

**参考入口**：

- CC：`src/types/command.ts:25-56` 的 `PromptCommand.skillRoot`；`src/skills/loadSkillsDir.ts:343-363` 的 base directory 和变量替换；
- DSH：`packages/skill/skill/src/index.ts:41-70`、`:171-215` 的 `SkillResourceBase` 和 canonical renderer；`docs/subsystems/skills.md:140-175` 的 candidate/definition 分离。

**实施建议**：

1. 在 `SkillProvider` 增加可选 `readResource(candidate, relativePath, options)`，在 `SkillRegistry` 增加按名称解析胜出 candidate 后调用该方法的 `readResource()`。
2. 将 provider 内部 locator 明确定义为 opaque 对象；filesystem locator 至少包含 `skillFilePath`、`skillDirectory` 和 root/trust 信息。
3. 将公共 catalog 与内部资源身份分离。`SkillSummary` 不再向 API/SSE 暴露绝对 `resourceBase.path`；完整 definition 可以保留 provider-owned resource metadata，但模型只拿到逻辑 Skill 名称和相对路径能力。
4. `SkillLookupOptions` 是否增加 tenant/owner 信息要在 ADR 中裁决。推荐由 Host 按 tenant 构造或过滤 provider roots，必要时再增加可选的 tenant scope；不能让 provider 从全局状态猜测租户。

**复用方式**：DSH 类型和调用顺序 `adapt`；CC 仅 `behavior-reference`。不能直接复制 DSH 的 Cordis 类型。

**契约影响**：改变 `SkillProvider`、可能改变 `SkillSummary` 公共投影，属于 Skill/Tool/tenant contract 变更；第一阶段不新增 AgentEventType。

**测试**：contract test 验证 candidate winner、provider 不匹配、缺少 `readResource` 时稳定错误；API test 验证 `/v1/skills` 不含绝对路径；scope/tenant test 验证不能跨层或跨租户解析。

**回滚/禁用**：`skillResourceToolEnabled=false` 时不注册资源工具；registry 保留旧 `get()` 能力，缺少 `readResource` 的 provider 仍可加载 SKILL.md，但资源调用返回 `SKILL_RESOURCE_UNSUPPORTED`。

### M1：Filesystem Skill 资源包解析

**价值**：把 `<skill>/SKILL.md` 和其 sibling 目录绑定为一个可校验的资源包。

**本仓库入口**：`packages/skills-filesystem/src/index.ts:27-75` 的 `Entry`、`get()` 和 `start()`；`:98-142` 的 `scanRoot()`；`packages/workspace/src/index.ts:31-56` 的 realpath/parent containment。

**参考入口**：

- CC：`src/skills/loadSkillsDir.ts:407-471` 把 `skillDirPath` 传给 `baseDir`；
- DSH：`packages/skill/skill-filesystem/src/index.ts:206-221`、`:719-744` 的 `LocalLocator`、`locator.directory` 和 candidate 构造。

**实施建议**：

- `Entry.filePath` 改为同时保存 `skillFilePath` 与 `skillDirectory`，candidate locator 使用不可直接解释的对象；
- `readResource()` 只接收 Skill 根目录下相对路径，统一 `/` 分隔，拒绝空路径、绝对路径、`..`、NUL 和过长输入；
- 先 `lstat`/`realpath` Skill 目录和目标文件，再检查目标仍在 Skill directory 内、是 regular file、不是特殊文件；
- 资源读取默认 UTF-8 bounded text，返回行窗口和 `nextOffset`；binary/assets 第一阶段只返回受限 metadata 或 `SKILL_RESOURCE_BINARY_UNSUPPORTED`；
- 使用独立 `maxResourceBytes`、`maxResourceLines`、`maxResourcePathBytes`，不要复用 `SKILL.md` 描述上限；
- resource root 的访问由 provider 自己检查，不能通过把 user/bundled 根临时拼进 `workspaceRoot` 绕过 workspace policy。

**复用方式**：DSH locator/resolve/stat/read 顺序 `adapt`；CC 目录发现行为 `behavior-reference`。

**契约影响**：新增 provider resource contract 和资源错误码；不改变 Skill catalog 事件格式。

**测试**：目录包发现、相对路径、`references/` / `scripts/` / `assets/`；路径穿越、symlink 内外、大小/深度/特殊文件、UTF-8 截断、取消、文件在读取期间删除。

**回滚/禁用**：filesystem provider 的 `resourceRead` flag 关闭时仅保留旧 `SKILL.md`；资源工具发现到 provider 不支持时给出可恢复错误。

### M2：`read_skill_resource` 模型工具

**价值**：提供模型可见、Skill 名称绑定、workspace/tenant 安全受控的按需读取入口。

**本仓库入口**：

- 新文件建议：`packages/tools/src/skill-resource.ts`；
- `packages/tools/src/index.ts` 导出；
- `packages/runtime/src/index.ts:350-365` 注册内置工具；
- `packages/tools/src/runtime.ts:223-270`、`:404-448` 复用统一执行管线；
- `packages/tools/src/builtin.ts:334-343`、`:743-783` 作为 bounded read 输出格式参考。

**参考入口**：

- CC：`packages/builtin-tools/src/tools/SkillTool/SkillTool.ts:358-433` 的先校验 Skill 再加载；
- DSH：`packages/skill/tool-skill/src/index.ts:81-160` 的 summary → policy → definition 顺序；`packages/fs/tool-fs/src/read-target.ts:19-33` 和 `read.ts:136-180` 的 resolve → stat → bounded read。

**建议 schema**：

```ts
{
  skill: string,
  path: string,
  offset?: number,
  limit?: number
}
```

执行顺序：

1. schema 校验和 Skill 名称规范化；
2. `SkillRegistry` 查找当前 scope/cwd 下的 winning candidate；
3. 检查 `modelInvocable`、trust、provider capability 和 tenant/workspace scope；
4. provider `readResource()` 解析 Skill-relative path；
5. 生成 `output` metadata、bounded `modelView` 和 `presentation`；
6. 通过 ToolRuntime 写入标准 tool events，返回模型结果。

推荐 model view：

```text
<skill_resource skill="review" path="references/checklist.md">
1: ...
2: ...

(Output capped. Use offset=... to continue.)
</skill_resource>
```

输出中只展示 Skill 名称和相对路径，不展示 provider 的绝对文件系统路径。工具 description 要明确“仅读取 Skill 包内、模型引用到的资源；不会自动枚举整个目录”。

**复用方式**：DSH read tool 的 bounded window 行为 `adapt`；CC SkillTool 的校验顺序 `behavior-reference`；工具实现必须使用本项目 ToolRuntime。

**契约影响**：新增一个 model-facing ToolDefinition；风险为 `read`、默认 `auto`；需要更新 `docs/tool-contract.md` 的工具表。无需新增事件类型。

**测试**：工具 schema、未知/不可见 Skill、provider 缺失、按 Skill 绑定读取、offset/limit、超限、取消、并行/独占策略、结果 presentation、模型下一步收到 resource content 的 runtime contract test。

**回滚/禁用**：能力开关 `skillResourceToolEnabled`；关闭后 SkillTool 仍可调用，但正文只提示资源能力不可用，不能回退到任意绝对路径读取。

### M3：Canonical Skill 内容与资源提示

**价值**：让模型在读到 `SKILL.md` 后知道资源是同一 Skill 包的一部分，并知道如何按需读取。

**本仓库入口**：`packages/context/src/skill-catalog.ts:39-42` 的 `renderSkillContent()`；`packages/tools/src/skill.ts:4-10`、`:43-49` 的正文渲染；`packages/context/src/index.ts:91` 的导出；`packages/runtime/src/index.ts:2109-2120` 的 catalog 注入。

**参考入口**：

- CC：`src/skills/loadSkillsDir.ts:344-369` 的 base directory、`${CLAUDE_SKILL_DIR}`、`${CLAUDE_SESSION_ID}`；
- DSH：`packages/skill/skill/src/index.ts:171-215` 的 `<skill_content>`、`<skill_resources>`、`<skill_instructions>` canonical renderer；`packages/skill/tool-skill/tests/tool-skill.spec.ts:760-799` 的精确输出断言。

**实施建议**：将当前 `<skill>` 渲染改为：

```text
<skill_content name="review">
<skill_resources>
Resources for this skill are available as a package.
Use read_skill_resource with skill="review" and a Skill-relative path such as references/foo.md or scripts/check.ts.
Load referenced resources only as needed; the directory is not preloaded.
</skill_resources>

<skill_instructions>
...
</skill_instructions>
</skill_content>
```

本项目第一阶段不向模型输出绝对 `Base directory`。若未来需要兼容 `${CLAUDE_SKILL_DIR}`，应把它限定为 host-side script execution 的逻辑变量，并在执行前再次经过 provider root、workspace、permission 和 allowlist 检查；不能让正文替换结果直接绕过 `read_skill_resource` 或 `run_command`。

**复用方式**：DSH renderer 标签和 escape 行为 `adapt`；CC 变量替换仅 `behavior-reference`。

**契约影响**：改变 SkillTool 的 model-visible 文本形状；需要更新 SkillTool、上下文和 API/回放 fixture。`skill/invocation` / `skill/result` 仍只保存 metadata。

**测试**：精确 canonical output、Skill 名称转义、远程 Skill 不执行 shell/参数替换、正文引用 resource tool 的提示、旧事件 replay 兼容。

**回滚/禁用**：保留 renderer version `v1`；feature flag 关闭时继续输出旧 `<skill>` 形状，旧 SkillTool 调用不受影响。

### M4：Model step、EventStore、compact/replay

**价值**：保证资源正文确实进入后续模型步骤，同时保持事件事实源、正文脱敏和恢复一致性。

**本仓库入口**：

- `packages/tools/src/runtime.ts:456-488`：deferred result commit 和 `tool/result`；
- `packages/tools/src/runtime.ts:638-648`：结果预算和 `modelView`；
- `packages/runtime/src/index.ts:2767-2798`：工具结果追加到下一模型步骤；
- `packages/runtime/src/index.ts:2024-2062`：从事件重建 conversation messages；
- `packages/runtime/src/index.ts:2365-2399`：compact 前 tool result replacement；
- `packages/context/src/tool-result-storage.ts:51-133`：host-owned artifact、preview 和 replacement receipt。

**参考入口**：

- CC：`packages/builtin-tools/src/tools/SkillTool/SkillTool.ts:1092-1109` 的 invoked skill compaction preservation；
- DSH：`packages/skill/tool-skill/src/index.ts:163-235` 的 step-boundary catalog replacement；`packages/fs/tool-fs/src/read.ts:120-131` 的 replay-safe presentation metadata。

**关键设计**：

1. 当前调用返回给模型的 `modelView` 可以包含资源正文，确保 `runSteps()` 立即把它追加到下一次请求。
2. `tool/result`、`skill/result` 和 SSE 默认只保存 Skill 名称、相对路径、字节数、digest、offset/limit、truncated、provider 和 artifact receipt，不直接写正文。
3. 为满足“任何 model-visible 输入可从事件恢复”的根不变量，推荐为资源读取增加 host-owned immutable artifact：事件记录 opaque artifact id、digest、大小和 tenant/session 归属，`conversationMessages()` 在 replay 时按 artifact id 恢复正文。artifact 不放在用户 workspace 可编辑目录，读取需经过 host ACL。
4. artifact 不可用时返回明确的 `<skill_resource status="unavailable">`，并记录 bounded recovery metadata；不能用当前磁盘文件静默替代历史快照，除非 ADR 明确选择 `reread-current` 的非确定性恢复策略。
5. compact/microcompact 可以像普通 tool result 一样替换为 preview + artifact receipt，但不得删除唯一可恢复的资源快照；旧 `context/tool_result_persisted` 机制可作为实现基础，需增加 `kind: "skill-resource"` 分支。

**复用方式**：沿用本项目的 ToolRuntime、EventStore、ToolResultStorage；DSH/CC 仅作为生命周期和 replay 行为参考。

**契约影响**：可能扩展 `ToolResult` 的持久化表示或增加专用 artifact receipt；更新 `docs/event-contract.md` 的正文脱敏、回放和 compact 条款。建议先写 ADR 再编码。

**测试**：

- runtime contract：skill → resource tool → 下一模型请求包含资源正文；
- EventStore：事件不含正文但含 digest/receipt；
- restart/replay：artifact 存在时恢复原正文，artifact 缺失时 fail-closed；
- compact：资源结果被替换后仍可按 receipt 恢复；
- duplicate tool call / deferred commit：只追加一次 result 和 artifact receipt；
- SSE：只推送 bounded metadata，不泄露正文。

**回滚/禁用**：`skillResourceArtifactReplay=false` 时禁止宣称 deterministic replay；资源工具可以继续运行，但 capability 页面明确显示“资源正文 replay 不可用”，并在 production 默认拒绝该模式。

### M5：Filesystem watcher 与外部变更失效

**价值**：让外部编辑器、Git、shell 或其它进程写入 `SKILL.md` 后，模型在后续 step 看到最新 catalog；同时避免资源正文变化导致无意义的全量 catalog 重建。

**本仓库入口**：`packages/skills-filesystem/src/index.ts:18-20` 的 `watch` 配置、`:42-43` 的当前 no-op 注释、`:75` 的 provider start；`packages/runtime/src/index.ts:369-388` 的 `notifySkillWorkspaceMutation()`；`:3644-3662` 的 recent changed paths。

**参考入口**：

- CC：`src/utils/skills/skillChangeDetector.ts:90-140`、`:247-278` 的 Chokidar、depth 2 和 debounce；
- DSH：`packages/skill/skill-filesystem/src/index.ts:283-350`、`:487-555`、`:658-684` 的 `SkillWatchManager`、watcher error/retry 和相关事件筛选。

**实施建议**：

- watcher 监听 roots 和每个 `<skill>` 直属项；catalog 变化仅包括 Skill 目录新增/删除、`SKILL.md` 新增/删除/修改和扁平入口（如未来支持）；
- `references/`、`scripts/`、`assets/` 深层文件变化默认不发 catalog invalidation。下一次资源 tool call 直接读取当前内容；
- watcher 使用 stability threshold、polling fallback、bounded project/root 数量、debounce 和 dispose；watcher 失败保留 last-good candidate，catalog 标记 incomplete；
- 现有 `notifySkillWorkspaceMutation()` 需要先判断路径是否属于 Skill catalog 相关文件，再调用 `skills.invalidate()`；不要把所有 workspace 写入都当成 Skill 变化；
- 资源读取期间的文件变更通过 stat/version 或 digest 检查报告 stale/changed，不修改已完成的旧 tool result。

**复用方式**：DSH watcher 管理器 `adapt` 时必须保留 MIT notice；CC debounce 行为 `behavior-reference`。如果暂时不引入 chokidar，可先使用 Node `fs.watch` 做受限实现并把 watcher 标记为 best-effort。

**契约影响**：沿用 `skills/change`，payload 仍只带 bounded revision/reason/path metadata；不新增资源正文事件。

**测试**：SKILL.md add/change/unlink、资源深层 change 不刷新 catalog、批量变更 debounce、watcher error/incomplete、dispose、模型写入回调、Git/外部编辑器写入。

**回滚/禁用**：保留 `watch=false`；关闭时每个 step/显式 `refresh()` 仍可读取最新 Skill，catalog 变化延迟到 refresh，不影响资源读取安全性。

### M6：Permission、workspace、symlink、大小和 tenant 隔离

**价值**：防止“Skill 资源包”成为读取 workspace 外秘密、跨租户文件或脚本执行的旁路。

**本仓库入口**：`packages/skills/src/index.ts:287-305` 的 Skill trust/unknown-property assessment；`packages/tools/src/runtime.ts:223-270`、`:304-333` 的 tenant/permission/approval；`packages/workspace/src/index.ts:31-56`；`packages/tools/src/builtin.ts:613-624` 的命令 guard；`packages/contracts/src/index.ts:1470-1476` 的 Skill permission assessment。

**参考入口**：

- CC：`packages/builtin-tools/src/tools/SkillTool/SkillTool.ts:436-581` 的 deny/allow/safe-property 顺序；`src/skills/loadSkillsDir.ts:371-395` 的 MCP shell 禁止；
- DSH：`packages/fs/tool-fs/src/read-target.ts:19-33` 的 regular-file gate；`packages/fs/fs-local/src/index.ts:121-124` 的 canonical containment；`packages/skill/skill-filesystem/src/index.ts:658-690` 的 contained segments；
- DSH sandbox 测试：`packages/fs/fs-sandbox/tests/fs-sandbox.spec.ts:106-162` 的 traversal、symlink 和 TOCTOU 场景。

**实施建议**：

- `read_skill_resource` 的风险等级固定为 `read`，Skill frontmatter 不能把它升级为任意 filesystem read；
- Skill trust 只能影响是否展示/是否 ask，不能扩大 provider root；remote/opaque provider 必须实现自己的 resource policy；
- 所有 path 先做 lexical normalization，再做 canonical realpath containment；默认拒绝资源 symlink，若允许则必须确认目标仍在 Skill directory；
- 对单文件、单调用、单 Skill、单 session 和 tenant 设置独立 byte/line/count budget；错误返回稳定 code，不返回 provider 绝对路径或底层异常全文；
- 第一阶段不执行 `scripts/`。未来脚本执行输入应是 Skill 名称 + 相对脚本路径 + 显式 argv，经过 executable allowlist、permission、workspace/sandbox、deadline、取消和事件审计；禁止把 SKILL.md 中的 shell 文本自动拼接执行；
- API/Web 只展示 Skill 名称、description、resource capability 和相对路径 receipt，不展示 `skillDirectory`、home 路径或其它 tenant 信息。

**复用方式**：安全不变量使用本项目实现；CC/DSH 只复用测试场景和检查顺序。

**契约影响**：更新 `docs/tool-contract.md` 安全表和 `docs/event-contract.md` 脱敏条款；若增加 tenant 到 `SkillLookupOptions` 或 `ToolContext`，必须单独 ADR。

**测试**：路径穿越、Windows 盘符/UNC、NUL、大小写、symlink escape、TOCTOU、special file、remote provider、cross-tenant session、permission preset、错误信息脱敏。

**回滚/禁用**：任何一项安全检查失败时 fail closed；可关闭 remote resource provider，不得通过“full access” flag 跳过 Skill root containment。

### M7：E2E、回放和产品验收

**价值**：证明“模型确实能够读到 Skill.md 后实时继续读取资源”，而非只验证类型或单工具返回。

**本仓库入口**：

- `packages/skills/src/*.test.ts`、`packages/skills-filesystem/src/*.test.ts`：registry/provider；
- `packages/tools/src/skill.test.ts`、新增 `skill-resource.test.ts`、`packages/tools/src/index.test.ts`：工具和 ToolRuntime；
- `packages/runtime/src/index.test.ts`：多 step、恢复、compact/replay；
- `apps/api/src/server.ts`、`apps/web/src/client/api.ts`、`apps/web/src/presentation/skill-presenter.ts`：API/Web 只读资源能力；
- 评测脚本和浏览器 e2e：真实模型 tool call 顺序和后续上下文。

**参考入口**：

- CC：`packages/builtin-tools/src/tools/SkillTool/SkillTool.ts` 的 validate/permission/call 测试区域；`src/utils/skills/skillChangeDetector.ts` 的 watcher 测试；
- DSH：`packages/skill/tool-skill/tests/tool-skill.spec.ts:760-859` 的 resourceBase/canonical output 断言；`packages/fs/tool-fs` read tests 的 truncation/presentation/replay 场景。

**最低验收矩阵**：

| 场景 | 证明点 |
|---|---|
| SkillTool 后读取 `references/checklist.md` | registry 绑定、resource tool schema、下一 step modelView |
| SkillTool 后读取 `scripts/check.ts` 的第 201 行 | offset/limit、继续读取提示、无目录枚举 |
| Skill 不引用资源 | 没有隐式 read call，token/context 不增长 |
| 资源路径 `../secret` / symlink escape | workspace/provider containment fail-closed |
| 修改 SKILL.md 后下一 step | `skills/change`、catalog digest 和 definition reread |
| 修改 references 文件后下一次读取 | 读取最新版本，旧 tool result 不被改写 |
| watcher 关闭或失败 | last-good/incomplete 与显式 refresh |
| host 重启后 replay | artifact 存在恢复正文；artifact 缺失明确 unavailable |
| compact 后继续对话 | 资源 tool pair 不破坏，receipt/preview 可恢复 |
| 不同 tenant 访问同名 Skill | 只能看到本 tenant/provider root |

**回滚/禁用**：先在单元/合同测试启用，再在 API Host 用 feature flag；真实模型 e2e 失败时只关闭资源 tool，不回滚已存在的 Skill catalog/正文加载。

## 8. 分阶段实施顺序

### Phase A：契约、renderer、只读资源工具

完成 M0 → M1 → M2 → M3。默认只支持本地 filesystem provider、UTF-8 文本、相对路径和 bounded line window；不启用 watcher、不执行脚本、不承诺 deterministic replay。完成以下门禁后再进入下一阶段：typecheck、Skill/provider/tool contract、路径安全、运行时下一 step 测试。

### Phase B：事件 artifact 与 replay

完成 M4，明确资源正文的 host-owned artifact 位置、ACL、digest、恢复失败行为和 compact replacement。同步 ADR、事件契约、状态页和回放 fixture。没有 Phase B 的明确策略时，不把资源能力标记为完整恢复能力。

### Phase C：真实 watcher 和外部变化

完成 M5。先保持 `watch=false` 兼容，验证 Chokidar/`fs.watch` 失败、debounce、dispose 和 incomplete 语义，再开放默认配置。资源文件变化继续与 catalog invalidation 分离。

### Phase D：多租户、远程 provider 和脚本执行评估

完成 M6 的本地安全闭环后，再评估 MCP/opaque resource provider。远程资源只能通过 host-owned MCP manager 和显式 URI allowlist；脚本执行必须有独立验收场景，不能因为已有 `scripts/` 目录就自动启用。

## 9. 迁移、feature flag 与回滚

建议配置：

```text
skillToolEnabled=true                 # 已有能力
skillResourceToolEnabled=false        # 新能力，默认关闭直到 Phase A/B 完成
skillResourceArtifactReplay=false     # Phase B 完成后才允许 production
skillFilesystem.watch=false           # watcher 单独灰度
skillResourceMaxBytes=262144          # 示例默认值，最终进入 config catalog
skillResourceMaxLines=2000
```

迁移规则：

- 旧 SkillTool `<skill>` 事件保持可读；新 renderer 用 version/feature flag 区分，replay 同时支持两种形状；
- 旧 provider 没有 `readResource()` 时仍可加载 Skill 正文，但资源工具返回稳定的 unsupported，不尝试读取 `definition.path`；
- 资源 artifact 使用独立 namespace，禁止复用用户可编辑的 Skill 目录作为快照；
- 关闭资源工具不删除 Skill 目录、不删除历史 catalog、不删除已产生的 artifact；只停止后续资源 tool discovery；
- 若发现公共 API 暴露绝对路径，先收紧 API projection，再继续扩大资源 provider 范围。

## 10. 需要登记的来源与许可证边界

- DSH `packages/skill/skill`、`packages/skill/skill-filesystem`、`packages/skill/tool-skill`、`packages/fs/tool-fs`：根仓库 MIT，未来若复制或大量改编，必须保留 MIT 版权/许可证声明，并在 `docs/source-reuse-register.md` 新增明确记录，列出本项目改写和测试。
- Claude Code `src/skills/loadSkillsDir.ts`、`packages/builtin-tools/src/tools/SkillTool/SkillTool.ts`、`src/utils/skills/skillChangeDetector.ts`：当前本地快照未发现根 `LICENSE`，只做行为参考和自有实现，不直接复制源码。
- 本方案本身只新增文档，没有对上述上游代码建立新的代码来源关系；真正编码前再按实际复用范围登记。

## 11. 最终验收标准

当且仅当以下条件全部满足，才可把“Skill 渐进式资源加载”标为已实现：

1. 模型能在看到 `SKILL.md` 后，通过 `read_skill_resource` 读取同一 Skill 目录下的相对资源，且未引用的资源不会被预加载。
2. 每次资源读取都经过 registry winner、provider root、realpath/symlink、size/line、permission、workspace/tenant 和取消检查。
3. 资源结果经 ToolRuntime 写入标准事件并在下一模型步骤可见；事件/SSE 不泄露正文、绝对路径或跨租户信息。
4. watcher 只在 catalog 相关变化时失效；资源正文变化由下一次资源读取得到，不改写旧 Skill catalog 或旧 result。
5. restart、断线、compact、SSE replay 和 artifact 缺失都有可解释、可测试的行为。
6. `pnpm typecheck`、`pnpm test`、Skill/Tool/Runtime 合同测试、安全测试和真实浏览器 e2e 均通过；`docs/event-contract.md`、`docs/tool-contract.md`、`docs/status.zh-CN.md`、`docs/source-reuse-register.md` 与实现同步。

