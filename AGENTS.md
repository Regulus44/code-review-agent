# Coding Agent：长期开发规则

本文件是本仓库所有开发任务的根级约束。它保存长期有效的目标、架构边界、安全不变量和交付规则；当前能力、已知限制和近期优先级统一记录在 `docs/status.zh-CN.md`。

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

根目录 `AGENTS.md` 是本项目的治理文件，不是普通说明文档。它定义长期目标、架构裁决顺序、安全不变量和任务规则。

- 普通开发任务不得顺手修改本文件；
- 只有以下两种情况允许修改：用户明确要求修改治理规则，或已接受的架构决策确实使本文件过时；
- 修改前必须说明变更原因、影响范围、迁移要求和回滚方式；
- 修改必须使用独立提交，提交信息以 `docs(governance):` 开头；
- 同一变更必须同步相关 ADR、契约文档、当前状态页和测试门禁；
- 如果任务过程中发现本文件可能需要修改，先暂停该部分工作并请求用户确认，不得自行“顺便更新”；
- 子目录 `AGENTS.md` 不能覆盖本文件；若发生冲突，以根目录 `AGENTS.md` 和已接受 ADR 为准。

撰写开发日志、README、ADR、规划文档和其他项目文档时，优先使用直接、正向和清晰的陈述；尽量避免使用“不是……而是……”等对比式句型，只有在必须澄清边界或纠正误解时才使用。

单靠文件内容无法阻止拥有仓库写权限的人修改它。需要强制审查时，应在 GitHub branch protection 中要求 `AGENTS.md` 的 code owner review；本地 Git hook 或 `assume-unchanged` 不能作为可靠的治理手段。

## 2. 项目状态与文档来源

本文件不作为进度看板。当前能力、已知限制、风险和近期优先级以 `docs/status.zh-CN.md` 为准；文档分类和入口以 `docs/README.zh-CN.md` 为准；历史阶段计划和开发日志位于 `docs/archive/`，只用于追溯。

- 新后端使用 TypeScript/Node.js；不能把已退役的 Python Runtime 重新加入依赖图；
- 架构、协议、事件、工具和上游复用规则位于 `docs/architecture-decisions.md`、`docs/protocol-boundaries.md`、`docs/event-contract.md`、`docs/tool-contract.md` 和 `docs/source-reuse-register.md`；
- 新需求按产品价值、风险、契约影响和验收场景排序，不绑定历史编号；
- 发生架构、公共契约或安全边界变化时，先更新 ADR/契约，再编码。

## 3. 架构裁决顺序

发生设计冲突时，按以下顺序裁决：

1. 本文件和 `docs/` 中已接受的架构决策；
2. 本项目的事件、工具、任务、权限和 workspace 安全不变量；
3. DSH 的 TypeScript 包分层、Session/Event API 和 Web 信息架构；
4. Claude Code 的 Agent 行为、工具体验、权限、上下文和任务协调模式；
5. 当前实现的便利性或个人偏好。

如果新需求会改变 Runtime 边界、公共契约或安全不变量，先增加或更新 ADR，再编码。不要因为一个局部需求直接改变整个 Runtime 的边界。

## 4. 不可改变的核心原则

### 4.1 TypeScript 是目标后端

- 新后端使用 TypeScript/Node.js；不以旧 Python Runtime 为底座。
- 旧 Python Runtime 不进入新 Runtime 的依赖图，也不共享 Python ORM、FastAPI 类型或业务对象；其源码已经从工作树移除。
- 历史行为、迁移输入和缺陷记录通过 Git 提交、契约文档和归档文档保留。

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

## 5. 交付与变更规则

每个可交付切片都必须明确：

- 用户或系统价值；
- 影响的 Runtime、工具、协议、存储、安全、Web、评测或运维边界；
- 受影响的 Event、Tool、Task、Permission 或 Workspace contract；
- 单元、合同、恢复、安全和 e2e 验收场景；
- 禁用、回滚和迁移方式。

涉及公共契约、持久化 schema、权限边界或跨包架构的变更，必须先更新对应 ADR/契约文档。独立交付切片完成后创建可回滚的 Git checkpoint；提交说明写清变更范围和验证结果。

## 6. 每个任务开始前必须回答

在 issue、计划或 PR 描述中写清楚：

1. 它解决 Runtime、工具、协议、存储、安全、Web、评测还是运维问题？
2. 它的产品价值、风险和验收场景是什么？
3. 它是否改变 Event、Tool、Task、Permission 或 Workspace contract？
4. 它参考 DSH 或 Claude Code 的哪个具体入口（如适用）？
5. 它是否需要登记上游代码来源或许可证？
6. 它如何回滚、禁用或迁移？

如果这些问题无法回答，不要直接开始大范围编码。

## 7. 质量和安全门禁

每个涉及运行时、契约或安全边界的交付切片至少覆盖：

- 单元测试：schema、状态机、路径、权限、事件序列；
- 合同测试：LLM stream、SSE、MCP、ACP 或 A2A adapter；
- 恢复测试：断线、重启、重复请求、重复批准、取消；
- 安全测试：路径穿越、命令注入、权限绕过、输出泄露、租户隔离；
- e2e：浏览器完成真实 Coding Agent 场景；
- 回放测试：从事件日志重建 Session 和 Web 状态。

提交前按改动范围运行相关检查。当前 TypeScript workspace 可用的基础检查包括：

```powershell
# TypeScript workspace checks
pnpm typecheck
pnpm test
```

不要因为 TypeScript 编译通过，就跳过 workspace 安全和事件恢复测试。

## 8. Web 开发规则

- Web 信息架构尽量沿用 DSH：Session sidebar、Conversation、Tool row、Diff、Permission、Terminal、Plan、Subagent、Settings。
- 可以改名称、图标、logo、颜色、文案和 API client；不要复制 DSH 品牌标识或产品文案。
- Web 只消费本项目 `packages/contracts` 和 API projection，不直接依赖 DSH 内部类型。
- Web 不得成为事实来源；刷新、重连和回放后必须得到同样状态。
- 没有后端事件支持的 UI 能力只能作为明确标记的占位，不得伪造成功状态。

## 9. 目录级 AGENTS.md 策略

当前仓库只保留根目录这一份 `AGENTS.md`，避免重复规则漂移。

当以下目录真正建立并出现独立约束时，再添加局部 AGENTS.md：

| 目录 | 添加条件 | 局部规则范围 |
|---|---|---|
| `docs/` | 文档开始有生成文件、双语同步或独立文档门禁 | 文档来源、链接、预算、更新规则 |
| `packages/` | TypeScript workspace 建立 | 包边界、依赖方向、公共 API、测试 |
| `packages/contracts/` | 公共类型开始被多个包消费 | 向后兼容、事件/工具/Task contract |
| `apps/api/` | API host 开始实现 | HTTP/SSE、认证、错误和业务分层 |
| `apps/web/` | Web Shell 开始实现 | DSH 组件移植、事件 reducer、视觉和 e2e |

子目录 AGENTS.md 只能补充根规则，不能降低根目录的安全、事件、许可证和交付门禁。出现冲突时，以根目录和 `docs/architecture-decisions.md` 为准。

## 10. 禁止的目标漂移信号

看到以下情况时暂停实现并记录决策：

- 为了“像 DSH”引入完整插件平台，但没有本项目验收场景；
- 为了“像 Claude Code”复制 CLI、账户、遥测或商业 provider；
- 恢复已退役的旧 Runtime 作为后端底座；
- MCP 工具绕过统一权限、workspace 或事件；
- A2A 直接进入 ToolRegistry；
- 子 Agent 共享父 Agent 全部上下文或权限；
- UI 先于事件契约发明一套状态模型；
- 没有回归测试就放宽 shell、路径或输出安全策略；
- 一个变更同时改变多个公共边界，且没有 ADR 解释依赖关系。

## 11. 完成标准

一个交付切片只有在以下条件全部满足时才能标记完成：

- 目标和范围已经实现或明确关闭；
- 验收条件有实际命令、测试、fixture 或运行结果证明；
- Event/Tool/Task/Permission/Workspace contract 的变更已同步文档；
- 上游复用和许可证信息已登记；
- 旧能力没有被无记录地破坏；
- 有可回滚 checkpoint，必要时有迁移和禁用说明；
- `docs/status.zh-CN.md` 已反映当前能力、限制或风险。
