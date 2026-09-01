# M14：Context Collapse Capability Boundary 实施说明

状态：`deferred`

日期：2026-08-26

阶段：Phase 8 / M14

## Claude Code 参考入口

| Claude Code 入口 | 观察到的职责 | 本项目处理 |
|---|---|---|
| `D:/Develop/claude-code/src/services/contextCollapse/index.ts` | 暴露 collapse 状态、读取时投影和持久化协调接口 | 只登记 capability，不复制未完成算法 |
| `D:/Develop/claude-code/src/services/contextCollapse/operations.ts` | `projectView()` 等操作入口；本地快照中的 `projectView()` 为恒等操作 | 不把恒等 stub 误报成历史折叠 |
| `D:/Develop/claude-code/src/services/contextCollapse/persist.ts` | collapse 状态恢复/提交入口；本地快照恢复为空操作 | 保持 EventStore transcript、M08 boundary 和 M09 recovery 为事实来源 |
| `D:/Develop/claude-code/docs/features/context-collapse.md` | 说明 read-time projection、后台折叠、commit log、overflow drain、snip 的边界 | 将四类未实现特性逐项暴露为 `false` |
| `D:/Develop/claude-code/src/query.ts` | 在 snip → microcompact → collapse → autocompact 的调用链中预留 collapse 集成点 | 当前不改变 `runSteps()` 的 M05–M10 路径 |

Claude Code 本地快照的关键事实是：目录和调用点存在，但核心 Context Collapse 仍是 stub；因此 M14 不能仅凭名称或入口存在就声明能力可用。M14 采用研究文档允许的第二种结果：保留可演进的 host-backed 接口，并明确 `deferred`。

## 契约与数据流

`packages/contracts/src/index.ts` 新增 `ContextCollapseCapability`：

```ts
{
  version: 1,
  enabled: false,
  status: "deferred" | "unavailable",
  reason: string,
  features: {
    readTimeProjection: boolean,
    backgroundCollapse: boolean,
    overflowDrain: boolean,
    snip: boolean
  }
}
```

`packages/runtime/src/index.ts` 的 `ContextSettings` 始终返回 `collapse` 字段。当前 host 返回 `enabled: false`、`status: "deferred"`、四项 feature 全部为 `false`；reason 说明必须先通过 M01–M13 的真实 provider model-view、boundary、recovery 和 replay 验收，且 Claude Code 本地实现仍为 stub。

API `/v1/capabilities` 直接透传 Runtime 的 host-backed context capability。Web typed client 的 `ContextCapability.collapse` 为可选字段，以兼容旧 API snapshot；`settings-presenter` 的行为如下：

```text
collapse metadata exists → status = deferred/unavailable, detail = host reason
collapse metadata missing → status = unavailable
```

该字段只描述能力，不创建任何 `context/collapse_*` 事件，也不改变 model-visible view。现有 M05 tool-result budget、M06/M11 memory、M07 summary、M08 boundary、M09 recovery、M10 transcript restore 和 M13 diagnostics 保持原有事实来源。

## 分层实现映射

| 层 | 文件 | M14 变化 | 事实边界 |
|---|---|---|---|
| Public contract | `packages/contracts/src/index.ts` | 新增 capability 类型 | 不新增 transcript、tool 或 permission 字段 |
| Runtime host | `packages/runtime/src/index.ts` | `ContextSettings.collapse` 固定返回 deferred metadata | 不进入 `runSteps()`，不做新压缩 |
| API typed boundary | `apps/web/src/client/api.ts` | 增加可选 collapse 子结构 | 旧服务响应仍可被读取 |
| Web presentation | `apps/web/src/presentation/settings-presenter.ts` | 新增 `context-collapse` capability 行 | UI 不触发副作用、不伪造成功 |
| Tests | Runtime/Web presenter tests | 覆盖 deferred、missing fallback | 不测试不存在的算法 |

## 安全与恢复边界

- Context Collapse capability metadata 不包含 prompt、transcript、工具结果、provider response、凭据或 workspace 文件内容。
- `deferred` 表示已知集成点但产品/算法尚未接受；`unavailable` 表示 host 没有暴露该 capability。
- Web 只能展示 capability；它不能直接调用 collapse、drain、snip 或 recovery 副作用。
- EventStore 不追加虚假的 collapse 事件；已有 compact/boundary/recovery 事件继续按 M01–M13 contract replay。
- 回滚只需移除 `ContextSettings.collapse` 的 capability 输出和 Settings 行；保留公共可选字段可让旧客户端继续工作，模型请求、transcript、权限和恢复逻辑不受影响。

## 验收场景

1. 默认 AgentHost 的 `/v1/capabilities.context.collapse` 为 `enabled=false/status=deferred`，四个 feature 全部为 false。
2. Web Settings 在 metadata 存在时显示 `Context Collapse` 为 deferred，并展示 host reason。
3. Web Settings 在旧 API snapshot 缺少 collapse 时显示 unavailable，不抛异常。
4. M14 不产生新的 collapse 事件，M13 diagnostics 和 M08/M09 projection replay 保持不变。
5. Runtime/Web 定向测试、全量测试、构建和 diff 检查通过。

## 验证命令

```text
pnpm typecheck
pnpm --filter @coding-agent/web test -- --run src/presentation/settings-presenter.test.ts
pnpm --filter @coding-agent/runtime test -- --run src/index.test.ts
pnpm test
pnpm build:web
git diff --check
```

## 后续开启条件

只有在真实 provider 场景证明 M01–M13 的 model view、compact boundary、reactive recovery、transcript restore、memory 和 diagnostics 仍不足时，才创建独立的 `packages/context-collapse` 设计与 ADR。届时必须先定义 read-time projection 的纯函数输入/输出、append-only collapse commit log、overflow drain 幂等、snip 的保护清单和完整 replay/恢复测试。
