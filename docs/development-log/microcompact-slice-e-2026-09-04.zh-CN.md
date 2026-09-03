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

### 首个契约提交（本次）

- 更新 `docs/event-contract.md`，固定 `toolResultBudget.microcompact` 的 bounded 字段、状态枚举、coverage
  上限和旧事件兼容语义。
- 该提交是后续代码修改的前置契约 checkpoint；实际 commit hash 由 Git 历史和最终交付记录确认。

## 验证

待 Slice E 代码、replay 和 fixture 完成后补充命令与结果。

## 风险与回滚

- 旧 `step/started` 没有 `microcompact` 对象时继续使用已有字段；回滚只需停止写入新对象，保留事件可被旧
  Runtime 忽略。
- bounded coverage 使用 sequence/count/少量 tool call ID，禁止向 projection/SSE 扩散工具原文或绝对路径。

## 后续提交追踪

后续每个实现/测试/文档提交都在本日志追加文件范围、验证、风险、回滚和 commit hash；最终收尾提交的 hash
以交付时 `git log` 为准。
