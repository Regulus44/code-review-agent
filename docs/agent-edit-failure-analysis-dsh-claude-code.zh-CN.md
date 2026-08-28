# Django 16046 评测失败分析与 DSH / Claude Code 参考方案

> 文档状态：阶段二实施准备版  
> 更新时间：2026-08-29  
> 适用范围：当前 Coding Agent 的 SWE-bench Lite 评测、日常代码修改流程，以及后续编辑工具和 Runner 的改进

## 1. 结论摘要

这次 `django__django-16046` 失败不是单一原因：

1. **直接原因是 Agent 没有覆盖完整边界条件。** 任务实际要求同时处理 `None` 和空字符串 `""`，Agent 只加入了 `number is None` 分支。
2. **框架放大了失败。** Agent 多次对同一个文件重复编辑，在已经收到 `TEXT_NOT_FOUND` 后没有被强制重新读取当前文件，也没有切换到另一种编辑方式，最终达到 32 步上限。
3. **数据集描述存在轻微歧义。** Prompt 使用了“when null”，而隐藏测试方法名为 `test_empty`，并同时断言 `""` 与 `None`。这不是隐藏测试错误，但任务说明和真实验收边界没有完全对齐。
4. **Grader 还暴露出范围检查问题。** Agent diff 中出现了 `.agent-artifacts/`，但 Grader 的 `scopeViolation` 仍为 `false`，说明非业务产物的变更没有被可靠地纳入范围审计。

因此，后续实施应围绕编辑失败恢复、验证闭环和范围审计展开；不要把这次结果简单归因成“模型能力不足”。

## 2. 本次失败的事实与证据

### 2.1 任务和运行结果

| 项目 | 结果 |
| --- | --- |
| 任务 | `django__django-16046` |
| Provider / Model | `yayi-deepreasoning-ds-v4pro` / `deepreasoning-ds-v4pro` |
| Agent 起止时间 | 2026-08-28 14:53:04 ～ 15:00:31 |
| Agent 步数 / 工具调用 | 32 / 38 |
| 事件数 | 342 |
| Agent 状态 | `failed` |
| 失败错误 | `MAX_AGENT_STEPS_EXCEEDED` |
| Grader `passToPass` | 通过 |
| Grader `failToPass` | 失败 |
| 隐藏测试失败 | `TestNumberFormat.test_empty` |

原始结果文件：

`D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01\results\v4pro-rerun-0828c\django__django-16046\django-16046-v4pro-20260828145301202\result.json`

Grader 结果文件：

`D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01\results\v4pro-rerun-0828c\django__django-16046\django-16046-v4pro-20260828145301202\grader-20260828-230104311\grader-result.json`

### 2.2 任务边界和 Agent 实际修改

隐藏测试补丁增加了：

```python
def test_empty(self):
    self.assertEqual(nformat("", "."), "")
    self.assertEqual(nformat(None, "."), "None")
```

正确补丁需要：

```python
if number is None or number == "":
    return mark_safe(number)
```

Agent 最终只加入了：

```python
if number is None:
    return ""
```

这会漏掉 `number == ""`，同时与 gold patch 的返回语义也不完全一致。

Agent 结果中的业务文件是：

`django/utils/numberformat.py`

Agent diff 还记录了：

`.agent-artifacts/`

但 Grader 结果同时报告 `scopeViolation: false`，需要单独修复范围检查逻辑。

### 2.3 失败时间线

从 `events.jsonl` 可观察到：

- 14:57:47 首次 `TEXT_NOT_FOUND`；
- 14:57:55、14:58:04、14:58:13 等时间点继续对同一文件编辑失败；
- 后续仍多次收到同类 `TEXT_NOT_FOUND`，没有形成“重新读取文件 → 重新定位 → 再编辑”的闭环；
- 15:00:31 触发 `MAX_AGENT_STEPS_EXCEEDED`。

本次运行没有调用 `bash` 或 `pwsh`，也没有形成针对性测试执行证据。这里既有 Agent 判断问题，也有运行时未对失败模式施加足够强的恢复约束。

## 3. 三层归因

### 3.1 Agent 层：任务理解和恢复策略不足

- 没有从测试名称、调用方语义和函数现有行为中推导出“空字符串也是边界条件”；
- 没有在编辑失败后立即重新读取目标文件；
- 没有在连续失败后改用 `apply_patch` 或更大上下文的唯一替换；
- 没有尽早运行目标测试，因此错误补丁一直延续到 turn 末尾。

### 3.2 框架层：失败反馈存在，但缺少状态化恢复控制

当前编辑工具定义在：

`D:\Develop\code-review-agent\packages\tools\src\builtin.ts:315`

其中 `edit_file` 要求唯一精确替换，`apply_patch` 负责多文件 patch。

当前匹配失败在：

`D:\Develop\code-review-agent\packages\tools\src\builtin.ts:638`

统一返回 `TEXT_NOT_FOUND` / `TEXT_NOT_UNIQUE`。错误展示在：

`D:\Develop\code-review-agent\packages\tools\src\builtin.ts:861-863`

运行时 remedy 在：

`D:\Develop\code-review-agent\packages\tools\src\runtime.ts:630`

已有“重新读取当前文件、使用唯一上下文”的建议，但目前只是文本提示：

- 没有记录同一文件/同一错误的连续失败次数；
- 没有阻止 Agent 原样重复调用；
- 没有自动提供更有用的当前文件窗口或当前 hash；
- 没有在成功写入后自动触发任务要求的目标测试。

Agent 步数上限在：

`D:\Develop\code-review-agent\packages\runtime\src\index.ts:2601`

它是 Agent 运行时限制，不是 SWE-bench 任务本身的限制。任务开始时应把剩余步数和“有限步数内完成修改、验证、总结”的要求显式告知 Agent。

### 3.3 数据集层：验收边界和自然语言描述需要一致

任务元数据位于：

`D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01\runtime\metadata\django__django-16046.json`

该任务本身适合作为边界条件修复样本，但建议将用户 prompt 明确写成：

> 修复 `django/utils/numberformat.py` 对 `None` 和空字符串 `""` 的处理，使两种输入都能返回预期结果，并运行 Django 对应测试。

这样可以减少“任务只要求 null，但隐藏测试还测 empty”的任务漂移，同时仍保留隐藏测试对真实行为的约束。

## 4. DSH 源码对照基线

本地 DSH 仓库：`D:\Develop\deepseek-harness-fork`。

阶段二相关的 DSH 实现分为两条完整链路：`@deepseek-ai/dsh-fs-observation-policy` 将“先读再编辑”和版本化 CAS 放在文件策略层；`@deepseek-ai/dsh-repeat-tool-reminder` 将连续完全相同的工具调用变成模型可见的提醒。两者都不替 Agent 自动选择替代编辑，也不以专用 recovery event 记录恢复状态。当前项目应对照这两条链路完成最小等价实现，不复制 DSH 的 Cordis 框架或插件加载系统。

| DSH 模块 | 文件与代码入口 | 对照时应关注的行为 |
| --- | --- | --- |
| 模型可见编辑工具 | `packages/fs/tool-str-replace-editor/src/index.ts`；`DEFAULT_DESCRIPTION`（约 19 行）、`viewPath()`（216 行）、`replaceInFile()`（274 行）、工具注册 `str_replace_editor`（422 行） | 工具说明直接规定 `old_str` 必须精确且唯一；`view` 返回带行号的当前文件内容；替换前再次读取当前文件。 |
| 编辑失败分类 | 同文件 `replaceInFile()` 的 `FS_EDIT_NOT_FOUND`（297 行）和 `FS_AMBIGUOUS_EDIT`（304 行） | “找不到”和“匹配多个”是可供程序判断的稳定错误码，不是让模型解析错误文本。多匹配时附带行号。 |
| 底层文字替换 | `packages/fs/fs-local/src/fsio.ts`；`applyLiteralEdit()`（759–779 行） | 输入为空、无匹配、多个匹配分别具有固定语义；该纯函数适合被单测覆盖。 |
| 版本化写入 | `packages/fs/tool-str-replace-editor/src/index.ts:309–315` 的 `ctx.fs.writeText(... replaceIfVersion ...)`；`packages/fs/fs-local/src/fsio.ts` 文件头和写入实现 | 读取的版本与写入条件绑定，避免把其他进程或用户的最新修改覆盖掉。当前项目已有 `expectedHash`，应保留并强化该语义。 |
| 编辑工具合同测试 | `packages/fs/tool-str-replace-editor/tests/tools.spec.ts`；特别是 336 行起的失败案例 | 覆盖找不到、多匹配、换行符、相对路径、写入成功及呈现结果；失败路径和成功路径同等重要。 |

### 4.1 DSH 阶段二链路 A：文件观察、读前编辑与版本恢复

| DSH 程序 / 模块 | 文件与代码入口 | 已实现的行为 | 当前仓库阶段二必须保持的对应边界 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-fs-observation-policy` | `packages/fs/fs-observation-policy/src/index.ts:21–95` 的 `ObservedStateGate`；`writeIntent()`（65 行）、`editIntent()`（78 行）、`observe()`（91 行）；`apply()` 注册 `fs/write-intent`、`fs/edit-intent`、`fs/observed`（106–129 行） | 以 `WeakMap<session, Map<target, observation>>` 保存三态：未观察、已确认不存在、已确认存在且带 version。未观察编辑返回 `FS_NOT_OBSERVED`；已观察不存在返回 `FS_NOT_FOUND`；已观察存在时把 version 作为 CAS 条件。 | 新建本项目的轻量文件观察策略，owner 固定为当前 Session，target 固定为 workspace-normalized path。它属于工具层，不属于 Agent 决策层；不允许只靠 system prompt 约定“先读”。 |
| 同模块的最小 actor 类型 | `packages/fs/fs-observation-policy/src/types.ts:18–31` 的 `FsObservationActor` | 策略只依赖“能定位 session owner”的最小结构，不反向依赖 Agent、Tool 或 Session 的具体实现。 | 本项目观察策略只接收 `sessionId`、规范化路径、hash/version 和存在状态；不得使 `packages/tools` 反向 import `packages/runtime`。 |
| `@deepseek-ai/dsh-tool-fs` 读取入口 | `packages/fs/tool-fs/src/read.ts:136–163`；`resolveRegularReadTarget()` 后在成功读取时 `ctx.emit('fs/observed', ..., { kind: 'present', version })` | 读取成功即记录该 owner 对文件当前 version 的权威观察。窗口读取也授权后续编辑；授权的依据是文件版本，而非“读到了全文件”。 | `read_file` 成功后必须记录当前 hash；记录由工具内部完成，模型不必手工回传 hash。读取失败的“不存在”状态也应与 DSH 一样进入观察记录，使后续创建写入能够安全地使用 create-if-absent 语义。 |
| `@deepseek-ai/dsh-tool-fs` 编辑入口 | `packages/fs/tool-fs/src/edit.ts:80` 的模型提示；`execute()` 中 `fs/edit-intent`（119–141 行）和成功后 `fs/observed` 刷新 | 每次编辑先向策略索取 version guard；Provider 在原子写入点检查 CAS；成功编辑后立即刷新观察 version，因此连续的成功编辑不需要额外读取。 | `edit_file` 在普通匹配逻辑前必须取得该 Session 的观察 hash；未观察返回稳定的本地 `EDIT_NOT_OBSERVED`（语义对齐 DSH `FS_NOT_OBSERVED`）。观察 hash 与现有 `expectedHash` 共同构成写入前提；成功后刷新 hash。不得在 Runtime 中伪造一次读取来绕过策略。 |
| `@deepseek-ai/dsh-tool-fs` 错误包装 | `packages/fs/tool-fs/src/error.ts:15–34` 的 `remediateFsError()` | 对 `FS_NOT_OBSERVED` 和 `FS_STALE_VERSION` 保留稳定错误 code，只在模型边界增加“读取/重读后重试”的 remedy。 | 保留阶段一既有 `TEXT_NOT_FOUND`、`TEXT_NOT_UNIQUE`、`EDIT_STALE`、`EDIT_CONFLICT`；新增 `EDIT_NOT_OBSERVED` 时只表达“没有读前观察”。不得新增 `EDIT_RECOVERY_REQUIRED`，也不得用错误文案替代稳定 code。 |
| DSH 观察策略测试 | `packages/fs/fs-observation-policy/tests/policy.spec.ts:47–170`；`packages/fs/tool-fs/tests/integration.spec.ts:149–195、217–264、463–504` | 覆盖未读拒绝、windowed read、外部修改导致 stale、重读后恢复、成功写/编辑刷新 version、owner 隔离和并发 CAS 只有一个获胜者。 | 本项目测试必须覆盖同一矩阵；恢复的定义是“重读刷新版本后可以带新文本再次编辑”，不是 Runtime 暂时解除一个人为阻断。 |

DSH 的 `fs/observed`、`fs/edit-intent` 是其内部文件策略事件，不是 Session 的公共事件类型。对应到本项目时，观察表是 host 内存状态；持久化事实仍是既有 `tool/call`、`tool/result` 和后文的既有 `user/message`，不新增 `AgentEventType`。

补充阅读：`D:\Develop\deepseek-harness-fork\packages\fs\fs-observation-policy\README.md` 的 “The four-layer split”“How the gate participates” 和 “Known Limitations” 规定了策略层、工具层、Provider 层的职责边界；阶段二实施时以这些边界为准。

### 4.2 DSH 阶段二链路 B：重复工具调用提醒

| DSH 程序 / 模块 | 文件与代码入口 | 已实现的行为 | 当前仓库阶段二必须保持的对应边界 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-repeat-tool-reminder` | `packages/guard/repeat-tool-reminder/src/index.ts:28–50` 的 Config 和默认 `[3, 5, 8]`；`sortJsonValue()` / `canonicalize()`（89–109 行）；`Chain`（152–155 行）；`WeakMap<Agent, Chain>`（173 行） | key 为“工具名 + 深度排序后的完整 JSON 参数”。对象属性顺序不同仍算同一次调用；参数预览可截断，但检测 key 永远使用完整参数。 | 新建纯 `RepeatToolReminder`，默认阈值固定为 `[3, 5, 8]`，详细提醒的参数预览上限为 500 字符。不得用 path/error code/相似度猜测替代 DSH 的精确 key。 |
| 同模块的 post-execute hook | `packages/guard/repeat-tool-reminder/src/index.ts:189–224` 的 `observe()` 与 `tools/post-execute` | 调用在执行后计数，拒绝调用也计数；首个阈值给简短提醒，后续阈值给含工具名、次数和参数预览的详细提醒；只追加 context，绝不 veto、重写或延迟调用。 | 在 Agent loop 按模型声明顺序完成每个工具结果后观察调用。到达阈值只生成 notice；绝不阻断 `edit_file`、绝不自动改参数、绝不终止 turn。`TEXT_NOT_FOUND` 连续出现时由该提醒影响下一次模型决策，而不是由 Runtime 返回新的拒绝 code。 |
| 同模块的 reset hook | `packages/guard/repeat-tool-reminder/src/index.ts:229–232` | 新的用户消息清除该 Agent 的链；不同 Agent 的链互不影响；状态只在内存中保存。 | 以当前 Session 作为 DSH Agent 的等价 owner：真实用户新消息清除该 Session 链，删除 Session 时清理；Host 重启/Session resume 从空链开始。不得把计数写成持久恢复状态或跨 Session 共享。 |
| DSH 工具上下文 seam | `packages/core/tools/src/index.ts:563–600、1732–1779` 的 `ToolExecutionResult.additionalContexts` / `PostToolDecision.additionalContexts`；`packages/core/agent-loop/src/tool-calls.ts:156` 接收上下文；`packages/core/agent-loop/src/agent.ts:283` 追加 `user/message` | 提醒附在工具结果后的 `additionalContexts`，随后以带 `{ kind: 'plugin', plugin: 'repeat-tool-reminder' }` source 的合成 `user/message` 写入会话。原始 `tool/result` 保持工具自身结果，提醒可回放但不需要新事件种类。 | 当前仓库尚无通用 `additionalContexts` seam。阶段二只实现该 guard 所需的最小等价路径：`RepeatToolReminder` 产出 notice，`AgentHost.runSteps()` 在已提交的 `tool/result` 后追加既有 `user/message`，payload 带 `source: { kind: 'plugin', plugin: 'repeat-tool-reminder', form: 'notice' }`。不要借此提前建设通用插件 waterfall。 |
| DSH 默认装配与测试 | `packages/bundle/base/cordis.patch.yml:389–394`；`packages/guard/repeat-tool-reminder/tests/repeat-tool-reminder.spec.ts:57–397` | 默认阈值、参数上限、深度排序、阈值升级、不同 agent、拒绝调用、用户重置、配置校验和 downstream context 合并都已有合同测试。 | 在本项目测试中逐项复现相同行为；观察器的状态不能取代这组测试，两个子模块分别验收。 |

阶段二中对 DSH `additionalContexts` 的等价实现只使用已经存在的 `user/message` 与 `tool/result`：不增加 `AgentEventType`、不修改 `AGENT_EVENT_TYPES`，也不创建 `edit/recovery` 事件。`docs/event-contract.md` 只需补充既有 `user/message` 的 plugin notice payload 和回放顺序说明；如果以后形成可复用的通用 post-tool hook，再作为独立阶段评估其公共 contract。

补充阅读：`D:\Develop\deepseek-harness-fork\packages\guard\repeat-tool-reminder\README.md` 的 “Chain semantics”“Reminder delivery” 和 “Known Limitations” 是 2B 的行为规范；尤其 advisory、不阻断、内存态和精确参数 key 不得改成更强的自定义策略。

## 5. Claude Code 源码对照基线

本地 Claude Code 仓库：`D:\Develop\claude-code`。

本轮未发现与当前 `edit_file` 一一对应的公开编辑器实现。可以确认的是，它对“有限资源和反复失败”使用显式状态而非反复依赖自然语言提示；以下内容只能作为流程实现的对照，不能表述为 Claude Code 的同名编辑方案。

| Claude Code 模块 | 文件与代码入口 | 对照时应关注的行为 |
| --- | --- | --- |
| 上下文与输出 token | `src/utils/context.ts`；`MAX_OUTPUT_TOKENS_DEFAULT`（20 行）、`CAPPED_DEFAULT_MAX_TOKENS`（29 行）、`getModelMaxOutputTokens()` | 上下文窗口、默认输出、输出上限和请求预留是不同概念；这与 Agent 的最大 step 数也应分开记录。 |
| 连续失败熔断 | `src/services/compact/autoCompact.ts`；`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`（99 行）、`autoCompactIfNeeded()`（270 行）、异常处理（约 366 行） | 这是 Claude Code 的上下文压缩失败保护，不是阶段二编辑行为。仅保留为“结构化失败状态”的背景参考；阶段二实际按 DSH 的 advisory reminder 实现，不迁移其熔断/阻断语义。 |
| 会话恢复与审计 | `src/services/sessionTranscript/`、`src/utils/sessionRestore.ts`、`src/utils/messages.ts` | 恢复和重放依据结构化 transcript / state，而不是仅从最后一条自然语言猜测历史。 |

## 6. 当前仓库的分阶段实施模块与代码入口

这里按模块和实施阶段组织，不使用优先级标签。阶段之间存在实现依赖：先固定编辑工具契约，再接入 Agent 恢复状态，随后接入任务测试闭环，最后收紧 Runner 的范围审计。每个阶段都列出当前仓库的修改入口、DSH/Claude Code 的参考入口和应保持的行为边界。

| 阶段 | 模块 | 阶段产物 |
| --- | --- | --- |
| 阶段一 | 编辑工具契约 | 稳定错误 code、当前文件上下文、版本化写入、合同测试 |
| 阶段二 | Agent 编辑失败恢复 | DSH 文件观察/CAS、DSH advisory repeat-tool reminder、既有事件回放 |
| 阶段三 | 任务约束与测试闭环 | step/路径提示、仓库原生测试命令、Django adapter 验收 |
| 阶段四 | Runner 范围审计 | 未跟踪文件、删除文件、运行产物和候选 diff 的一致判定 |

### 阶段一：编辑工具的匹配、错误结果和版本语义

| 项目 | 当前仓库：要修改的文件与入口 | DSH 对照文件与入口 | 对照后的实现边界 |
| --- | --- | --- | --- |
| 工具 schema 和说明 | `packages/tools/src/builtin.ts:315`，`edit_file` 注册 | `packages/fs/tool-str-replace-editor/src/index.ts:19–36` 的 `DEFAULT_DESCRIPTION`，以及 422 行的注册 | 在 `edit_file` 描述中明确：替换必须唯一；失败后先重新读取当前文件；不可原样重复失败调用。不要改变现有 `expectedHash` 和 `edits[]` 兼容性。 |
| 唯一匹配实现 | `packages/tools/src/builtin.ts:627`，`editFile()`；核心判断在 638 行 | `packages/fs/fs-local/src/fsio.ts:759`，`applyLiteralEdit()` | 将匹配、行号计算、换行规范化等可测试逻辑抽为纯函数或放入独立的 `edit-file.ts`；当前 `findOccurrences()` 可作为起点。目标是让无匹配、多匹配、空输入成为明确分支。 |
| 错误 payload | `packages/tools/src/builtin.ts:861`，`editFailure()` | `packages/fs/tool-str-replace-editor/src/index.ts:294–305` | 保持 `TEXT_NOT_FOUND`、`TEXT_NOT_UNIQUE`、`EDIT_CONFLICT` 这些稳定 code；`presentation.data` 补充当前文件 hash、总行数、匹配行号/局部行窗。这里不要求沿用 DSH 的 `FS_*` 命名。 |
| 条件写入 | `packages/tools/src/builtin.ts:643–647`，读取后 hash 对比与写入 | `tool-str-replace-editor/src/index.ts:309–315` 的 `replaceIfVersion` | 当前的 `expectedHash` 和写前重新加载应继续作为写入条件；出现变更时返回 `EDIT_CONFLICT`，而不是基于旧文本继续尝试。 |
| 合同测试 | `packages/tools/src/index.test.ts:197` 已有多编辑和 hash 冲突测试；在此文件新增失败分支用例，或新增 `packages/tools/src/edit-file.test.ts` | `packages/fs/tool-str-replace-editor/tests/tools.spec.ts:336` | 对齐测试矩阵：无匹配、多匹配、空搜索串、CRLF、hash 冲突、成功后 diff。测试断言 error code 和结构化数据，不只断言文案。 |

### 阶段二：按 DSH 对齐 Agent 编辑失败恢复

本阶段由两个独立子模块组成。2A 在工具层保证“观察过的版本才能编辑”；2B 在 Agent 层对完全相同的连续调用增加 advisory notice。二者均不替模型作编辑决策。阶段一已经完成的唯一匹配、错误 payload 和条件写入是 2A 的基础。

#### 2A：DSH observation policy 对齐

| 项目 | 当前仓库：要修改的文件与入口 | DSH 对照文件与入口 | 强制实现行为与禁止项 |
| --- | --- | --- | --- |
| 观察策略的纯状态机 | 新增 `packages/tools/src/file-observation.ts`，导出 `FileObservationPolicy`；由 `packages/tools/src/builtin.ts:293` 的 `createBuiltinTools()` 创建单例并注入内置文件工具 | `packages/fs/fs-observation-policy/src/index.ts:21–95` 的 `ObservedStateGate`；`types.ts:18–31` | 状态键是 `sessionId + workspace-normalized path`，值为 `unseen`、`absent` 或 `{ present, hash }`。只保存元数据，不保存文件正文；不得放在 `packages/runtime/src/edit-recovery.ts`，不得依赖 Runtime。 |
| `read_file` 观察写入 | `packages/tools/src/builtin.ts:303` 的 `read_file` 注册和 `readWorkspaceFile()`（696 行） | `packages/fs/tool-fs/src/read.ts:136–163` 的成功读取和 `fs/observed` | 成功读取立刻记录当前 hash，即使只读了一个 window；读取不存在目标时记录 `absent`。`grep`、`glob`、终端输出不能作为观察授权，避免把搜索结果误当作当前文件版本。 |
| `edit_file` 的读前 guard | `packages/tools/src/builtin.ts:315` 的 `edit_file` 注册、`editFile()`（627 行）和现有条件写入（630、651 行） | `packages/fs/tool-fs/src/edit.ts:119–141` 的 `fs/edit-intent` → provider CAS → 成功 `fs/observed` | 在唯一匹配前查询观察状态：`unseen` 返回稳定 `EDIT_NOT_OBSERVED`（DSH `FS_NOT_OBSERVED` 的本地映射）；`absent` 返回现有文件不存在语义；`present` 将已观察 hash 作为内部 CAS guard，并继续同时检查调用者给出的 `expectedHash`。成功编辑后用 `afterHash` 刷新状态。不得自动读取文件、不得忽略已观察 hash。 |
| stale 的恢复路径 | 同上；阶段一的 `EDIT_STALE` / `EDIT_CONFLICT` payload 与 remedy 保持有效 | `packages/fs/fs-observation-policy/src/index.ts:78–87`、`packages/fs/tool-fs/src/error.ts:15–34`；`tool-fs/tests/integration.spec.ts:174–195` | 观察 hash 与实际当前 hash 不一致时返回 `EDIT_STALE` 或 `EDIT_CONFLICT`，并保留“重新读取后重试”的 remedy。成功 `read_file` 刷新 hash 后，新的编辑自然恢复。不得为此创建 recovery event 或 Runtime unblock flag。 |
| 连续成功编辑 | `packages/tools/src/builtin.ts:315、627`；`file-observation.ts` | `packages/fs/fs-observation-policy/src/index.ts:91`；`packages/fs/tool-fs/src/edit.ts:141`；`integration.spec.ts:217–224` | 一次成功编辑立即更新观察 hash，因此同一 Session 可连续编辑同一文件而无需强制重读；每次仍受 CAS 保护。把“每次编辑必读一次”写成硬规则与 DSH 不一致。 |
| 生命周期和隔离 | `packages/runtime/src/index.ts:901` 的 `deleteSession()` 清理该 Session 观察状态；Host 生命周期销毁时清空策略 | `ObservedStateGate` 的 `WeakMap` 和 `apply()` teardown（28、58、106–116 行） | 不同 Session 不得互相授权；重启后观察状态为空，恢复的 Session 必须重新读取。只清理内存，不删除任何 EventStore 历史。 |
| 2A 测试 | 新增 `packages/tools/src/file-observation.test.ts`；在 `packages/tools/src/index.test.ts` 增加文件工具集成测试 | `fs-observation-policy/tests/policy.spec.ts:47–170`；`tool-fs/tests/integration.spec.ts:149–195、217–264、463–504` | 至少覆盖：未读编辑拒绝且文件不变、windowed read 后可编辑、外部修改触发 stale、重读后成功、成功编辑刷新 hash、Session 隔离、两个并发编辑只有一个成功。 |

#### 2B：DSH repeat-tool-reminder 对齐

| 项目 | 当前仓库：要修改的文件与入口 | DSH 对照文件与入口 | 强制实现行为与禁止项 |
| --- | --- | --- | --- |
| 重复链纯逻辑 | 新增 `packages/runtime/src/repeat-tool-reminder.ts`，导出 `RepeatToolReminder`、参数 canonicalize 和 notice formatter | `packages/guard/repeat-tool-reminder/src/index.ts:28–109、124–155` | chain key 必须是 `toolName + JSON.stringify(deepKeySorted(arguments))`。默认阈值 `[3, 5, 8]`；空阈值、重复值、非整数或小于 2 的配置 fail loud；详细提醒仅展示最多 500 字符参数预览。不得按 error code、文件路径或近似文本合并调用。 |
| 配置与装配 | `packages/runtime/src/index.ts:58–129` 的 `AgentHostOptions` 增加 `repeatToolReminder` 配置；构造 `AgentHost` 时创建 tracker | `packages/bundle/base/cordis.patch.yml:389–394`；`repeat-tool-reminder/src/index.ts:28–50、124–170` | 配置字段只镜像 DSH 的 `thresholds`、`include`、`exclude`、`argumentsPreviewChars`。默认值和 fail-loud 校验保持一致；没有显式配置时仍启用 `[3,5,8]`。 |
| 计数、顺序和提醒注入 | `packages/runtime/src/index.ts:2344` 的 `runSteps()`；工具调度/结果提交在 2565–2599 行；`executeModelToolCall()`（3205 行）继续负责普通工具执行 | `repeat-tool-reminder/src/index.ts:189–224`；`core/agent-loop/src/tool-calls.ts:128–156` 的按模型顺序 commit | 每个模型工具调用在产生 terminal result 后计数，`denied`、失败和成功都计数。只在精确达到 3、5、8 次时提醒：第一个阈值简短提醒，后续阈值详细提醒。未到阈值和超过最高阈值不额外提醒。任何提醒都不能修改工具输入、result、scheduler 并发规则或 turn terminal status。 |
| 现有事件的 materialization | 同一 `runSteps()`：先保留并 push `tool/result`，随后 append 既有 `user/message` 并把 notice push 入下一次模型请求的 `messages`；`conversationMessages()`（1907 行）验证重放顺序 | `core/tools/src/index.ts:563–600、1732–1779` 的 `additionalContexts`；`core/agent-loop/src/tool-calls.ts:156、268–291` 和 `agent.ts:283` | 追加 payload 为 `{ content, source: { kind: 'plugin', plugin: 'repeat-tool-reminder', form: 'notice' } }`。它必须在对应 `tool/result` 之后，保持 source；原 `tool/result` 不嵌入提醒、不改变 audit/result。复用既有 `user/message`，不增加 `AgentEventType`、`AGENT_EVENT_TYPES` 或 `edit/recovery`。 |
| 链 owner 与重置 | `packages/runtime/src/index.ts:1312–1338` 的真实用户消息入口清除该 Session 的 chain；`deleteSession()`（901 行）清理 | `repeat-tool-reminder/src/index.ts:173、229–232` | Session 是当前 Runtime 中 DSH `Agent` 的等价 owner。新用户消息重置，工具之间不同调用重置为 1；被 `include`/`exclude` 排除的调用保持 transparent，既不计数也不重置。Session/Host 重启从空链开始。不得把 repeat count 纳入 Session recovery state。 |
| 已有事件文档 | 修改 `docs/event-contract.md` 的 `user/message` 说明；`packages/contracts/src/index.ts` 的 `AgentEventType` 和 `AGENT_EVENT_TYPES` 不修改 | DSH `repeat-tool-reminder/README.md` “Reminder delivery”；`core/agent-loop/tests/tool-calls.spec.ts:402–417` | 明确 plugin notice 是现有 `user/message` 的可回放 source-attributed payload，并且其 sequence 在触发的 `tool/result` 之后。这里是既有事件 payload 的文档补充，不是新增事件契约。 |
| 2B 测试 | 新增 `packages/runtime/src/repeat-tool-reminder.test.ts`；在 `packages/runtime/src/index.test.ts` 添加 scripted-model 集成与 replay 用例 | `repeat-tool-reminder/tests/repeat-tool-reminder.spec.ts:57–397` | 覆盖阈值升级、深度排序、500 字符截断、不同 Session、拒绝调用、新用户消息重置、提醒不阻断调用、`tool/result → user/message(plugin)` 的顺序以及重启后 counter 清零但旧 notice 可回放。 |

#### 阶段二不可变规则

1. 不新建 `EDIT_RECOVERY_REQUIRED`、`edit/recovery` 或任何等价 `AgentEventType`；因此不修改 `packages/contracts/src/index.ts` 的事件联合类型和公开列表。
2. `TEXT_NOT_FOUND` / `TEXT_NOT_UNIQUE` 仍是阶段一的编辑结果。DSH 没有把它们升级为强制重读 gate：相同调用达到阈值后只得到 notice，模型可读取、改参数、改用 patch，或结束任务。
3. `FS_NOT_OBSERVED` / `FS_STALE_VERSION` 的 DSH 语义由本项目 `EDIT_NOT_OBSERVED` / 既有 `EDIT_STALE`、`EDIT_CONFLICT` 对齐；稳定错误 code 与模型 remedy 必须分离。
4. 观察状态和 repeat chain 都是 host 内存启发式状态。EventStore 只保存工具事实和实际注入的 plugin notice；重启不会恢复其计数或观察授权。
5. 阶段二不接入任务测试、step 预算、Django adapter 或 Runner 范围审计；这些仍分别属于阶段三和阶段四。

### 阶段三：有限 step 预算、任务约束和测试闭环

| 项目 | 当前仓库：要修改的文件与入口 | 外部对照入口 | 对照后的实现边界 |
| --- | --- | --- | --- |
| 评测 prompt 中的预算与范围 | `scripts/eval-mvp/run-agent-task.ts:149–156` | Claude Code：`src/utils/context.ts` 的资源维度分离 | 该入口已经注入 `maxSteps` 与 `allowedPaths`，应保持为评测专用的动态任务提示。当前 Django 任务已能看见“最多 32 step”和允许路径，不需要再把这部分归因成“Agent 不知限制”。 |
| 产品 Agent 的静态执行规则 | `packages/runtime/src/system-prompt.ts`；`taskExecutionSection()`、`workspaceSection()`、`safetySection()`、`verificationSection()` | DSH：`DEFAULT_DESCRIPTION` 的编辑规则；Claude Code：资源和恢复状态分离 | 在“工具失败”规则中增加可验证的编辑恢复动作：遇到 `TEXT_NOT_FOUND` / `TEXT_NOT_UNIQUE` 时，先读取当前文件再编辑；在验证规则中要求报告实际执行的命令和退出状态。不要把 SWE-bench 的具体 Django 命令写进通用 system prompt。 |
| 工具级测试能力 | `packages/tools/src/builtin.ts:387`，`run_tests`；`packages/tools/src/prompt-catalog.ts:84` | DSH 没有 Django 适配器；它的参考点是工具说明与失败语义 | 保持测试命令由仓库 adapter/任务元数据决定。对 Django 任务，Runner 和 Agent 应使用 Django 原生 runner，而不是让所有项目走 pytest。 |
| Django grader adapter | `scripts/eval-mvp/grade-agent-run.ps1:162–203` 的 `Convert-DjangoTestTarget` / `New-TestInvocation` | 无直接 DSH 对照；这是 SWE-bench/Django 的仓库专属适配 | 保持 `tests/runtests.py` 原生调用；该模块的职责是最终判分，不应把隐藏测试细节暴露给 Agent。 |
| 数据集任务定义 | `D:\Develop\coding-agent-test\datasets\swebench-lite\pilot-01\public\tasks\django__django-16046\task.json` | 无直接 DSH 对照 | `problemStatement`、`allowedPaths`、`requiredChecks` 是 Agent 可见契约；`failToPass`/`passToPass` 的具体内容仍供 Grader 使用。对于此任务，应在公开问题描述中明确 `None` 与空字符串两个输入边界，避免“null”一词造成歧义。 |

### 阶段四：评测范围审计与 `.agent-artifacts/`

这不是 DSH 编辑器模块需要解决的问题，而是当前评测 Runner 的输入证据不完整。

| 项目 | 当前仓库：要修改的文件与入口 | 原因与修改边界 |
| --- | --- | --- |
| Agent 原始工作区范围检查 | `scripts/eval-mvp/run-agent-task.ts:249`，当前结果对象把 `scopeViolation` 固定为 `false`；同一脚本生成 `git-status.json` 和 `agent.diff` | `agent.diff` 无法表示 Git 未跟踪文件，`.agent-artifacts/` 因此会出现在 `changedFiles` 但不会被随后 `git apply` 到 Grader clean copy。应在生成 diff 前基于原始 workspace 的 `git status --porcelain` 检查所有修改、未跟踪和删除路径，再写入独立 scope 审计结果。 |
| 最终 Grader 范围检查 | `scripts/eval-mvp/grade-agent-run.ps1:77` 的 `Get-ChangedFiles`、91 行的 `Get-PatchFiles`、289–293 行的 scope 判断 | 该脚本目前只对“已应用的 agent.diff”检查范围，因此看不到未纳入 diff 的未跟踪文件。应消费 Runner 生成的完整范围审计结果，或在 agent 原始 workspace 再做一次核验。 |
| 运行产物策略 | `packages/runtime/src/index.test.ts:975–983`、`packages/tools/src/jobs.ts:103`、`packages/tools/src/patch.ts:293` 均会使用 `.agent-artifacts/` | 必须在评测配置中明确：`.agent-artifacts/` 是允许的运行时临时产物并从候选代码变更中排除，还是任何新增文件都算越界。两种策略均可，但 Runner、结果 JSON、Grader 必须一致。不能让 `changedFiles` 与 `scopeViolation` 给出互相矛盾的结论。 |

### 阶段文件改动清单

下表用于实际开工时确认改动范围；其中“新增”表示为保持职责可测试而新增的本项目文件，并非 DSH 原样文件迁移。

| 仓库 | 文件 | 处理方式 | 对照来源 |
| --- | --- | --- | --- |
| 当前仓库 | `packages/tools/src/builtin.ts` | 修改 `edit_file` 的描述、匹配失败 payload 和局部上下文；保留现有工具名和兼容 schema | DSH `tool-str-replace-editor/src/index.ts`、`fs-local/src/fsio.ts` |
| 当前仓库 | `packages/tools/src/index.test.ts` 或新增 `edit-file.test.ts` | 新增编辑错误合同测试 | DSH `tool-str-replace-editor/tests/tools.spec.ts` |
| 当前仓库 | 新增 `packages/tools/src/file-observation.ts` 与 `file-observation.test.ts` | 保存 Session + 文件路径的 present/absent/hash 观察状态，提供读前编辑与 CAS guard | DSH `fs-observation-policy/src/index.ts`、`types.ts` |
| 当前仓库 | `packages/tools/src/builtin.ts` | `read_file` 成功/不存在时记录观察；`edit_file` 取得 guard、沿用条件写入、成功后刷新观察 | DSH `tool-fs/src/read.ts`、`edit.ts`、`error.ts` |
| 当前仓库 | 新增 `packages/runtime/src/repeat-tool-reminder.ts` 与 `repeat-tool-reminder.test.ts` | 保存 Session 级、内存中的精确重复调用 chain 并产出 advisory notice | DSH `repeat-tool-reminder/src/index.ts` |
| 当前仓库 | `packages/runtime/src/index.ts` | 在 model-order `tool/result` 后 materialize plugin `user/message`；新用户消息/删除 Session 时重置相应内存状态 | DSH `core/agent-loop/src/tool-calls.ts`、`agent.ts` |
| 当前仓库 | `packages/runtime/src/index.test.ts` | 覆盖 notice 不阻断工具、`tool/result → user/message` 顺序、重放和重启后 chain 清零 | DSH `repeat-tool-reminder/tests/repeat-tool-reminder.spec.ts` |
| 当前仓库 | `docs/event-contract.md` | 说明既有 `user/message` 的 plugin notice source 与回放顺序；不新增事件类型 | DSH `repeat-tool-reminder/README.md` 的 Reminder delivery |
| 当前仓库 | `packages/runtime/src/system-prompt.ts` | 补充通用编辑失败恢复和验证规则，不注入数据集私有信息 | DSH 工具说明的精确替换约束 |
| 当前仓库 | `scripts/eval-mvp/run-agent-task.ts` | 把完整工作区状态转为可用的 scope 审计结果；维持现有预算/路径 prompt 注入 | 本次结果中 `.agent-artifacts/` 与 diff 不一致的事实 |
| 当前仓库 | `scripts/eval-mvp/grade-agent-run.ps1` | 消费完整范围审计结果，并继续执行 Django 原生 Grader | 当前 `Get-ChangedFiles` / `Get-PatchFiles` 分支 |

## 7. 分阶段验收入口

实现完成后，不以“模型回答看起来合理”作为判断依据，而应从下列入口复核：

| 验收对象 | 入口 | 通过条件 |
| --- | --- | --- |
| 编辑工具 | `packages/tools` 的单元测试 | 无匹配、多匹配、空输入、CRLF、hash 冲突都返回可预期 code；成功编辑产生正确 diff。 |
| 文件观察与版本恢复（2A） | `packages/tools/src/file-observation.test.ts`、`packages/tools/src/index.test.ts` | 未读编辑稳定拒绝且文件不变；windowed read 后可编辑；外部改动 stale；重读后恢复；成功编辑刷新 hash；Session 隔离；并发 CAS 仅一个成功。 |
| 重复调用提醒（2B） | `packages/runtime/src/repeat-tool-reminder.test.ts`、`packages/runtime/src/index.test.ts` | 精确调用在 3/5/8 次获得正确升级提醒；参数键深度排序、预览截断、拒绝调用计数、新用户消息重置、Session 隔离都符合 DSH；提醒不阻断调用。 |
| 事件回放 | `packages/runtime/src/index.test.ts` 与 `docs/event-contract.md` 对应 fixture | 触发提醒时 sequence 为 `tool/call → tool/result → user/message(plugin notice)`；重启后旧 notice 可回放，但观察授权和 repeat counter 都不会被错误恢复。 |
| 评测范围审计 | `scripts/eval-mvp/run-agent-task.ts`、`grade-agent-run.ps1` 的脚本级 fixture | 已跟踪修改、未跟踪文件、删除文件和 `.agent-artifacts/` 都得到一致判定。 |
| Django 16046 | Django 原生 `tests/runtests.py`，由 `grade-agent-run.ps1` 调用 | `nformat("", ".") == ""`、`nformat(None, ".") == "None"`、pass-to-pass 通过；脚本化恢复场景中同一精确编辑第 3 次开始可见 DSH 式提醒，stale 编辑只能在重读后继续。 |

## 8. 不应直接照搬的部分

- 不迁移 DSH 的 Cordis、插件注册或通用 `additionalContexts` waterfall；阶段二只落地 observation policy 和 repeat-tool-reminder 所需的最小等价路径。
- 不把 Claude Code 的自动上下文压缩熔断迁入编辑工具。DSH 的重复提醒是 advisory，不会在阈值后阻止工具调用。
- 不新增 `EDIT_RECOVERY_REQUIRED`、`edit/recovery`、新的 `AgentEventType` 或公开事件列表项；若未来确需新事件，必须在那个独立阶段同步 `packages/contracts/src/index.ts` 和 `docs/event-contract.md`。
- 本阶段只参照 DSH 的程序结构和行为，不复制其源码；因此不新增 `docs/source-reuse-register.md` 条目。若后续改为复制或大量改编，必须先按许可证规则登记。
- 不把 Django 的私有测试目标或 gold patch 注入产品级 system prompt；评测 runner 与通用 Agent 的职责必须保持分离。
- 不使用 LLM judge 替代 Django 原生测试、隐藏测试和 Git 范围审计。

本次调研形成的实现对照是：**编辑工具契约以 DSH 的 `str_replace_editor` / `applyLiteralEdit` / 合同测试为参照；阶段二以 DSH 的 `fs-observation-policy` / `tool-fs` / `repeat-tool-reminder` / `additionalContexts` materialization 为参照；评测范围审计在当前 Runner 中独立修复。**
