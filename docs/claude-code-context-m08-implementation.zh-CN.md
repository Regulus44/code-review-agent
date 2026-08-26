# M08 实施说明：Compact Boundary 与 Post-Compact Rebuild

状态：implemented
日期：2026-08-26
所属阶段：Phase 8，高级上下文能力
参考快照：D:/Develop/claude-code

## 1. Claude Code 入口与本项目映射

| Claude Code 入口 | 关注点 | 本项目实现 |
|---|---|---|
| src/utils/messages.ts:4967-5093 | compact marker、micro marker、最近 boundary 查找和 boundary 后切片 | packages/context/src/boundary.ts |
| src/services/compact/compact.ts:336-389 | boundary、summary、preserved segment 的固定顺序和 head/anchor/tail | packages/context/src/post-compact.ts |
| src/services/compact/compact.ts:541-621 | compact 后文件、plan、skill、工具和 hook 附件恢复 | packages/context/src/attachments.ts、AgentHost.rebuildPostCompactView() |
| src/services/compact/compact.ts:623-669 | pre-token、summary、preserved segment 和 post-context 统计 | ContextBoundaryMetadata、context/compact_boundary |

Claude Code 仅作为行为参考。本项目没有复制其代码；boundary 使用 EventStore 事件和可选 host-owned attachment provider 实现。

## 2. Boundary 契约

ContextBoundaryMetadata 是 bounded、可重放的 compact 元数据，包含 version、kind、trigger、preCompactTokens、sourceSequence、lastPreCompactMessageId、preservedSegment、已发现工具、附件 ID 和 microcompact 统计。

createCompactBoundaryMessage() 生成带 contextBoundary metadata 的 system message。createMicrocompactBoundaryMessage() 使用同一 contract 表达 tokensSaved、compactedToolIds 和 clearedAttachmentIds。Boundary 本身不携带完整工具输出或 provider body。

annotateBoundaryWithPreservedSegment() 在消息被替换后记录 preserved tail 的 head、summary/boundary anchor 和 tail。findLastCompactBoundaryIndex()、getMessagesAfterCompactBoundary() 提供与 Claude Code 对应的最近 boundary lookup 和 slice 行为。

## 3. Post-Compact 消息顺序

buildPostCompactMessages() 固定产生：

    boundary marker
    → summary messages
    → preserved messages
    → bounded attachment messages

summary 和 preserved 消息均被克隆，输入数组不被修改。附件使用 context-attachment 不可信数据 wrapper，不覆盖 system、permission、workspace 或工具安全规则。

## 4. 附件预算、去重和重建

selectPostCompactAttachments() 执行以下限制：

| 项目 | 默认值 |
|---|---:|
| 最近文件数量 | 5 |
| 总附件 token | 50,000 |
| 单附件 token | 5,000 |
| skill 总 token | 12,000 |

选择顺序由 order → id 稳定排序。重复 attachment ID、已存在于 preserved segment 的 attachment、超过文件数量或 token 预算的附件被跳过，并在 droppedAttachmentIds 返回。内容超过单附件预算时加入 bounded 截断 marker。

Runtime 支持 postCompactAttachmentProvider，由 host 重新生成最近文件、skill、MCP、agent 或 hook 内容。默认 provider-free 路径会恢复当前 active/draft/approved plan。已有附件通过 ID 去重，因此同一次 compact 或重启后的 rebuild 不会重复注入。

## 5. Runtime 与重启重建

AgentHost.compactTurnContext() 的顺序现在是：

    M06 Session Memory Compact
      → M07 LLM Summary Compact
      → legacy deterministic compact
      → M08 boundary + post-compact rebuild

成功压缩后，Runtime 生成 boundary、重新划分 summary/preserved segment、调用 host attachment provider、更新当前 model-view，并追加 context/compact_boundary 事件。

conversationMessages() 读取最近 projection boundary：

1. 使用 preservedSegment.headMessageId 在 EventStore replay 的完整消息中定位保留段；
2. 只取 head 之后的历史；
3. 插入 boundary marker 和最近 compact summary；
4. 后续 assembleTurnContext() 通过 attachment provider 重新注入缺失附件。

这样 transcript 继续保存完整历史，model view 依据 boundary 重建。Boundary 不存在或 head 无法定位时走兼容路径，不猜测历史边界。

## 6. Durable Event 与 Projection

新增事件：

- context/compact_boundary：保存 boundary、summary、保留/丢弃统计、附件 metadata 和 token estimate；
- context/post_compact_rebuild_failed：attachment provider 失败时保存 bounded error，boundary 仍可成功落盘。

Storage 将 context/compact_boundary 合并到 SessionProjection.contextCompaction，记录 boundary、kind、sourceSequence、summary、compact counts 和 attachments 的 ID/kind/tokenEstimate。

事件不保存附件原文、工具输出、provider request、凭据或 secret material。

## 7. 测试覆盖

packages/context/src/post-compact.test.ts 覆盖 boundary metadata、preserved head/anchor/tail、固定顺序、重复附件去重、文件数量和 token 预算、最近 boundary slice。

packages/runtime/src/index.test.ts 覆盖 M08 boundary 事件、plan 和 host attachment provider 恢复、boundary projection metadata。

packages/storage/src/index.test.ts 覆盖 context/compact_boundary 的 InMemory projection。

## 8. 边界与回滚

M08 不实现 reactive overflow recovery、SessionStart/PreCompact 外部 hook 调度、provider prompt-cache edit、完整 Session Restore 和 Project Memory。它们分别留给 M09、provider adapter、M10/M12。

回滚 M08 时移除 boundary/post-compact 模块、context/compact_boundary 与 rebuild provider wiring，保留 M07/M06 的 compact result 和 legacy model view。
