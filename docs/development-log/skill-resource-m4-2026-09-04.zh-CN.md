# Skill 资源渐进式加载 M4 开发日志

日期：2026-09-04  
范围：Model step、EventStore、host-owned artifact、compact/replay

## 目标

让 `read_skill_resource` 的正文在当前 tool call 完成后进入下一模型步骤，同时保证 durable event、SSE、projection 和重启回放不泄露正文。资源正文需要在启用开关时由 host-owned immutable artifact 提供确定性恢复；artifact 缺失时必须显式 fail closed。

## 实现切片

1. Context 增加 `SkillResourceArtifactStore`、`SkillResourceArtifactReceipt`、稳定 artifact id 和 available/unavailable model-view helper；新增内存实现用于本地 host 与恢复测试。`read_skill_resource` 纳入 compactable 工具集合。
2. ToolRuntime 在 deferred result commit 阶段识别 Skill resource，按 `skillResourceArtifactReplay` 写入 artifact，并将 `tool/result` 的 output、audit、modelView、presentation 收敛为 metadata + receipt。相同 `toolCallId` 的重复 commit 只保留一条结果事件。
3. AgentHost 增加 artifact store/replay 配置。`conversationMessages()` 按 receipt 读取 host snapshot 并重建原始 `<skill_resource>`；读取失败返回 `status="unavailable"`，不回退当前 workspace 文件。
4. Runtime/ToolRuntime contract tests 覆盖正文脱敏、digest/receipt、重复 deferred commit、artifact 存在/缺失以及 restart/replay。

## 契约与安全边界

- 资源正文只存在于内存中的即时 `ToolResult` 或 host-owned artifact，不进入 EventStore、SSE 或 public projection。
- receipt 只包含 Skill 名称、相对路径、offset/limit、size、digest、truncated/provider 和 opaque artifact id。
- artifact store 必须自行实施 session/tenant ACL 与 immutable write；当前内存实现用于默认本地测试，生产持久化实现仍需宿主提供。
- `skillResourceArtifactReplay` 默认关闭。关闭时工具仍可实时读取资源，但系统不宣称 deterministic replay。

## 提交与验证

- `1fb8958 feat(context): add skill resource artifact receipts`
- `699e905 feat(tools): persist skill resource replay receipts`
- `1ff287d fix(tools): redact skill bodies from durable model view`
- `d5c0a77 feat(runtime): replay skill resources from host artifacts`

定向验证：Context 101 tests、Tools 108 tests、Runtime 81 tests（含 M4 新增用例）通过；`pnpm typecheck` 通过；`git diff --check` 通过。完整 workspace `pnpm test` 由主代理在合并所有并行切片后执行。

## 剩余风险

- `InMemorySkillResourceArtifactStore` 不跨进程持久化，生产环境需注入 host-owned durable store。
- artifact 事件目前复用 `tool/result`，artifact ACL/读取 API 仍由宿主适配器负责，未向公共 API 暴露正文读取端点。
- M5 watcher、资源版本变化事件和生产级 tenant ACL 尚未实现。
