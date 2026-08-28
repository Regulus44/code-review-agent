# 阶段 3：单工具结果落盘与预览实施日志（2026-08-28）

## 目标与边界

本阶段按实施基线完成 Claude Code 风格的单工具结果 artifact 化。单条工具结果超过 `50000` 字符，或超过 `100000` token 硬上限时，完整正文写入当前 Session workspace；模型上下文只保留 workspace-relative artifact 路径和最多 `2000` UTF-8 bytes 预览。`tool/result` 事件继续保存完整工具结果，replacement receipt 只保存 metadata。

本阶段没有实现阶段 4 的单消息工具结果聚合、时间型 microcompact，也没有实现阶段 5 的并行 scheduler。

## 直接修改的代码入口

- `packages/contracts/src/index.ts`
  - 增加 `context/tool_result_persisted` 事件类型；
  - 增加 `ToolResultReplacementRecord`，固定保存 `toolCallId`、artifact、relative path、原始 chars/bytes/tokens、阈值、preview、previewBytes 和 replacement reason；
  - `SessionProjection` 增加 `toolResultReplacements`，用于 API 和恢复回放。
- `packages/context/src/tool-result-storage.ts`
  - 实现 `50000` 字符阈值、`100000` token hard cap、`2000` bytes UTF-8 preview；
  - preview 在进入 model view 和 replacement receipt 前脱敏常见 credential-shaped 字段；artifact writer 接收并保存完整原文；
  - JSON 使用 `.json`，普通文本使用 `.txt`；image/document block 保持 unsupported，不强行 stringify；
  - artifact 路径固定为 `.agent-artifacts/tool-results/<session>/<toolCallId>.(txt|json)`；
  - 通过 writer callback 执行写入，`wx`/EEXIST 语义由 Runtime writer 提供，生成可恢复的 bounded model view；
  - 写入失败返回 `persistence-failed` receipt 和 bounded unavailable view，阻止无限原文进入模型。
- `packages/context/src/tool-result-budget.ts`
  - 默认不再以 `8000` 字符对每条结果做前缀截断；显式 legacy policy 仍可启用旧 bounded/microcompact 行为；
  - persisted view 进入后续 count/token microcompact 前，阶段 4 的 aggregate/time 逻辑保持未启用。
- `packages/runtime/src/index.ts`
  - `AgentHostOptions.toolResultStorage` 支持注入 storage；默认 writer 使用 `WorkspaceResolver`；
  - `prepareModelContext()` 在 normalize/tool pairing 后调用单结果 storage，再执行现有 count/token budget；
  - receipt 追加 `context/tool_result_persisted`，不写入完整正文；
  - `conversationMessages()` 从完整 `tool/result` 重建原文，再按 receipt 重放同一 preview；artifact 缺失时使用 bounded unavailable view；
  - 读取 receipt 时复用 Session workspace 安全边界，避免宿主绝对路径和跨 workspace 访问。
- `packages/storage/src/index.ts`
  - 回放 `context/tool_result_persisted` 到 `SessionProjection.toolResultReplacements`，按 `toolCallId` 幂等更新。
- `packages/tools/src/runtime.ts`
  - 默认 result buffer 从 `64 KiB` 提升到现有 `512 KiB` host safety boundary，避免在 artifact storage 前丢失可持久化正文。
- `packages/tools/src/builtin.ts`、`packages/tools/src/jobs.ts`
  - shell/terminal/job 的 model-visible 读取默认 `30000` 字符，配置上限 `150000`；底层进程/job 缓冲仍保持 `512 KiB`。
- `apps/api/src/artifacts.ts`
  - 受控 artifact lookup 同时支持 Task artifact 和 tool-result replacement artifact；响应不返回宿主绝对路径，读取继续执行 lexical/existence/symlink workspace 校验。

## 上游行为对照

- Claude Code `src/utils/toolResultStorage.ts`：`50000` 字符阈值、`100000` token hard cap、`2000` bytes preview、`.txt/.json` 分流、exclusive create、replacement state 和 bounded persisted-output model view；本项目改为 workspace-relative path，并保留本项目 EventStore/WorkspaceResolver 边界。
- Claude Code `src/constants/toolLimits.ts`：单工具结果 token 限制和大结果处理边界。
- DSH 的 Session/Event/Workspace 分层：artifact 通过 Session 事件和 projection 回放，不把文件路径直接作为客户端权限。

## 验收证据

- `packages/context/src/tool-result-storage.test.ts`：阈值边界、token hard cap、UTF-8 preview、JSON、image/document 排除、写入失败、EEXIST 幂等和 preview 脱敏；
- `packages/runtime/src/index.test.ts`：完整 `tool/result`、receipt 不含正文、artifact 创建、首轮和重启后的 preview 一致；
- `apps/api/src/artifacts.test.ts`：replacement artifact 受控读取、响应不暴露绝对路径、workspace 越界拒绝；
- `pnpm --filter @code-review-agent/context test`：通过；
- `pnpm --filter @code-review-agent/tools test -- --run src/index.test.ts`：通过；
- `pnpm --filter @code-review-agent/runtime test -- --run src/index.test.ts`：通过；
- `pnpm --filter @code-review-agent/api test`：通过；
- `pnpm test`：全 workspace 通过；
- `pnpm typecheck`：通过；
- `git diff --check`：通过。

preview 脱敏跟进 checkpoint：`2bfb2b2 fix(phase3): redact tool result previews`。该跟进只收紧 model-visible preview/receipt 的 secret 边界，不改变 artifact 完整原文、EventStore `tool/result` 或 workspace artifact API contract。

## 回滚与下一步

回滚时停止创建新 `context/tool_result_persisted` receipt 即可；已有 artifact、完整 `tool/result` 和 receipt 仍可读取，未改变 EventStore 基础契约。阶段 4入口是单消息工具结果聚合预算与 Claude Code 时间型 microcompact；阶段 5入口是最多 10 个并行工具调用 scheduler。
