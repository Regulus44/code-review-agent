# Microcompact Slice E 评测与诊断收尾

日期：2026-09-04

## 固定等价 fixture

真实 `pylint-dev__pylint-7080` 需要外部 `coding-agent-test` workspace、依赖和原生工具链；当前
Slice E 门禁不把该外部运行当作稳定 CI 前提。因此使用
`packages/context/src/microcompact-slice-e-fixture.ts` 提供可重复的等价长检索 fixture：8 个
`read_file` 结果、固定 workspace-relative 文件、定向测试命令和 bounded checkpoint facts。fixture
只保留事实元数据，不包含真实仓库源码、provider body 或凭据。

## 验收矩阵

| 场景 | 固定证据 | 结果 |
| --- | --- | --- |
| 低 pressure 不清理 | 4,000 / 10,000 tokens、8 条结果 | strategy=`none`，保留全部 model view |
| 接近阈值 handoff | 9,100 tokens、pressure-v2 | 生成 bounded checkpoint，覆盖文件与定向测试证据 |
| 重启/replay 稳定 | 相同 replacement 与 cleared IDs 重放 | model view 字节一致，不新增清理 |
| 测试证据保留 | `run_command` 的固定测试命令 | checkpoint `testsRun` 保留命令，未写入工具输出正文 |

## 验证命令

```text
pnpm --filter @coding-agent/context test -- --run src/microcompact-slice-e-fixture.test.ts
pnpm --filter @coding-agent/storage test -- --run src/index.test.ts
pnpm --filter @coding-agent/web test -- --run src/client/store.test.ts src/presentation/context-presenter.test.ts
pnpm --filter @coding-agent/runtime test -- --run src/index.test.ts
pnpm typecheck
```

对应结果分别为 Context fixture 3/3、Storage 34/34、Web 20/20、Runtime 80/80，且 typecheck 通过。

## 诊断与安全边界

`step/started.payload.toolResultBudget.microcompact` 及 budget/microcompact receipts 只投影
strategy、threshold、pre/post usage、checkpoint 状态和 bounded coverage。Storage 与 Web replay 使用
同一字段解析，coverage tool call ID 上限为 64；工具正文、prompt、provider body、凭据和绝对路径
不会进入 diagnostics。客户端只展示 projection，不从消息内容推断 compact 成功。

## 风险、回滚与后续

- 外部 Pylint 任务仍需在具备稳定依赖的评测 workspace 中单独复测；本 fixture 只替代不稳定环境，不能
  证明真实仓库修复质量。
- 关闭新 diagnostics 写入或回滚 Slice E 实现即可继续使用旧字段；已有 checkpoint/replacement 事件
  保留并可由旧 Runtime 忽略。
- provider-specific cache edit、collapse、遥测和账户能力不属于本 Slice。
