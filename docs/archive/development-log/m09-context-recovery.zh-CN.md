# M09 开发日志：Query Proactive 与 Reactive Recovery

日期：2026-08-26  
阶段：Phase 8 / M09  
参考：`D:/Develop/claude-code/src/query.ts`、`src/services/compact/autoCompact.ts`、`src/services/compact/reactiveCompact.ts`

## 开发范围

本次实现 Claude Code 风格的请求前主动 compact、provider overflow 后反应式 compact、retry transition、per-turn guard、连续失败 circuit breaker 和 durable recovery diagnostics。没有修改根目录 `AGENTS.md`，没有提前实现 M10 及之后模块。

## 变更记录

1. 在 `packages/context/src/recovery.ts` 增加 provider error 分类、稳定 request fingerprint 和 `ContextRecoveryGuard`。
2. 在 contracts 增加五类 `context/recovery_*` 事件、`ContextRecoveryProjection`、错误分类类型，以及 stream error 的可选 provider status/code。
3. 在 Runtime `runSteps()` 接入 proactive/reactive recovery：同一 turn 默认只允许一次 reactive compact；成功后继续原 query loop；失败后暴露原 provider error。
4. 将 `compactTurnContext()` 改为返回是否产生有效 compact，供 recovery 状态机判断成功/失败。
5. 在 LLM adapter 中保留非 2xx HTTP status，并从错误 body 提取 bounded provider message/code。
6. 在 Storage reducer 中投影最近一次 recovery 状态，保留 EventStore 为唯一事实来源。
7. 新增 Context、Runtime、Storage 测试，覆盖分类、hash、retry、事件 replay 和 guard 隔离。

## 关键行为

- `prompt_too_long` 与 `media_too_large` 才进入 reactive recovery；tool pairing、schema 和普通网络错误不误触发 compact。
- provider 413 不再自动切换 fallback model，而是先执行一次 reactive compact；其他模型错误继续沿用原 fallback 行为。
- compact 成功后保持原 `turnId`，不伪造新的 user/assistant transcript。
- 已产生部分 text delta 的失败请求标记 `partialOutput`，不执行 reactive compact。
- recovery metadata 只包含 `turnId`（由事件 envelope 提供）、request hash、provider status/code、error class、attempt、模块列表和 transition reason；不保存 prompt、provider body、凭据或 secret。

## 验证结果

```text
pnpm --filter @code-review-agent/context test -- --run   ✓ 45 tests
pnpm --filter @code-review-agent/storage test -- --run   ✓ 19 tests
pnpm --filter @code-review-agent/runtime test -- --run    ✓ 46 tests
pnpm --filter @code-review-agent/llm test -- --run        ✓ 9 tests
pnpm typecheck                                           ✓
git diff --check                                         ✓
```

## 回滚点

本模块可独立回滚到 M08 checkpoint `5e24d0f`。回滚只移除 M09 recovery 模块、事件和 projection 字段，不删除 M01–M08 的 compact、boundary、attachment 或 summary 实现。
