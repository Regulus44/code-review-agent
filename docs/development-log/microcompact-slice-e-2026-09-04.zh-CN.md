# Microcompact Slice E 开发日志

日期：2026-09-04  
范围：评测与 bounded microcompact/checkpoint diagnostics 收尾

## 需求来源与设计依据

本切片执行 `docs/evaluation/microcompact-improvement-plan-2026-09-03.zh-CN.md` 的“Slice E：评测与诊断”。
约束依据为根目录 `AGENTS.md`、ADR-037（Slice C checkpoint 事实源）、ADR-038（Slice D 收束与恢复）、
`docs/event-contract.md` 和当前 `packages/runtime`、`packages/storage`、`apps/web` replay 实现。
行为参考 DSH compaction 的 bounded diagnostics/replay，以及 Claude Code microcompact 的稳定 replacement；
本项目只复用行为语义，不复制上游代码或引入许可证依赖。

## 目标与边界

- 在 `step/started.payload.toolResultBudget` 中统一投影 strategy、pressure threshold、pre/post usage、
  checkpoint 状态和 bounded coverage，不携带完整工具输出。
- Storage、API/SSE 和 Web 仅消费同一 contracts/projection，重启与 replay 得到一致 diagnostics；Web 不从
  当前消息内容推断 compact 成功。
- 以固定 deterministic fixture 覆盖低 pressure、接近阈值 handoff、重启 view 稳定和测试证据保留。
- 不增加 collapse、provider cache edit、账户、遥测或 Slice E 之外的产品能力。

## 变更记录

### Commit `980c22d` — 首个契约提交

- 更新 `docs/event-contract.md`，固定 `toolResultBudget.microcompact` 的 bounded 字段、状态枚举、coverage
  上限和旧事件兼容语义。
- 该提交是后续代码修改的前置契约 checkpoint，先于 Runtime/Storage/Web 实现。

## 验证

待 Slice E 代码、replay 和 fixture 完成后补充命令与结果。

## 风险与回滚

- 旧 `step/started` 没有 `microcompact` 对象时继续使用已有字段；回滚只需停止写入新对象，保留事件可被旧
  Runtime 忽略。
- bounded coverage 使用 sequence/count/少量 tool call ID，禁止向 projection/SSE 扩散工具原文或绝对路径。

## 后续提交追踪

后续每个实现/测试/文档提交都在本日志追加文件范围、验证、风险、回滚和 commit hash；最终收尾提交的 hash
以交付时 `git log` 为准。

### Contracts/Runtime/Storage/Web diagnostics 实现（本次）

- `packages/contracts/src/index.ts` 新增 `ContextMicrocompactDiagnosticsProjection`、checkpoint 状态和
  coverage bounded 类型；`ContextToolResultBudgetProjection.microcompact` 作为兼容可选字段，统一
  `strategy`、threshold、pre/post usage、checkpoint、coverage 命名。
- `packages/runtime/src/index.ts` 在每个 `step/started` 生成 bounded microcompact diagnostics；成功
  checkpoint 记录 `persisted`、有限 checkpointId、token 变化与最多 64 个 tool call ID；失败/低压路径分别
  记录 `failed`/`not_needed`，不暴露工具正文。`context/tool_results_budgeted` 和 `context/microcompacted`
  也携带相同 bounded 对象，便于 SSE/replay。
- `packages/storage/src/index.ts` 统一解析并限制 diagnostics，保留 checkpoint/failure metadata，且从
  budget/microcompact 事件重建最新 tool-result budget；后续 `step/started` 不再丢失 checkpoint 投影。
- `apps/web/src/client/store.ts` 增加同一 parser 与 checkpoint/failure/budget 事件 fold，Web 只消费事件
  投影，不依据消息正文推断 compact 成功。
- 回滚：停止写入 `microcompact` 对象即可兼容旧客户端；删除本提交新增 parser/fold 不影响已有
  `context/microcompacted`/checkpoint 事件历史。

### Commit `9461433` — Diagnostics/replay 实现

- 文件：`packages/contracts/src/index.ts`、`packages/runtime/src/index.ts`、`packages/storage/src/index.ts`、
  `apps/web/src/client/store.ts`。
- 落地上一节所述 contract、Runtime event/step payload、Storage reducer 与 Web live/replay fold；该 commit
  没有混入并行 Skill resource artifact、用户 README 或现有评测文档改动。
- 验证：`pnpm typecheck` 通过。

### Tests/presenter（本次）

- 文件：`packages/runtime/src/index.test.ts`、`packages/storage/src/index.test.ts`、
  `apps/web/src/client/store.test.ts`、`apps/web/src/presentation/context-presenter.ts`、
  `apps/web/src/presentation/context-presenter.test.ts`。
- Runtime 覆盖低压 `not_needed`、成功 checkpoint `persisted`、checkpoint persist 失败 `failed` 的 step payload；
  Storage 验证 tool output 不进入 projection、coverage 最多 64 IDs；Web 验证 checkpoint/replay fold 和
  presenter 使用持久化 metadata 显示 status/usage/count，不读取或推断工具正文。
- 验证：Storage 34/34、Web 20/20、Runtime 80/80 定向测试通过。
- 回滚：移除 tests/presenter 与 nested diagnostics rendering；Web 会回退已有 context meter，不影响
  Runtime 的 model view 或 event replay。

### Commit `c771803` — Replay tests and Web presenter

- 新增 Storage/Web/Runtime 合同测试与 `context-presenter` bounded diagnostics 展示；验证结果为
  Storage 34/34、Web 20/20、Runtime 80/80。
- Presenter 只显示 projection 中的 strategy、usage、checkpoint status 和覆盖计数，不读取工具正文。

### Commit `60e6d40` — 等价长检索评测证据

- 文件：`packages/context/src/microcompact-slice-e-fixture.ts`、对应 Vitest、
  `docs/evaluation/microcompact-slice-e-2026-09-04.zh-CN.md`，并在 `docs/status.zh-CN.md` 与评测 README
  增加入口说明。
- 固定 fixture 覆盖低 pressure 不清理、接近阈值 pressure handoff、重复 replay replacement 稳定和
  checkpoint `testsRun` 证据保留；真实 Pylint 任务因依赖/外部 workspace 不具备稳定 CI 前提，已明确采用
  deterministic equivalent，并保留后续真实复测要求。
- 验证：`pnpm --filter @coding-agent/context test -- --run src/microcompact-slice-e-fixture.test.ts`
  3/3 通过；`pnpm typecheck` 通过。
- 回滚：删除 fixture/test 和新增评测入口即可；Slice E diagnostics contract/实现仍可独立保留或回滚。
