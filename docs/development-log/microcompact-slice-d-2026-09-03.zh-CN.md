# Microcompact Slice D 开发日志

日期：2026-09-03  
范围：microcompact 后重计数、全量 compact 联动、checkpoint 历史背景、幂等和 recovery circuit breaker

## 需求来源与设计依据

本切片执行 `docs/evaluation/microcompact-improvement-plan-2026-09-03.zh-CN.md` 的“Slice D：与全量
compact、收束和恢复联动”。约束依据为根目录 `AGENTS.md`、ADR-037（Slice C checkpoint 事实源）和
`docs/event-contract.md`。行为参考 Claude Code `src/query.ts` 的 microcompact → autoCompact 顺序、
summary/legacy fallback 与连续失败保护，以及 DSH Agent Loop 的 step-local retry/replay 边界；本项目
只按既有 EventStore、ContextRecoveryGuard 和 compact helpers 重新实现，没有复制上游源码。

## 目标与边界

- microcompact 成功后立即重新计算 model-visible token usage；若仍高于 `autoCompactThreshold`，在同一
  step 进入 Session Memory → summary → legacy 全量 compact 阶梯。
- summary 可接收 bounded checkpoint facts，并过滤已由 checkpoint 覆盖的 tool result，避免从清理前的
  原始证据重复读取。
- 使用 `turnId + step + modelViewFingerprint` 作为 reduction 幂等键；重复执行不追加第二组
  checkpoint/budget/microcompact receipt。
- checkpoint 失败与 summary/legacy compact 失败统一调用 `ContextRecoveryGuard.recordCompactionFailure`；
  连续达到上限后打开 circuit breaker。失败始终保留当前 model view，主 turn 终态分类不变。
- 不新增 Slice E 的 UI/评测诊断，不引入新的公共事件类型；`historicalContext`、covered IDs 和
  reduction fingerprint 仅作为 bounded 内部参数/事件 metadata。

## 变更记录

### Commits `33c4b06` + `9ffdcbd` — 文档/ADR

- 文件：`docs/architecture-decisions.md`、`docs/event-contract.md`。
- 新增 ADR-038，固定 microcompact 后重计数、Session Memory → summary → legacy 阶梯、summary checkpoint
  历史背景、fingerprint 幂等和 recovery circuit breaker 语义。
- 补充事件契约中的同一步收束、失败保留 view 和 bounded metadata 约束。
- `33c4b06` 实际提交 ADR-038；`9ffdcbd` 是 Slice C 已提交的 checkpoint 事件契约，作为本 Slice 的前置契约依据。
- 回滚：移除 ADR-038 增量即可回到 Slice C 文档；已写事件保持向后兼容。

### Commit `81725d8` — Context summary 实现

- 文件：`packages/context/src/summary-compact.ts`。
- `SummaryCompactOptions` 增加 `historicalContext` 与 `historicalToolCallIds`；summary 输入注入
  `<microcompact-checkpoint>` bounded 历史块，并过滤已覆盖 tool result。
- 回滚：移除新增 options 与过滤逻辑；普通 summary 调用仍使用原有输入。

### Commit `52eb07f` — Runtime 联动实现

- 文件：`packages/runtime/src/index.ts`。
- microcompact 成功后保存 checkpoint，重算 token；checkpoint 失败记入 guard；成功 checkpoint 的
  fingerprint 写入 budget/microcompact receipt。
- 全量 compact 仅在仍高于阈值时触发；若存在 checkpoint，compact reducer 使用 post-microcompact model
  view，避免重新读取原始 tool output；summary 收到 checkpoint facts。
- `persistMicrocompactCheckpoint` 按 reduction fingerprint 查找既有 checkpoint/receipt，保持同一 turn/step
  幂等；失败路径继续追加 bounded failure event，不改变 model view。
- 回滚：恢复 Slice C 的 `compactTurnContext` 调用和 checkpoint metadata 增量；可关闭 `compactionEnabled`
  或使用 `legacy-count`/`disabled` trigger。

### Commit `620b30c` — Context summary 单元测试

- 文件：`packages/context/src/summary-compact.test.ts`。
- 验证 checkpoint 历史块可见、covered tool result 不再进入 summary runner，且 summary 仍成功产出。

### Commit `4f3829c` — Runtime 合同/恢复测试

- 文件：`packages/runtime/src/index.test.ts`。
- 新增 microcompact 后仍超阈值时进入 summary compact 的合同测试，检查事件顺序、checkpoint 历史块和
  重计数 token metadata。
- 扩展 receipt 断言，验证 `reductionFingerprint`；新增 ContextRecoveryGuard 混合模块连续失败打开
  circuit breaker 的测试。

### Commit `afba6c1` — 测试编译修复（并行工作树混入说明）

- Slice D 相关文件仅修复 `packages/context/src/summary-compact.test.ts` 的可变数组类型，消除
  `pnpm typecheck` 的 `readonly ... push` 错误。
- 该提交创建时工作树中并行 Skill 任务的 staged 内容一并进入 commit（`packages/context/src/index.ts`、
  `skill-catalog*`、`packages/tools/*`、`pnpm-lock.yaml`）；这些文件不属于 Slice D，已在本日志中明确标注，
  便于主线程后续按并行任务归档或拆分。

### Commit `e055608` — 开发日志落盘（并行工作树混入说明）

- 新增本开发日志文件；该提交同时带入当时已 staged 的并行 Skill renderer 变更
  （`packages/runtime/src/index.ts`、`packages/runtime/src/index.test.ts`）。这些 runtime/test hunk
  不属于 Slice D，主线程应按并行 Skill 任务归档；Slice D 的日志正文与核心实现仍可按上方独立
  commit 追溯。

### Commit `e055608` — Runtime 测试/日志收尾（并行工作树混入说明）

- Slice D 相关内容：补充 Runtime reduction recovery 测试与本日志的执行记录。
- 该提交同时包含并行 Skill renderer 的 `packages/runtime/src/index.ts` 与
  `packages/runtime/src/index.test.ts` 改动；这些内容不属于 Slice D，已保留并单独标注。

### Commit `85b6e1e` — 测试类型修复

- 文件：`packages/context/src/summary-compact.test.ts`。
- 将 checkpoint summary runner 捕获数组改为保存只读消息数组，修复 `pnpm typecheck` 的
  `readonly ChatMessage[]` 类型错误，不改变运行时行为。
- 验证：`pnpm typecheck`、summary compact 定向测试通过。

## 验证

- `pnpm --filter @coding-agent/context test -- --run src/summary-compact.test.ts`（7/7）
- `pnpm --filter @coding-agent/runtime test -- --run src/index.test.ts`（79/79）
- `pnpm typecheck`（通过）
- Slice D 测试覆盖：microcompact 后重计数、full compact 联动、summary checkpoint 历史背景、fingerprint
  幂等 metadata、连续失败 circuit breaker。

## 风险与后续边界

- reduction fingerprint 目前作为 bounded receipt metadata 写入，Storage projection 尚未单独展示该字段；
  Slice E 再决定 Web/诊断投影。
- checkpoint 历史块来自 deterministic builder，仍不包含 provider 精确事实；summary 失败时继续 fallback
  legacy compact，并由现有 `context/summary_compaction_failed` 记录原因。
- EventStore 在 checkpoint 与 failure receipt 同时不可用时仍依赖既有 append 错误处理；当前安全不变量是
  不替换 model view、不改变 turn 终态。
- 本切片没有实现 collapse、cached provider edit 或新的公共 event type。

## 回滚与迁移

- 优先关闭 `compactionEnabled` 或将 microcompact trigger 设为 `legacy-count`/`disabled`，可保留已有
  checkpoint/receipt 并继续由旧 Runtime 忽略。
- 代码回滚顺序：`4f3829c` → `620b30c` → `52eb07f` → `81725d8`；文档回滚 `33c4b06`。每个 commit
  均为独立可回滚 checkpoint，其他并行 Skill 改动未纳入上述提交。
