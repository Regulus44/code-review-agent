# 上游参考与复用登记

每次直接复制、改编或大量依赖上游代码时，在本文件登记一条记录。只读参考、不产生代码来源关系的阅读不需要登记。

## 登记格式

```text
ID:
来源仓库:
来源路径:
复用方式: copy | adapt | behavior-reference
许可证/来源证据:
本项目路径:
删除或改写的部分:
新增测试:
```

## 当前登记

### DSH-001

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/client`、`apps/web`

复用方式：`adapt`

许可证/来源证据：根仓库和 Web package 声明 MIT。

本项目路径：未来的 `apps/web`。

范围：复用 Shell、Session sidebar、Conversation、Tool row、Diff、Permission、Terminal 和 Settings 的信息架构；先剥离 Cordis、DSH 专有 API 和无关插件依赖。

要求：保留 MIT notice；所有 API/event 类型改为本项目 `packages/contracts`；补充本项目的 SSE 重连和权限测试。

### DSH-002

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/core/agent-loop/src/agent.ts`、`packages/core/agent-loop/src/tool-calls.ts`

复用方式：`behavior-reference`，必要时在确认具体 package license 后再局部 `adapt`。

许可证/来源证据：根仓库 MIT；具体复制前检查目标 package 的 notice。

本项目路径：未来的 `packages/runtime`、`packages/tools`。

范围：turn/step、parallel/exclusive、取消、兄弟工具失败、结果顺序和 progress 语义。

### DSH-003

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/client/ui-layout`、`packages/client/ui-sidebar`、`packages/client/ui-conversation`、`packages/client/ui-model-selection`、`packages/client/ui-tool`

复用方式：`behavior-reference` + `adapt`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本批没有复制 DSH 品牌资产或运行时代码。

本项目路径：`apps/web/index.html`

范围：三栏 AppFrame 几何、sidebar rail、New session、workspace picker、hero/composer 空态、composer model popover、details panel、tool row 和 permission card 的信息分区与交互顺序。

改写部分：所有 DOM、CSS、事件渲染和 API 调用均适配本项目静态 Web shell、`/v1/*` API 和 SSE event contract；品牌、颜色、图标、文案和模型列表使用本项目内容。

新增测试：浏览器 smoke 验证 Session transcript、Connected 状态、模型 popover/切换、sidebar collapse、details close 和 API error 空态。

### DSH-004

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx`、`packages/client/ui-workspace/src/client/tree.ts`、`packages/client/ui-sidebar/src/client/SidebarRoot.tsx`。

复用方式：`behavior-reference` + `adapt`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本批没有复制 DSH 运行时类型或品牌资产。

本项目路径：`apps/web/index.html`。

范围：Workspace 父级分组、Session 子项、展开/折叠、搜索、活动/归档视图、行级操作菜单、滚动侧栏和当前 Workspace 自动展开。

改写部分：树数据直接由本项目 `/v1/sessions` projection 按 `workspaceRoot` 派生；Session 操作使用本项目 archive/restore/delete API；Workspace 和 Session 文案、颜色、图标保持本项目风格。

新增测试：浏览器 DOM smoke 验证多 Workspace 分组、搜索过滤、展开/折叠和 Session 操作菜单；API 合同测试覆盖软删除与事件历史保留。

### DSH-005

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/client/ui-primitives/src/markdown/MarkdownText.tsx`、`packages/client/ui-primitives/src/markdown/parse.ts`、`packages/client/ui-primitives/src/markdown/render.tsx`、`packages/client/ui-primitives/tests/fixtures/markdown-dom`。

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本批没有复制 DSH Markdown parser 或 React renderer 实现。

本项目路径：`apps/web/index.html`。

范围：GFM 有序/无序列表的连续编号、嵌套列表、表格 header/body、列对齐、横向滚动、流式 Markdown 的稳定 DOM 行为和原始 HTML 安全策略。

适配方式：当前静态 Web shell 保持无构建依赖，按 DSH 的 GFM DOM 语义适配轻量渲染器；表格和列表样式使用本项目 CSS token，HTTP(S) 链接和 HTML 转义继续由本项目安全规则控制。

### CC-001

来源仓库：`D:/Develop/claude-code`

来源路径：`src/query.ts`、`src/services/tools/StreamingToolExecutor.ts`、`src/tools.ts`。

复用方式：`behavior-reference`；只有具体文件或 package 的许可证明确兼容时才 `adapt`。

许可证/来源证据：本地快照未发现根 `LICENSE`；仓库描述为 reverse-engineered/decompiled。

本项目路径：未来的 `packages/runtime`、`packages/tools`、`packages/llm`。

范围：流式 turn、工具调度、工具目录、权限前置检查、错误合成和恢复路径。不得默认整段复制实现。

### CC-002

来源仓库：`D:/Develop/claude-code`

来源路径：`packages/builtin-tools/src/tools`、`src/services/contextCollapse`、`src/coordinator`。

复用方式：`behavior-reference`。

许可证/来源证据：按目录逐文件核实；无明确许可时只复刻接口和行为。

本项目路径：未来的 `packages/tools`、`packages/context`、`packages/agents`。

范围：Read/Edit/Write/Glob/Grep/Bash/Task 的用户体验，上下文压缩、父子任务和报告模型。

### DSH-006

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/core/system-prompt/src/index.ts`、`packages/core/system-prompt/tests/tool-order.spec.ts`、`packages/core/tools/src/types.ts`、`packages/core/tools/src/presentation.ts`

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本次未复制 DSH 运行时代码。

本项目路径：`packages/tools/src/prompt.ts`、`packages/tools/src/prompt-catalog.ts`、`packages/runtime/src/system-prompt.ts`

范围：有序 prompt section、确定性工具排序、可见工具过滤、上下文长度预算、schema/presentation 与跨调用工具指导分层。

适配方式：使用本项目的 `ToolPromptRegistry`、`ToolDefinition`、permission-filtered tool list 和 system prompt builder；不引入 Cordis、DSH scope 或远程 description 作为高优先级指令。

新增测试：`packages/tools/src/prompt.test.ts` 和 `packages/runtime/src/index.test.ts` 覆盖唯一注册、确定性 assembly、fallback、预算和权限过滤。

### CC-003

来源仓库：`D:/Develop/claude-code`

来源路径：`packages/builtin-tools/src/tools/*/prompt.ts`、`src/constants/prompts.ts`、`packages/builtin-tools/src/tools/TaskUpdateTool`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本次只参考每个工具独立 prompt、前置条件、失败恢复和 Todo/Task 状态边界。

本项目路径：`packages/tools/src/prompt-catalog.ts`

范围：Purpose、When to use、When not to use、Prerequisites、Input rules、Sequencing、Result interpretation、Failure recovery、Safety 九段工具指导。

适配方式：所有文案和实现均为本项目自有内容；不复制 Claude Code 代码、账户、遥测或商业服务。

### CC-018

来源仓库：`D:/Develop/claude-code`

来源路径：`src/services/SessionMemory/sessionMemoryUtils.ts`、`src/services/SessionMemory/sessionMemory.ts`、`src/services/SessionMemory/prompts.ts`、`src/utils/permissions/filesystem.ts`。

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本次未复制实现。

本项目路径：`packages/context/src/session-memory-file.ts`、`packages/runtime/src/index.ts`、`apps/api/src/server.ts`。

范围：Session Memory 的 token/tool/natural-break 门控、host-owned Markdown 边界、exact-path writer、后台隔离 extractor 和失败 fail-closed 语义；本项目使用自有 frontmatter/etag/atomic rename 实现。

新增测试：`packages/context/src/session-memory-file.test.ts`、`packages/context/src/session-memory.test.ts`、`apps/api/src/server.test.ts` 覆盖 bound、原子写、重复写、symlink/path traversal、取消和默认 API 装配。

### DSH-014

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/core/session`、`packages/compaction/compaction-basic`、Session event/projection/replay tests。

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本次未复制 DSH 运行时代码。

本项目路径：`packages/runtime/src/index.ts`、`packages/context/src/session-memory-file.ts`、`packages/storage/src/index.ts`。

范围：append-only metadata receipt、session-scoped recovery、compaction lifecycle 与原始 transcript/Memory 正文分离；实现继续使用本项目 EventStore、projection 和统一权限边界。

### DSH-007

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/goal/tool-goal`、`packages/session-query/tool-session-query`、`packages/fs/tool-fs/src/read-image.ts`、`packages/lsp/lsp`、`packages/lsp/lsp-stdio`、`packages/shell/tool-bash` background adapter。

复用方式：`behavior-reference` + `adapt`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本次未复制 DSH 运行时代码或内部包依赖。

本项目路径：`packages/contracts/src/index.ts`、`packages/storage/src/index.ts`、`packages/tools/src/builtin.ts`、`packages/tools/src/jobs.ts`、`packages/tools/src/image.ts`、`packages/tools/src/lsp.ts`。

范围：Goal durable lifecycle、bounded session query、background job restart metadata、image type/size gate 和 configured read-only LSP lifecycle。

适配方式：使用本项目 EventStore、SQLite projection、ToolRuntime、WorkspaceResolver、权限和审计；LSP server 只能由 host 配置，工具输入不能注入任意 executable；无 vision/LSP capability 时不暴露对应工具。

### DSH-008

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/web/tool-web`、`packages/skill/tool-skill`、`packages/subagent/subagent`、`packages/subagent/tool-subagent`、`packages/workflow/tool-workflow`、`packages/workflow/tool-ralph`。

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本次只登记 capability、scope、budget、depth、iteration、stop-condition 参考，没有复制运行时实现。

本项目路径：`packages/tools/src/capabilities.ts`、`packages/tools/src/builtin.ts`、`docs/archive/phases/phase-plans/phase-3b-tool-hardening.zh-CN.md`。

范围：Web 默认关闭和 host allowlist、Skill 低优先级不可覆盖安全规则、Subagent 深度/工具白名单/预算、Workflow 最大迭代与停止条件。

适配方式：先落地 `CapabilityRegistry` 与 `capability_status` 只读切片；真实 Web provider、Skill loader、Subagent lifecycle 和 Workflow executor 留到后续专门阶段，避免从 prompt 或扩展入口绕过 ToolRuntime。

### DSH-009

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/fs/tool-fs/src/diff.ts`、`packages/fs/tool-fs/src/write.ts`、`packages/fs/tool-fs/src/edit.ts`、`packages/fs/tool-str-replace-editor/src/index.ts`

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本次未复制 DSH 代码或引入其 `diff` 依赖。

本项目路径：`packages/tools/src/patch.ts`、`packages/tools/src/builtin.ts`。

范围：多文件 unified patch 的 hunk 解析、上下文/删除校验、stale/conflict 停止、变更前后 diff 展示、apply/reject/rollback 语义和结构化错误。

适配方式：使用本项目自有 parser、WorkspaceResolver、ToolRuntime、审批和 `patch/*` 事件；不复用 DSH runtime、Cordis 或外部 diff 包。新增测试覆盖 create/update/delete、多文件、stale、冲突、审批和回滚。

### DSH-010

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/mcp/mcp-client/src/index.ts`、`connection.ts`、`tools.ts`、`transport.ts`。

复用方式：`behavior-reference`。

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本批没有复制 DSH 实现。

本项目路径：`packages/mcp-client/src/{config,manager,bridge,transport}.ts`、`packages/tools/src/registry.ts`。

范围：server namespace reservation、per-generation client/transport、generation guard、串行 discovery、registry atomic swap、重连预算/稳定窗口、stdio argv/env 清理和 close 顺序。

改写部分：配置事实来源改为本项目 SQLite；credential 只使用 opaque reference；scope visibility、ToolRuntime、EventStore、resource/prompt trust boundary 和 Web projection 使用本项目 contract。

### DSH-011

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/subagent/subagent/src/{index,types,descriptor,child-agent,depth,lifecycle,continuation,projection,run-settlement}.ts`、`packages/subagent/tool-subagent/src/index.ts`、`packages/subagent/tool-subagent-control/src/{index,list-agents}.ts`、`packages/subagent/tool-subagent-report/src/index.ts`、`packages/subagent/subagent-{spawn-in-process,fork-in-process,in-process-driver}`、`packages/core/agent/src/{inbox,dispatch}.ts`、`packages/core/agent-loop/src/agent.ts`、`packages/host/apiproxy/src/api/subagents*.ts`。

复用方式：`behavior-reference` + `architecture-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本轮没有复制 DSH 运行时代码、Cordis、内部类型或 Web 组件。

本项目路径：`docs/archive/phases/phase-plans/phase-5-subagents.zh-CN.md`、未来的 `packages/subagent`、`packages/contracts`、`packages/storage`、`packages/runtime`、`packages/tools` 和 `apps/api`/`apps/web`。

范围：provider registry、one-shot run ownership、continuable child inbox、descriptor/versioning、parent/ancestor authority、depth/budget、child-scoped report、Task projection 和 browser-safe subagent API。

适配方式：先建立行为 fixture 和本项目 contract，再按 DSH 的职责分层实现；EventStore、ToolRuntime、PermissionPolicy、WorkspaceResolver、MCP scope 和 SSE replay 继续作为本项目事实来源与安全边界。Phase 5 不引入完整 DSH runtime，也不把 DSH 内部类型暴露为公共 API。

### DSH-012

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/subagent/subagent/src/{descriptor,continuation,run-settlement}.ts`、`packages/core/agent/src/inbox.ts`、`packages/subagent/tool-subagent-control/src/{index,list-agents}.ts`、`packages/subagent/tool-subagent-report/src/index.ts`、`packages/host/apiproxy/src/api/subagents.ts`。

复用方式：`behavior-reference` + `architecture-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；Phase 5 实现没有复制 DSH 代码、Cordis Context、内部品牌类型或 Web 组件。

本项目路径：`packages/contracts/src/index.ts`、`packages/storage/src/index.ts`、`packages/subagent/src/*`、`packages/runtime/src/subagent-provider.ts`、`packages/tools/src/subagent.ts`、`apps/api/src/server.ts`、`apps/web/index.html`。

范围：Task 与 child Session 身份分离、descriptor versioning、one-shot `start → result → dispose`、continuable FIFO/child lock、interrupt 保留 inbox、parent/ancestor authority、direct-parent report、settlement notice 和 browser-safe catalog/history/control API。

改写部分：所有 durable event、projection、permission、workspace、MCP allowlist、ToolRuntime、SSE 和 DTO 均为本项目自有实现；MCP child 默认 deny 未显式 allow 的 server/tool，Web 只消费 projection/DTO。

新增测试：`packages/subagent/src/index.test.ts` 覆盖 descriptor、SQLite child metadata、foreground/background report、sequence gap、FIFO/interrupt/direct-parent report；`apps/api/src/server.test.ts` 覆盖 catalog/output/scoped replay。

### CC-004

来源仓库：`D:/Develop/claude-code`

来源路径：`src/context.ts`、`src/constants/prompts.ts`、`src/utils/systemPrompt.ts`、`src/utils/messages.ts`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本次没有复制 Claude Code 实现代码，只重新实现 section 分层、canonical model view、稳定排序和不可信上下文边界。

本项目路径：`packages/context/src/assembler.ts`、`packages/runtime/src/system-prompt.ts`、`packages/runtime/src/index.ts`

范围：static/dynamic system prompt sections、visible tool schema 与 history/attachment 的统一组装、稳定 fingerprint、compact 后重新组装和 `step/started` 诊断元数据。

改写部分：workspace、permission、EventStore、ToolRuntime、ChatMessage 和 token estimator 全部使用本项目 contract；M04 API round/tool pairing 与 M05 microcompact 不在本登记项范围内。

新增测试：`packages/context/src/assembler.test.ts`、`packages/runtime/src/index.test.ts` 的 M03 assembly fingerprint/section metadata 场景。

### CC-005

来源仓库：`D:/Develop/claude-code`

来源路径：`src/services/compact/grouping.ts`、`src/utils/messages.ts`、`src/query.ts`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本次没有复制 Claude Code 实现代码，只重新实现 API round、message normalize、tool pairing 和请求前 gate。

本项目路径：`packages/context/src/api-round.ts`、`api-normalize.ts`、`tool-pairing.ts`、`packages/runtime/src/index.ts`

范围：assistant response ID 分组、streaming assistant 合并、duplicate/orphan/missing tool pair 检测、repair/strict 策略、request/response identity 和诊断事件。

改写部分：synthetic result、EventStore 事件、ChatMessage contract、ToolRuntime 权限和 provider request 使用本项目规则；M05 microcompact、provider cache edit 和 summary agent不在本登记项范围内。

新增测试：`packages/context/src/api-round.test.ts`、`api-normalize.test.ts`、`tool-pairing.test.ts`、`packages/runtime/src/index.test.ts` 的 M04 gate 场景。

### CC-006

来源仓库：`D:/Develop/claude-code`

来源路径：`src/query.ts:526-624`、`src/services/compact/microCompact.ts:137-365,426-520`、`src/services/compact/cachedMicrocompact.ts`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本次没有复制 Claude Code 代码，只重新实现工具结果估算、compactable 白名单、count/token/time trigger、最近结果保留和 model-view cleared marker。

本项目路径：`packages/context/src/tool-result-budget.ts`、`packages/runtime/src/index.ts`、`packages/context/src/tool-result-budget.test.ts`。

范围：Tool Result Budget、MicroCompact、protected tool call、turn-local cleared IDs、tokensSaved、`context/tool_results_budgeted` 和 `context/microcompacted` receipts。

明确未复用：`cachedMicrocompact.ts` 的 provider-specific prompt-cache edit 暂不实现；本项目 transcript/model view 分离、EventStore 事件和 permission/workspace 安全边界均为自有实现。

新增测试：`packages/context/src/tool-result-budget.test.ts` 和 `packages/runtime/src/index.test.ts` 的 M05 model-view、幂等、事件和原文保留场景。

### CC-007

来源仓库：`D:/Develop/claude-code`

来源路径：`src/services/compact/sessionMemoryCompact.ts:45-127,234-390,439-590`、`src/services/SessionMemory/sessionMemoryUtils.ts`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本次没有复制 Claude Code 代码，只重新实现 session memory adapter、摘要边界查找、保留窗口、tool pair/stream 回溯和 legacy fallback。

本项目路径：`packages/context/src/session-memory-compact.ts`、`packages/runtime/src/index.ts`、`packages/storage/src/index.ts`。

范围：`SessionMemoryStore` 只读输入、`lastSummarizedMessageId`、minimum/maximum keep window、`adjustIndexToPreserveAPIInvariants()`、resumed-session 保守策略、边界缺失不猜测、`context/session_memory_compacted` 和失败 receipt。

明确未复用：Session Memory extraction/update、SessionStart hooks、文件路径解析、Project Memory、summary agent 和 provider cache edit 留给 M07/M08/M11；memory 原文不写入 EventStore receipt。

新增测试：`packages/context/src/session-memory-compact.test.ts`、`packages/runtime/src/index.test.ts` 的 memory boundary、fallback、tool pair、streaming 和 projection 场景。

### CC-008

来源仓库：`D:/Develop/claude-code`

来源路径：`src/services/compact/compact.ts:149-227,247-297,336-389,411-690,1159-1450`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本次没有复制 Claude Code 代码，只重新实现 summary input 清理、无工具 summary request、API-round PTL retry、summary usage 和结构化失败回退。

本项目路径：`packages/context/src/summary-input.ts`、`packages/context/src/summary-compact.ts`、`packages/runtime/src/index.ts`、`packages/storage/src/index.ts`。

范围：image/document marker、skill attachment 过滤、summary agent purpose/tool boundary、recent suffix、oldest API-round retry、synthetic user marker、summary compact receipts。

明确未复用：forked-agent prompt-cache sharing、PreCompact/SessionStart hooks、compact boundary、post-compact attachments、provider-specific error APIs 和完整 Claude Code tool runtime。

新增测试：`packages/context/src/summary-compact.test.ts`、`packages/runtime/src/index.test.ts` 的 summary request、PTL retry、usage 和 projection 场景。

### CC-009

来源仓库：D:/Develop/claude-code

来源路径：src/utils/messages.ts:4967-5093、src/services/compact/compact.ts:336-389,541-669,1467-1650

复用方式：behavior-reference

许可证/来源证据：本地快照未发现根 LICENSE；本次没有复制 Claude Code 实现代码，只重新实现 compact boundary、preserved segment、post-compact 附件顺序、附件预算和 projection replay。

本项目路径：packages/context/src/boundary.ts、attachments.ts、post-compact.ts、packages/runtime/src/index.ts、packages/storage/src/index.ts。

范围：compact/micro marker、最近 boundary lookup、head/anchor/tail、summary/preserved/attachment 顺序、最近文件/plan/skill/MCP/hook provider、数量与 token cap、ID 去重、context/compact_boundary 和 rebuild failure receipt。

明确未复用：Claude Code 文件读取实现、SessionStart/PreCompact hook runtime、provider prompt-cache edit、完整 JSONL transcript loader、商业遥测和工具权限实现。

新增测试：packages/context/src/post-compact.test.ts、packages/runtime/src/index.test.ts、packages/storage/src/index.test.ts 的 boundary、attachment budget、projection 和 replay 场景。

### CC-010

来源仓库：D:/Develop/claude-code

来源路径：src/query.ts:584-888,1041-1124,1349-1470,1582-1587；src/services/compact/autoCompact.ts:52-60,270-380；src/services/compact/reactiveCompact.ts

复用方式：behavior-reference

许可证/来源证据：本地快照未发现根 LICENSE；本次没有复制 Claude Code 实现代码，只重新实现主动/反应式 compact 状态机、provider overflow 分类、per-turn guard、retry transition 和 bounded circuit breaker。

本项目路径：packages/context/src/recovery.ts、packages/runtime/src/index.ts、packages/llm/src/index.ts、packages/storage/src/index.ts、packages/contracts/src/index.ts。

范围：请求前 proactive recovery、prompt-too-long/413/media 错误分类、reactive compact retry、同一 turn 的 attempt 上限、连续 compact 失败熔断、request hash、recovery 事件和 projection replay。

明确未复用：Claude Code 的 context collapse、stop-hook runtime、provider prompt-cache edit、商业遥测、完整 JSONL transcript loader 和工具权限实现；provider body、凭据、完整 prompt 不写入本项目事件。

新增测试：packages/context/src/recovery.test.ts、packages/runtime/src/index.test.ts 的 reactive retry/guard 场景、packages/storage/src/index.test.ts 的 recovery projection 场景。

### CC-011

来源仓库：`D:/Develop/claude-code`

来源路径：`src/services/sessionTranscript/sessionTranscript.ts`、`src/utils/sessionRestore.ts:99-145,404-559`、`src/utils/messages.ts:5043-5090`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；`sessionTranscript.ts` 当前为 auto-generated stub，本次没有复制 Claude Code 代码，只重新实现 transcript/boundary/resume 的职责分离。

本项目路径：`packages/context/src/transcript-replay.ts`、`packages/runtime/src/index.ts:conversationMessages()`、`packages/storage/src/index.ts`、`packages/contracts/src/index.ts`。

范围：完整 transcript 永久保留、compact boundary 的 durable head/anchor/tail、algorithm version、boundary replay、stale anchor fallback、SQLite/EventStore restore projection 和 `context/session_restored` receipt；Runtime message identity 使用 append 返回的 eventId，保证跨重启定位。

明确未复用：Claude Code JSONL loader、文件轮转、context-collapse persistence、Session Memory extraction、Project Memory、hooks、商业遥测和账户/CLI 状态；本项目使用 EventStore、SQLite projection、Session/Tool/Permission contract 重新实现。

新增测试：`packages/context/src/transcript-replay.test.ts`、`packages/runtime/src/index.test.ts` 的 Host restart/boundary replay 场景、`packages/storage/src/index.test.ts` 的 SQLite reopen/restore projection 场景。

### CC-012

来源仓库：`D:/Develop/claude-code`

来源路径：`src/services/SessionMemory/sessionMemoryUtils.ts:16-210`、`src/services/SessionMemory/sessionMemory.ts:135-181,273-357`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本次没有复制 Claude Code 代码，只重新实现 extraction gate、状态迁移、后台串行调度、受限 fork adapter 和 exact-path memory guard。

本项目路径：`packages/context/src/session-memory.ts`、`packages/context/src/session-memory-compact.ts`、`packages/runtime/src/index.ts`、`packages/storage/src/index.ts`、`packages/contracts/src/index.ts`。

范围：10,000 初始 token、5,000 增长 token、3 次 tool call 默认门槛；自然 assistant break；per-session extraction scheduler；AbortSignal；host-owned `SessionMemoryStore.save()`；restricted capabilities；running extraction restart/idempotent completion；M11 extraction events/projection。

明确未复用：Claude Code 文件路径实现、全局进程状态、`runForkedAgent()` 内部 prompt/cache/provider 代码、SessionStart/PreCompact hooks、账户/遥测、Project Memory 和主 Agent 工具权限。

新增测试：`packages/context/src/session-memory.test.ts`、`packages/runtime/src/index.test.ts`、`packages/storage/src/index.test.ts` 的 gate、隔离、串行、保存、失败隔离、正文不入事件和 projection replay 场景。

### CC-013

来源仓库：`D:/Develop/claude-code`

来源路径：`src/memdir/memdir.ts:34-315,419-470`、`src/memdir/findRelevantMemories.ts`、`src/memdir/memoryTypes.ts`、`src/memdir/memoryScan.ts`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本次没有复制 Claude Code 代码，只重新实现 bounded `MEMORY.md` index、四类 taxonomy、topic relevance、stale validation 和 host-owned scope adapter。

本项目路径：`packages/context/src/project-memory.ts`、`packages/runtime/src/index.ts`、`packages/storage/src/index.ts`、`packages/contracts/src/index.ts`。

范围：200 行/25,000 UTF-8 bytes 入口上限、自然换行 warning、user/feedback/project/reference 类型、最多五个 topic recall、already-surfaced 去重、path/symbol/flag 验证、workspace/tenant scope、Project Memory metadata events/projection。

明确未复用：Claude Code 的账户/遥测、memory writer agent、JSONL/文件布局、feature flags、商业 provider、完整 prompt 文本和未经确认许可的实现代码；topic 正文不进入本项目 EventStore。

新增测试：`packages/context/src/project-memory.test.ts`、`packages/runtime/src/index.test.ts`、`packages/storage/src/index.test.ts` 的 bounded index、相关性、stale、忽略、scope 和 SQLite replay 场景。

### CC-014

来源仓库：`D:/Develop/claude-code`

来源路径：`src/components/TokenWarning.tsx`、`src/utils/analyzeContext.ts`、`src/query.ts` 的 compact progress/log events

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本次没有复制 Claude Code 代码，只重新实现 durable token diagnostics、compact receipt、recovery chain 和 Web presenter projection。

本项目路径：`packages/contracts/src/index.ts`、`packages/runtime/src/index.ts`、`packages/storage/src/index.ts`、`apps/web/src/presentation/context-presenter.ts`、`apps/web/src/client/store.ts`。

范围：token source/confidence、warning/error/auto-compact/blocking 状态、percent left、compact 前后 token、tokens saved、recovery metadata、SSE replay 和旧 projection fallback。

明确未复用：Claude Code 的 React 组件实现、账户/遥测、provider-specific UI、完整 context inspector、context collapse、prompt-cache edit 和商业服务。

新增测试：`apps/web/src/presentation/context-presenter.test.ts`、`apps/web/src/client/store.test.ts`、`packages/runtime/src/index.test.ts`、`packages/storage/src/index.test.ts` 的 diagnostics、replay、SQLite reopen 和 bounded chain 场景。

### CC-015

来源仓库：`D:/Develop/claude-code`

来源路径：`src/services/contextCollapse/index.ts`、`src/services/contextCollapse/operations.ts`、`src/services/contextCollapse/persist.ts`、`docs/features/context-collapse.md`、`src/query.ts` 的 collapse 集成点

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；contextCollapse 核心为 stub，本次没有复制源码或算法，只记录接口、职责和 query 集成顺序。

本项目路径：`packages/contracts/src/index.ts`、`packages/runtime/src/index.ts`、`apps/web/src/client/api.ts`、`apps/web/src/presentation/settings-presenter.ts`。

范围：host-backed `ContextCollapseCapability`、deferred/unavailable 状态、read-time projection/background collapse/overflow drain/snip 的 feature metadata 和 Web Settings 展示。

明确未复用：Claude Code 的 collapse 算法、commit log、persist 实现、snip、后台折叠、账户/遥测、provider cache edit 或商业服务；M14 不追加虚假 collapse 事件。

新增测试：`packages/runtime/src/index.test.ts` 和 `apps/web/src/presentation/settings-presenter.test.ts` 的 deferred capability、feature 全 false 与缺失 metadata fallback。

### CC-016

来源仓库：`D:/Develop/claude-code`

来源路径：`src/utils/toolResultStorage.ts`、`src/constants/toolLimits.ts`、`src/query.ts` 的 content replacement state

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本次没有复制 Claude Code 实现，只重新实现单工具结果阈值、exclusive create、preview 和 durable receipt。

本项目路径：`packages/context/src/tool-result-storage.ts`、`packages/runtime/src/index.ts`、`packages/contracts/src/index.ts`、`packages/storage/src/index.ts`、`apps/api/src/artifacts.ts`。

范围：`50000` 字符、`100000` token hard cap、`2000` UTF-8 bytes preview、`.txt/.json` artifact、失败 fail-closed、重启 replacement replay；本项目使用 workspace-relative path、EventStore 和 WorkspaceResolver，未暴露宿主绝对路径。

新增测试：`packages/context/src/tool-result-storage.test.ts`、`packages/runtime/src/index.test.ts`、`apps/api/src/artifacts.test.ts` 的阈值、JSON/media、EEXIST、恢复和 workspace 越界场景。

### DSH-013

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/core/agent-loop/src/constants.ts`、`packages/core/agent-loop/src/index.ts`、`packages/core/agent-loop/src/tool-calls.ts`、`packages/core/agent-loop/tests/tool-calls.spec.ts`

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本项目没有复制 DSH scheduler、Cordis 类型或 AgentLoop 实现。

本项目路径：`packages/runtime/src/tool-call-scheduler.ts`、`packages/runtime/src/index.ts`、`packages/runtime/src/tool-call-scheduler.test.ts`、`packages/runtime/src/index.test.ts`。

范围：默认最多 `10` 个 parallel in-flight、rolling pool、exclusive barrier、未启动调用的 live execution mode 重分类、模型顺序 commit、abort 停止补充并 drain 已启动调用。

改写部分：调度结果通过本项目 `ToolRuntime` 和 EventStore 提交；权限、workspace、tenant、interaction、取消和审计继续由本项目 contract 负责；Host 硬上限固定为 `512`，没有引入 DSH 的其他 runtime 边界。

新增测试：scheduler rolling cap、exclusive barrier、动态重分类、模型顺序、abort drain/skip，以及 Runtime/API 集成和 capability projection。

### CC-017

来源仓库：`D:/Develop/claude-code`

来源路径：`src/utils/toolResultStorage.ts`、`src/query.ts`、`src/services/compact/microCompact.ts`、`src/services/compact/timeBasedMCConfig.ts`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本项目没有复制 Claude Code 实现代码，仅重新实现工具结果 artifact、单消息 aggregate、count/token/time microcompact 和稳定 replacement state。

本项目路径：`packages/context/src/tool-result-storage.ts`、`packages/context/src/tool-result-budget.ts`、`packages/runtime/src/index.ts`、`packages/tools/src/runtime.ts`、`packages/context/src/tool-result-*.test.ts`。

范围：`50000` 字符/`100000` token 单结果阈值、`2000` UTF-8 bytes 预览、`200000` 字符单消息聚合预算、最大 fresh 结果优先 replacement、时间型 `60` 分钟 gap、最近 `5` 个保留和重启后的 model-view 重建。

改写部分：artifact 使用 workspace-relative 路径和 WorkspaceResolver；完整结果继续保留在 EventStore；凭据脱敏、tenant/session 边界、permission 和事件 projection 使用本项目实现；provider-specific cached microcompact 仍 deferred。

新增测试：`packages/context/src/tool-result-storage.test.ts`、`tool-result-budget.test.ts`、`packages/runtime/src/index.test.ts` 和 `apps/api/src/artifacts.test.ts` 的阈值、聚合、时间触发、replacement、恢复和安全场景。

### CC-019

来源仓库：`D:/Develop/claude-code`

来源路径：`src/memdir/paths.ts`、`src/memdir/memoryScan.ts`、`src/memdir/findRelevantMemories.ts`、`src/memdir/memoryTypes.ts`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；没有复制 Claude Code 源码，仅重新实现 Project Memory 目录、bounded scan、topic taxonomy 和 stale 引用行为。

本项目路径：`packages/context/src/project-memory-fs.ts`、`packages/context/src/project-memory.ts`、`packages/runtime/src/index.ts`、`apps/api/src/server.ts`。

范围：scopeKey 目录隔离、`MEMORY.md`/`topics/*.md`、200 行/25KB 入口 bound、frontmatter taxonomy、safe links、writer policy、atomic write 和 fail-closed scan。

### DSH-015

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/skill/skill-filesystem/src/index.ts` 及 cwd/git-root/provider 解析相关测试。

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本项目未复制 DSH provider 或 loader 类型。

本项目路径：`packages/context/src/project-memory-fs.ts`、`apps/api/src/server.ts`。

范围：host-owned root、workspace/tenant scope 边界、只读扫描失败保留 last-good、显式 writer policy；不引入 DSH Skill registry 或 Cordis runtime。

### CC-020

来源仓库：`D:/Develop/claude-code`

来源路径：`src/memdir/findRelevantMemories.ts`、`src/memdir/memoryScan.ts`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本项目没有复制 Claude Code 代码，只重新实现安全 manifest 交集、词法排序、last-good/incomplete 观察和 bounded recall。

本项目路径：`packages/context/src/project-memory.ts`、`packages/context/src/project-memory-fs.ts`、`packages/runtime/src/index.ts`、`packages/contracts/src/index.ts`、`packages/storage/src/index.ts`。

范围：MEMORY.md 安全链接约束、最多五个 topic、alreadySurfaced 去重、读取/验证失败 fail-closed、有限扫描状态和正文不进入 EventStore/SSE/projection。

### DSH-016

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/host/apiproxy/src/api/sessions.ts`、`packages/host/apiproxy/src/api/events.ts`、`packages/skill/skill/src/index.ts` 的 digest/replay 观察形状

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本项目没有复制 DSH 类型或 Web 组件。

本项目路径：`packages/contracts/src/index.ts`、`packages/storage/src/index.ts`、`apps/api/src/server.ts`、`apps/web/src/client/store.ts`、`apps/web/src/presentation/memory-presenter.ts`。

范围：只读 Memory inspector、bounded projection、SSE/replay 一致性和 unavailable/incomplete 状态展示；API 不读取或返回 Memory 正文。

### CC-021

来源仓库：`D:/Develop/claude-code`

来源路径：`packages/builtin-tools/src/tools/SkillTool/SkillTool.ts` 的 `checkPermissions()`、`src/skills/loadSkillsDir.ts` 的来源优先级与 name shadow 行为

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本项目未复制 Claude Code 代码。

本项目路径：`packages/skills/src/index.ts`、`packages/tools/src/capabilities.ts`、`packages/contracts/src/index.ts`。

范围：正向 allowlist、unknown property ask、source trust 降权、provider/rank/scope 合并和 cwd/signal 传递；model-facing SkillTool 留待 S2。

### DSH-017

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/skill/skill/src/index.ts` 的 `SkillSummary`/`SkillCandidate`/`SkillDefinition`/`SkillProvider`/`SkillRegistry`、scope chain 和 `skills/change` 观察

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本项目重新实现类型和 registry，未复制 DSH 代码或 Cordis 依赖。

本项目路径：`packages/skills/src/index.ts`、`packages/contracts/src/index.ts`、`packages/runtime/src/index.ts`、`apps/api/src/server.ts`。

范围：分层 registry、最近 scope shadow、同层稳定 rank 排序、provider incomplete/failure bounded metadata、AbortSignal 和可回放 `skills/change` 生命周期；不引入 DSH 插件平台。

### CC-022

来源仓库：`D:/Develop/claude-code`

来源路径：`src/skills/loadSkillsDir.ts`、`src/skills/skillChangeDetector.ts`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本项目未复制 Claude Code loader 或 watcher 实现。

本项目路径：`packages/skills-filesystem/src/index.ts`、`apps/api/src/server.ts`。

范围：`<name>/SKILL.md` 发现、project/user/custom/bundled roots、延迟正文读取、realpath 去重、来源 rank、手动 refresh；动态 watcher 默认关闭。

### DSH-018

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/skill/skill-filesystem/src/index.ts` 及 provider watcher/incomplete 测试

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本项目重新实现 filesystem provider，未复制 DSH 代码。

本项目路径：`packages/skills-filesystem/src/index.ts`、`packages/skills/src/index.ts`、`apps/api/src/server.ts`。

范围：cwd/project root 解析、rank/provider composition、bounded depth/size/count、symlink/gitignore fail-closed、last-good incomplete observation 和可选 watcher 生命周期。

### CC-023

来源仓库：`D:/Develop/claude-code`

来源路径：`packages/builtin-tools/src/tools/SkillTool/SkillTool.ts`、`packages/builtin-tools/src/tools/SkillTool/prompt.ts`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本项目仅重新实现 SkillTool 校验、摘要预算和按需渲染。

本项目路径：`packages/context/src/skill-catalog.ts`、`packages/tools/src/skill.ts`、`packages/runtime/src/index.ts`。

范围：catalog digest/预算、摘要→正文二次校验、inline/fork 标记和用户调用审批；不复制上游账户、CLI 或 provider。

### DSH-019

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`packages/skill/tool-skill/src/index.ts` 的 durable catalog/source、pre-step user gesture、renderSkillContent

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本项目未复制 DSH 实现。

本项目路径：`packages/context/src/skill-catalog.ts`、`packages/tools/src/skill.ts`、`apps/api/src/server.ts`。

范围：用户 `/name` ingress、canonical renderer、交互审批与正文脱敏事件。

### CC-024

来源仓库：`D:/Develop/claude-code`

来源路径：`src/skills/discoverSkillDirsForPaths.ts`、`src/skills/activateConditionalSkillsForPaths.ts`、`src/hooks/useSkillsChange.ts`

复用方式：`behavior-reference`

许可证/来源证据：本地快照未发现根 `LICENSE`；本项目未复制上游代码。

本项目路径：`packages/skills-filesystem/src/index.ts`、`packages/skills/src/index.ts`、`packages/runtime/src/index.ts`。

范围：paths 条件激活、文件变更后的 registry invalidation、手动/turn-boundary refresh。

### DSH-020

来源仓库：`D:/Develop/deepseek-harness-fork`

来源路径：`skills/change` 事件、`skill.list` RPC、Web `SkillRow.tsx`

复用方式：`behavior-reference`

许可证/来源证据：`D:/Develop/deepseek-harness-fork/LICENSE` 为 MIT；本项目未复制 DSH 代码。

本项目路径：`apps/api/src/server.ts`、`apps/web/src/client/api.ts`、`apps/web/src/presentation/skill-presenter.ts`、`apps/web/src/presentation/tool-presenter.ts`。

范围：bounded skills/change、只读 `/v1/skills` catalog/suggestions 和 dedicated Skill row presenter。
