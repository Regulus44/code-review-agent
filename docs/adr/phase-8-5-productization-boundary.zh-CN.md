# ADR：Phase 8.5 产品化边界与渐进式启用

状态：`accepted`

日期：2026-08-24

## 背景

Phase 8.5 的计划范围包括 remote auth、multi-user/tenant、quota、provider/model routing、secrets/credentials 以及 deployment、backup、migration、upgrade policy。当前 Runtime 和 API 主要面向单机/单租户 Web Coding Agent，已有 MCP credential reference 和 provider model selector，但还没有统一的 principal、tenant、quota 或远程认证事实来源。

如果直接把现有本地能力标记为“已产品化”，会让 Web 和 API 暴露超过当前安全边界的状态，也会在没有租户隔离和审计契约的情况下引入认证模型。

## 决策

### 1. 先建立 host-backed 产品化 capability contract

API `/v1/capabilities` 返回 `productization` 元数据。该元数据必须区分 `configured`、`available`、`deferred`、`disabled` 和 `unavailable`，并逐项报告：

- remote auth；
- multi-user 与 tenant isolation；
- quota enforcement；
- provider/model routing；
- secrets/credentials；
- deployment、backup、migration、upgrade。

默认本地 Host 返回 `deferred` 或 `disabled`，并提供原因。Web 只能展示这些状态，不能据此推断认证、租户隔离或 quota 已经生效。

### 2. Phase 8.5 第一实现切片采用显式配置，不改变默认本地行为

第一切片先增加能力元数据和禁用态；在 principal/tenant contract、持久化 ownership、权限审计和恢复测试具备后，允许显式配置的静态 bearer token adapter。默认本地 Host 仍不要求认证，也不自动推断租户。

后续实现认证时，必须明确：

- principal 与 tenant 的来源和生命周期；
- Session/Workspace/Task 的 tenant ownership；
- 未认证请求的公开端点；
- quota 的计量、拒绝和恢复语义；
- 凭据只使用 host-owned reference，日志和事件中不得出现 secret value。

当前已接受的第一可用切片是：静态 bearer token → principal/tenant identity → durable Session ownership → tenant-scoped Session/Workspace/MCP catalog and mutation → hard Session/Turn quota。该 adapter 只适用于受控部署和测试 fixture，不代表外部 IdP、JWT 验签或完整用户目录已经实现。Workspace catalog、rename/archive/restore/delete、reorder 以及 MCP config/list/catalog/lifecycle 操作只作用于调用者 tenant 的 Session members；跨租户 Workspace/MCP 访问统一隐藏为 404。global diagnostics 在认证请求下继续保持 fail closed，直到具备 tenant-scoped diagnostics adapter。

Workspace 生命周期事件仍进入统一 EventStore：`workspace/updated` 与 `workspace/reordered` 在显式 tenant scope 下携带 `tenantId` 和 `principalId`，重启回放按 tenant 过滤；未认证的本地 catalog 只消费 legacy unscoped workspace metadata，不把某个 tenant 的标签或顺序投影到其他 tenant。MCP config 以 SQLite schema v4 持久化可选 `tenant_id`，ConfigStore、ConnectionManager、ToolRuntime 和 API 均按 tenant fail closed；持久化 config 继续只保存 scrubbed values 与 credential reference。

### 3. Provider/model routing 与 secrets 分开演进

现有 model selector 和 MCP credential reference 只能分别作为 routing 与 credential plumbing 的基础，不自动等同于多租户产品能力。新增路由或凭据实现必须经过统一 permission、workspace、事件和审计管线。

### 4. 运维能力必须有可回滚证据

backup、migration 和 upgrade policy 需要配套 schema version、恢复 fixture、rollback 命令和部署 smoke。没有这些证据时，状态保持 `deferred`。

## 影响

- Settings 可以展示真实的产品化 readiness，而不会伪造登录、租户或 quota 能力；
- 8.5 后续实现拥有明确的 contract 和回滚边界；
- 默认本地开发和已有 Phase 0–8.4 行为保持兼容；
- 需要为后续 principal/tenant ownership 迁移增加 durable schema 和 recovery/security 测试；当前 Workspace 与 MCP slice 已具备 InMemory、SQLite reopen 和 API/browser fixture 证据。

## 验收与回滚

第一切片至少通过 `pnpm typecheck`、相关 Runtime/API/Web tests、产品化 capability gate 和 `git diff --check`。Workspace/MCP tenant slice 还必须验证 catalog 过滤、mutation/lifecycle 隔离、重启回放、credential redaction 和跨租户 404。失败时移除 capability 字段并回退到现有 `/v1/capabilities` 结构；不回滚已稳定的 EventStore 或工具权限 contract。
