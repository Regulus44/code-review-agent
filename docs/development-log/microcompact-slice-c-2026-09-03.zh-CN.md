# Microcompact Slice C 开发日志

日期：2026-09-03
范围：Pressure-V2 语义 checkpoint 与事件事实源

## 需求来源与设计依据

本切片执行 `docs/evaluation/microcompact-improvement-plan-2026-09-03.zh-CN.md` 的
“Slice C：Checkpoint 与事件事实源”。当前 M05 ADR 只定义工具结果 replacement receipt，
不足以约束清理前的语义交接，因此先新增 ADR-037。设计参考 DSH
`packages/compaction/compaction-basic` 的 checkpoint 生命周期和 Claude Code
`src/services/compact/microCompact.ts`、`cachedMicrocompact.ts` 的稳定 model-view replacement；
仅复现行为，不复制上游代码或引入许可证依赖。

## 目标与边界

- 增加 `context/microcompact_checkpoint` 与 `context/microcompact_checkpoint_failed` 事件；
- 扩展 `context/microcompacted` 的 checkpoint、pressure、coverage metadata；
- checkpoint 成功且先落 EventStore 后才允许写 cleared marker/替换 model view；失败保留完整 view；
- 提供 contracts、storage、runtime/context 的单元、合同、恢复和安全测试；
- 不实现 Slice D 的全量 compact 联动、summary 注入或 circuit-breaker 扩展。

## 变更记录

### Commit `a50dde2`

- 变更文件：`packages/contracts/src/index.ts`、`packages/context/src/index.ts`、`packages/context/src/tool-result-budget.ts`、`packages/context/src/microcompact-checkpoint.ts`、`packages/runtime/src/index.ts`。
- 内容：注册 checkpoint 成功/失败事件，增加 bounded projection 类型与 deterministic checkpoint builder/validator，并增加 `microcompactCheckpointMaxChars` policy 字段。
- 事件顺序：本提交只建立契约和生成器；Runtime 的持久化顺序在后续提交实现。
- 验证：待 Runtime/storage 接线完成后统一执行 `pnpm typecheck`、相关 package tests 与 `pnpm test`。
- 风险：生成器仅提取受限元数据；路径字段剥离盘符并拒绝 `..`，不读取或保存完整工具输出。若 schema 预算过小会触发 validator failure，按失败语义保留原 model view。
- 回滚：回滚 `a50dde2`，或将 `microcompactTriggerMode` 设为 `legacy-count`/`disabled`；原有 replacement receipt 行为保持。

### Commit `a4f1e71`

- 变更文件：`packages/storage/src/index.ts`。
- 内容：EventStore projection 解析 checkpoint 成功/失败事件，向 SessionProjection 与 ContextDiagnostics 写入 bounded metadata。
- 事件顺序：成功 checkpoint 以事件 sequence 作为 source，失败事件仅记录稳定 stage/code 并标记 `preservedModelView=true`。
- 验证：待 Runtime 接线后执行 storage/context/runtime 定向测试与全 workspace 检查。
- 风险：projection 对未知/不完整 payload fail closed，不会把原始工具输出带入 API/Web；旧事件继续兼容。
- 回滚：回滚 `a4f1e71`，EventStore 仍保留新增事件，旧 projection 忽略未知类型。

### Commit `f824e68`

- 变更文件：`packages/runtime/src/index.ts`。
- 内容：Runtime 在 microcompact candidate 产生清理 ID 后先构造、校验并追加 checkpoint；只有 checkpoint 成功才替换 model view、追加 budget receipt 和 `context/microcompacted`。失败追加 bounded failure event 并保留原 view。
- 事件顺序：`context/microcompact_checkpoint` → `context/tool_results_budgeted` → `context/microcompacted`；失败路径为 `context/microcompact_checkpoint_failed`，无 cleared marker。
- 验证：`pnpm typecheck`；`pnpm --filter @coding-agent/context test`（93/93）；`pnpm --filter @coding-agent/runtime test -- --run src/index.test.ts`（74/74）。
- 风险：checkpoint ID 由 turn/step/cleared IDs 派生；deterministic builder 只读取 bounded metadata。EventStore 同时故障时 failure receipt 可能无法落盘，但仍不会改变 model view。
- 回滚：回滚 `f824e68` 可恢复 Slice B 的直接 replacement 逻辑；新增事件保留且旧 Runtime 可忽略。
