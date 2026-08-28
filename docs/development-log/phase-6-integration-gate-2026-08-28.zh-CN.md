# 阶段 6：集成门禁、迁移说明和文档收敛实施日志（2026-08-28）

## 目标与边界

本阶段把阶段 1–5 的实际运行行为、代码入口、上游参考、评测配置和回滚边界收敛到可执行的文档基线，并运行跨模块门禁。阶段 6 不新增 Provider、Context、Tool、Permission、Workspace 或协议运行时能力；新增的 Runtime 测试只用于验证阶段 3–5 的组合行为。

## 直接修改的内容

- `docs/claude-code-context-m01-implementation.zh-CN.md`
  - 增加当前基线修订，明确未知模型 fallback 为 `200000/64000/32000`，默认 effective window 为 `180000`，legacy summary 为 `8192` 字符；原始 16K/0 说明保留为历史记录。
- `docs/claude-code-context-m05-implementation.zh-CN.md`
  - 增加阶段 3–5 的当前修订，明确单工具 artifact、单消息 `200000` 字符聚合、`60` 分钟时间型 microcompact、最近 `5` 个保留和 10 并行 scheduler 的组合入口。
- `docs/claude-code-context-management-research.zh-CN.md`
  - 增加 accepted implementation baseline，列出阶段 1–5 的参数、入口和证据文档，并标明 M14 Context Collapse 仍为 deferred。
- `docs/source-reuse-register.md`
  - 新增 DSH-013，登记 DSH scheduler 的 constants、resolution、rolling pool/barrier/abort 行为参考；
  - 新增 CC-017，登记 Claude Code 工具结果 artifact、aggregate、time-based microcompact 和 replacement 行为参考；均未复制源码。
- `README.zh-CN.md`
  - 增加当前运行时默认值、硬上限、artifact 位置和 `/v1/capabilities`/`step/started` 诊断入口。
- `docs/coding-agent-bench-mvp.zh-CN.md`
  - 明确评测 `maxSteps=32` 与 `maxSteps=512` 均须通过 `1–512` 校验，并保存 capability、事件和 artifact 诊断。
- `packages/runtime/src/index.test.ts`
  - 新增 Windows PowerShell 大结果并行、artifact 持久化、`tool/result` 顺序和 Host 重启 replay 的组合验收场景。

## 对照依据

- DSH：`D:/Develop/deepseek-harness-fork/packages/core/agent-loop/src/{constants,index,tool-calls}.ts` 及 `tests/tool-calls.spec.ts`；用于并行 scheduler 的默认值、cap ownership、barrier、顺序提交和取消行为。
- Claude Code：`D:/Develop/claude-code/src/utils/toolResultStorage.ts`、`src/query.ts`、`src/services/compact/{microCompact,timeBasedMCConfig}.ts`；用于工具结果 artifact、聚合预算、时间触发和 model-view replacement 行为。
- 本项目：`packages/runtime/src/index.ts`、`packages/tools/src/runtime.ts`、`packages/context/src/{index,tool-result-storage,tool-result-budget}.ts`、`packages/storage/src/index.ts`、`apps/api/src/server.ts`；EventStore 仍是唯一事实来源。

## 验收证据

阶段 6 执行以下门禁：

```text
pnpm --filter @code-review-agent/llm test
pnpm --filter @code-review-agent/context test
pnpm --filter @code-review-agent/compaction test
pnpm --filter @code-review-agent/tools test
pnpm --filter @code-review-agent/runtime test
pnpm --filter @code-review-agent/api test
pnpm test
pnpm typecheck
git diff --check
```

评测基础设施自检：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/eval-mvp/verify-grader.ps1 -Mode gold -TaskId pallets__flask-4045 -Python D:/Develop/coding-agent-test/datasets/swebench-lite/pilot-01/runtime/venvs/pallets__flask-4045/Scripts/python.exe
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/eval-mvp/verify-grader.ps1 -Mode empty -TaskId pallets__flask-4045 -Python D:/Develop/coding-agent-test/datasets/swebench-lite/pilot-01/runtime/venvs/pallets__flask-4045/Scripts/python.exe
```

两种 Grader 自检均通过；`gold` 结果通过，`empty` 结果按预期失败并由脚本报告自检通过。使用 Echo provider 分别运行 `EVAL_MVP_MAX_STEPS=32` 和 `EVAL_MVP_MAX_STEPS=512` 的 `pnpm eval:mvp:run-agent pallets__flask-4045`，两次 turn 均 completed，结果文件记录了对应 step budget。Windows 集成测试验证了两个 PowerShell 并行大结果的 artifact、EventStore 顺序及重启后的相同 model view。

当前环境的 `.env` 只配置 `deepseek-v4-flash`，没有可用于 `v4pro` 的独立 provider endpoint/credential，因此没有执行真实 v4pro 网络 smoke；Anthropic-compatible 的 `32000/64000` wire、模型上限、413/429/529、partial output 和 abort 合同由 LLM adapter 测试覆盖。取得 v4pro 凭据后可直接复用同一 Runner 做外部 smoke，不需要修改阶段 1–5 的代码或契约。

## 回滚与后续入口

阶段 6 文档可整体回滚到前一文档 checkpoint；不删除历史事件、artifact、评测结果或阶段 1–5 的代码 checkpoint。Runtime 新增的组合测试可单独移除，不影响生产运行时。

阶段 6 完成后，后续工作回到 [阶段状态](../phase-status.zh-CN.md) 中的 Phase 8 剩余部署环境 smoke 和产品化边界；A2A 仍按既有 ADR deferred，不作为本阶段前置。

## Checkpoint

- 代码与组合测试：`61e3064 test(phase6): cover cross-stage integration`；
- 文档与阶段状态：`c5b747e docs(phase6): record provider smoke boundary`（基线文档提交 `d15a2ae`）。
