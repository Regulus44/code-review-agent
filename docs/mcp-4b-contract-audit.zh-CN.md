# Phase 4B MCP 契约审计与 hostile fixture 矩阵

状态：`implemented`

本文件冻结 Phase 4B 的 MCP 边界。DSH 是主要行为参考；Claude Code 只补充设置、授权和内容展示语义。本项目不复制 DSH 的 Cordis/plugin runtime，也不把远端 MCP 描述当作本地安全规则。

## 身份与 generation

- `serverName` 是跨 scope 的唯一 MCP namespace；重复配置会更新同一 durable record，必须经过 revision/并发检查，不得静默创建第二个同名 registry。
- 每次连接、握手和 discovery 形成一个单调递增 `generation`。旧 generation 的 close/error/list-changed 回调不能修改当前 client、transport、catalog 或工具集合。
- discovery 先构建完整候选 generation，再调用 `ToolRegistry.replace(ownedNames, definitions)`。候选 discovery、schema 复制或注册冲突失败时保留旧 generation。
- `tools/list_changed` 进入每个 server 自己的去抖队列和串行 sync chain；关闭 server 时清理 timer、registry generation 和 transport。

## Scope → visible Session

| scope | 可见 Session |
|---|---|
| `user` | 当前 host 的所有 Session；owner 过滤由上层 tenant/principal 继续约束 |
| `project` | `workspaceRoot` 相同的 Session |
| `session` | `sessionId` 相同的 Session；缺少 binding 的 session 配置不得用于跨 Session 事件投影 |

`mcp/server`、`mcp/tool`、`mcp/resource`、`mcp/prompt` 事件只写入可见 Session。MCP config API 返回 public view；env/header 中的 credential-shaped key 只显示 `[redacted]`，SQLite 只保存 scrubbed config 和 `credentialRef`。

## Credential / OAuth boundary

配置只保存 credential reference、transport、scope、binding、enabled、revision、policy 和非敏感参数。credential material 通过 host-owned resolver 在进程内合并到 transport，不能进入 EventStore、projection、SSE、tool catalog、Web 或 model view。401/403/unauthorized 被映射为 `needs_auth`；恢复授权后由显式 reconnect 或受控 retry 重新握手。

## Tool / schema / content trust

- public tool name 为 `mcp__<server>__<raw>`，超长或含非法字符时使用 SHA-256 identity suffix（12 hex）。
- MCP annotations 只是低信任 hint；server 默认风险、tool policy、allowlist 和 approvalMode 可以覆盖它们。
- JSON Schema 在预算内按 JSON 结构递归保留，包括 `oneOf`、`anyOf`、`allOf`、`$defs`、`$ref`、`not`、`const` 等字段。无法安全保留时使用显式 fallback，并在 catalog 提示原因。
- resource 内容的 `modelView` 有字节预算；prompt 内容总是 `untrusted-mcp-content`，只能作为低优先级追加上下文，不能覆盖 workspace、permission、security、system prompt 或 verification 规则。
- tool 结果仍必须经过 `ToolRuntime`；resource/prompt service 只负责 MCP adapter、bounded view、timeout/cancel、scope 和脱敏审计事件。

## DSH R0 对照

| DSH 文件 | 吸收的不变量 | 本项目实现 |
|---|---|---|
| `packages/mcp/mcp-client/src/index.ts` | server namespace reservation、独立 client/transport | `McpConfigStore` + `McpConnectionManager` per-server state |
| `packages/mcp/mcp-client/src/connection.ts` | generation guard、串行 sync、重连预算、dispose barrier | manager generation guard、`syncChain`、debounced list-changed、stable-window retry、close cleanup |
| `packages/mcp/mcp-client/src/tools.ts` | public identity、两阶段 tool registration、失败回滚 | SHA-256 name、lossless schema、`ToolRegistry.replace` |
| `packages/mcp/mcp-client/src/transport.ts` | 直接 argv、环境清理、明确 transport 生命周期 | `createMcpTransport`、credential resolver、stdio parent env scrub |

## Hostile fixture matrix

| fixture | 预期结果 |
|---|---|
| 重复 server/tool identity | config revision 或 discovery 明确失败，不覆盖 built-in/旧 generation |
| 超大/过深 schema | bounded fallback + catalog warning，不能导致进程内存失控 |
| `oneOf`/`anyOf`/`$ref`/`const` 组合 | 字段保留，ToolRegistry 只按本地 validator 能力执行；不支持部分有显式 warning |
| 连续 list-changed 风暴 | 50ms 去抖后单 server 串行刷新，不并发破坏 registry |
| 旧 transport 在新 generation 后 close | generation guard 丢弃回调 |
| 短暂成功后再次断线 | retry attempt 不立即归零；稳定窗口后才恢复预算 |
| retry 达到 maxAttempts | 保留 `failed`/`needs_auth` 和 `retry` diagnostics，不无限 setTimeout |
| env/header/token/cookie/Authorization | public view、SQLite config、event、SSE 和 Web 不含原值 |
| 恶意 description/resource/prompt | 仅作为不可信数据；不能覆盖 system/security/workspace 规则 |
| stdio/SSE/Streamable HTTP transport error | 只影响对应 server；built-in registry 和其他 server 保持可用 |

## 验证入口

- `packages/storage/src/index.test.ts`：schema v2、reopen、MCP config durable record；
- `packages/mcp-client/src/index.test.ts`：stdio/HTTP、ToolRuntime approval/cancel/reconnect、credential scrub、schema preservation、stable namespace；
- `apps/api/src/server.test.ts`：API MCP route 与既有 Session/工具回归；
- `apps/web/index.html`：MCP settings/diagnostics、scope/revision/generation/auth/retry/catalog 和事件投影；
- 阶段门禁：`pnpm typecheck`、focused MCP/storage/API tests、`git diff --check`，以及 API + browser smoke。
