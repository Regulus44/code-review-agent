# Code Review Agent：长期开发规则

本文件是本仓库所有开发任务的根级约束。它的目的不是描述某个实现细节，而是让长期、多阶段、多次交接的开发始终围绕同一个目标推进。

## 1. 项目目标

把本项目从“面向代码审查的 Python 单 Agent 原型”重建为“网页上的 TypeScript Coding Agent”，最终具备：

- DSH 风格的 Web 工作台；
- 流式 Agent Loop、Session、Turn、Event Store 和可恢复执行；
- 文件、Git、终端等受权限控制的 Coding Agent 工具；
- MCP 外部工具接入；
- 内部 Subagent / 多 Agent 任务委派；
- 后续 A2A 外部 Agent 互操作；
- 上下文压缩、Worktree、LSP 和产品化能力。

长期开发不能把目标缩回“把现有代码修得能用”，也不能变成“复制 DSH/Claude Code 的所有功能”。每个改动必须说明它如何推进上述目标中的某一项。

## 1.1 本文件的治理级别

根目录 `AGENTS.md` 是本项目的治理文件，不是普通说明文档。它定义长期目标、架构裁决顺序、安全不变量、阶段门禁和任务规则。

- 普通开发任务不得顺手修改本文件；
- 只有以下两种情况允许修改：用户明确要求修改治理规则，或已接受的架构/阶段决策确实使本文件过时；
- 修改前必须说明变更原因、影响范围、迁移要求和回滚方式；
- 修改必须使用独立提交，提交信息以 `docs(governance):` 开头；
- 同一变更必须同步相关 ADR、阶段计划、契约文档和测试门禁；
- 如果任务过程中发现本文件可能需要修改，先暂停该部分工作并请求用户确认，不得自行“顺便更新”；
- 子目录 `AGENTS.md` 不能覆盖本文件；若发生冲突，以根目录 `AGENTS.md` 和已接受 ADR 为准。

撰写开发日志、README、ADR、阶段计划和其他项目文档时，优先使用直接、正向和清晰的陈述；尽量避免使用“不是……而是……”等对比式句型，只有在必须澄清边界或纠正误解时才使用。

单靠文件内容无法阻止拥有仓库写权限的人修改它。需要强制审查时，应在 GitHub branch protection 中要求 `AGENTS.md` 的 code owner review；本地 Git hook 或 `assume-unchanged` 不能作为可靠的治理手段。

## 2. 项目状态与阶段状态来源

本文件只保存长期有效的目标、边界和治理规则，不作为阶段进度看板。当前阶段、完成证据、下一阶段入口和暂缓事项统一以 `docs/phase-status.zh-CN.md` 及对应的阶段计划为准；阶段切换时应更新这些文档，而不是例行修改本文件。

- `src/code_review_agent` 是旧 Python 原型，只作为行为、数据和测试参考；
- 新 TypeScript Runtime 已建立并通过 Phase 1 验收；不能把 Python 模块作为新 Runtime 的 import dependency；
- 详细总计划位于 `docs/coding-agent-migration-plan.zh-CN.md`；
- 阶段索引位于 `docs/phase-plans/README.zh-CN.md`；
- Phase 0 执行清单位于 `docs/phase-0-checklist.zh-CN.md`，当前阶段状态和验收证据位于 `docs/phase-status.zh-CN.md`；
- 架构、协议、事件、工具和上游复用规则位于 `docs/architecture-decisions.md`、`docs/protocol-boundaries.md`、`docs/event-contract.md`、`docs/tool-contract.md` 和 `docs/source-reuse-register.md`。

完成 Phase 2 前，不要把 MCP、A2A、Subagent、LSP、Worktree 或复杂工作流作为核心实现提前引入；Phase 3 工具和权限也必须等待 Phase 2 的恢复契约稳定。

## 3. 架构裁决顺序

发生设计冲突时，按以下顺序裁决：

1. 本文件和 `docs/` 中已接受的架构决策；
2. 本项目的事件、工具、任务、权限和 workspace 安全不变量；
3. DSH 的 TypeScript 包分层、Session/Event API 和 Web 信息架构；
4. Claude Code 的 Agent 行为、工具体验、权限、上下文和任务协调模式；
5. 当前实现的便利性或个人偏好。

如果新需求不能映射到当前 Phase，先增加或更新 ADR，再编码。不要因为一个局部需求直接改变整个 Runtime 的边界。

## 4. 不可改变的核心原则

### 4.1 TypeScript 是目标后端

- 新后端使用 TypeScript/Node.js；不以旧 Python Runtime 为底座。
- 旧 Python 代码不进入新 Runtime 的依赖图，不共享 Python ORM、FastAPI 类型或业务对象。
- 旧 Python 实现只允许作为行为样本、迁移输入、回归 fixture 和缺陷参考。
- Python 目录是否归档或删除，必须等 TypeScript 版本通过 Read-only、Edit、Test 垂直场景后单独决策。

### 4.2 DSH 是主骨架，Claude Code 是行为参考

- DSH 优先参考 Agent Loop、Tool Scheduler、Session/Event API、MCP、Subagent 和 Web Shell。
- Claude Code 优先参考流式 turn、工具并发、权限审批、文件编辑 UX、上下文压缩、Task/Team 协作和远程 Session。
- 不复制 DSH 的全部 Cordis、插件、桌面端、CLI 或发布系统。
- 不复制 Claude Code 的账户、遥测、商业服务或与本项目无关的 CLI 体系。

### 4.3 上游代码复用必须可追溯

- DSH 根仓库为 MIT；直接复制或改编其代码时保留许可证和版权声明。
- Claude Code 当前本地快照没有发现根许可证；具体文件或 package 没有明确兼容许可证时，只参考其结构和行为并自行实现。
- 所有直接复制或大量改编登记到 `docs/source-reuse-register.md`。
- 不把第三方内部类型直接暴露为本项目公共 API。

### 4.4 事件是唯一事实来源

- 任何 model-visible 状态、用户消息、工具调用、权限、Task 和 Subagent 状态都必须先追加事件，再投影给 API/Web。
- 事件必须支持单调 sequence、幂等、SSE replay 和断线恢复。
- 不能只更新内存或数据库状态而不记录事件，也不能只推送 UI 事件而不落盘。

### 4.5 工具必须经过统一管线

所有内置工具、MCP 工具和 Subagent 工具都经过：

```text
discover → schema validate → workspace/policy check → approval
        → execute → progress → structured result → presentation → event append
```

文件、workspace、diff、进程终止和权限审计是本地安全基元；Git 托管、数据库、浏览器、知识库和云服务等扩展能力优先通过 MCP。

### 4.6 协议不能互相越权

- MCP 负责外部工具、资源和 Prompt；
- ACP 负责程序化 Client 驱动 Agent；
- A2A 负责外部 Agent 互操作；
- A2A 必须映射到内部 Task/Session/Subagent，不能直接调用 ToolRegistry；
- 任何协议都不能绕过 permission、workspace、审计和取消机制。

## 5. 阶段推进规则

阶段顺序固定为：

```text
0 基线与契约
→ 1 AgentHost + Web Shell
→ 2 事件与恢复
→ 3 工具与权限
→ 4 MCP
→ 5 Subagent
→ 6 A2A
→ 7 Web 收敛
→ 8 高级能力与产品化
```

每个阶段必须有：

- 明确交付物；
- 参考源码入口；
- 单元/合同/e2e/恢复/安全测试；
- 进入条件和退出条件；
- 可回滚 Git checkpoint；
- 明确的“不包含”列表。

每一次开发阶段更新完成后都必须立即创建独立的 Git commit 作为 checkpoint；这里的“开发阶段更新”包括代码、公共契约、测试、阶段计划、状态看板和开发日志的成组变更。提交前必须运行与改动范围匹配的检查，并在提交信息或提交说明中标明 Phase、变更范围和验证结果。未提交的阶段性更新不能被标记为完成，也不能作为进入下一阶段的依据；不同 Phase 的变更不得无说明地混入同一个提交。

前一阶段退出条件未满足时，可以做下一阶段的调研和文档，但不能合并下一阶段的核心运行时实现。

## 6. 每个任务开始前必须回答

在 issue、计划或 PR 描述中写清楚：

1. 它属于哪个 Phase？
2. 它解决 Runtime、工具、协议、存储、安全还是 UI 问题？
3. 它是否改变 Event、Tool、Task、Permission 或 Workspace contract？
4. 它参考 DSH 或 Claude Code 的哪个具体入口？
5. 它是否需要登记上游代码来源或许可证？
6. 它的验收场景是什么？
7. 它如何回滚或禁用？

如果这七个问题无法回答，不要直接开始大范围编码。

## 7. 质量和安全门禁

每个阶段至少覆盖：

- 单元测试：schema、状态机、路径、权限、事件序列；
- 合同测试：LLM stream、SSE、MCP、ACP 或 A2A adapter；
- 恢复测试：断线、重启、重复请求、重复批准、取消；
- 安全测试：路径穿越、命令注入、权限绕过、输出泄露、租户隔离；
- e2e：浏览器完成真实 Coding Agent 场景；
- 回放测试：从事件日志重建 Session 和 Web 状态。

提交前按改动范围运行相关检查。当前旧项目可用的检查包括：

```powershell
# Python 原型回归（仅用于旧实现参考）
pytest

# 新 TypeScript workspace 建立后，以其 package.json 中的命令为准
pnpm typecheck
pnpm test
```

不要因为旧 Python 测试通过，就声称 TypeScript Runtime 已完成；也不要因为 TypeScript 编译通过，就跳过 workspace 安全和事件恢复测试。

## 8. Web 开发规则

- Web 信息架构尽量沿用 DSH：Session sidebar、Conversation、Tool row、Diff、Permission、Terminal、Plan、Subagent、Settings。
- 可以改名称、图标、logo、颜色、文案和 API client；不要复制 DSH 品牌标识或产品文案。
- Web 只消费本项目 `packages/contracts` 和 API projection，不直接依赖 DSH 内部类型。
- Web 不得成为事实来源；刷新、重连和回放后必须得到同样状态。
- 没有后端事件支持的 UI 能力只能作为明确标记的占位，不得伪造成功状态。

## 9. 目录级 AGENTS.md 策略

当前阶段只保留根目录这一份 `AGENTS.md`，避免在尚未建立 TypeScript workspace 前复制重复规则。

当以下目录真正建立并出现独立约束时，再添加局部 AGENTS.md：

| 目录 | 添加条件 | 局部规则范围 |
|---|---|---|
| `docs/` | 文档开始有生成文件、双语同步或独立文档门禁 | 文档来源、链接、预算、更新规则 |
| `packages/` | TypeScript workspace 建立 | 包边界、依赖方向、公共 API、测试 |
| `packages/contracts/` | 公共类型开始被多个包消费 | 向后兼容、事件/工具/Task contract |
| `apps/api/` | API host 开始实现 | HTTP/SSE、认证、错误和业务分层 |
| `apps/web/` | Web Shell 开始实现 | DSH 组件移植、事件 reducer、视觉和 e2e |

子目录 AGENTS.md 只能补充根规则，不能降低根目录的安全、事件、许可证和阶段门禁。出现冲突时，以根目录和 `docs/architecture-decisions.md` 为准。

## 10. 禁止的目标漂移信号

看到以下情况时暂停实现并记录决策：

- 为了“像 DSH”引入完整插件平台，但没有本项目验收场景；
- 为了“像 Claude Code”复制 CLI、账户、遥测或商业 provider；
- 继续把旧 Python Runtime 修补成新后端底座；
- MCP 工具绕过统一权限、workspace 或事件；
- A2A 直接进入 ToolRegistry；
- 子 Agent 共享父 Agent 全部上下文或权限；
- UI 先于事件契约发明一套状态模型；
- 没有回归测试就放宽 shell、路径或输出安全策略；
- 一个 PR 同时跨越多个未完成 Phase，且没有 ADR 解释依赖关系。

## 11. 完成标准

一个阶段只有在以下条件全部满足时才能标记完成：

- 该阶段文档中的交付物已实现或明确关闭；
- 退出条件有实际命令、测试、fixture 或运行结果证明；
- Event/Tool/Task/Permission/Workspace contract 的变更已同步文档；
- 上游复用和许可证信息已登记；
- 旧能力没有被无记录地破坏；
- 有可回滚 checkpoint；
- 下一阶段的进入条件已经满足。
