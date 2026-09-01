# Phase 2：事件、持久化与恢复

## 目标

把 Phase 1 的内存垂直切片变成可恢复的 Session Runtime：事件追加到 SQLite，SSE 支持历史补发，进程重启后可以重建 Session、消息、工具和权限状态。

## 参考入口

DSH：

- `D:/Develop/deepseek-harness-fork/packages/session`
- `D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/events.ts`
- `D:/Develop/deepseek-harness-fork/packages/host/apiproxy/src/api/sessions.ts`
- `D:/Develop/deepseek-harness-fork/packages/client/connection`
- `D:/Develop/deepseek-harness-fork/packages/client/runtime`

Claude Code：

- `D:/Develop/claude-code/src/QueryEngine.ts`
- `D:/Develop/claude-code/src/query.ts`
- `D:/Develop/claude-code/src/state`
- `D:/Develop/claude-code/src/services/contextCollapse`

## 交付物

- SQLite-backed `EventStore`；
- Session、Turn、Message、Task 的 projection；
- `after_sequence` 和 `Last-Event-ID` SSE replay；
- Session resume、cancel、queue 和幂等 command；
- 数据库 schema version 和迁移脚本；
- 事件 fixture/replay test harness。

## 工作流任务

### 存储

1. 设计 `sessions`、`events`、`projections`、`commands` 表；
2. 每个 Session 独立分配单调 sequence；
3. 事件和 projection 更新使用同一事务；
4. 记录 payload、createdAt、correlationId 和 schemaVersion。

### 恢复

1. 启动时从事件重建可查询状态；
2. 未完成 turn 标记为 resumable 或 interrupted；
3. 重复 send/approve/cancel 使用 command id 幂等；
4. SSE 先补历史再订阅实时事件，客户端检测 sequence gap。

### API/Web

1. 增加 session history、resume、cancel、fork 的 API 形状；
2. Web 只以 projection 和事件更新视图；
3. 重连时保留 composer、pending action 和 tool timeline 状态。

## 不包含

- 复杂上下文压缩；
- MCP Server；
- 多 Agent 调度；
- 多租户数据库和远程对象存储。

## 测试与验收

- 进程重启后 Session 历史完整；
- 任意 sequence 断线后可以补发且不重复渲染；
- 重复 command 不产生重复副作用；
- 中途取消、模型错误和客户端断开都有可解释事件；
- SQLite schema migration 和并发追加测试通过；
- 从事件 fixture 重建的 projection 与 API 返回一致。

退出条件：Read-only 场景可以在进程重启、浏览器刷新和 SSE 断线后继续，并且事件日志是唯一事实来源。

## 回滚点

保留 in-memory Store 作为测试实现；SQLite schema 只新增版本，不修改旧 Python 数据库文件格式。
