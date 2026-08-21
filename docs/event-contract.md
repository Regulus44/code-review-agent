# 事件契约

事件是 Session 的事实来源。内存状态、数据库 projection、SSE 和 Web UI 都由事件派生。

## Envelope

```ts
type AgentEvent = {
  eventId: string;
  sequence: number;
  schemaVersion: 1;
  sessionId: string;
  turnId?: string;
  type: AgentEventType;
  createdAt: string;
  correlationId?: string;
  payload: Record<string, unknown>;
};
```

`sequence` 在一个 Session 内严格单调递增。`eventId` 用于唯一标识事件，command id 单独写入 `commands` 表用于请求幂等；`schemaVersion` 只在 wire/durable 格式发生不兼容变化时递增。

## 第一版事件集合

```text
session/created
session/updated
user/message
turn/queued
turn/started
turn/ended
assistant/chunk
assistant/message
tool/call
tool/progress
tool/result
diff/preview
permission/requested
permission/resolved
agent/status
agent/error
queue/changed
task/created
task/updated
task/ended
```

工具、权限和 queue 事件保留在公共契约中，分别由后续 Phase 实现；Phase 2 当前落地的是 Session/Turn/Message/Task projection 所需的事件子集。

## 不变量

- 任何到达模型请求的输入，都能从 Session 事件重建；
- 任何工具调用都先产生 `tool/call`，再产生 `tool/progress` 或 `tool/result`；
- 需要用户决定的动作必须产生 `permission/requested`，结果必须产生 `permission/resolved`；
- permission 事件必须记录 caller、workspace、toolCall、创建时间和过期时间；过期、拒绝、取消都必须有 terminal tool/result；
- 事件先落盘，再推送 SSE；
- 重复发送消息、重复批准、重复取消必须幂等；
- 客户端可以用 `Last-Event-ID` 或 `after_sequence` 补发事件；
- 事件 payload 不直接暴露第三方仓库的内部类型。

## SSE 规则

```text
GET /v1/sessions/{sessionId}/events?after_sequence=42
Last-Event-ID: 42
```

服务端先发送 sequence 大于游标的历史事件，再订阅新事件。客户端按 sequence 去重；检测到 gap 时重新请求补发，不自行猜测状态。

## 回放测试

每个影响 model-visible 状态的功能必须提供事件 fixture，至少验证：

1. 从空 Session 回放到当前状态；
2. 在任意事件后断线并按 sequence 恢复；
3. 重复同一 command 不产生重复副作用；
4. 失败、取消和权限拒绝都能从事件解释。
