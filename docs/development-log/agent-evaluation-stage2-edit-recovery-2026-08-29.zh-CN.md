# Coding Agent 评测阶段二：编辑失败恢复实施日志

## 阶段判断

阶段二的范围经过 DSH 对照后收敛为两个必要的最小闭环：

- 2A 在工具层落实 read-before-edit、观察版本和 CAS。它是编辑安全不变量，避免 Agent 用旧内容覆盖用户或其他进程的新修改；
- 2B 在 Agent 层对完全相同的连续工具调用提供 advisory notice。它用于减少失败循环，提醒模型读取最新结果、改变参数或结束任务；它不阻断工具调用，也不改变 turn 状态。

两部分均不引入通用插件运行时、自动替代编辑、强制熔断或新的 recovery event。观察状态和重复计数只保存在 Host 内存中，EventStore 继续保存实际工具事实和已经 materialize 的 `user/message`。

## DSH 对照入口

2A 对照：

- `D:\Develop\deepseek-harness-fork\packages\fs\fs-observation-policy\src\index.ts`：`ObservedStateGate`、`writeIntent()`、`editIntent()`、`observe()`；
- `D:\Develop\deepseek-harness-fork\packages\fs\fs-observation-policy\src\types.ts`：最小 actor/owner 边界；
- `D:\Develop\deepseek-harness-fork\packages\fs\tool-fs\src\read.ts`、`edit.ts`、`error.ts`：读取登记版本、编辑 CAS、稳定错误码和重读 remedy；
- `D:\Develop\deepseek-harness-fork\packages\fs\fs-observation-policy\tests\policy.spec.ts` 与 `packages/fs/tool-fs/tests/integration.spec.ts`：未读、stale、重读恢复、owner 隔离和并发矩阵。

2B 对照：

- `D:\Develop\deepseek-harness-fork\packages\guard\repeat-tool-reminder\src\index.ts`：配置、深度 canonicalize、Chain、post-execute observe 和 reset；
- `D:\Develop\deepseek-harness-fork\packages\core\tools\src\index.ts`：`additionalContexts` seam；
- `D:\Develop\deepseek-harness-fork\packages\core\agent-loop\src\tool-calls.ts`、`agent.ts`：按模型顺序接收上下文并追加可回放的 `user/message`；
- `D:\Develop\deepseek-harness-fork\packages\guard\repeat-tool-reminder\tests\repeat-tool-reminder.spec.ts`：阈值、参数排序、截断、拒绝调用、重置和 downstream context 合同。

## 当前仓库实施

### 2A：文件观察策略

- 新增 `packages/tools/src/file-observation.ts` 与 `file-observation.test.ts`；
- `createBuiltinTools()` 为内置文件工具持有 `FileObservationPolicy`；`read_file` 成功记录当前 hash，读取缺失目标记录 `absent`；
- `edit_file` 在匹配前检查同一 Session 的观察状态。未观察返回 `EDIT_NOT_OBSERVED`，已观察版本与当前 hash 或调用者 `expectedHash` 任一不一致时返回 `EDIT_STALE`；成功写入后刷新 hash；
- AgentHost 在自有内置工具池的情况下负责策略生命周期：删除 Session 时清理该 Session，Host shutdown 时清空全部观察状态；
- 观察键按 Session、workspace root 和规范化相对路径隔离；`grep`、`glob`、终端输出不产生编辑授权。

### 2B：重复工具调用提醒

- 新增 `packages/runtime/src/repeat-tool-reminder.ts` 与 `repeat-tool-reminder.test.ts`；
- key 为工具名加深度排序后的完整 JSON 参数；默认阈值为 `[3, 5, 8]`，详细参数预览上限为 500 字符；
- 工具结果提交后计数，成功、失败和 denied 都计数。到达阈值后，在对应 `tool/result` 之后追加既有 `user/message`，并附带 `source.kind=plugin`、`source.plugin=repeat-tool-reminder`、`source.form=notice`；
- 新用户消息和删除 Session 重置 chain；Host 重启从空 chain 开始；提醒不修改工具输入、结果、调度和 turn terminal status；
- 未修改 `packages/contracts/src/index.ts` 的事件联合类型，也未新增 `edit/recovery` 事件。`docs/event-contract.md` 记录了 plugin notice 的 payload、顺序和 replay 语义。

### 评测 fixture 适配

`apps/api/src/fixtures/coding.ts` 的 edit fixture 现在先在同一 Session 读取 `notes.txt`，再创建待审批的 `edit_file` 调用；对应测试按工具名定位 edit result，保持 read-before-edit 语义下的原有验收目标。

## 验证记录

```text
pnpm --filter @code-review-agent/tools test
pnpm --filter @code-review-agent/runtime test
pnpm --filter @code-review-agent/api test -- src/fixtures/coding.test.ts
pnpm typecheck
pnpm test
git diff --check
```

2A、2B 定向测试、API fixture、TypeScript 类型检查、全量 `pnpm test` 和 `git diff --check` 均已通过。

## 阶段边界与回滚

本阶段不接入阶段三的 step 预算、Django adapter、仓库测试策略或阶段四 Runner 范围审计；不改变已有事件类型、权限审批、工具调度和 EventStore schema。回滚时移除两个内存策略及其测试、`user/message` notice 文档补充和 fixture 的读前观察即可，阶段一编辑错误与 CAS 契约继续保留。
