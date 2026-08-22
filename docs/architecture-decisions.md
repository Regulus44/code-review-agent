# Architecture Decisions

本文记录 Coding Agent 重建期间不可随意改变的架构决策。新的设计以 DSH 的 TypeScript 分层和 Web 信息架构为主参考，以 Claude Code 的 Agent 行为、工具体验、权限和上下文策略为行为参考。

## ADR-001：后端重建为 TypeScript/Node.js

状态：accepted

目标后端使用 TypeScript/Node.js。旧 Python 原型不进入新 Runtime 的 import graph，也不作为新 API、Session、Tool 或 Event 类型的来源。

TypeScript 版本已经通过 Read-only、Edit、Test 三个垂直场景，旧 Python 源码、测试和启动入口已从工作树移除。历史行为和迁移决策通过 Git 提交与开发日志保留，当前运行时只保留一套 TypeScript 实现。

## ADR-002：DSH 负责主骨架，Claude Code 负责行为层

状态：accepted

选择 DSH 作为主骨架，因为它的本地快照已经提供了适合网页 Coding Agent 的 TypeScript 包分层、Session API、事件 API、MCP client、Subagent 和 Web 前端组织方式。

选择 Claude Code 作为行为参考，因为它在单次 turn 内的流式工具调度、工具权限、文件编辑体验、上下文压缩和任务协调方面更接近成熟 Coding Agent 的用户行为。

冲突时使用以下顺序裁决：

1. 本项目的事件、工具、任务和 workspace 安全不变量；
2. DSH 的包边界、Session/Event API 和 Web 信息架构；
3. Claude Code 的工具行为、权限交互和上下文处理；
4. 当前实现的便利性。

## ADR-003：允许按许可边界选择性借鉴上游代码

状态：accepted

本项目不复制整个上游仓库，但允许在许可证和来源清晰的前提下选择性复用代码或代码片段：

- DSH 根仓库明确为 MIT，可以作为代码和结构的主要来源；复制其代码时保留版权和许可证声明，并记录来源文件；
- Claude Code 本地快照没有发现根 `LICENSE` 文件，因此默认只把它当作源码级参考；只有确认某个具体包或文件有兼容许可证、或取得明确授权后，才复制实现代码；
- 在未确认许可前，可以自由复刻目录边界、类型设计、状态机、算法思路和行为测试，但不整段搬运实现；
- 新文件必须保留本项目的版权、测试和安全策略，不把第三方内部类型直接暴露为公共 API。

## ADR-004：不复制整个上游仓库

状态：accepted

本项目建立自己的 TypeScript workspace，只选择性重建下列最小闭包：

```text
packages/contracts
packages/llm
packages/storage
packages/workspace
packages/tools
packages/runtime
packages/protocols
apps/api
apps/web
```

不复制 DSH 的全部 Cordis、插件、桌面端、工作流和发布系统；不复制 Claude Code 的 CLI、账户、遥测、商业服务或与本项目无关的逆向工程实现。每次引入上游设计都必须能映射到一个本项目验收场景。

## ADR-005：Web 先于复杂协议，但后端事件先于 UI 定制

状态：accepted

`apps/web` 在 Phase 1 就建立 DSH 风格的 Shell，使 Session sidebar、Conversation、Tool row、Diff、Permission 和 Terminal 等区域尽早验证。但 UI 只能消费本项目的事件和 API 类型，不能直接依赖 DSH 内部类型。

在事件重放、断线重连和权限请求稳定之前，不做大规模视觉或交互创新。品牌、图标、颜色、文案和 API client 可以替换；信息架构不重新发明。

## ADR-006：协议按 MCP → 内部 Subagent → A2A 的顺序引入

状态：accepted

- MCP 是外部工具、资源和 Prompt 接入协议，先实现 MCP Client；
- 内部 Subagent 是本项目自己的任务委派模型，先稳定父子 Session、权限和报告契约；
- A2A 只作为外部 Agent 互操作适配层，必须映射到内部 Task/Session，不能直接调用 ToolRegistry。

这样可以避免在内部任务模型尚未稳定时，用 A2A 的外部协议反过来决定核心 Runtime。

## ADR-007：事件日志是唯一事实来源

状态：accepted

所有 model-visible 状态变化、工具调用、权限请求、子任务生命周期和用户消息都先追加到 EventStore，再投影给 Web、查询 API 或外部协议。SSE 断线后按 sequence 重放，不能只依赖内存状态或“turn 完成后保存整段消息”。

## ADR-008：安全策略属于本项目

状态：accepted

DSH 和 Claude Code 的工具体验可以参考，但 workspace resolver、路径穿越防护、命令执行 policy、输出截断、权限审批和审计字段由本项目维护。任何 MCP、Subagent 或 A2A 调用都必须经过同一套权限和 workspace 检查。

## ADR-009：System prompt 使用静态 section 与动态 turn context

状态：accepted

Coding Agent 的 system prompt 采用可测试的 section builder，而不是长期维护一段无法审计的字符串。静态部分约束身份、任务执行、工具优先、读后编辑、权限、安全、验证、沟通和恢复行为；动态部分只注入当前 Session 的 workspace、经过 policy 过滤的可见工具、可选 permission preset、恢复状态和应用级补充指令。

选择这一结构是因为 Claude Code 的 prompt section pipeline 能清晰区分长期行为与 session/environment context，DSH 的生命周期和工具管线则要求 tool/permission/event 的事实来自运行时，而不是 prompt 自己声明。工具 schema 继续通过 `ModelRequest.tools` 传递，外部 MCP 描述不直接作为可信指令拼进系统规则。

以下规则不可由应用级自定义 prompt 覆盖：workspace 边界、权限审批、工具结果信任边界、秘密保护和完成前验证。尚未进入真实 ToolRegistry 的 Subagent、A2A、LSP、Worktree、Web Search、Skills、上下文压缩和图像/Notebook 不得在 prompt 中宣称可用。

## ADR-010：MCP 配置与凭据引用持久化，但秘密不进入事件事实源

状态：accepted

MCP server 配置由 SQLite 的 `mcp_server_configs` 表持久化，记录 scope、owner/workspace/session binding、enabled、revision、非敏感 transport config 和 opaque `credentialRef`。credential material 只能由 host-owned resolver 在 transport 创建时短暂注入；token、Authorization、cookie、private key 和 credential-shaped env/header 不得进入普通 config JSON、EventStore、projection、SSE、Web 或 model view。

## ADR-011：MCP discovery 使用可验证的 generation swap 与不可信内容边界

状态：accepted

每个 MCP server 独立维护 generation、client、transport、discovery catalog 和工具 ownership。list-changed 只能排队触发串行 discovery；候选 generation 必须在 schema 预算、policy、allowlist 和 registry conflict 校验完成后原子替换旧工具。旧 generation 的回调被 generation guard 丢弃。

外部 tool/resource/prompt description 和结果都是不可信数据。ToolRuntime 仍是 MCP tool 的唯一执行入口；resource/prompt 只能产生有界 model view 和低优先级追加上下文，不能覆盖本地 system prompt、workspace、permission、security 或 verification 规则。

## 参考代码入口

- DSH Agent Loop：`D:/Develop/deepseek-harness-fork/packages/core/agent-loop/src/agent.ts`
- DSH 工具调度：`D:/Develop/deepseek-harness-fork/packages/core/agent-loop/src/tool-calls.ts`
- DSH Session API：`D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/sessions.ts`
- DSH Event API：`D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/events.ts`
- DSH Web：`D:/Develop/deepseek-harness-fork/packages/client`、`D:/Develop/deepseek-harness-fork/apps/web`
- Claude Code Agent Loop：`D:/Develop/claude-code/src/query.ts`
- Claude Code Streaming Tool Executor：`D:/Develop/claude-code/src/services/tools/StreamingToolExecutor.ts`
- Claude Code 工具总表：`D:/Develop/claude-code/src/tools.ts`
- Claude Code 上下文压缩：`D:/Develop/claude-code/src/services/contextCollapse`
