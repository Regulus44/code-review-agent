# M08 开发日志：Compact Boundary 与 Post-Compact Rebuild

状态：implemented
日期：2026-08-26
checkpoint：本次独立提交 feat(phase8): implement compact boundary M08

## 任务七问

1. Phase：Phase 8 高级上下文能力，M08；依赖 M01–M07。
2. 问题类型：为 M06/M07/legacy compact 生成 durable boundary，并在压缩后按 bounded 预算恢复 plan、文件、skill、MCP 和 hook 类附件。
3. 契约影响：新增 ContextBoundaryMetadata、ContextPreservedSegment、ContextAttachmentProjection、context/compact_boundary 和 context/post_compact_rebuild_failed；ChatMessage 支持 boundary metadata。
4. Claude Code 参考：src/utils/messages.ts:4967-5093、src/services/compact/compact.ts:336-389,541-669,1467-1650。
5. 上游来源：登记为 behavior-reference；没有复制 Claude Code 代码。
6. 验收场景：compact 后 boundary 顺序稳定；preserved head/anchor/tail 可回放；plan/provider attachment 按数量和 token 预算恢复；重复 compact 和 Host 重启不会重复注入相同附件。
7. 回滚方式：移除 boundary/rebuild 模块、事件和 Runtime wiring，回到 M07 compact result。

## 实现内容

- 新增 packages/context/src/boundary.ts，实现 compact/micro boundary marker、最近 boundary 查找、preserved segment annotation 和 metadata replay。
- 新增 packages/context/src/attachments.ts，实现最近文件、skill、总附件和单附件 token budget，稳定排序、去重和 bounded truncation。
- 新增 packages/context/src/post-compact.ts，实现 boundary → summary → preserved → attachments 的 Claude Code 式顺序。
- Runtime 在 M06/M07/legacy compact 成功后统一执行 M08 rebuild；当前 active/draft/approved plan 由默认 host builder 恢复，其他附件由 postCompactAttachmentProvider 注入。
- conversationMessages() 根据 projection 中的 boundary preserved head 重建最近 model-visible segment；assembler 保留 boundary system marker，并按 provider 重建缺失附件。
- Storage 新增 boundary projection 合并逻辑，事件只保存 bounded metadata，不保存附件原文或 provider body。

## 关键决策

- transcript 永远不被压缩覆盖；boundary 只作为 replay/model-view rebuild 的 durable metadata。
- boundary metadata 使用 version 1、有限数组和 token/字符限制，防止恶意事件膨胀 projection。
- 附件按 ID 去重；preserved segment 已包含的附件不会再次注入。
- attachment provider 失败时记录 context/post_compact_rebuild_failed，仍保留 boundary 和主 compact 结果，不阻塞后续 turn。
- boundary 不存在或 preserved head 无法定位时不猜测边界，继续兼容完整 transcript。

## 验证证据

    pnpm typecheck
    pnpm --filter @code-review-agent/context test -- --run
    pnpm --filter @code-review-agent/storage test -- --run
    pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts
    git diff --check

本次新增验证：Context 42 tests、Storage 18 tests、Runtime 44 tests 均通过。
