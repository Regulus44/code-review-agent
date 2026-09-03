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

（后续每个独立提交完成后追加变更文件、事件顺序、验证命令、风险、回滚方式和 commit hash。）
